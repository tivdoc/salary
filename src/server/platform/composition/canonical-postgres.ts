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
export type CanonicalPostgresRuntimeRole = "web" | "operations" | "worker";

export type CanonicalVerifiedRuntimeIdentity = Readonly<{
  session_id: string;
  token_id: string;
  tenant_id: string;
  actor_id: string;
  reviewer_organization_id: string | null;
  rotation_counter: number;
}>;

export type CanonicalVerifiedTransactionInput = Readonly<{
  identity: CanonicalVerifiedRuntimeIdentity;
  runtime_role: CanonicalPostgresRuntimeRole;
  case_id: string;
  correlation_id: string;
}>;

export type CanonicalPostgresTarget = Readonly<{
  target_id: string;
  host: string;
  database: string;
  disposable: true;
  /**
   * `REMOTE_DEV_ALLOWLISTED` is produced only by the driver, and only when the
   * caller declared that exact host, port and database in advance. The database
   * name still has to be disposable, so the guarantee this root enforces is
   * unchanged: it never reaches a database nobody declared throwaway.
   */
  validation: "LOOPBACK_DISPOSABLE_VALIDATED" | "REMOTE_DEV_ALLOWLISTED";
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
  runtime_connection_factories?: Partial<Readonly<Record<CanonicalPostgresRuntimeRole, PostgresConnectionFactory>>>;
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
  verified_transaction<T>(
    input: CanonicalVerifiedTransactionInput,
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

const BUILD_CONTEXT = `select pg_catalog.set_config('tivdoc.engine_git_sha', $1, true)`;

const VERIFIED_RUNTIME_CONTEXT = `
select tenant_id, actor_id, runtime_role, reviewer_organization_id,
       session_rotation_counter::text as session_rotation_counter
from private.runtime_context_install($1, $2, $3)`;

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
  const runtimeFactories = dependencies.runtime_connection_factories ?? {};
  const runtimeRoles = (["web", "operations", "worker"] as const)
    .filter((role) => runtimeFactories[role] !== undefined);
  if ((!dependencies.connection_factory && runtimeRoles.length === 0)
      || !dependencies.intake_factory || !dependencies.analysis_factory) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  }

  const transactionManager = dependencies.connection_factory
    ? new CanonicalPostgresTransactionManager(dependencies.connection_factory)
    : null;
  const runtimeManagers = new Map<CanonicalPostgresRuntimeRole, CanonicalPostgresTransactionManager>();
  for (const role of runtimeRoles) {
    runtimeManagers.set(role, new CanonicalPostgresTransactionManager(runtimeFactories[role]!));
  }
  const startupManager = transactionManager ?? runtimeManagers.values().next().value;
  if (!startupManager) throw new CanonicalPostgresError("POSTGRES_TARGET_REQUIRED");
  await startupManager.transaction(async (context) => {
    if (transactionManager) await setRuntimeContext(context, config.build_identity_sha, "startup_schema_probe");
    else await setBuildContext(context, config.build_identity_sha);
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
    ): Promise<T> => {
      if (!transactionManager) return Promise.reject(new CanonicalPostgresError("POSTGRES_RUNTIME_IDENTITY_REQUIRED"));
      return transactionManager.transaction(async (context) => {
      await setRuntimeContext(context, config.build_identity_sha, tenantId);
      const bundle = createTransactionBundle(context, tenantId, caseId, dependencies);
      return operation(bundle);
      });
    },
    verified_transaction: <T>(
      input: CanonicalVerifiedTransactionInput,
      operation: (bundle: TransactionScopedPostgresBundle<TIntake, TAnalysis>) => Promise<T>,
    ): Promise<T> => {
      assertVerifiedTransactionInput(input);
      const manager = runtimeManagers.get(input.runtime_role);
      if (!manager) return Promise.reject(new CanonicalPostgresError("POSTGRES_RUNTIME_ROLE_UNAVAILABLE"));
      return manager.transaction(async (context) => {
        await setBuildContext(context, config.build_identity_sha);
        const verified = await installVerifiedRuntimeContext(context, input);
        const bundle = createTransactionBundle(context, verified.tenant_id, input.case_id, dependencies);
        return operation(bundle);
      });
    },
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
  const remoteAllowlisted = target.validation === "REMOTE_DEV_ALLOWLISTED";
  if (!remoteAllowlisted && !["127.0.0.1", "::1", "localhost"].includes(target.host)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_LOOPBACK");
  }
  if (!target.disposable
      || (target.validation !== "LOOPBACK_DISPOSABLE_VALIDATED" && !remoteAllowlisted)
      || !/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(target.database)) {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_DISPOSABLE");
  }
  // A remote target still has to name a host; an empty one would slip past the
  // loopback check above.
  if (remoteAllowlisted && target.host.trim() === "") {
    throw new CanonicalPostgresError("POSTGRES_TARGET_NOT_LOOPBACK");
  }
}

async function setRuntimeContext(context: PostgresTransactionContext, buildIdentitySha: string, tenantId: string): Promise<void> {
  await context.client.query(statement("runtime_context_set", RUNTIME_CONTEXT, [buildIdentitySha, tenantId, "service_role"]));
}

async function setBuildContext(context: PostgresTransactionContext, buildIdentitySha: string): Promise<void> {
  await context.client.query(statement("runtime_build_context_set", BUILD_CONTEXT, [buildIdentitySha]));
}

function createTransactionBundle<TIntake, TAnalysis, TMemoryTestOnly>(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
  dependencies: CanonicalPostgresDependencies<TIntake, TAnalysis, TMemoryTestOnly>,
): TransactionScopedPostgresBundle<TIntake, TAnalysis> {
  return Object.freeze({
    context,
    intake: dependencies.intake_factory!(context, tenantId),
    analysis: dependencies.analysis_factory!(context, tenantId),
    runtime: Object.freeze({
      idempotency: new PostgresIdempotencyRepository(),
      jobs_outbox_audit: new PostgresJobsOutboxAuditRepository(context, tenantId, caseId),
    }),
  });
}

function assertVerifiedTransactionInput(input: CanonicalVerifiedTransactionInput): void {
  const opaque = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
  if (!opaque.test(input.identity.session_id) || !opaque.test(input.identity.token_id)
      || !opaque.test(input.identity.tenant_id) || !opaque.test(input.identity.actor_id)
      || !opaque.test(input.case_id) || !opaque.test(input.correlation_id)
      || !Number.isSafeInteger(input.identity.rotation_counter) || input.identity.rotation_counter < 0
      || (input.identity.reviewer_organization_id !== null
        && !opaque.test(input.identity.reviewer_organization_id))) {
    throw new CanonicalPostgresError("POSTGRES_RUNTIME_IDENTITY_INVALID");
  }
  if (input.runtime_role === "operations" && input.identity.reviewer_organization_id === null) {
    throw new CanonicalPostgresError("POSTGRES_RUNTIME_REVIEWER_ORGANIZATION_REQUIRED");
  }
}

async function installVerifiedRuntimeContext(
  context: PostgresTransactionContext,
  input: CanonicalVerifiedTransactionInput,
): Promise<CanonicalVerifiedRuntimeIdentity & Readonly<{ runtime_role: CanonicalPostgresRuntimeRole }>> {
  const result = await context.client.query(statement("runtime_verified_context_install", VERIFIED_RUNTIME_CONTEXT, [
    input.identity.session_id,
    input.identity.token_id,
    input.correlation_id,
  ]));
  const row = result.rows[0];
  const rotation = typeof row?.session_rotation_counter === "string"
    ? Number(row.session_rotation_counter)
    : Number.NaN;
  if (result.row_count !== 1 || result.rows.length !== 1 || !row
      || row.tenant_id !== input.identity.tenant_id
      || row.actor_id !== input.identity.actor_id
      || row.runtime_role !== input.runtime_role
      || (row.reviewer_organization_id ?? null) !== input.identity.reviewer_organization_id
      || rotation !== input.identity.rotation_counter) {
    throw new CanonicalPostgresError("POSTGRES_RUNTIME_IDENTITY_MISMATCH");
  }
  return Object.freeze({ ...input.identity, runtime_role: input.runtime_role });
}
