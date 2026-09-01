import type { PostgresTransactionContext } from "../persistence/postgres/contracts.ts";
import { statement } from "../persistence/postgres/contracts.ts";
import { CanonicalPostgresError } from "../persistence/postgres/runtime/errors.ts";
import { PostgresIdempotencyRepository } from "../persistence/postgres/runtime/idempotency.ts";
import { PostgresJobsOutboxAuditRepository } from "../persistence/postgres/runtime/jobs-outbox-audit.ts";
import {
  CanonicalPostgresTransactionManager,
  type PostgresConnectionFactory,
} from "../persistence/postgres/runtime/transaction-manager.ts";

export const CANONICAL_POSTGRES_SCHEMA_VERSION = "tivdoc-canonical-postgresql-v0.9.0" as const;
export const CANONICAL_POSTGRES_RUNTIME_MODES = ["memory_test_only", "isolated_postgres", "disabled"] as const;
export type CanonicalPostgresRuntimeMode = (typeof CANONICAL_POSTGRES_RUNTIME_MODES)[number];
export type CanonicalPostgresExecutionBoundary = "test" | "hermetic_synthetic" | "non_test";

export type CanonicalPostgresTarget = Readonly<{
  target_id: string;
  host: "127.0.0.1" | "::1" | "localhost";
  database: string;
  disposable: true;
  validation: "LOOPBACK_DISPOSABLE_VALIDATED";
}>;

export type CanonicalPostgresConfig =
  | Readonly<{ mode: "disabled"; execution_boundary: CanonicalPostgresExecutionBoundary }>
  | Readonly<{
      mode: "memory_test_only";
      execution_boundary: "test" | "hermetic_synthetic" | "non_test";
      test_sentinel?: "TIVDOC_HERMETIC_TEST_ONLY";
    }>
  | Readonly<{
      mode: "isolated_postgres";
      execution_boundary: CanonicalPostgresExecutionBoundary;
      target: CanonicalPostgresTarget;
      build_identity_sha: string;
    }>;

export type TransactionScopedRuntimeRepositories = Readonly<{
  idempotency: PostgresIdempotencyRepository;
  jobs_outbox_audit: PostgresJobsOutboxAuditRepository;
}>;

export type TransactionScopedPostgresBundle<TIntake, TAnalysis> = Readonly<{
  context: PostgresTransactionContext;
  intake: TIntake;
  analysis: TAnalysis;
  runtime: TransactionScopedRuntimeRepositories;
}>;

export type CanonicalPostgresAdapterFactory<T> = (
  context: PostgresTransactionContext,
  tenantId: string,
) => T;

export type CanonicalPostgresDependencies<TIntake, TAnalysis, TMemoryTestOnly = never> = Readonly<{
  connection_factory?: PostgresConnectionFactory;
  intake_factory?: CanonicalPostgresAdapterFactory<TIntake>;
  analysis_factory?: CanonicalPostgresAdapterFactory<TAnalysis>;
  memory_test_only_factory?: () => TMemoryTestOnly;
}>;

export type DisabledCanonicalPostgresComposition = Readonly<{
  mode: "disabled";
  durable: false;
  reason: "PERSISTENCE_DISABLED";
}>;

export type MemoryTestOnlyCanonicalPostgresComposition<T> = Readonly<{
  mode: "memory_test_only";
  durable: false;
  test_only: true;
  bundle: T;
}>;

export type IsolatedCanonicalPostgresComposition<TIntake, TAnalysis> = Readonly<{
  mode: "isolated_postgres";
  durable: true;
  target_id: string;
  schema_version: typeof CANONICAL_POSTGRES_SCHEMA_VERSION;
  transaction<T>(
    tenantId: string,
    caseId: string,
    operation: (bundle: TransactionScopedPostgresBundle<TIntake, TAnalysis>) => Promise<T>,
  ): Promise<T>;
}>;

export type CanonicalPostgresComposition<TIntake, TAnalysis, TMemoryTestOnly> =
  | DisabledCanonicalPostgresComposition
  | MemoryTestOnlyCanonicalPostgresComposition<TMemoryTestOnly>
  | IsolatedCanonicalPostgresComposition<TIntake, TAnalysis>;

const SCHEMA_COMPATIBILITY = `
select schema_version
from public.engine_schema_metadata
where component = 'canonical_postgresql_composition'`;

const RUNTIME_CONTEXT = `
select set_config('tivdoc.engine_git_sha', $1, true),
       set_config('tivdoc.tenant_id', $2, true),
       set_config('tivdoc.runtime_role', $3, true)`;

/**
 * Single version-neutral non-test root. It accepts the W1/W2 adapter factories
 * and constructs them only inside the same explicit transaction context.
 */
export async function startCanonicalPostgresComposition<TIntake, TAnalysis, TMemoryTestOnly = never>(
  config: CanonicalPostgresConfig,
  dependencies: CanonicalPostgresDependencies<TIntake, TAnalysis, TMemoryTestOnly>,
): Promise<CanonicalPostgresComposition<TIntake, TAnalysis, TMemoryTestOnly>> {
  if (config.mode === "disabled") {
    return Object.freeze({ mode: "disabled", durable: false, reason: "PERSISTENCE_DISABLED" });
  }

  if (config.mode === "memory_test_only") {
    if (config.execution_boundary === "non_test") {
      throw new CanonicalPostgresError("MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION");
    }
    if (config.test_sentinel !== "TIVDOC_HERMETIC_TEST_ONLY" || !dependencies.memory_test_only_factory) {
      throw new CanonicalPostgresError("MEMORY_TEST_ONLY_SENTINEL_REQUIRED");
    }
    return Object.freeze({
      mode: "memory_test_only" as const,
      durable: false as const,
      test_only: true as const,
      bundle: dependencies.memory_test_only_factory(),
    });
  }

  validateTarget(config.target);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(config.build_identity_sha)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }
  if (!dependencies.connection_factory || !dependencies.intake_factory || !dependencies.analysis_factory) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }

  const transactionManager = new CanonicalPostgresTransactionManager(dependencies.connection_factory);
  await transactionManager.transaction(async (context) => {
    await setRuntimeContext(context, config.build_identity_sha, "startup_schema_probe");
    const result = await context.client.query(statement("schema_compatibility_read", SCHEMA_COMPATIBILITY, []));
    if (result.row_count !== 1 || result.rows.length !== 1 || result.rows[0].schema_version !== CANONICAL_POSTGRES_SCHEMA_VERSION) {
      throw new CanonicalPostgresError("POSTGRES_SCHEMA_INCOMPATIBLE");
    }
  });

  return Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: config.target.target_id,
    schema_version: CANONICAL_POSTGRES_SCHEMA_VERSION,
    transaction: <T>(
      tenantId: string,
      caseId: string,
      operation: (bundle: TransactionScopedPostgresBundle<TIntake, TAnalysis>) => Promise<T>,
    ): Promise<T> => transactionManager.transaction(async (context) => {
      await setRuntimeContext(context, config.build_identity_sha, tenantId);
      const bundle: TransactionScopedPostgresBundle<TIntake, TAnalysis> = Object.freeze({
        context,
        intake: dependencies.intake_factory!(context, tenantId),
        analysis: dependencies.analysis_factory!(context, tenantId),
        runtime: Object.freeze({
          idempotency: new PostgresIdempotencyRepository(),
          jobs_outbox_audit: new PostgresJobsOutboxAuditRepository(context, tenantId, caseId),
        }),
      });
      return operation(bundle);
    }),
  });
}

export function requireIsolatedCanonicalPostgres<TIntake, TAnalysis, TMemoryTestOnly>(
  composition: CanonicalPostgresComposition<TIntake, TAnalysis, TMemoryTestOnly>,
): IsolatedCanonicalPostgresComposition<TIntake, TAnalysis> {
  if (composition.mode !== "isolated_postgres") throw new CanonicalPostgresError("PERSISTENCE_DISABLED");
  return composition;
}

function validateTarget(target: CanonicalPostgresTarget | undefined): void {
  if (!target || !target.target_id || !target.database) throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  if (!["127.0.0.1", "::1", "localhost"].includes(target.host)) throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_LOOPBACK");
  if (!target.disposable || target.validation !== "LOOPBACK_DISPOSABLE_VALIDATED" || !/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(target.database)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_DISPOSABLE");
  }
}

async function setRuntimeContext(context: PostgresTransactionContext, buildIdentitySha: string, tenantId: string): Promise<void> {
  await context.client.query(statement("runtime_context_set", RUNTIME_CONTEXT, [buildIdentitySha, tenantId, "service_role"]));
}
