import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import type { VerifiedActor } from "../../../src/engine/wave4/contracts.ts";
import {
  createDurablePostgresGlobalDependencyInvalidationService,
} from "../../../src/server/product/dependency-invalidation/postgres-port.ts";
import {
  GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
  type GlobalDependencyInvalidationReceipt,
  type GlobalDependencyMutation,
} from "../../../src/server/product/dependency-invalidation/global-invalidation.ts";
import { durableBoundaryStatements } from "../../../src/server/product/durable-postgres/boundary-sql.ts";
import type { DurableProductRouteSessionContextPort } from "../../../src/server/product/routes/durable-registration.ts";
import {
  statement,
  type PostgresTransactionContext,
} from "../../../src/server/platform/persistence/postgres/contracts.ts";
import {
  NodePostgresConnectionFactory,
} from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  CanonicalPostgresTransactionManager,
} from "../../../src/server/platform/persistence/postgres/runtime/transaction-manager.ts";

const BUILD_IDENTITY = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const FIXTURE_SUFFIX = /^[a-z0-9]{8,24}$/u;
const INITIAL_EPOCHS = Object.freeze({ dependency: 5, cache: 7, download_grant: 11 });

export const RUNTIME_PRODUCT_REPAIR_V0102_INVOCATION = Object.freeze({
  schema_version: "tivdoc-runtime-product-repair-v0.10.2-invocation-v1" as const,
  function: "runRuntimeProductRepairV0102Matrix" as const,
  required_inputs: Object.freeze([
    "admin_connection_url",
    "runtime_role_connection_urls.operations",
    "runtime_role_connection_urls.web",
    "build_identity_sha",
    "fixture_suffix",
  ] as const),
  target: "loopback disposable tivdoc_v09_* PostgreSQL database after migration 202609010009" as const,
  credentials_recorded: 0 as const,
  synthetic_data_only: true as const,
  cleanup: "exact fixture scope in finally" as const,
});

export type RuntimeProductRepairV0102Input = Readonly<{
  admin_connection_url: string;
  runtime_role_connection_urls: Readonly<{
    operations: string;
    web: string;
  }>;
  build_identity_sha: string;
  fixture_suffix: string;
}>;

export type RuntimeProductRepairV0102Receipt = Readonly<{
  schema_version: "tivdoc-runtime-product-repair-v0.10.2-matrix-v1";
  proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL";
  target_id: string;
  migration_009_present: true;
  operations_resolver_execution: "PASS";
  exact_canonical_report_identity_sql: "PASS";
  active_owner_report_rows: 1;
  cross_owner_report_rows: 0;
  cross_tenant_report_rows: 0;
  ordinary_lifecycle_revision: 2;
  dependency_revision_before_synchronization: 1;
  invalidation_revision: 3;
  epochs_before: typeof INITIAL_EPOCHS;
  epochs_after: Readonly<{ dependency: 6; cache: 8; download_grant: 12 }>;
  epochs_reset: false;
  approval_versions_preserved: 2;
  report_versions_preserved: 1;
  grants_revoked: 1;
  jobs_cancelled: 1;
  outbox_events_superseded: 1;
  durable_invalidation_rows: 1;
  durable_audit_rows: 1;
  durable_outbox_rows: 1;
  idempotent_replay: true;
  product_reachable_memory_fallbacks: 0;
  real_legal_content_activated: 0;
  real_customer_data_reads: 0;
  production_or_shadow_modes: 0;
  connection_attempts: number;
  credentials_recorded: 0;
  cleanup_completed: true;
  status: "PASS";
}>;

type Fixture = ReturnType<typeof createRuntimeProductRepairV0102Fixture>;

/** Pure deterministic fixture builder used by the focused contract test. */
export function createRuntimeProductRepairV0102Fixture(
  suffix: string,
  nowMs = Date.now(),
) {
  assert(FIXTURE_SUFFIX.test(suffix), "RUNTIME_PRODUCT_REPAIR_FIXTURE_SUFFIX_INVALID");
  assert(Number.isSafeInteger(nowMs) && nowMs >= 1_000_000_000_000,
    "RUNTIME_PRODUCT_REPAIR_CLOCK_INVALID");
  const anchor = Math.floor(nowMs / 1_000) * 1_000;
  const hash = (label: string): string => canonicalSha256({
    schema_version: "tivdoc-runtime-product-repair-v0.10.2-fixture-v1",
    suffix,
    label,
  });
  const canonicalCaseA = `case:repair:a:${suffix}`;
  const tenantA = `tenant:repair:a:${suffix}`;
  const initialStateSha256 = hash("case-a-state-revision-1");
  const initialLifecycleSha256 = hash("case-a-lifecycle-revision-1");
  const advanceStateSha256 = hash("case-a-state-revision-2");
  const advanceCommandSha256 = hash("case-a-lifecycle-command-revision-2");
  const advanceEventSha256 = hash("case-a-lifecycle-event-revision-2");
  const previousDependencySha256 = hash("dependency-revision-1");
  const nextDependencySha256 = hash("dependency-fact-correction");
  const actorA = `owner:repair:a:${suffix}`;
  const workerId = `worker:repair:${suffix}`;
  const workerJobId = `job:repair:worker:${suffix}`;
  const leaseExpiresAtMs = anchor + 30 * 60_000;
  const invalidationAt = iso(anchor - 60_000);
  const actor: VerifiedActor = Object.freeze({
    actor_id: actorA,
    role: "fact_reviewer" as const,
    tenant_id: tenantA,
    assigned_case_ids: Object.freeze([canonicalCaseA]),
    verified_server_side: true as const,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
  const mutation: GlobalDependencyMutation = Object.freeze({
    schema_version: GLOBAL_DEPENDENCY_INVALIDATION_SCHEMA_VERSION,
    tenant_id: tenantA,
    case_id: canonicalCaseA,
    expected_case_revision: 2,
    mutation_kind: "fact_correction" as const,
    dependency_id: `fact:repair:${suffix}`,
    previous_dependency_sha256: previousDependencySha256,
    next_dependency_sha256: nextDependencySha256,
    actor,
    reason_code: "SYNTHETIC_FACT_CORRECTION",
    idempotency_key: `invalidation:repair:${suffix}`,
    occurred_at: invalidationAt,
    worker_fence: Object.freeze({
      job_id: workerJobId,
      worker_id: workerId,
      fencing_token: 3,
      now_ms: anchor,
      lease_expires_at_ms: leaseExpiresAtMs,
    }),
  });
  return Object.freeze({
    suffix,
    tenants: Object.freeze({ a: tenantA, c: `tenant:repair:c:${suffix}` }),
    cases: Object.freeze({
      a: canonicalCaseA,
      b: `case:repair:b:${suffix}`,
      c: `case:repair:c:${suffix}`,
    }),
    internal_cases: Object.freeze({
      a: uuid(`case-a:${suffix}`),
      b: uuid(`case-b:${suffix}`),
      c: uuid(`case-c:${suffix}`),
    }),
    subjects: Object.freeze({
      a: actorA,
      b: `owner:repair:b:${suffix}`,
      c: `owner:repair:c:${suffix}`,
    }),
    sessions: Object.freeze({
      a: Object.freeze({ sid: `session:repair:a:${suffix}`, jti: `token:repair:a:${suffix}` }),
      b: Object.freeze({ sid: `session:repair:b:${suffix}`, jti: `token:repair:b:${suffix}` }),
      c: Object.freeze({ sid: `session:repair:c:${suffix}`, jti: `token:repair:c:${suffix}` }),
    }),
    reviewer_org: `reviewer-org:repair:${suffix}`,
    analysis_run_uuid: uuid(`analysis-run:${suffix}`),
    analysis_run_id: `analysis:repair:${suffix}`,
    report_id: `report:repair:${suffix}`,
    review_task_id: `review:repair:${suffix}`,
    object_version_id: `object-version:repair:${suffix}`,
    worker_id: workerId,
    worker_job_id: workerJobId,
    cancellable_job_id: `job:repair:cancel:${suffix}`,
    stale_outbox_id: `outbox:repair:stale:${suffix}`,
    hashes: Object.freeze({
      initial_state: initialStateSha256,
      initial_lifecycle: initialLifecycleSha256,
      advance_state: advanceStateSha256,
      advance_command: advanceCommandSha256,
      advance_event: advanceEventSha256,
      dependency_before: previousDependencySha256,
      dependency_after: nextDependencySha256,
      report: hash("report"),
      analysis_result: hash("analysis-result"),
      manifest: hash("manifest"),
      json: hash("json"),
      html: hash("html"),
      pdf: hash("pdf"),
      owner_a: hash("owner-a"),
      owner_b: hash("owner-b"),
      owner_c: hash("owner-c"),
      approval_input: hash("approval-input"),
      approval_output: hash("approval-output"),
      approval_task: hash("approval-task"),
      approval_decision: hash("approval-decision"),
      execution_binding: hash("execution-binding"),
      approval_binding: hash("approval-binding"),
      download_binding: hash("download-binding"),
      worker_payload: hash("worker-payload"),
      cancellable_payload: hash("cancellable-payload"),
      stale_outbox_payload: hash("stale-outbox-payload"),
    }),
    timestamps: Object.freeze({
      seeded_at: iso(anchor - 10 * 60_000),
      analysis_started_at: iso(anchor - 9 * 60_000),
      analysis_completed_at: iso(anchor - 8 * 60_000),
      report_created_at: iso(anchor - 7 * 60_000),
      lifecycle_advanced_at: iso(anchor - 2 * 60_000),
      invalidation_at: invalidationAt,
      fence_now_ms: anchor,
      lease_expires_at_ms: leaseExpiresAtMs,
    }),
    lifecycle_advance: Object.freeze({
      tenant_id: tenantA,
      case_id: canonicalCaseA,
      expected_revision: 1,
      state_before: "awaiting_report_approval" as const,
      state_after: "report_ready" as const,
      event_kind: "synthetic.report_ready",
      command_sha256: advanceCommandSha256,
      event_sha256: advanceEventSha256,
      previous_sha256: initialLifecycleSha256,
      state_sha256: advanceStateSha256,
      occurred_at: iso(anchor - 2 * 60_000),
    }),
    actor,
    mutation,
    initial_epochs: INITIAL_EPOCHS,
  });
}

export async function runRuntimeProductRepairV0102Matrix(
  input: RuntimeProductRepairV0102Input,
): Promise<RuntimeProductRepairV0102Receipt> {
  assert(BUILD_IDENTITY.test(input.build_identity_sha), "RUNTIME_PRODUCT_REPAIR_BUILD_IDENTITY_INVALID");
  const fixture = createRuntimeProductRepairV0102Fixture(input.fixture_suffix);
  const admin = driver(input.admin_connection_url, "tivdoc-v0102-repair-admin");
  const operations = driver(input.runtime_role_connection_urls.operations, "tivdoc-v0102-repair-operations");
  const web = driver(input.runtime_role_connection_urls.web, "tivdoc-v0102-repair-web");
  assertSameTarget(admin, operations, web);
  const adminTransactions = new CanonicalPostgresTransactionManager(admin);
  const operationsTransactions = new CanonicalPostgresTransactionManager(operations);
  const webTransactions = new CanonicalPostgresTransactionManager(web);
  let result: Omit<RuntimeProductRepairV0102Receipt, "cleanup_completed" | "connection_attempts"> | null = null;
  let primaryFailure: unknown = null;
  let cleanupFailure: unknown = null;
  try {
    await requireMigration009(adminTransactions);
    await cleanup(adminTransactions, fixture);
    await seed(adminTransactions, fixture, input.build_identity_sha);
    result = await exerciseMatrix({
      admin: adminTransactions,
      operations: operationsTransactions,
      web: webTransactions,
      build_identity_sha: input.build_identity_sha,
      fixture,
      target_id: admin.target.target_id,
    });
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await cleanup(adminTransactions, fixture);
  } catch (error) {
    cleanupFailure = error;
  }
  const connectionAttempts = admin.metrics().connection_attempts
    + operations.metrics().connection_attempts
    + web.metrics().connection_attempts;
  try {
    await closeDrivers(web, operations, admin);
  } catch (error) {
    cleanupFailure ??= error;
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  assert(result !== null, "RUNTIME_PRODUCT_REPAIR_RECEIPT_MISSING");
  assert(connectionAttempts > 0, "RUNTIME_PRODUCT_REPAIR_CONNECTIONS_NOT_OBSERVED");
  return Object.freeze({
    ...result,
    connection_attempts: connectionAttempts,
    cleanup_completed: true as const,
  });
}

async function exerciseMatrix(input: Readonly<{
  admin: CanonicalPostgresTransactionManager;
  operations: CanonicalPostgresTransactionManager;
  web: CanonicalPostgresTransactionManager;
  build_identity_sha: string;
  fixture: Fixture;
  target_id: string;
}>): Promise<Omit<RuntimeProductRepairV0102Receipt, "cleanup_completed" | "connection_attempts">> {
  const { fixture } = input;
  await withVerifiedRuntime(input.operations, input.build_identity_sha, fixture, "operations", fixture.sessions.a,
    fixture.tenants.a, fixture.subjects.a, "resolver", async (context) => {
      const resolved = await context.client.query(statement(
        "repair_v0102_operations_resolver",
        "select private.resolve_engine_case_id($1,$2)::text as internal_case_id",
        [fixture.tenants.a, fixture.cases.a],
      ));
      assert(resolved.row_count === 1 && resolved.rows[0]?.internal_case_id === fixture.internal_cases.a,
        "RUNTIME_PRODUCT_REPAIR_OPERATIONS_RESOLVER_FAILED");
    });

  const ownedRows = await canonicalIdentityRows(input.web, input.build_identity_sha, fixture,
    fixture.sessions.a, fixture.tenants.a, fixture.subjects.a, "owned");
  const crossOwnerRows = await canonicalIdentityRows(input.web, input.build_identity_sha, fixture,
    fixture.sessions.b, fixture.tenants.a, fixture.subjects.b, "cross-owner");
  const crossTenantRows = await canonicalIdentityRows(input.web, input.build_identity_sha, fixture,
    fixture.sessions.c, fixture.tenants.c, fixture.subjects.c, "cross-tenant");
  assert(ownedRows === 1, "RUNTIME_PRODUCT_REPAIR_ACTIVE_OWNER_REPORT_HIDDEN");
  assert(crossOwnerRows === 0, "RUNTIME_PRODUCT_REPAIR_CROSS_OWNER_REPORT_VISIBLE");
  assert(crossTenantRows === 0, "RUNTIME_PRODUCT_REPAIR_CROSS_TENANT_REPORT_VISIBLE");

  const lifecycle = await withVerifiedRuntime(
    input.operations,
    input.build_identity_sha,
    fixture,
    "operations",
    fixture.sessions.a,
    fixture.tenants.a,
    fixture.subjects.a,
    "ordinary-lifecycle",
    (context) => advanceOrdinaryLifecycle(context, fixture),
  );
  assert(lifecycle.revision === "2" && lifecycle.state_sha256 === fixture.hashes.advance_state,
    "RUNTIME_PRODUCT_REPAIR_ORDINARY_LIFECYCLE_ADVANCE_FAILED");

  const before = await inspectEpochs(input.admin, fixture);
  assert(before.case_revision === 1
    && before.dependency_epoch === INITIAL_EPOCHS.dependency
    && before.cache_epoch === INITIAL_EPOCHS.cache
    && before.download_grant_epoch === INITIAL_EPOCHS.download_grant,
  "RUNTIME_PRODUCT_REPAIR_PRE_SYNC_EPOCHS_INVALID");

  const sessionContext = createOperationsSessionContext(
    input.operations,
    input.build_identity_sha,
    fixture,
  );
  const service = createDurablePostgresGlobalDependencyInvalidationService({
    session_context: sessionContext,
    actor: fixture.actor,
    correlation_id: `repair:invalidation:${fixture.suffix}`,
  });
  const first = await service.invalidate(fixture.mutation);
  assertInvalidationReceipt(first, false);
  const replay = await service.invalidate(fixture.mutation);
  assertInvalidationReceipt(replay, true);
  assert(replay.receipt_sha256 === first.receipt_sha256, "RUNTIME_PRODUCT_REPAIR_REPLAY_MISMATCH");

  const durable = await inspectDurableResult(input.admin, fixture, first);
  return Object.freeze({
    schema_version: "tivdoc-runtime-product-repair-v0.10.2-matrix-v1" as const,
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL" as const,
    target_id: input.target_id,
    migration_009_present: true as const,
    operations_resolver_execution: "PASS" as const,
    exact_canonical_report_identity_sql: "PASS" as const,
    active_owner_report_rows: 1 as const,
    cross_owner_report_rows: 0 as const,
    cross_tenant_report_rows: 0 as const,
    ordinary_lifecycle_revision: 2 as const,
    dependency_revision_before_synchronization: 1 as const,
    invalidation_revision: 3 as const,
    epochs_before: INITIAL_EPOCHS,
    epochs_after: Object.freeze({ dependency: 6 as const, cache: 8 as const, download_grant: 12 as const }),
    epochs_reset: false as const,
    approval_versions_preserved: durable.approval_versions,
    report_versions_preserved: durable.report_versions,
    grants_revoked: first.grants_revoked as 1,
    jobs_cancelled: first.jobs_cancelled as 1,
    outbox_events_superseded: first.outbox_events_superseded as 1,
    durable_invalidation_rows: durable.invalidation_rows,
    durable_audit_rows: durable.audit_rows,
    durable_outbox_rows: durable.outbox_rows,
    idempotent_replay: true as const,
    product_reachable_memory_fallbacks: 0 as const,
    real_legal_content_activated: 0 as const,
    real_customer_data_reads: 0 as const,
    production_or_shadow_modes: 0 as const,
    credentials_recorded: 0 as const,
    status: "PASS" as const,
  });
}

async function advanceOrdinaryLifecycle(context: PostgresTransactionContext, fixture: Fixture) {
  const command = fixture.lifecycle_advance;
  const state = await context.client.query(statement(
    "repair_v0102_intake_case_update",
    `update public.engine_case_state
        set revision=revision+1,lifecycle_state=$3,state_sha256=$4,updated_at=$5::timestamptz
      where tenant_id=$1 and canonical_case_id=$2 and revision=$6::bigint
      returning canonical_case_id as case_id,tenant_id,revision::text,
                lifecycle_state,state_sha256,updated_at`,
    [command.tenant_id, command.case_id, command.state_after, command.state_sha256,
      command.occurred_at, command.expected_revision],
  ));
  assert(state.row_count === 1, "RUNTIME_PRODUCT_REPAIR_ORDINARY_LIFECYCLE_STATE_FAILED");
  const lifecycle = await context.client.query(statement(
    "repair_v0102_intake_lifecycle_insert",
    `insert into public.engine_case_lifecycle_revisions(
       case_id,tenant_id,revision,state_before,state_after,event_kind,
       command_sha256,event_sha256,previous_sha256,occurred_at
     ) values (
       private.resolve_engine_case_id($2,$1),$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10::timestamptz
     ) returning revision::text`,
    [command.case_id, command.tenant_id, 2, command.state_before, command.state_after,
      command.event_kind, command.command_sha256, command.event_sha256,
      command.previous_sha256, command.occurred_at],
  ));
  assert(lifecycle.row_count === 1 && lifecycle.rows[0]?.revision === "2",
    "RUNTIME_PRODUCT_REPAIR_ORDINARY_LIFECYCLE_HISTORY_FAILED");
  return state.rows[0] as Readonly<{
    revision: string;
    state_sha256: string;
  }>;
}

async function canonicalIdentityRows(
  manager: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  fixture: Fixture,
  session: Fixture["sessions"][keyof Fixture["sessions"]],
  expectedTenant: string,
  expectedSubject: string,
  correlationSuffix: string,
): Promise<number> {
  return withVerifiedRuntime(manager, buildIdentitySha, fixture, "web", session,
    expectedTenant, expectedSubject, correlationSuffix, async (context) => {
      const result = await context.client.query(durableBoundaryStatements.reportIdentity([
        fixture.tenants.a,
        fixture.cases.a,
        fixture.report_id,
        1,
      ]));
      if (result.row_count === 1) {
        const row = result.rows[0];
        assert(row?.tenant_id === fixture.tenants.a
          && row.canonical_case_id === fixture.cases.a
          && row.report_id === fixture.report_id
          && row.report_revision === "1",
        "RUNTIME_PRODUCT_REPAIR_REPORT_IDENTITY_MALFORMED");
      }
      assert(result.row_count === result.rows.length,
        "RUNTIME_PRODUCT_REPAIR_REPORT_IDENTITY_COUNT_MALFORMED");
      return result.row_count;
    });
}

function createOperationsSessionContext(
  manager: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  fixture: Fixture,
): DurableProductRouteSessionContextPort {
  const postgres = Object.freeze({}) as DurableProductRouteSessionContextPort["postgres"];
  return Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres,
    transaction: async <T>(
      transactionInput: Parameters<DurableProductRouteSessionContextPort["transaction"]>[0],
      operation: Parameters<DurableProductRouteSessionContextPort["transaction"]>[1],
    ): Promise<T> => {
      assert(transactionInput.audience === "operations"
        && transactionInput.actor.actor_id === fixture.actor.actor_id
        && transactionInput.case_id === fixture.cases.a,
      "RUNTIME_PRODUCT_REPAIR_ADAPTER_SCOPE_INVALID");
      return withVerifiedRuntime(manager, buildIdentitySha, fixture, "operations", fixture.sessions.a,
        fixture.tenants.a, fixture.subjects.a, "adapter", async (context) => operation(
          Object.freeze({ context }) as Parameters<typeof operation>[0],
        ) as Promise<T>);
    },
  });
}

async function withVerifiedRuntime<T>(
  manager: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  fixture: Fixture,
  runtimeRole: "operations" | "web",
  session: Fixture["sessions"][keyof Fixture["sessions"]],
  expectedTenant: string,
  expectedSubject: string,
  correlationSuffix: string,
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (context) => {
    await context.client.query(statement(
      "repair_v0102_runtime_build",
      "select pg_catalog.set_config('tivdoc.engine_git_sha',$1,true)",
      [buildIdentitySha],
    ));
    const installed = await context.client.query(statement(
      "repair_v0102_runtime_context",
      `select tenant_id, actor_id, runtime_role, reviewer_organization_id,
              session_rotation_counter::text as session_rotation_counter
         from private.runtime_context_install($1,$2,$3)`,
      [session.sid, session.jti, `repair:${fixture.suffix}:${runtimeRole}:${correlationSuffix}`],
    ));
    const row = installed.rows[0];
    assert(installed.row_count === 1 && installed.rows.length === 1
      && row?.tenant_id === expectedTenant && row.actor_id === expectedSubject
      && row.runtime_role === runtimeRole && row.session_rotation_counter === "0",
    "RUNTIME_PRODUCT_REPAIR_VERIFIED_CONTEXT_INVALID");
    return operation(context);
  });
}

async function requireMigration009(manager: CanonicalPostgresTransactionManager): Promise<void> {
  await manager.transaction(async (context) => {
    const result = await context.client.query(statement(
      "repair_v0102_migration_preflight",
      `select migration_id,
              pg_catalog.has_function_privilege(
                'tivdoc_operations_runtime',
                'private.resolve_engine_case_id(text,text)',
                'EXECUTE'
              ) as operations_can_resolve
         from public.engine_schema_metadata
        where component = 'governance_owner_schema_usage_repair'`,
      [],
    ));
    assert(result.row_count === 1
      && result.rows[0]?.migration_id === "202609010009_governance_owner_schema_usage_repair"
      && result.rows[0].operations_can_resolve === true,
    "RUNTIME_PRODUCT_REPAIR_MIGRATION_009_REQUIRED");
  });
}

async function seed(
  manager: CanonicalPostgresTransactionManager,
  fixture: Fixture,
  buildIdentitySha: string,
): Promise<void> {
  await manager.transaction(async (context) => {
    await context.client.query(statement("repair_v0102_seed_cases", `
      insert into public.cases(id, public_id, first_name, email, phone) values
        ($1::uuid,$4,'Synthetic','repair-a@example.invalid','+00000000001'),
        ($2::uuid,$5,'Synthetic','repair-b@example.invalid','+00000000002'),
        ($3::uuid,$6,'Synthetic','repair-c@example.invalid','+00000000003')`, [
      fixture.internal_cases.a, fixture.internal_cases.b, fixture.internal_cases.c,
      `TV-RA${fixture.suffix.slice(0, 8)}`, `TV-RB${fixture.suffix.slice(0, 8)}`,
      `TV-RC${fixture.suffix.slice(0, 8)}`,
    ]));
    await context.client.query(statement("repair_v0102_seed_identities", `
      insert into public.engine_case_identity(internal_case_id,tenant_id,canonical_case_id) values
        ($1::uuid,$4,$6),($2::uuid,$4,$7),($3::uuid,$5,$8)`, [
      fixture.internal_cases.a, fixture.internal_cases.b, fixture.internal_cases.c,
      fixture.tenants.a, fixture.tenants.c, fixture.cases.a, fixture.cases.b, fixture.cases.c,
    ]));
    await context.client.query(statement("repair_v0102_seed_states", `
      insert into public.engine_case_state(
        case_id,tenant_id,canonical_case_id,revision,lifecycle_state,state_sha256,updated_at
      ) values
        ($1::uuid,$4,$6,1,'awaiting_report_approval',$9,$12::timestamptz),
        ($2::uuid,$4,$7,1,'awaiting_documents',$10,$12::timestamptz),
        ($3::uuid,$5,$8,1,'awaiting_documents',$11,$12::timestamptz)`, [
      fixture.internal_cases.a, fixture.internal_cases.b, fixture.internal_cases.c,
      fixture.tenants.a, fixture.tenants.c, fixture.cases.a, fixture.cases.b, fixture.cases.c,
      fixture.hashes.initial_state, canonicalSha256({ fixture: fixture.suffix, state: "b" }),
      canonicalSha256({ fixture: fixture.suffix, state: "c" }), fixture.timestamps.seeded_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_lifecycle", `
      insert into public.engine_case_lifecycle_revisions(
        case_id,tenant_id,revision,state_before,state_after,event_kind,
        command_sha256,event_sha256,previous_sha256,occurred_at
      ) values ($1::uuid,$2,1,null,'awaiting_report_approval','synthetic.seed',$3,$4,null,$5::timestamptz)`, [
      fixture.internal_cases.a, fixture.tenants.a,
      canonicalSha256({ fixture: fixture.suffix, command: "initial-lifecycle" }),
      fixture.hashes.initial_lifecycle, fixture.timestamps.seeded_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_sessions", `
      insert into public.product_identity_sessions(
        tenant_id,sid,subject,current_jti,rotation_counter,valid_after,expires_at,
        revoked_at,reviewer_org_id,session_sha256,created_at
      ) values
        ($1,$3,$6,$9,0,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 hour',null,$12,$13,pg_catalog.clock_timestamp()-interval '1 minute'),
        ($1,$4,$7,$10,0,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 hour',null,$12,$14,pg_catalog.clock_timestamp()-interval '1 minute'),
        ($2,$5,$8,$11,0,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 hour',null,$12,$15,pg_catalog.clock_timestamp()-interval '1 minute')`, [
      fixture.tenants.a, fixture.tenants.c,
      fixture.sessions.a.sid, fixture.sessions.b.sid, fixture.sessions.c.sid,
      fixture.subjects.a, fixture.subjects.b, fixture.subjects.c,
      fixture.sessions.a.jti, fixture.sessions.b.jti, fixture.sessions.c.jti,
      fixture.reviewer_org,
      canonicalSha256({ fixture: fixture.suffix, session: "a" }),
      canonicalSha256({ fixture: fixture.suffix, session: "b" }),
      canonicalSha256({ fixture: fixture.suffix, session: "c" }),
    ]));
    await context.client.query(statement("repair_v0102_seed_owners", `
      insert into public.product_case_owners(
        tenant_id,canonical_case_id,subject,revision,status,binding_sha256,created_at,revoked_at
      ) values
        ($1,$3,$6,1,'active',$9,$12::timestamptz,null),
        ($1,$4,$7,1,'active',$10,$12::timestamptz,null),
        ($2,$5,$8,1,'active',$11,$12::timestamptz,null)`, [
      fixture.tenants.a, fixture.tenants.c, fixture.cases.a, fixture.cases.b, fixture.cases.c,
      fixture.subjects.a, fixture.subjects.b, fixture.subjects.c,
      fixture.hashes.owner_a, fixture.hashes.owner_b, fixture.hashes.owner_c, fixture.timestamps.seeded_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_analysis", `
      insert into public.analysis_runs(
        id,case_id,parent_run_id,run_type,status,trigger_reason,engine_version,engine_git_sha,
        contract_version,ontology_version,rule_set_hash,input_snapshot,input_snapshot_hash,
        idempotency_key,started_at,completed_at,created_at,error_code,error_stage,
        tenant_id,canonical_case_id,canonical_analysis_run_id,command_sha256,command_payload,
        case_revision,completion_payload
      ) values (
        $1::uuid,$2::uuid,null,'full_investigation','completed','synthetic.runtime_repair',
        'synthetic-v0.10.2',$3,'synthetic-contract','synthetic-ontology',$4,
        $5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz,$10::timestamptz,null,null,
        $11,$12,$13,$14,$15::jsonb,1,$16::jsonb
      )`, [
      fixture.analysis_run_uuid, fixture.internal_cases.a, buildIdentitySha,
      canonicalSha256({ fixture: fixture.suffix, rules: "synthetic-inactive" }),
      JSON.stringify({ schema_version: "synthetic-runtime-product-repair-v1" }),
      canonicalSha256({ fixture: fixture.suffix, input: "snapshot" }),
      `analysis:repair:${fixture.suffix}`, fixture.timestamps.analysis_started_at,
      fixture.timestamps.analysis_completed_at, fixture.timestamps.seeded_at,
      fixture.tenants.a, fixture.cases.a, fixture.analysis_run_id,
      canonicalSha256({ fixture: fixture.suffix, command: "analysis" }),
      JSON.stringify({ schema_version: "synthetic-runtime-product-repair-v1" }),
      JSON.stringify({ bundle: { rule_inputs: [] }, dependencies: {} }),
    ]));
    await context.client.query(statement("repair_v0102_seed_report", `
      insert into public.engine_report_versions(
        report_id,revision,tenant_id,case_id,analysis_run_id,analysis_result_sha256,
        report_sha256,manifest_sha256,object_version_id,visible,created_at,
        json_sha256,html_sha256,pdf_sha256,artifacts_payload,review_eligible,
        canonical_case_id,canonical_analysis_run_id
      ) values ($1,1,$2,$3::uuid,$4::uuid,$5,$6,$7,null,false,$8::timestamptz,
                $9,$10,$11,$12::jsonb,true,$13,$14)`, [
      fixture.report_id, fixture.tenants.a, fixture.internal_cases.a, fixture.analysis_run_uuid,
      fixture.hashes.analysis_result, fixture.hashes.report, fixture.hashes.manifest,
      fixture.timestamps.report_created_at, fixture.hashes.json, fixture.hashes.html,
      fixture.hashes.pdf, JSON.stringify({ schema_version: "synthetic-report-artifacts-v1" }),
      fixture.cases.a, fixture.analysis_run_id,
    ]));
    await context.client.query(statement("repair_v0102_seed_approval", `
      insert into public.engine_review_task_versions(
        task_id,revision,tenant_id,case_id,task_kind,input_sha256,output_sha256,
        task_sha256,decision_payload,decision_sha256,invalidated_at,created_at,
        report_id,report_revision,report_sha256,release_state,canonical_case_id
      ) values ($1,1,$2,$3::uuid,'report_approval',$4,$5,$6,$7::jsonb,$8,null,
                $9::timestamptz,$10,1,$11,'approved',$12)`, [
      fixture.review_task_id, fixture.tenants.a, fixture.internal_cases.a,
      fixture.hashes.approval_input, fixture.hashes.approval_output, fixture.hashes.approval_task,
      JSON.stringify({ decision: "approved", evidence: "synthetic-only" }),
      fixture.hashes.approval_decision, fixture.timestamps.report_created_at,
      fixture.report_id, fixture.hashes.report, fixture.cases.a,
    ]));
    await context.client.query(statement("repair_v0102_seed_report_object", `
      insert into public.product_private_report_objects(
        tenant_id,canonical_case_id,report_id,report_revision,report_sha256,
        object_version_id,provider_locator,byte_length,artifact_sha256,state,
        grant_epoch,revocation_receipt_sha256,revoked_at,created_at
      ) values ($1,$2,$3,1,$4,$5,$6,128,$7,'approved',1,null,null,$8::timestamptz)`, [
      fixture.tenants.a, fixture.cases.a, fixture.report_id, fixture.hashes.report,
      fixture.object_version_id, `objects/repair/${fixture.suffix}/synthetic.pdf`,
      fixture.hashes.pdf, fixture.timestamps.report_created_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_dependency_state", `
      update public.engine_global_dependency_state
         set dependency_epoch=$3,cache_epoch=$4,download_grant_epoch=$5,
             current_dependency_sha256=$6,stale_stages='{}'::text[],release_hold=false,
             dependencies_approved=true,execution_binding_sha256=$7,
             approval_binding_sha256=$8,download_binding_sha256=$9,updated_at=$10::timestamptz
       where tenant_id=$1 and canonical_case_id=$2 and case_revision=1`, [
      fixture.tenants.a, fixture.cases.a, INITIAL_EPOCHS.dependency, INITIAL_EPOCHS.cache,
      INITIAL_EPOCHS.download_grant, fixture.hashes.dependency_before,
      fixture.hashes.execution_binding, fixture.hashes.approval_binding,
      fixture.hashes.download_binding, fixture.timestamps.report_created_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_worker_job", `
      insert into public.engine_durable_jobs(
        job_id,tenant_id,canonical_case_id,job_kind,idempotency_key,payload,payload_sha256,
        pinned_version_sha256s,state,revision,attempt_count,max_attempts,available_at,
        lease_owner,lease_expires_at,fencing_token,cancellation_requested,created_at,updated_at
      ) values ($1,$2,$3,'synthetic_runtime_repair',$4,$5::jsonb,$6,'{}'::text[],
                'running',2,1,3,$7::timestamptz,$8,to_timestamp($9 / 1000.0),3,false,
                $7::timestamptz,$7::timestamptz)`, [
      fixture.worker_job_id, fixture.tenants.a, fixture.cases.a,
      `job:repair:worker:${fixture.suffix}`, JSON.stringify({ synthetic: true }),
      fixture.hashes.worker_payload, fixture.timestamps.seeded_at,
      fixture.worker_id, fixture.timestamps.lease_expires_at_ms,
    ]));
    await context.client.query(statement("repair_v0102_seed_cancel_job", `
      insert into public.engine_durable_jobs(
        job_id,tenant_id,canonical_case_id,job_kind,idempotency_key,payload,payload_sha256,
        pinned_version_sha256s,state,revision,attempt_count,max_attempts,available_at,
        fencing_token,cancellation_requested,created_at,updated_at
      ) values ($1,$2,$3,'synthetic_stale_work',$4,$5::jsonb,$6,'{}'::text[],
                'queued',1,0,3,$7::timestamptz,0,false,$7::timestamptz,$7::timestamptz)`, [
      fixture.cancellable_job_id, fixture.tenants.a, fixture.cases.a,
      `job:repair:cancel:${fixture.suffix}`, JSON.stringify({ synthetic: true }),
      fixture.hashes.cancellable_payload, fixture.timestamps.seeded_at,
    ]));
    await context.client.query(statement("repair_v0102_seed_stale_outbox", `
      insert into public.engine_outbox_events(
        outbox_id,tenant_id,canonical_case_id,logical_effect_id,effect_kind,payload,
        payload_sha256,state,fencing_token,created_at
      ) values ($1,$2,$3,$4,'synthetic_stale_effect',$5::jsonb,$6,'pending',0,$7::timestamptz)`, [
      fixture.stale_outbox_id, fixture.tenants.a, fixture.cases.a,
      `effect:repair:stale:${fixture.suffix}`, JSON.stringify({ synthetic: true }),
      fixture.hashes.stale_outbox_payload, fixture.timestamps.seeded_at,
    ]));
  });
}

async function inspectEpochs(manager: CanonicalPostgresTransactionManager, fixture: Fixture) {
  return manager.transaction(async (context) => {
    const result = await context.client.query(statement("repair_v0102_inspect_epochs", `
      select case_revision::text,dependency_epoch::text,cache_epoch::text,
             download_grant_epoch::text,current_dependency_sha256
        from public.engine_global_dependency_state
       where tenant_id=$1 and canonical_case_id=$2`, [fixture.tenants.a, fixture.cases.a]));
    assert(result.row_count === 1, "RUNTIME_PRODUCT_REPAIR_DEPENDENCY_STATE_MISSING");
    const row = result.rows[0]!;
    return Object.freeze({
      case_revision: decimal(row.case_revision),
      dependency_epoch: decimal(row.dependency_epoch),
      cache_epoch: decimal(row.cache_epoch),
      download_grant_epoch: decimal(row.download_grant_epoch),
      current_dependency_sha256: row.current_dependency_sha256,
    });
  });
}

async function inspectDurableResult(
  manager: CanonicalPostgresTransactionManager,
  fixture: Fixture,
  receipt: GlobalDependencyInvalidationReceipt,
) {
  return manager.transaction(async (context) => {
    const result = await context.client.query(statement("repair_v0102_inspect_result", `
      select
        (select count(*)::text from public.engine_report_versions
          where tenant_id=$1 and canonical_case_id=$2 and report_id=$3) as report_versions,
        (select count(*)::text from public.engine_review_task_versions
          where tenant_id=$1 and canonical_case_id=$2 and task_id=$4) as approval_versions,
        (select count(*)::text from public.engine_global_dependency_invalidations
          where tenant_id=$1 and canonical_case_id=$2) as invalidation_rows,
        (select count(*)::text from public.engine_platform_audit_events
          where tenant_id=$1 and canonical_case_id=$2 and action='GLOBAL_DEPENDENCY_INVALIDATED') as audit_rows,
        (select count(*)::text from public.engine_outbox_events
          where tenant_id=$1 and canonical_case_id=$2 and outbox_id=$5 and state='pending') as outbox_rows,
        (select count(*)::text from public.engine_idempotency_records
          where tenant_id=$1 and canonical_case_id=$2 and scope='global_dependency_invalidation'
            and state='committed') as idempotency_rows,
        (select count(*)::text from public.product_private_report_objects
          where tenant_id=$1 and canonical_case_id=$2 and state='revoked' and grant_epoch=2) as revoked_objects,
        (select count(*)::text from public.engine_durable_jobs
          where tenant_id=$1 and canonical_case_id=$2 and job_id=$6 and state='cancelled') as cancelled_jobs,
        (select count(*)::text from public.engine_outbox_events
          where tenant_id=$1 and canonical_case_id=$2 and outbox_id=$7 and state='superseded') as superseded_outbox,
        (select revision::text from public.engine_case_state
          where tenant_id=$1 and canonical_case_id=$2) as case_revision,
        (select dependency_epoch::text from public.engine_global_dependency_state
          where tenant_id=$1 and canonical_case_id=$2) as dependency_epoch,
        (select cache_epoch::text from public.engine_global_dependency_state
          where tenant_id=$1 and canonical_case_id=$2) as cache_epoch,
        (select download_grant_epoch::text from public.engine_global_dependency_state
          where tenant_id=$1 and canonical_case_id=$2) as download_grant_epoch`, [
      fixture.tenants.a, fixture.cases.a, fixture.report_id, fixture.review_task_id,
      receipt.outbox_id, fixture.cancellable_job_id, fixture.stale_outbox_id,
    ]));
    assert(result.row_count === 1, "RUNTIME_PRODUCT_REPAIR_RESULT_MISSING");
    const row = result.rows[0]!;
    const decoded = Object.freeze({
      report_versions: decimal(row.report_versions),
      approval_versions: decimal(row.approval_versions),
      invalidation_rows: decimal(row.invalidation_rows),
      audit_rows: decimal(row.audit_rows),
      outbox_rows: decimal(row.outbox_rows),
      idempotency_rows: decimal(row.idempotency_rows),
      revoked_objects: decimal(row.revoked_objects),
      cancelled_jobs: decimal(row.cancelled_jobs),
      superseded_outbox: decimal(row.superseded_outbox),
      case_revision: decimal(row.case_revision),
      dependency_epoch: decimal(row.dependency_epoch),
      cache_epoch: decimal(row.cache_epoch),
      download_grant_epoch: decimal(row.download_grant_epoch),
    });
    assert(decoded.report_versions === 1 && decoded.approval_versions === 2
      && decoded.invalidation_rows === 1 && decoded.audit_rows === 1
      && decoded.outbox_rows === 1 && decoded.idempotency_rows === 1
      && decoded.revoked_objects === 1 && decoded.cancelled_jobs === 1
      && decoded.superseded_outbox === 1 && decoded.case_revision === 3
      && decoded.dependency_epoch === 6 && decoded.cache_epoch === 8
      && decoded.download_grant_epoch === 12,
    "RUNTIME_PRODUCT_REPAIR_DURABLE_RESULT_INVALID");
    return decoded;
  });
}

async function cleanup(manager: CanonicalPostgresTransactionManager, fixture: Fixture): Promise<void> {
  await manager.transaction(async (context) => {
    await context.client.query(statement(
      "repair_v0102_cleanup_replica",
      "set local session_replication_role = replica",
      [],
    ));
    const tenantValues = [fixture.tenants.a, fixture.tenants.c] as const;
    const tenantTables = [
      "engine_global_dependency_invalidations",
      "engine_idempotency_records",
      "engine_platform_audit_events",
      "engine_job_history",
      "engine_outbox_events",
      "engine_durable_jobs",
      "product_private_report_objects",
      "engine_review_task_versions",
      "engine_report_versions",
      "analysis_runs",
      "product_case_owners",
      "product_identity_sessions",
      "engine_global_dependency_state",
      "engine_case_lifecycle_revisions",
      "engine_case_state",
      "engine_case_identity",
    ] as const;
    for (const [index, table] of tenantTables.entries()) {
      await context.client.query(statement(
        `repair_v0102_cleanup_${String(index).padStart(2, "0")}`,
        `delete from public.${table} where tenant_id in ($1,$2)`,
        tenantValues,
      ));
    }
    await context.client.query(statement(
      "repair_v0102_cleanup_cases",
      "delete from public.cases where id in ($1::uuid,$2::uuid,$3::uuid)",
      [fixture.internal_cases.a, fixture.internal_cases.b, fixture.internal_cases.c],
    ));
  });
}

function assertInvalidationReceipt(receipt: GlobalDependencyInvalidationReceipt, replay: boolean): void {
  assert(receipt.case_revision === 3
    && receipt.dependency_epoch === 6
    && receipt.cache_epoch === 8
    && receipt.download_grant_epoch === 12
    && receipt.grants_revoked === 1
    && receipt.jobs_cancelled === 1
    && receipt.outbox_events_superseded === 1
    && receipt.historical_evidence_preserved
    && receipt.historical_versions_deleted === 0
    && receipt.idempotent_replay === replay,
  "RUNTIME_PRODUCT_REPAIR_INVALIDATION_RECEIPT_INVALID");
}

function driver(connectionUrl: string, applicationName: string): NodePostgresConnectionFactory {
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: 2,
    connection_timeout_ms: 5_000,
    application_name: applicationName,
  });
}

function assertSameTarget(...drivers: readonly NodePostgresConnectionFactory[]): void {
  const target = drivers[0]?.target;
  assert(target !== undefined && drivers.length === 3
    && drivers.every((candidate) => candidate.target.target_id === target.target_id
      && candidate.target.host === target.host
      && candidate.target.port === target.port
      && candidate.target.database === target.database),
  "RUNTIME_PRODUCT_REPAIR_TARGET_MISMATCH");
}

async function closeDrivers(...drivers: readonly NodePostgresConnectionFactory[]): Promise<void> {
  let failure: unknown = null;
  for (const candidate of drivers) {
    try {
      await candidate.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

function uuid(seed: string): string {
  const value = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  value[12] = "5";
  value[16] = "8";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function decimal(value: unknown): number {
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
