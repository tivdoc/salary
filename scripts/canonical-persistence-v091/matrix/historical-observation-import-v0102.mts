import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { legalOperationsSha256 } from "../../../src/engine/legal-operations/canonical.ts";
import { statement, type PostgresTransactionContext } from "../../../src/server/platform/persistence/postgres/contracts.ts";
import { createDurableGovernanceApplication } from "../../../src/server/platform/persistence/postgres/governance/application.ts";
import {
  HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256,
  HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256,
  PostgresHistoricalObservationImportService,
  loadExactHistoricalObservationImportPlan,
  type HistoricalObservationImportPlan,
  type HistoricalObservationImportReceipt,
} from "../../../src/server/platform/persistence/postgres/governance/historical-observation-import.ts";
import { NodePostgresConnectionFactory } from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { CanonicalPostgresTransactionManager } from "../../../src/server/platform/persistence/postgres/runtime/transaction-manager.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const BUILD_IDENTITY = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const FIXTURE_SUFFIX = /^[a-z0-9]{8,24}$/u;
const EXACT_CROSSWALK_RELATIVE = path.join(
  "output",
  "parallel-wave-2",
  "review-package-v0.4",
  "worker-evidence",
  "A1",
  "wave1-artifact-crosswalk.json",
);

export const HISTORICAL_OBSERVATION_IMPORT_V0102_INVOCATION = Object.freeze({
  schema_version: "tivdoc-historical-observation-import-v0.10.2-invocation-v1" as const,
  service: "PostgresHistoricalObservationImportService.importExactPlan" as const,
  runtime_principal: "tivdoc_worker_runtime" as const,
  transaction_boundary: "CanonicalPostgresTransactionManager" as const,
  source: "exact ignored V0.4 wave1 artifact crosswalk; digest pinned in product code" as const,
  customer_documents_read: 0 as const,
  real_sources_activated: 0 as const,
  credentials_recorded: 0 as const,
});

export type HistoricalObservationImportGitIdentity = Readonly<{
  branch: string;
  head: string;
  tree: string;
}>;

export type HistoricalObservationImportBeforeRestart = Readonly<{
  schema_version: "tivdoc-historical-observation-import-before-restart-v0.10.2";
  checkpoint_sha256: string;
  tenant_id: string;
  imported_at: string;
  session: Readonly<{ sid: string; jti: string; actor_id: string }>;
  plan: HistoricalObservationImportPlan;
  concurrent_receipt_sha256s: readonly [string, string];
  concurrent_candidate_replay_counts: readonly [number, number];
  concurrent_queue_replay_counts: readonly [number, number];
  rerun_receipt_sha256: string;
  before_inspection: HistoricalObservationImportInspection;
  target_id: string;
  connection_attempts: number;
}>;

export type HistoricalObservationImportDynamicReceipt = Readonly<{
  schema_version: "tivdoc-historical-observation-import-dynamic-v0.10.2";
  proof_class: "REAL_ISOLATED_POSTGRESQL_LEAST_PRIVILEGE_RUNTIME_IMPORT";
  target_id: string;
  git: HistoricalObservationImportGitIdentity;
  source: Readonly<{
    input_file_sha256: typeof HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256;
    input_report_content_sha256: typeof HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256;
    source_set_sha256: string;
    plan_sha256: string;
    url_observation_count: 72;
    registered_overlap_count: 1;
    staged_observation_count: 71;
    acquired_byte_object_count: 71;
    staged_byte_object_count: 70;
    alias_group_count: 1;
  }>;
  runtime: Readonly<{
    principal: "tivdoc_worker_runtime";
    superuser: false;
    bypass_rls: false;
    verified_transaction_context: true;
    transaction_boundary: "CanonicalPostgresTransactionManager";
    service: "PostgresHistoricalObservationImportService.importExactPlan";
    service_role_calls: 0;
    table_owner_calls: 0;
  }>;
  durability: HistoricalObservationImportInspection & Readonly<{
    concurrent_first_imports: 2;
    concurrent_candidate_replay_counts: readonly [number, number];
    concurrent_queue_replay_counts: readonly [number, number];
    deterministic_rerun_replays: 71;
    restart_replays: 71;
    no_72nd_observation_after_concurrency_rerun_restart: true;
    before_restart_state_sha256: string;
    after_restart_state_sha256: string;
    state_preserved_across_restart: true;
    concurrent_receipt_sha256s: readonly [string, string];
    rerun_receipt_sha256: string;
    restart_receipt_sha256: string;
  }>;
  connection_attempts: number;
  credentials_recorded: 0;
  customer_documents_read: 0;
  real_sources_active: 0;
  real_parameters_active: 0;
  real_rules_active: 0;
  receipt_sha256: string;
  status: "PASS";
}>;

type HistoricalObservationImportInput = Readonly<{
  repository_root: string;
  admin_connection_url: string;
  worker_runtime_connection_url: string;
  exact_crosswalk_path: string;
  build_identity_sha: string;
  fixture_suffix: string;
}>;

type HistoricalObservationImportAfterRestartInput = HistoricalObservationImportInput & Readonly<{
  git: HistoricalObservationImportGitIdentity;
  before_restart: HistoricalObservationImportBeforeRestart;
}>;

type HistoricalObservationImportInspection = Readonly<{
  observations_imported: 71;
  distinct_observation_ids: 71;
  inactive_observation_versions: 71;
  observation_snapshots: 71;
  work_items_pending: 71;
  distinct_work_aggregate_ids: 71;
  source_lineage_rows: 71;
  unknown_metadata_rows: 71;
  staged_byte_object_count: 70;
  aliased_observation_count: 2;
  durable_audit_rows: 142;
  durable_idempotency_rows: 142;
  activated_observations: 0;
  legal_decisions: 0;
  human_decisions: 0;
  human_claims: 0;
  state_sha256: string;
}>;

type RuntimeProof = Readonly<{
  principal: "tivdoc_worker_runtime";
  superuser: false;
  bypass_rls: false;
  verified_transaction_context: true;
}>;

type Fixture = Readonly<{
  tenant_id: string;
  sid: string;
  jti: string;
  actor_id: string;
  correlation_id: string;
  imported_at: string;
  valid_after: string;
  expires_at: string;
  session_sha256: string;
}>;

export async function runHistoricalObservationImportBeforeRestart(
  input: HistoricalObservationImportInput,
): Promise<HistoricalObservationImportBeforeRestart> {
  validateInput(input);
  await assertExactIgnoredCrosswalk(input.repository_root, input.exact_crosswalk_path);
  const plan = await loadExactHistoricalObservationImportPlan(input.exact_crosswalk_path);
  assertExactPlan(plan);
  const fixture = createFixture(input.fixture_suffix);
  const adminDriver = driver(input.admin_connection_url, "tivdoc-v0102-observation-import-admin-before", 2);
  const workerDriverA = driver(input.worker_runtime_connection_url, "tivdoc-v0102-observation-import-worker-a", 1);
  const workerDriverB = driver(input.worker_runtime_connection_url, "tivdoc-v0102-observation-import-worker-b", 1);
  assertSameTarget(adminDriver, workerDriverA, workerDriverB);
  const admin = new CanonicalPostgresTransactionManager(adminDriver);
  const workerA = new CanonicalPostgresTransactionManager(workerDriverA);
  const workerB = new CanonicalPostgresTransactionManager(workerDriverB);
  try {
    await seedIdentitySession(admin, fixture);
    const [left, right] = await Promise.all([
      importInVerifiedWorkerTransaction(workerA, fixture, plan, "concurrent-a"),
      importInVerifiedWorkerTransaction(workerB, fixture, plan, "concurrent-b"),
    ]);
    assertRuntimeProof(left.runtime);
    assertRuntimeProof(right.runtime);
    assertImportReceipt(left.receipt, plan, fixture.imported_at);
    assertImportReceipt(right.receipt, plan, fixture.imported_at);
    const candidateReplayCounts = sortedPair(
      replayCount(left.receipt.candidate_receipts),
      replayCount(right.receipt.candidate_receipts),
    );
    const queueReplayCounts = sortedPair(
      replayCount(left.receipt.queue_receipts),
      replayCount(right.receipt.queue_receipts),
    );
    assert(candidateReplayCounts[0] === 0 && candidateReplayCounts[1] === 71
      && queueReplayCounts[0] === 0 && queueReplayCounts[1] === 71,
    "HISTORICAL_OBSERVATION_CONCURRENT_IDEMPOTENCY_INVALID");

    const rerun = await importInVerifiedWorkerTransaction(workerA, fixture, plan, "deterministic-rerun");
    assertRuntimeProof(rerun.runtime);
    assertImportReceipt(rerun.receipt, plan, fixture.imported_at, true);
    const inspection = await inspectDurableImport(admin, fixture.tenant_id, plan);
    const body = Object.freeze({
      schema_version: "tivdoc-historical-observation-import-before-restart-v0.10.2" as const,
      tenant_id: fixture.tenant_id,
      imported_at: fixture.imported_at,
      plan_sha256: plan.plan_sha256,
      source_set_sha256: plan.source_set_sha256,
      state_sha256: inspection.state_sha256,
      concurrent_receipt_sha256s: Object.freeze([left.receipt.receipt_sha256, right.receipt.receipt_sha256].sort()) as unknown as readonly [string, string],
      concurrent_candidate_replay_counts: candidateReplayCounts,
      concurrent_queue_replay_counts: queueReplayCounts,
      rerun_receipt_sha256: rerun.receipt.receipt_sha256,
    });
    const connectionAttempts = adminDriver.metrics().connection_attempts
      + workerDriverA.metrics().connection_attempts + workerDriverB.metrics().connection_attempts;
    return Object.freeze({
      schema_version: body.schema_version,
      checkpoint_sha256: legalOperationsSha256(body),
      tenant_id: fixture.tenant_id,
      imported_at: fixture.imported_at,
      session: Object.freeze({ sid: fixture.sid, jti: fixture.jti, actor_id: fixture.actor_id }),
      plan,
      concurrent_receipt_sha256s: body.concurrent_receipt_sha256s,
      concurrent_candidate_replay_counts: candidateReplayCounts,
      concurrent_queue_replay_counts: queueReplayCounts,
      rerun_receipt_sha256: rerun.receipt.receipt_sha256,
      before_inspection: inspection,
      target_id: adminDriver.target.target_id,
      connection_attempts: connectionAttempts,
    });
  } finally {
    await closeDrivers(adminDriver, workerDriverA, workerDriverB);
  }
}

export async function runHistoricalObservationImportAfterRestart(
  input: HistoricalObservationImportAfterRestartInput,
): Promise<HistoricalObservationImportDynamicReceipt> {
  validateInput(input);
  validateGit(input.git, input.build_identity_sha);
  await assertExactIgnoredCrosswalk(input.repository_root, input.exact_crosswalk_path);
  const plan = await loadExactHistoricalObservationImportPlan(input.exact_crosswalk_path);
  assertExactPlan(plan);
  assertCheckpoint(input.before_restart, plan);
  const fixture = Object.freeze({
    ...createFixture(input.fixture_suffix, input.before_restart.imported_at),
    tenant_id: input.before_restart.tenant_id,
    sid: input.before_restart.session.sid,
    jti: input.before_restart.session.jti,
    actor_id: input.before_restart.session.actor_id,
  });
  const adminDriver = driver(input.admin_connection_url, "tivdoc-v0102-observation-import-admin-after", 1);
  const workerDriver = driver(input.worker_runtime_connection_url, "tivdoc-v0102-observation-import-worker-after", 1);
  assertSameTarget(adminDriver, workerDriver);
  assert(adminDriver.target.target_id === input.before_restart.target_id,
    "HISTORICAL_OBSERVATION_RESTART_TARGET_MISMATCH");
  const admin = new CanonicalPostgresTransactionManager(adminDriver);
  const worker = new CanonicalPostgresTransactionManager(workerDriver);
  try {
    const restart = await importInVerifiedWorkerTransaction(worker, fixture, plan, "restart-replay");
    assertRuntimeProof(restart.runtime);
    assertImportReceipt(restart.receipt, plan, fixture.imported_at, true);
    const after = await inspectDurableImport(admin, fixture.tenant_id, plan);
    assert(after.state_sha256 === input.before_restart.before_inspection.state_sha256,
      "HISTORICAL_OBSERVATION_RESTART_STATE_CHANGED");
    const connectionAttempts = input.before_restart.connection_attempts
      + adminDriver.metrics().connection_attempts + workerDriver.metrics().connection_attempts;
    const receiptBody = Object.freeze({
      schema_version: "tivdoc-historical-observation-import-dynamic-v0.10.2" as const,
      proof_class: "REAL_ISOLATED_POSTGRESQL_LEAST_PRIVILEGE_RUNTIME_IMPORT" as const,
      target_id: adminDriver.target.target_id,
      git: Object.freeze({ ...input.git }),
      source: Object.freeze({
        input_file_sha256: HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256,
        input_report_content_sha256: HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256,
        source_set_sha256: plan.source_set_sha256,
        plan_sha256: plan.plan_sha256,
        url_observation_count: 72 as const,
        registered_overlap_count: 1 as const,
        staged_observation_count: 71 as const,
        acquired_byte_object_count: 71 as const,
        staged_byte_object_count: 70 as const,
        alias_group_count: 1 as const,
      }),
      runtime: Object.freeze({
        principal: "tivdoc_worker_runtime" as const,
        superuser: false as const,
        bypass_rls: false as const,
        verified_transaction_context: true as const,
        transaction_boundary: "CanonicalPostgresTransactionManager" as const,
        service: "PostgresHistoricalObservationImportService.importExactPlan" as const,
        service_role_calls: 0 as const,
        table_owner_calls: 0 as const,
      }),
      durability: Object.freeze({
        ...after,
        concurrent_first_imports: 2 as const,
        concurrent_candidate_replay_counts: input.before_restart.concurrent_candidate_replay_counts,
        concurrent_queue_replay_counts: input.before_restart.concurrent_queue_replay_counts,
        deterministic_rerun_replays: 71 as const,
        restart_replays: 71 as const,
        no_72nd_observation_after_concurrency_rerun_restart: true as const,
        before_restart_state_sha256: input.before_restart.before_inspection.state_sha256,
        after_restart_state_sha256: after.state_sha256,
        state_preserved_across_restart: true as const,
        concurrent_receipt_sha256s: input.before_restart.concurrent_receipt_sha256s,
        rerun_receipt_sha256: input.before_restart.rerun_receipt_sha256,
        restart_receipt_sha256: restart.receipt.receipt_sha256,
      }),
      connection_attempts: connectionAttempts,
      credentials_recorded: 0 as const,
      customer_documents_read: 0 as const,
      real_sources_active: 0 as const,
      real_parameters_active: 0 as const,
      real_rules_active: 0 as const,
      status: "PASS" as const,
    });
    return Object.freeze({ ...receiptBody, receipt_sha256: legalOperationsSha256(receiptBody) });
  } finally {
    await closeDrivers(adminDriver, workerDriver);
  }
}

export function createHistoricalObservationImportFixture(
  suffix: string,
  importedAtInput?: string,
): Fixture {
  return createFixture(suffix, importedAtInput);
}

async function importInVerifiedWorkerTransaction(
  manager: CanonicalPostgresTransactionManager,
  fixture: Fixture,
  plan: HistoricalObservationImportPlan,
  phase: string,
): Promise<Readonly<{ receipt: HistoricalObservationImportReceipt; runtime: RuntimeProof }>> {
  return manager.transaction(async (context) => {
    const runtime = await installAndVerifyRuntimeContext(context, fixture, phase);
    const application = createDurableGovernanceApplication(context, fixture.tenant_id);
    assert(application.historical_observations instanceof PostgresHistoricalObservationImportService,
      "HISTORICAL_OBSERVATION_SERVICE_INSTANCE_INVALID");
    const receipt = await application.historical_observations.importExactPlan(plan, fixture.imported_at);
    return Object.freeze({ receipt, runtime });
  });
}

async function installAndVerifyRuntimeContext(
  context: PostgresTransactionContext,
  fixture: Fixture,
  phase: string,
): Promise<RuntimeProof> {
  const installed = await context.client.query(statement(
    "historical_observation_runtime_context_install",
    `select tenant_id,actor_id,runtime_role
       from private.runtime_context_install($1::text,$2::text,$3::text)`,
    [fixture.sid, fixture.jti, `${fixture.correlation_id}:${phase}`],
  ));
  assert(installed.row_count === 1 && installed.rows[0]?.tenant_id === fixture.tenant_id
    && installed.rows[0]?.actor_id === fixture.actor_id
    && installed.rows[0]?.runtime_role === "worker",
  "HISTORICAL_OBSERVATION_RUNTIME_CONTEXT_INVALID");
  const attributes = await context.client.query(statement(
    "historical_observation_runtime_attributes",
    `select session_user as principal,role.rolsuper as superuser,role.rolbypassrls as bypass_rls,
            private.runtime_verified_tenant() as verified_tenant
       from pg_catalog.pg_roles role where role.rolname=session_user`,
    [],
  ));
  const row = attributes.rows[0];
  assert(attributes.row_count === 1 && row?.principal === "tivdoc_worker_runtime"
    && row.superuser === false && row.bypass_rls === false
    && row.verified_tenant === fixture.tenant_id,
  "HISTORICAL_OBSERVATION_RUNTIME_PRINCIPAL_INVALID");
  return Object.freeze({
    principal: "tivdoc_worker_runtime" as const,
    superuser: false as const,
    bypass_rls: false as const,
    verified_transaction_context: true as const,
  });
}

async function seedIdentitySession(
  manager: CanonicalPostgresTransactionManager,
  fixture: Fixture,
): Promise<void> {
  await manager.transaction(async (context) => {
    const result = await context.client.query(statement(
      "historical_observation_seed_identity_session",
      `insert into public.product_identity_sessions(
         tenant_id,sid,subject,current_jti,rotation_counter,valid_after,expires_at,
         revoked_at,reviewer_org_id,session_sha256,created_at
       ) values ($1,$2,$3,$4,0,$5::timestamptz,$6::timestamptz,null,null,$7,$5::timestamptz)
       returning sid`,
      [fixture.tenant_id, fixture.sid, fixture.actor_id, fixture.jti,
        fixture.valid_after, fixture.expires_at, fixture.session_sha256],
    ));
    assert(result.row_count === 1 && result.rows[0]?.sid === fixture.sid,
      "HISTORICAL_OBSERVATION_IDENTITY_SEED_FAILED");
  });
}

async function inspectDurableImport(
  manager: CanonicalPostgresTransactionManager,
  tenantId: string,
  plan: HistoricalObservationImportPlan,
): Promise<HistoricalObservationImportInspection> {
  return manager.transaction(async (context) => {
    const result = await context.client.query(statement(
      "historical_observation_import_inspection",
      `select
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1) as observations_imported,
        (select count(distinct v.observation_id)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1) as distinct_observation_ids,
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1 and v.state='reconciliation_candidate_inactive'
            and not v.activation_allowed and v.revision=1) as inactive_observation_versions,
        (select count(*)::text from private.governance_aggregate_snapshots s
          where s.tenant_id=$1 and s.mutation_scope='legal_observation_import'
            and s.state='reconciliation_candidate_inactive' and not s.activation_allowed) as observation_snapshots,
        (select count(*)::text from private.governance_work_items w
          where w.tenant_id=$1 and w.workflow_kind='legal_reconciliation'
            and w.work_kind='legal_observation_reconciliation' and w.state='pending'
            and w.claimant_id is null and w.lease_expires_at is null) as work_items_pending,
        (select count(distinct w.aggregate_id)::text from private.governance_work_items w
          where w.tenant_id=$1 and w.workflow_kind='legal_reconciliation') as distinct_work_aggregate_ids,
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1
            and v.candidate_json->'provenance'->>'historical_crosswalk_file_sha256'=$2
            and v.candidate_json->'provenance'->>'historical_crosswalk_report_content_sha256'=$3) as source_lineage_rows,
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1 and v.candidate_json->>'legal_effect'='unreviewed'
            and v.candidate_json->'knowledge_time'='null'::jsonb
            and v.candidate_json->'candidate_valid_from'='null'::jsonb
            and v.candidate_json->'candidate_valid_to'='null'::jsonb
            and v.candidate_json->'topic'='null'::jsonb) as unknown_metadata_rows,
        (select count(distinct v.candidate_json->>'byte_object_id')::text
          from private.governance_legal_observation_versions v where v.tenant_id=$1) as staged_byte_object_count,
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1 and pg_catalog.jsonb_array_length(v.candidate_json->'alias_refs')=1) as aliased_observation_count,
        (select count(*)::text from private.governance_audit_events a
          where a.tenant_id=$1 and a.workflow_kind='legal_reconciliation'
            and a.event_kind in ('legal_observation_imported','work_enqueued')) as durable_audit_rows,
        (select count(*)::text from private.governance_idempotency i
          where i.tenant_id=$1 and i.scope in ('legal_observation_import','work_enqueue')) as durable_idempotency_rows,
        (select count(*)::text from private.governance_legal_observation_versions v
          where v.tenant_id=$1 and v.activation_allowed) as activated_observations,
        (select count(*)::text from private.governance_legal_observation_decisions d
          where d.tenant_id=$1) as legal_decisions,
        (select count(*)::text from private.governance_human_decisions h
          where h.tenant_id=$1) as human_decisions,
        (select count(*)::text from private.governance_work_items w
          where w.tenant_id=$1 and (w.state<>'pending' or w.claimant_id is not null)) as human_claims`,
      [tenantId, HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256,
        HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256],
    ));
    assert(result.row_count === 1, "HISTORICAL_OBSERVATION_INSPECTION_MISSING");
    const row = result.rows[0]!;
    const counts = Object.freeze({
      observations_imported: decimal(row.observations_imported),
      distinct_observation_ids: decimal(row.distinct_observation_ids),
      inactive_observation_versions: decimal(row.inactive_observation_versions),
      observation_snapshots: decimal(row.observation_snapshots),
      work_items_pending: decimal(row.work_items_pending),
      distinct_work_aggregate_ids: decimal(row.distinct_work_aggregate_ids),
      source_lineage_rows: decimal(row.source_lineage_rows),
      unknown_metadata_rows: decimal(row.unknown_metadata_rows),
      staged_byte_object_count: decimal(row.staged_byte_object_count),
      aliased_observation_count: decimal(row.aliased_observation_count),
      durable_audit_rows: decimal(row.durable_audit_rows),
      durable_idempotency_rows: decimal(row.durable_idempotency_rows),
      activated_observations: decimal(row.activated_observations),
      legal_decisions: decimal(row.legal_decisions),
      human_decisions: decimal(row.human_decisions),
      human_claims: decimal(row.human_claims),
    });
    assert(counts.observations_imported === 71 && counts.distinct_observation_ids === 71
      && counts.inactive_observation_versions === 71 && counts.observation_snapshots === 71
      && counts.work_items_pending === 71 && counts.distinct_work_aggregate_ids === 71
      && counts.source_lineage_rows === 71 && counts.unknown_metadata_rows === 71
      && counts.staged_byte_object_count === 70 && counts.aliased_observation_count === 2
      && counts.durable_audit_rows === 142 && counts.durable_idempotency_rows === 142
      && counts.activated_observations === 0 && counts.legal_decisions === 0
      && counts.human_decisions === 0 && counts.human_claims === 0,
    "HISTORICAL_OBSERVATION_DURABLE_COUNTS_INVALID");
    const stateBody = Object.freeze({
      ...counts,
      input_file_sha256: plan.input_file_sha256,
      input_report_content_sha256: plan.input_report_content_sha256,
      source_set_sha256: plan.source_set_sha256,
      plan_sha256: plan.plan_sha256,
    });
    return Object.freeze({
      ...counts,
      state_sha256: legalOperationsSha256(stateBody),
    }) as HistoricalObservationImportInspection;
  });
}

function createFixture(suffix: string, importedAtInput?: string): Fixture {
  assert(FIXTURE_SUFFIX.test(suffix), "HISTORICAL_OBSERVATION_FIXTURE_SUFFIX_INVALID");
  const importedAt = importedAtInput ?? new Date().toISOString();
  const importedMs = Date.parse(importedAt);
  assert(Number.isFinite(importedMs), "HISTORICAL_OBSERVATION_IMPORTED_AT_INVALID");
  const seed = (label: string): string => createHash("sha256")
    .update(`tivdoc:v0102:historical-observation:${suffix}:${label}`)
    .digest("hex");
  const tenantId = `tenant:historical-observation:${suffix}`;
  const sid = `sid:historical-observation:${seed("sid").slice(0, 24)}`;
  const jti = `jti:historical-observation:${seed("jti").slice(0, 24)}`;
  const actorId = `worker:historical-observation:${seed("actor").slice(0, 24)}`;
  const validAfter = new Date(importedMs - 5 * 60_000).toISOString();
  const expiresAt = new Date(importedMs + 24 * 60 * 60_000).toISOString();
  return Object.freeze({
    tenant_id: tenantId,
    sid,
    jti,
    actor_id: actorId,
    correlation_id: `corr:historical-observation:${suffix}`,
    imported_at: importedAt,
    valid_after: validAfter,
    expires_at: expiresAt,
    session_sha256: legalOperationsSha256({ tenant_id: tenantId, sid, jti, actor_id: actorId,
      valid_after: validAfter, expires_at: expiresAt }),
  });
}

async function assertExactIgnoredCrosswalk(repositoryRoot: string, crosswalkPath: string): Promise<void> {
  const root = path.resolve(repositoryRoot);
  const expected = path.resolve(root, EXACT_CROSSWALK_RELATIVE);
  const supplied = path.resolve(crosswalkPath);
  assert(supplied === expected, "HISTORICAL_OBSERVATION_CROSSWALK_PATH_INVALID");
  const metadata = await lstat(supplied);
  assert(metadata.isFile() && !metadata.isSymbolicLink()
    && path.resolve(await realpath(supplied)) === supplied,
  "HISTORICAL_OBSERVATION_CROSSWALK_FILE_UNSAFE");
}

function assertExactPlan(plan: HistoricalObservationImportPlan): void {
  assert(plan.input_file_sha256 === HISTORICAL_OBSERVATION_CROSSWALK_FILE_SHA256
    && plan.input_report_content_sha256 === HISTORICAL_OBSERVATION_CROSSWALK_CONTENT_SHA256
    && SHA256.test(plan.source_set_sha256) && SHA256.test(plan.plan_sha256)
    && plan.url_observation_count === 72 && plan.registered_overlap_count === 1
    && plan.staged_observation_count === 71 && plan.candidates.length === 71
    && plan.acquired_byte_object_count === 71 && plan.staged_byte_object_count === 70
    && plan.alias_group_count === 1 && plan.registered_overlap_observation_ids.length === 1,
  "HISTORICAL_OBSERVATION_EXACT_PLAN_INVALID");
}

function assertImportReceipt(
  receipt: HistoricalObservationImportReceipt,
  plan: HistoricalObservationImportPlan,
  importedAt: string,
  allReplay = false,
): void {
  const { receipt_sha256: omitted, ...body } = receipt;
  void omitted;
  assert(receipt.schema_version === "tivdoc-historical-observation-import-receipt-v0.10.2"
    && receipt.input_report_content_sha256 === plan.input_report_content_sha256
    && receipt.source_set_sha256 === plan.source_set_sha256
    && receipt.plan_sha256 === plan.plan_sha256 && receipt.imported_at === importedAt
    && receipt.observations_imported === 71 && receipt.work_items_pending === 71
    && receipt.activation_allowed === false && receipt.candidate_receipts.length === 71
    && receipt.queue_receipts.length === 71 && receipt.receipt_sha256 === legalOperationsSha256(body)
    && receipt.candidate_receipts.every((entry) => entry.state === "reconciliation_candidate_inactive"
      && entry.activation_allowed === false)
    && receipt.queue_receipts.every((entry) => entry.state === "pending"
      && entry.activation_allowed === false)
    && (!allReplay || (replayCount(receipt.candidate_receipts) === 71
      && replayCount(receipt.queue_receipts) === 71)),
  "HISTORICAL_OBSERVATION_IMPORT_RECEIPT_INVALID");
}

function assertCheckpoint(
  checkpoint: HistoricalObservationImportBeforeRestart,
  plan: HistoricalObservationImportPlan,
): void {
  const body = Object.freeze({
    schema_version: checkpoint.schema_version,
    tenant_id: checkpoint.tenant_id,
    imported_at: checkpoint.imported_at,
    plan_sha256: checkpoint.plan.plan_sha256,
    source_set_sha256: checkpoint.plan.source_set_sha256,
    state_sha256: checkpoint.before_inspection.state_sha256,
    concurrent_receipt_sha256s: checkpoint.concurrent_receipt_sha256s,
    concurrent_candidate_replay_counts: checkpoint.concurrent_candidate_replay_counts,
    concurrent_queue_replay_counts: checkpoint.concurrent_queue_replay_counts,
    rerun_receipt_sha256: checkpoint.rerun_receipt_sha256,
  });
  assert(checkpoint.schema_version === "tivdoc-historical-observation-import-before-restart-v0.10.2"
    && checkpoint.plan.plan_sha256 === plan.plan_sha256
    && checkpoint.plan.source_set_sha256 === plan.source_set_sha256
    && checkpoint.checkpoint_sha256 === legalOperationsSha256(body)
    && checkpoint.before_inspection.observations_imported === 71,
  "HISTORICAL_OBSERVATION_CHECKPOINT_INVALID");
}

function validateInput(input: HistoricalObservationImportInput): void {
  assert(typeof input.repository_root === "string" && path.isAbsolute(path.resolve(input.repository_root))
    && typeof input.admin_connection_url === "string" && input.admin_connection_url.length > 0
    && typeof input.worker_runtime_connection_url === "string" && input.worker_runtime_connection_url.length > 0
    && BUILD_IDENTITY.test(input.build_identity_sha) && FIXTURE_SUFFIX.test(input.fixture_suffix),
  "HISTORICAL_OBSERVATION_IMPORT_INPUT_INVALID");
}

function validateGit(git: HistoricalObservationImportGitIdentity, head: string): void {
  assert(git.branch === "codex/tivdoc-engine-foundation" && git.head === head
    && BUILD_IDENTITY.test(git.head) && /^[a-f0-9]{40}$/u.test(git.tree),
  "HISTORICAL_OBSERVATION_GIT_IDENTITY_INVALID");
}

function assertRuntimeProof(proof: RuntimeProof): void {
  assert(proof.principal === "tivdoc_worker_runtime" && proof.superuser === false
    && proof.bypass_rls === false && proof.verified_transaction_context === true,
  "HISTORICAL_OBSERVATION_RUNTIME_PROOF_INVALID");
}

function replayCount(receipts: HistoricalObservationImportReceipt["candidate_receipts"]): number {
  return receipts.filter((entry) => entry.idempotent_replay).length;
}

function sortedPair(left: number, right: number): readonly [number, number] {
  return Object.freeze([left, right].sort((a, b) => a - b)) as unknown as readonly [number, number];
}

function decimal(value: unknown): number {
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
}

function driver(connectionUrl: string, applicationName: string, maxConnections: number): NodePostgresConnectionFactory {
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: maxConnections,
    connection_timeout_ms: 10_000,
    application_name: applicationName,
  });
}

function assertSameTarget(...drivers: readonly NodePostgresConnectionFactory[]): void {
  const first = drivers[0]?.target;
  assert(first !== undefined && drivers.every((candidate) => candidate.target.target_id === first.target_id
    && candidate.target.host === first.host && candidate.target.port === first.port
    && candidate.target.database === first.database),
  "HISTORICAL_OBSERVATION_TARGET_MISMATCH");
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

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
