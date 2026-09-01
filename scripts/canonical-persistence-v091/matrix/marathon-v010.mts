import { createHash } from "node:crypto";

import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import {
  controlledImportCanonicalJson,
  ControlledImportLedgerError,
  controlledImportSha256,
  createControlledImportCommand,
  type ControlledImportCommand,
  type ControlledImportLease,
  type ExactByteReopenSource,
} from "../../../src/server/engine/legal-knowledge/controlled-import-ledger/contracts.ts";
import { PostgresControlledImportLedgerRepository } from "../../../src/server/engine/legal-knowledge/controlled-import-ledger/postgres-repository.ts";
import {
  CONTROLLED_IMPORT_SQL,
  controlledImportStatement,
} from "../../../src/server/engine/legal-knowledge/controlled-import-ledger/sql.ts";
import {
  DurableApprovedReportObjectReader,
  DurableBoundaryError,
  PostgresCaseOwnerRepository,
  PostgresIdentitySessionRepository,
  PostgresPrivacyRequestRepository,
  PostgresPrivateReportObjectRepository,
} from "../../../src/server/product/durable-postgres/boundary-repositories.ts";
import { durableBoundaryStatements } from "../../../src/server/product/durable-postgres/boundary-sql.ts";
import {
  CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
  CanonicalReportIdentityError,
  canonicalReportDependencySha256,
  canonicalReportModelSha256,
  canonicalReportStorageObjectId,
  canonicalReportStorageObjectVersionId,
  createCanonicalReportIdentity,
  withCanonicalReportGrantRevision,
  type CanonicalReportIdentity,
} from "../../../src/server/product/durable-postgres/report-identity.ts";
import { statement, type PostgresStatement, type PostgresTransactionContext } from "../../../src/server/platform/persistence/postgres/contracts.ts";
import { CanonicalPostgresError } from "../../../src/server/platform/persistence/postgres/runtime/errors.ts";
import {
  NodePostgresConnectionFactory,
} from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  CanonicalPostgresTransactionManager,
  type PostgresConnectionFactory,
} from "../../../src/server/platform/persistence/postgres/runtime/transaction-manager.ts";
import type {
  PrivateBlobInventoryEntry,
  PrivateBlobProvider,
} from "../../../src/server/platform/storage/private-storage-provider.ts";
import {
  replayCanonicalCapabilityMatrix,
  runCanonicalCapabilityMatrix,
  type CapabilityMatrixReceipt,
  type DurableCapabilityState,
} from "./capabilities.mts";
import { createSyntheticCapabilityFixtures } from "./synthetic-fixtures.mts";

const HASH = /^[a-f0-9]{64}$/u;
const BUILD_IDENTITY = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const FIXTURE_SUFFIX = /^[a-z0-9]{8,24}$/u;

const MAINTENANCE_CONTEXT = statement(
  "marathon_v010_maintenance_context",
  `select set_config('tivdoc.engine_git_sha', $1, true),
          set_config('tivdoc.tenant_id', $2, true),
          set_config('tivdoc.runtime_role', $3, true)`,
  ["0".repeat(40), "tenant:placeholder", "service_role"],
);

const RUNTIME_BUILD_CONTEXT = statement(
  "marathon_v010_runtime_build_context",
  "select pg_catalog.set_config('tivdoc.engine_git_sha', $1, true)",
  ["0".repeat(40)],
);

const VERIFIED_RUNTIME_CONTEXT = statement(
  "marathon_v010_verified_runtime_context",
  `select tenant_id, actor_id, runtime_role, reviewer_organization_id,
          session_rotation_counter::text as session_rotation_counter
     from private.runtime_context_install($1, $2, $3)`,
  ["session:placeholder", "token:placeholder", "correlation:placeholder"],
);

export const MARATHON_V010_RUNTIME_BOUNDARY = Object.freeze({
  schema_version: "tivdoc-marathon-v0102-runtime-boundary-v1" as const,
  identity_session_verification: "tivdoc_identity_runtime" as const,
  operations_mutations: "tivdoc_operations_runtime" as const,
  report_binding: "tivdoc_worker_runtime" as const,
  owner_portal_read: "tivdoc_web_runtime" as const,
  identity_lifecycle_maintenance: "service_role" as const,
  verified_context_function: "private.runtime_context_install" as const,
  runtime_product_boundary_service_role_calls: 0 as const,
  runtime_roles_verified: 4 as const,
});

type MarathonRuntimeRole = "operations" | "worker" | "web";

type MarathonRuntimeConnectionUrls = Readonly<{
  identity: string;
  operations: string;
  worker: string;
  web: string;
}>;

type MarathonRuntimeManagers = Readonly<{
  maintenance: CanonicalPostgresTransactionManager;
  identity: CanonicalPostgresTransactionManager;
  operations: CanonicalPostgresTransactionManager;
  worker: CanonicalPostgresTransactionManager;
  web: CanonicalPostgresTransactionManager;
}>;

export const MARATHON_V010_TRUTH_COUNTERS = Object.freeze({
  REAL_LEGAL_TOPICS_READY: "0/7" as const,
  REAL_SOURCES_ACTIVE: 0 as const,
  REAL_PARAMETERS_ACTIVE: 0 as const,
  REAL_RULES_ACTIVE: 0 as const,
  REAL_CALCULATIONS_OR_FINDINGS: 0 as const,
  HUMAN_GROUND_TRUTH_LOCKED: 0 as const,
  REAL_CUSTOMER_DATA_READS: 0 as const,
  CUSTOMER_PROCESSING_ENABLED: "NO" as const,
  CUSTOMER_SHADOW_AUTHORIZED: "NO" as const,
  PRODUCTION_DELIVERY_ENABLED: "NO" as const,
  DEPLOYMENTS: 0 as const,
  REMOTE_MIGRATIONS: 0 as const,
  LIVE_PROVIDER_CALLS: 0 as const,
  OPENAI_CALLS: 0 as const,
  PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0 as const,
});

export const MARATHON_V010_DEVELOPMENT_RECEIPT_PATH =
  "output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json" as const;

export type MarathonV010TableState = Readonly<{
  table: string;
  row_count: number;
  state_sha256: string;
}>;

export type MarathonV010Checkpoint = Readonly<{
  schema_version: "tivdoc-marathon-v010-postgresql-checkpoint-v1";
  build_identity_sha: string;
  target_id: string;
  fixture_suffix: string;
  tenant_ordinal: 3;
  runtime_boundary: typeof MARATHON_V010_RUNTIME_BOUNDARY;
  capability_state: DurableCapabilityState;
  import_command: ControlledImportCommand;
  import_lease: ControlledImportLease;
  import_artifact_sha256: string;
  import_byte_count: number;
  import_publication_id: string;
  import_publication_receipt_sha256: string;
  identity: Readonly<{
    tenant_id: string;
    case_id: string;
    session_id: string;
    subject: string;
    current_token_id: string;
    rotation_counter: 1;
    reviewer_organization_id: string;
  }>;
  privacy_revision_2: Parameters<PostgresPrivacyRequestRepository["append"]>[0];
  report: Readonly<{
    report_id: string;
    report_revision: 7;
    report_sha256: string;
    object_version_id: string;
    provider_locator: string;
    artifact_sha256: string;
    byte_length: number;
    bytes_base64: string;
    grant_epoch: 1;
    canonical_identity: CanonicalReportIdentity;
  }>;
  revocation: Readonly<{
    revoked_at: string;
    receipt_sha256: string;
    privacy_revision_3_created_at: string;
    privacy_revision_3_idempotency_key: string;
  }>;
  before_restart_rows: readonly MarathonV010TableState[];
  before_restart_rows_sha256: string;
  checkpoint_sha256: string;
}>;

export type MarathonV010BeforeRestartReceipt = Readonly<{
  schema_version: "tivdoc-marathon-v010-postgresql-before-restart-v1";
  proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL";
  status: "PASS";
  capability_seed: Readonly<{
    tenant_ordinal: 3;
    tenant_id: string;
    case_id: string;
    capability_count: 14;
    capability_matrix_sha256: string;
    durable_state_sha256: string;
  }>;
  controlled_import: Readonly<{
    reserve_idempotency_replay: true;
    idempotency_binding_mismatch_rejected: true;
    unpublished_bytes_denied: true;
    stale_fencing_token_rejected: true;
    toctou_reopen_rejected: true;
    exact_bytes_staged: true;
    publication_idempotency_replay: true;
    published_exact_bytes_reopened: true;
    audit_event_rows: 5;
  }>;
  durable_boundaries: Readonly<{
    identity_registration_replayed: true;
    identity_rotation_persisted: true;
    stale_identity_rotation_rejected: true;
    owner_binding_replayed: true;
    cross_owner_denied: true;
    privacy_revision_replayed: true;
    privacy_revision_count: 2;
    report_binding_replayed: true;
    report_approval_replayed: true;
    wrong_report_binding_denied: true;
    report_binding_late_failure_rolled_back: true;
    exact_report_bytes_read: true;
    report_byte_provider: "EXPLICIT_SYNTHETIC_TEST_DOUBLE_NOT_PRODUCT_COMPOSITION";
    managed_storage_proof_claimed: false;
  }>;
  row_counts: readonly MarathonV010TableState[];
  connection_attempts: Readonly<{
    capability_seed: number;
    maintenance: number;
    identity_runtime: number;
    operations_runtime: number;
    worker_runtime: number;
    web_runtime: number;
    administrative_count_probe: number;
    observed_total: number;
  }>;
  runtime_boundary: typeof MARATHON_V010_RUNTIME_BOUNDARY;
  checkpoint: MarathonV010Checkpoint;
  truth_counters: typeof MARATHON_V010_TRUTH_COUNTERS;
}>;

export type MarathonV010AfterRestartReceipt = Readonly<{
  schema_version: "tivdoc-marathon-v010-postgresql-after-restart-v1";
  proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL";
  status: "PASS";
  restart: Readonly<{
    externally_managed_genuine_stop_start: true;
    same_cluster_restarted: true;
    all_pre_restart_pools_closed: true;
    fresh_capability_replay_pool: true;
    fresh_boundary_pool: true;
    target_id_unchanged: true;
  }>;
  durable_replay: Readonly<{
    capability_count: 14;
    capability_matrix_unchanged: true;
    import_status_reloaded: true;
    import_publication_replayed: true;
    published_exact_bytes_reopened: true;
    pre_revocation_rows_unchanged: true;
    identity_rotation_reloaded: true;
    owner_binding_reloaded: true;
    privacy_revision_replayed: true;
    approved_report_exact_bytes_reloaded: true;
  }>;
  fail_closed_revocation: Readonly<{
    identity_revoked: true;
    revoked_identity_rotation_denied: true;
    owner_revoked: true;
    owner_read_denied: true;
    report_revoked: true;
    report_read_denied_before_provider_access: true;
    privacy_completion_revision_persisted: true;
  }>;
  pre_revocation_row_counts: readonly MarathonV010TableState[];
  final_row_counts: readonly MarathonV010TableState[];
  connection_attempts: Readonly<{
    capability_replay: number;
    maintenance: number;
    identity_runtime: number;
    operations_runtime: number;
    worker_runtime: number;
    web_runtime: number;
    administrative_count_probe: number;
    observed_total: number;
  }>;
  runtime_boundary: typeof MARATHON_V010_RUNTIME_BOUNDARY;
  checkpoint_sha256: string;
  truth_counters: typeof MARATHON_V010_TRUTH_COUNTERS;
}>;

export type MarathonV010PostgresMatrixReceipt = Readonly<{
  schema_version: "tivdoc-marathon-v010-postgresql-matrix-v1";
  proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL";
  receipt_path: typeof MARATHON_V010_DEVELOPMENT_RECEIPT_PATH;
  target_id: string;
  tenant_ordinal: 3;
  genuine_server_stop_start: true;
  same_cluster_restarted: true;
  pre_restart_pools_closed: true;
  fresh_post_restart_pools: true;
  before_restart: MarathonV010BeforeRestartReceipt;
  after_restart: MarathonV010AfterRestartReceipt;
  final_row_counts: readonly MarathonV010TableState[];
  truth_counters: typeof MARATHON_V010_TRUTH_COUNTERS;
  status: "PASS";
}>;

export type MarathonV010BeforeRestartInput = Readonly<{
  maintenance_connection_url: string;
  runtime_role_connection_urls: MarathonRuntimeConnectionUrls;
  administrative_connection_url: string;
  build_identity_sha: string;
  fixture_suffix: string;
  tenant_ordinal: 3;
}>;

export type MarathonV010AfterRestartInput = Readonly<{
  maintenance_connection_url: string;
  runtime_role_connection_urls: MarathonRuntimeConnectionUrls;
  administrative_connection_url: string;
  checkpoint: MarathonV010Checkpoint;
  restart_observation: Readonly<{
    externally_managed_genuine_stop_start: true;
    same_cluster_restarted: true;
    all_pre_restart_pools_closed: true;
  }>;
}>;

export type MarathonV010DeterministicFixture = ReturnType<typeof createMarathonV010DeterministicFixture>;

/**
 * Creates only synthetic, hash-bound values. It cannot activate sources, legal
 * parameters, rules, findings, customer processing, delivery, or live providers.
 */
export function createMarathonV010DeterministicFixture(durableState: DurableCapabilityState) {
  const capabilityFixture = assertDurableCapabilityState(durableState);
  const suffix = durableState.fixture_suffix;
  const importBytes = new TextEncoder().encode(`%PDF-1.4\n% Tivdoc V0.10 synthetic controlled import ${suffix}\n`);
  const reportBytes = Uint8Array.from(capabilityFixture.report_artifacts.pdf);
  const importArtifactSha256 = byteSha256(importBytes);
  const reportArtifactSha256 = byteSha256(reportBytes);
  const requestedAt = "2026-09-01T12:01:00.000Z";
  const importCommand = createControlledImportCommand({
    idempotency_key: `import:synthetic:v010:${suffix}`,
    source_id: `source:synthetic:v010:${suffix}`,
    actor_id: `actor:synthetic:v010:${suffix}`,
    request_payload: Object.freeze({
      schema_version: "tivdoc-marathon-v010-synthetic-import-v1",
      fixture_suffix: suffix,
      mode: "synthetic_test",
      customer_data: false,
      legal_activation: false,
    }),
    expected_artifact_sha256: importArtifactSha256,
    requested_at: requestedAt,
  });
  const identity = Object.freeze({
    tenant_id: durableState.tenant_id,
    case_id: durableState.case_id,
    session_id: `session:synthetic:v010:${suffix}`,
    subject: `subject:synthetic:v010:${suffix}`,
    initial_token_id: `token:synthetic:v010:${suffix}:0`,
    current_token_id: `token:synthetic:v010:${suffix}:1`,
    rejected_token_id: `token:synthetic:v010:${suffix}:rejected`,
    reviewer_organization_id: `organization:synthetic:v010:${suffix}`,
  });
  const reportDecision = Object.freeze({
    task_id: capabilityFixture.review_task_id,
    task_kind: "report_approval" as const,
    reviewer_id: "synthetic-reviewer-v091",
    reviewer_role: "report_approver",
    decision: "approved" as const,
    input_sha256: capabilityFixture.report_artifacts.report_sha256,
    output_sha256: capabilityFixture.report_artifacts.report_sha256,
    decided_at: "2026-08-31T10:00:50.000Z",
    reason: "Synthetic isolated PostgreSQL verification.",
    schema_version: "tivdoc-case-review-decision-v0.6.0",
  });
  const reportCore = Object.freeze({
    tenant_id: durableState.tenant_id,
    case_id: durableState.case_id,
    case_revision: durableState.case_revision,
    analysis_run_id: durableState.analysis_run_id,
    analysis_run_revision: durableState.case_revision,
    rule_input_dependency_sha256: canonicalReportDependencySha256({
      rule_inputs: capabilityFixture.analysis_bundle.rule_inputs,
      dependencies: capabilityFixture.dependencies,
    }),
    report_model_sha256: canonicalReportModelSha256({
      analysis_result_sha256: capabilityFixture.report_artifacts.analysis_result_sha256,
      json_sha256: capabilityFixture.report_artifacts.json_sha256,
      html_sha256: capabilityFixture.report_artifacts.html_sha256,
      manifest_sha256: capabilityFixture.report_artifacts.manifest_sha256,
    }),
    report_id: durableState.report_id,
    report_revision: durableState.case_revision,
    report_sha256: durableState.report_sha256,
    pdf_sha256: reportArtifactSha256,
  });
  const storageObjectId = canonicalReportStorageObjectId(reportCore);
  const objectVersionId = canonicalReportStorageObjectVersionId(reportCore);
  const stagedReportIdentity = createCanonicalReportIdentity(Object.freeze({
    schema_version: CANONICAL_REPORT_IDENTITY_SCHEMA_VERSION,
    ...reportCore,
    owner_binding_revision: 1,
    owner_binding_sha256: canonicalSha256({
      tenant_id: durableState.tenant_id,
      canonical_case_id: durableState.case_id,
      subject: identity.subject,
      revision: 1,
      status: "active",
      created_at: "2026-09-01T12:00:00.000Z",
    }),
    storage_object_id: storageObjectId,
    storage_object_version_id: objectVersionId,
    approval_task_id: capabilityFixture.review_task_id,
    approval_revision: 1,
    approval_decision_sha256: canonicalSha256(reportDecision),
    download_grant_revision: 0,
  }));
  const privacyBase = Object.freeze({
    request_id: `privacy:synthetic:v010:${suffix}`,
    tenant_id: durableState.tenant_id,
    case_id: durableState.case_id,
    request_kind: "deletion" as const,
  });
  const report = Object.freeze({
    report_id: durableState.report_id,
    report_revision: durableState.case_revision,
    report_sha256: durableState.report_sha256,
    object_version_id: objectVersionId,
    provider_locator: `objects/${reportArtifactSha256.slice(0, 2)}/${objectVersionId}`,
    artifact_sha256: reportArtifactSha256,
    byte_length: reportBytes.byteLength,
    storage_object_id: storageObjectId,
    staged_identity: stagedReportIdentity,
    approved_identity: withCanonicalReportGrantRevision(stagedReportIdentity, 1),
  });
  return Object.freeze({
    suffix,
    durable_state: durableState,
    import_bytes: Uint8Array.from(importBytes),
    import_identity_token: `synthetic-file-identity:v010:${suffix}:immutable`,
    import_artifact_sha256: importArtifactSha256,
    import_command: importCommand,
    report_bytes: Uint8Array.from(reportBytes),
    report,
    identity,
    privacy_revision_1: Object.freeze({
      ...privacyBase,
      revision: 1,
      state: "requested" as const,
      idempotency_key: `privacy:synthetic:v010:${suffix}:1`,
      legal_hold_conflict: false,
      grant_revocation_receipt_sha256: null,
      created_at: "2026-09-01T12:00:02.000Z",
    }),
    privacy_revision_2: Object.freeze({
      ...privacyBase,
      revision: 2,
      state: "acknowledged" as const,
      idempotency_key: `privacy:synthetic:v010:${suffix}:2`,
      legal_hold_conflict: false,
      grant_revocation_receipt_sha256: null,
      created_at: "2026-09-01T12:00:03.000Z",
    }),
    privacy_revision_3: Object.freeze({
      ...privacyBase,
      revision: 3,
      state: "completed_by_authorized_operations" as const,
      idempotency_key: `privacy:synthetic:v010:${suffix}:3`,
      legal_hold_conflict: false,
      grant_revocation_receipt_sha256: canonicalSha256({ suffix, kind: "marathon-v010-revocation" }),
      created_at: "2026-09-01T12:20:01.000Z",
    }),
    timestamps: Object.freeze({
      created_at: "2026-09-01T12:00:00.000Z",
      valid_after: "2026-09-01T12:00:01.000Z",
      expires_at: "2026-09-02T12:00:00.000Z",
      rotated_at: "2026-09-01T12:00:10.000Z",
      first_claim_at: "2026-09-01T12:01:10.000Z",
      second_claim_at: "2026-09-01T12:01:10.500Z",
      stale_stage_at: "2026-09-01T12:01:10.600Z",
      stage_at: "2026-09-01T12:01:10.700Z",
      publish_at: "2026-09-01T12:01:10.800Z",
      revoked_at: "2026-09-01T12:20:00.000Z",
    }),
  });
}

export async function runMarathonV010BeforeRestart(
  input: MarathonV010BeforeRestartInput,
): Promise<MarathonV010BeforeRestartReceipt> {
  assertBeforeInput(input);
  const capability = await runCanonicalCapabilityMatrix({
    connection_url: input.maintenance_connection_url,
    build_identity_sha: input.build_identity_sha,
    fixture_suffix: input.fixture_suffix,
  });
  assertCapabilitySeed(capability, input.fixture_suffix);
  const fixture = createMarathonV010DeterministicFixture(capability.durable_state);
  const maintenance = createDriver(input.maintenance_connection_url, "tivdoc-marathon-v010-before-maintenance");
  const identity = createDriver(input.runtime_role_connection_urls.identity, "tivdoc-marathon-v010-before-identity");
  const operations = createDriver(input.runtime_role_connection_urls.operations, "tivdoc-marathon-v010-before-operations");
  const worker = createDriver(input.runtime_role_connection_urls.worker, "tivdoc-marathon-v010-before-worker");
  const web = createDriver(input.runtime_role_connection_urls.web, "tivdoc-marathon-v010-before-web");
  const admin = createDriver(input.administrative_connection_url, "tivdoc-marathon-v010-before-counts");
  assertSameTarget(capability.target_id, maintenance, identity, operations, worker, web, admin);
  const managers = Object.freeze({
    maintenance: new CanonicalPostgresTransactionManager(maintenance),
    identity: new CanonicalPostgresTransactionManager(identity),
    operations: new CanonicalPostgresTransactionManager(operations),
    worker: new CanonicalPostgresTransactionManager(worker),
    web: new CanonicalPostgresTransactionManager(web),
  });
  let rowCounts: readonly MarathonV010TableState[];
  let importResult: Awaited<ReturnType<typeof exerciseControlledImportBeforeRestart>>;
  let boundaryResult: Awaited<ReturnType<typeof exerciseBoundariesBeforeRestart>>;
  try {
    boundaryResult = await exerciseBoundariesBeforeRestart(managers, input.build_identity_sha, fixture);
    importResult = await exerciseControlledImportBeforeRestart(
      managers.maintenance,
      maintenance,
      input.build_identity_sha,
      fixture,
    );
    rowCounts = await collectMarathonRows(admin, fixture);
    assertExpectedRows(rowCounts, 2);
  } finally {
    await closeDrivers(maintenance, identity, operations, worker, web, admin);
  }

  const checkpointSeed = Object.freeze({
    schema_version: "tivdoc-marathon-v010-postgresql-checkpoint-v1" as const,
    build_identity_sha: input.build_identity_sha,
    target_id: capability.target_id,
    fixture_suffix: fixture.suffix,
    tenant_ordinal: 3 as const,
    runtime_boundary: MARATHON_V010_RUNTIME_BOUNDARY,
    capability_state: capability.durable_state,
    import_command: fixture.import_command,
    import_lease: importResult!.lease,
    import_artifact_sha256: fixture.import_artifact_sha256,
    import_byte_count: fixture.import_bytes.byteLength,
    import_publication_id: importResult!.publication_id,
    import_publication_receipt_sha256: importResult!.publication_receipt_sha256,
    identity: Object.freeze({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      session_id: fixture.identity.session_id,
      subject: fixture.identity.subject,
      current_token_id: fixture.identity.current_token_id,
      rotation_counter: 1 as const,
      reviewer_organization_id: fixture.identity.reviewer_organization_id,
    }),
    privacy_revision_2: fixture.privacy_revision_2,
    report: Object.freeze({
      report_id: fixture.report.report_id,
      report_revision: fixture.report.report_revision,
      report_sha256: fixture.report.report_sha256,
      object_version_id: fixture.report.object_version_id,
      provider_locator: fixture.report.provider_locator,
      artifact_sha256: fixture.report.artifact_sha256,
      byte_length: fixture.report.byte_length,
      bytes_base64: Buffer.from(fixture.report_bytes).toString("base64"),
      grant_epoch: 1 as const,
      canonical_identity: fixture.report.approved_identity,
    }),
    revocation: Object.freeze({
      revoked_at: fixture.timestamps.revoked_at,
      receipt_sha256: fixture.privacy_revision_3.grant_revocation_receipt_sha256,
      privacy_revision_3_created_at: fixture.privacy_revision_3.created_at,
      privacy_revision_3_idempotency_key: fixture.privacy_revision_3.idempotency_key,
    }),
    before_restart_rows: rowCounts!,
    before_restart_rows_sha256: canonicalSha256(rowCounts!),
  });
  const checkpoint: MarathonV010Checkpoint = Object.freeze({
    ...checkpointSeed,
    checkpoint_sha256: canonicalSha256(checkpointSeed),
  });
  const maintenanceMetrics = maintenance.metrics();
  const identityMetrics = identity.metrics();
  const operationsMetrics = operations.metrics();
  const workerMetrics = worker.metrics();
  const webMetrics = web.metrics();
  const adminMetrics = admin.metrics();
  assert([maintenanceMetrics, identityMetrics, operationsMetrics, workerMetrics, webMetrics, adminMetrics]
    .every((metrics) => metrics.closed), "MARATHON_V010_PRE_RESTART_POOL_NOT_CLOSED");
  assert([maintenanceMetrics, identityMetrics, operationsMetrics, workerMetrics, webMetrics]
    .every((metrics) => metrics.connection_attempts > 0), "MARATHON_V010_RUNTIME_ROLE_NOT_EXERCISED");
  const observedTotal = capability.driver_metrics.connection_attempts
    + maintenanceMetrics.connection_attempts + identityMetrics.connection_attempts
    + operationsMetrics.connection_attempts + workerMetrics.connection_attempts
    + webMetrics.connection_attempts + adminMetrics.connection_attempts;
  assert(observedTotal > 0, "MARATHON_V010_CONNECTIONS_NOT_OBSERVED");
  assert(boundaryResult!.report_byte_reads === 1, "MARATHON_V010_REPORT_PROVIDER_READ_COUNT_INVALID");

  return Object.freeze({
    schema_version: "tivdoc-marathon-v010-postgresql-before-restart-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    status: "PASS",
    capability_seed: Object.freeze({
      tenant_ordinal: 3,
      tenant_id: capability.durable_state.tenant_id,
      case_id: capability.durable_state.case_id,
      capability_count: 14,
      capability_matrix_sha256: capability.durable_state.capability_matrix_sha256,
      durable_state_sha256: capability.durable_state.durable_state_sha256,
    }),
    controlled_import: Object.freeze({
      reserve_idempotency_replay: true,
      idempotency_binding_mismatch_rejected: true,
      unpublished_bytes_denied: true,
      stale_fencing_token_rejected: true,
      toctou_reopen_rejected: true,
      exact_bytes_staged: true,
      publication_idempotency_replay: true,
      published_exact_bytes_reopened: true,
      audit_event_rows: 5,
    }),
    durable_boundaries: Object.freeze({
      identity_registration_replayed: true,
      identity_rotation_persisted: true,
      stale_identity_rotation_rejected: true,
      owner_binding_replayed: true,
      cross_owner_denied: true,
      privacy_revision_replayed: true,
      privacy_revision_count: 2,
      report_binding_replayed: true,
      report_approval_replayed: true,
      wrong_report_binding_denied: true,
      report_binding_late_failure_rolled_back: true,
      exact_report_bytes_read: true,
      report_byte_provider: "EXPLICIT_SYNTHETIC_TEST_DOUBLE_NOT_PRODUCT_COMPOSITION",
      managed_storage_proof_claimed: false,
    }),
    row_counts: rowCounts!,
    connection_attempts: Object.freeze({
      capability_seed: capability.driver_metrics.connection_attempts,
      maintenance: maintenanceMetrics.connection_attempts,
      identity_runtime: identityMetrics.connection_attempts,
      operations_runtime: operationsMetrics.connection_attempts,
      worker_runtime: workerMetrics.connection_attempts,
      web_runtime: webMetrics.connection_attempts,
      administrative_count_probe: adminMetrics.connection_attempts,
      observed_total: observedTotal,
    }),
    runtime_boundary: MARATHON_V010_RUNTIME_BOUNDARY,
    checkpoint,
    truth_counters: MARATHON_V010_TRUTH_COUNTERS,
  });
}

export async function runMarathonV010AfterRestart(
  input: MarathonV010AfterRestartInput,
): Promise<MarathonV010AfterRestartReceipt> {
  assertCheckpoint(input.checkpoint);
  assertRestartObservation(input.restart_observation);
  const fixture = createMarathonV010DeterministicFixture(input.checkpoint.capability_state);
  assertCheckpointMatchesFixture(input.checkpoint, fixture);
  const replay = await replayCanonicalCapabilityMatrix({
    connection_url: input.maintenance_connection_url,
    build_identity_sha: input.checkpoint.build_identity_sha,
  }, input.checkpoint.capability_state);
  assert(replay.matrix.length === 14, "MARATHON_V010_CAPABILITY_REPLAY_COUNT_INVALID");
  assert(replay.adapter_replay.status === "PASS", "MARATHON_V010_CAPABILITY_ADAPTER_REPLAY_FAILED");

  const maintenance = createDriver(input.maintenance_connection_url, "tivdoc-marathon-v010-after-maintenance");
  const identity = createDriver(input.runtime_role_connection_urls.identity, "tivdoc-marathon-v010-after-identity");
  const operations = createDriver(input.runtime_role_connection_urls.operations, "tivdoc-marathon-v010-after-operations");
  const worker = createDriver(input.runtime_role_connection_urls.worker, "tivdoc-marathon-v010-after-worker");
  const web = createDriver(input.runtime_role_connection_urls.web, "tivdoc-marathon-v010-after-web");
  const admin = createDriver(input.administrative_connection_url, "tivdoc-marathon-v010-after-counts");
  assertSameTarget(input.checkpoint.target_id, maintenance, identity, operations, worker, web, admin);
  const managers = Object.freeze({
    maintenance: new CanonicalPostgresTransactionManager(maintenance),
    identity: new CanonicalPostgresTransactionManager(identity),
    operations: new CanonicalPostgresTransactionManager(operations),
    worker: new CanonicalPostgresTransactionManager(worker),
    web: new CanonicalPostgresTransactionManager(web),
  });
  let preRevocationRows: readonly MarathonV010TableState[];
  let finalRows: readonly MarathonV010TableState[];
  let replayResult: Awaited<ReturnType<typeof exerciseAfterRestartReplay>>;
  let revocationResult: Awaited<ReturnType<typeof exerciseFailClosedRevocation>>;
  try {
    replayResult = await exerciseAfterRestartReplay(
      managers,
      input.checkpoint.build_identity_sha,
      fixture,
      input.checkpoint,
    );
    preRevocationRows = await collectMarathonRows(admin, fixture);
    assertRowsUnchanged(preRevocationRows, input.checkpoint.before_restart_rows);
    revocationResult = await exerciseFailClosedRevocation(
      managers,
      input.checkpoint.build_identity_sha,
      fixture,
    );
    finalRows = await collectMarathonRows(admin, fixture);
    assertExpectedRows(finalRows, 3);
  } finally {
    await closeDrivers(maintenance, identity, operations, worker, web, admin);
  }
  const maintenanceMetrics = maintenance.metrics();
  const identityMetrics = identity.metrics();
  const operationsMetrics = operations.metrics();
  const workerMetrics = worker.metrics();
  const webMetrics = web.metrics();
  const adminMetrics = admin.metrics();
  assert([maintenanceMetrics, identityMetrics, operationsMetrics, workerMetrics, webMetrics, adminMetrics]
    .every((metrics) => metrics.closed), "MARATHON_V010_POST_RESTART_POOL_NOT_CLOSED");
  assert([maintenanceMetrics, identityMetrics, operationsMetrics, workerMetrics, webMetrics]
    .every((metrics) => metrics.connection_attempts > 0), "MARATHON_V010_REPLAY_RUNTIME_ROLE_NOT_EXERCISED");
  const observedTotal = replay.driver_metrics.connection_attempts
    + maintenanceMetrics.connection_attempts + identityMetrics.connection_attempts
    + operationsMetrics.connection_attempts + workerMetrics.connection_attempts
    + webMetrics.connection_attempts + adminMetrics.connection_attempts;
  assert(observedTotal > 0, "MARATHON_V010_REPLAY_CONNECTIONS_NOT_OBSERVED");

  return Object.freeze({
    schema_version: "tivdoc-marathon-v010-postgresql-after-restart-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    status: "PASS",
    restart: Object.freeze({
      externally_managed_genuine_stop_start: true,
      same_cluster_restarted: true,
      all_pre_restart_pools_closed: true,
      fresh_capability_replay_pool: true,
      fresh_boundary_pool: true,
      target_id_unchanged: true,
    }),
    durable_replay: Object.freeze({
      capability_count: 14,
      capability_matrix_unchanged: true,
      import_status_reloaded: replayResult!.import_status_reloaded,
      import_publication_replayed: replayResult!.import_publication_replayed,
      published_exact_bytes_reopened: replayResult!.published_exact_bytes_reopened,
      pre_revocation_rows_unchanged: true,
      identity_rotation_reloaded: replayResult!.identity_rotation_reloaded,
      owner_binding_reloaded: replayResult!.owner_binding_reloaded,
      privacy_revision_replayed: replayResult!.privacy_revision_replayed,
      approved_report_exact_bytes_reloaded: replayResult!.approved_report_exact_bytes_reloaded,
    }),
    fail_closed_revocation: Object.freeze({
      identity_revoked: revocationResult!.identity_revoked,
      revoked_identity_rotation_denied: revocationResult!.revoked_identity_rotation_denied,
      owner_revoked: revocationResult!.owner_revoked,
      owner_read_denied: revocationResult!.owner_read_denied,
      report_revoked: revocationResult!.report_revoked,
      report_read_denied_before_provider_access: revocationResult!.report_read_denied_before_provider_access,
      privacy_completion_revision_persisted: revocationResult!.privacy_completion_revision_persisted,
    }),
    pre_revocation_row_counts: preRevocationRows!,
    final_row_counts: finalRows!,
    connection_attempts: Object.freeze({
      capability_replay: replay.driver_metrics.connection_attempts,
      maintenance: maintenanceMetrics.connection_attempts,
      identity_runtime: identityMetrics.connection_attempts,
      operations_runtime: operationsMetrics.connection_attempts,
      worker_runtime: workerMetrics.connection_attempts,
      web_runtime: webMetrics.connection_attempts,
      administrative_count_probe: adminMetrics.connection_attempts,
      observed_total: observedTotal,
    }),
    runtime_boundary: MARATHON_V010_RUNTIME_BOUNDARY,
    checkpoint_sha256: input.checkpoint.checkpoint_sha256,
    truth_counters: MARATHON_V010_TRUTH_COUNTERS,
  });
}

/** Builds the one JSON-safe receipt copied into the Marathon evidence package. */
export function combineMarathonV010Receipts(
  before: MarathonV010BeforeRestartReceipt,
  after: MarathonV010AfterRestartReceipt,
): MarathonV010PostgresMatrixReceipt {
  assert(before.status === "PASS" && after.status === "PASS",
    "MARATHON_V010_RECEIPT_STATUS_INVALID");
  assert(before.checkpoint.checkpoint_sha256 === after.checkpoint_sha256,
    "MARATHON_V010_RECEIPT_CHECKPOINT_MISMATCH");
  assert(before.checkpoint.target_id.length > 0 && before.capability_seed.tenant_ordinal === 3,
    "MARATHON_V010_RECEIPT_TARGET_INVALID");
  assert(after.restart.externally_managed_genuine_stop_start
    && after.restart.same_cluster_restarted && after.restart.all_pre_restart_pools_closed
    && after.restart.fresh_capability_replay_pool && after.restart.fresh_boundary_pool,
  "MARATHON_V010_RECEIPT_RESTART_INVALID");
  assert(canonicalSha256(before.truth_counters) === canonicalSha256(MARATHON_V010_TRUTH_COUNTERS)
    && canonicalSha256(after.truth_counters) === canonicalSha256(MARATHON_V010_TRUTH_COUNTERS),
  "MARATHON_V010_RECEIPT_TRUTH_COUNTER_INVALID");
  assert(canonicalSha256(before.runtime_boundary) === canonicalSha256(MARATHON_V010_RUNTIME_BOUNDARY)
    && canonicalSha256(after.runtime_boundary) === canonicalSha256(MARATHON_V010_RUNTIME_BOUNDARY),
  "MARATHON_V010_RECEIPT_RUNTIME_BOUNDARY_INVALID");
  assertExpectedRows(after.final_row_counts, 3);
  return Object.freeze({
    schema_version: "tivdoc-marathon-v010-postgresql-matrix-v1",
    proof_class: "REAL_NODE_POSTGRES_PARAMETERIZED_SQL",
    receipt_path: MARATHON_V010_DEVELOPMENT_RECEIPT_PATH,
    target_id: before.checkpoint.target_id,
    tenant_ordinal: 3,
    genuine_server_stop_start: true,
    same_cluster_restarted: true,
    pre_restart_pools_closed: true,
    fresh_post_restart_pools: true,
    before_restart: before,
    after_restart: after,
    final_row_counts: after.final_row_counts,
    truth_counters: MARATHON_V010_TRUTH_COUNTERS,
    status: "PASS",
  });
}

async function exerciseReportBindingRollback(
  managers: MarathonRuntimeManagers,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
): Promise<void> {
  await assertCanonicalReportIdentityForWorker(managers.operations, buildIdentitySha, fixture);
  try {
    await withVerifiedRuntimeTransaction(managers.worker, buildIdentitySha, fixture, "worker",
      "report-rollback", async (context) => {
      await bindReportAsWorker(context, fixture);
      throw new Error("MARATHON_V010_SYNTHETIC_LATE_REPORT_FAILURE");
    });
  } catch (error) {
    if (!(error instanceof CanonicalPostgresError) || error.code !== "POSTGRES_TRANSACTION_FAILED") throw error;
  }
  await withVerifiedRuntimeTransaction(managers.worker, buildIdentitySha, fixture, "worker",
    "report-rollback-probe", async (context) => {
    const result = await context.client.query(statement(
      "marathon_v010_report_rollback_probe",
      `select (select count(*)::text from public.product_private_report_objects object
          where object.tenant_id = $1 and object.canonical_case_id = $2
            and object.report_id = $3 and object.report_revision = $4) as report_object_rows`,
      [
        fixture.identity.tenant_id,
        fixture.identity.case_id,
        fixture.report.report_id,
        fixture.report.report_revision,
      ],
    ));
    const row = result.rows[0];
    assert(result.row_count === 1 && row?.report_object_rows === "0",
      "MARATHON_V010_REPORT_LATE_FAILURE_NOT_ROLLED_BACK");
  });
}

async function exerciseBoundariesBeforeRestart(
  managers: MarathonRuntimeManagers,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
) {
  const provider = createSyntheticReadOnlyProvider(fixture.report.provider_locator, fixture.report_bytes);
  await withMaintenanceTransaction(managers.maintenance, buildIdentitySha, fixture.identity.tenant_id, async (context) => {
    const sessions = new PostgresIdentitySessionRepository(context.client);
    const registration = Object.freeze({
      tenant_id: fixture.identity.tenant_id,
      session_id: fixture.identity.session_id,
      subject: fixture.identity.subject,
      current_token_id: fixture.identity.initial_token_id,
      rotation_counter: 0,
      valid_after: fixture.timestamps.valid_after,
      expires_at: fixture.timestamps.expires_at,
      reviewer_organization_id: fixture.identity.reviewer_organization_id,
      created_at: fixture.timestamps.created_at,
    });
    const registered = await sessions.register(registration);
    const replayedRegistration = await sessions.register(registration);
    assert(registered.session_sha256 === replayedRegistration.session_sha256,
      "MARATHON_V010_IDENTITY_REGISTRATION_REPLAY_MISMATCH");
    await sessions.rotate({
      tenant_id: fixture.identity.tenant_id,
      session_id: fixture.identity.session_id,
      next_token_id: fixture.identity.current_token_id,
      expected_rotation_counter: 0,
      rotated_at: fixture.timestamps.rotated_at,
    });
    await expectDurableBoundaryError(() => sessions.rotate({
      tenant_id: fixture.identity.tenant_id,
      session_id: fixture.identity.session_id,
      next_token_id: fixture.identity.rejected_token_id,
      expected_rotation_counter: 0,
      rotated_at: fixture.timestamps.rotated_at,
    }), "DURABLE_BOUNDARY_OPERATION_REJECTED");
  });

  await managers.identity.transaction(async (context) => {
    const rotated = await new PostgresIdentitySessionRepository(context.client).read(fixture.identity.session_id);
    assert(rotated?.status === "active" && rotated.current_token_id === fixture.identity.current_token_id
      && rotated.rotation_counter === 1, "MARATHON_V010_IDENTITY_RUNTIME_READ_INVALID");
  });

  await withVerifiedRuntimeTransaction(managers.operations, buildIdentitySha, fixture, "operations",
    "owner-bind", async (context) => {
    const owners = new PostgresCaseOwnerRepository(context.client);
    const ownerInput = Object.freeze({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
      created_at: fixture.timestamps.created_at,
    });
    const owner = await owners.bind(ownerInput);
    const ownerReplay = await owners.bind(ownerInput);
    assert(owner.binding_sha256 === ownerReplay.binding_sha256, "MARATHON_V010_OWNER_REPLAY_MISMATCH");
    await expectDurableBoundaryError(() => owners.requireActive({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: `subject:synthetic:v010:${fixture.suffix}:other`,
    }), "DURABLE_BOUNDARY_OWNER_DENIED");
  });

  await withVerifiedRuntimeTransaction(managers.web, buildIdentitySha, fixture, "web",
    "owner-read", async (context) => {
    const owner = await new PostgresCaseOwnerRepository(context.client).requireActive({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
    });
    assert(owner.status === "active", "MARATHON_V010_WEB_OWNER_READ_INVALID");
  });

  await exerciseReportBindingRollback(managers, buildIdentitySha, fixture);

  await withVerifiedRuntimeTransaction(managers.operations, buildIdentitySha, fixture, "operations",
    "privacy-before-restart", async (context) => {
    const privacy = new PostgresPrivacyRequestRepository(context.client);
    const privacyOne = await privacy.append(fixture.privacy_revision_1);
    const privacyReplay = await privacy.append(fixture.privacy_revision_1);
    assert(privacyOne.command_sha256 === privacyReplay.command_sha256,
      "MARATHON_V010_PRIVACY_REPLAY_MISMATCH");
    const privacyTwo = await privacy.append(fixture.privacy_revision_2);
    assert(privacyTwo.revision === 2 && privacyTwo.state === "acknowledged",
      "MARATHON_V010_PRIVACY_REVISION_INVALID");
  });

  await assertCanonicalReportIdentityForWorker(managers.operations, buildIdentitySha, fixture);
  const reportBinding = await withVerifiedRuntimeTransaction(managers.worker, buildIdentitySha, fixture, "worker",
    "report-bind", (context) => bindReportAsWorker(context, fixture));
  const reportBindingReplay = await withVerifiedRuntimeTransaction(managers.worker, buildIdentitySha, fixture, "worker",
    "report-bind-replay", (context) => bindReportAsWorker(context, fixture));
  assert(reportBinding.object_version_id === reportBindingReplay.object_version_id,
      "MARATHON_V010_REPORT_BIND_REPLAY_MISMATCH");

  return withVerifiedRuntimeTransaction(managers.operations, buildIdentitySha, fixture, "operations",
    "report-approval-read", async (context) => {
    const reports = new PostgresPrivateReportObjectRepository(context.client);
    await reports.approve({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      object_version_id: fixture.report.object_version_id,
      expected_grant_epoch: 0,
      canonical_identity: fixture.report.staged_identity,
    });
    await reports.approve({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      object_version_id: fixture.report.object_version_id,
      expected_grant_epoch: 0,
      canonical_identity: fixture.report.staged_identity,
    });
    await expectCanonicalReportIdentityError(() => reports.approvedRead({
      ...reportReadInput(fixture),
      report_sha256: canonicalSha256({ suffix: fixture.suffix, kind: "wrong-report" }),
    }), "CANONICAL_REPORT_DIGEST_MISMATCH");
    const downloaded = await new DurableApprovedReportObjectReader(reports, provider.provider)
      .download(reportReadInput(fixture));
    assertBytes(downloaded.bytes, fixture.report_bytes, "MARATHON_V010_REPORT_BYTES_MISMATCH");
    assert(provider.readCount() === 1, "MARATHON_V010_REPORT_PROVIDER_READ_COUNT_INVALID");
    return Object.freeze({ report_byte_reads: provider.readCount() });
  });
}

async function exerciseControlledImportBeforeRestart(
  manager: CanonicalPostgresTransactionManager,
  service: NodePostgresConnectionFactory,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
) {
  const repository = new PostgresControlledImportLedgerRepository();
  const reserve = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.reserve(context, fixture.import_command));
  const reserveReplay = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.reserve(context, fixture.import_command));
  assert(reserve.state === "received" && reserveReplay.operation_id === reserve.operation_id,
    "MARATHON_V010_IMPORT_RESERVE_REPLAY_INVALID");
  await withAutocommitContext(service, (context) => expectControlledImportError(
    () => repository.openPublishedBytes(context, fixture.import_command.operation_id),
    "IMPORT_PUBLICATION_INVISIBLE",
  ));

  const conflictingCommand = createControlledImportCommand({
    idempotency_key: fixture.import_command.idempotency_key,
    source_id: fixture.import_command.source_id,
    actor_id: `${fixture.import_command.actor_id}:conflict`,
    request_payload: Object.freeze({ ...fixture.import_command.request_payload, conflict: true }),
    expected_artifact_sha256: fixture.import_command.expected_artifact_sha256,
    requested_at: fixture.import_command.requested_at,
  });
  await expectSqlstate(service, controlledImportStatement(CONTROLLED_IMPORT_SQL.reserve, [
    conflictingCommand.operation_id,
    conflictingCommand.idempotency_key,
    conflictingCommand.source_id,
    conflictingCommand.actor_id,
    controlledImportCanonicalJson(conflictingCommand.request_payload),
    conflictingCommand.request_sha256,
    conflictingCommand.expected_artifact_sha256,
    conflictingCommand.requested_at,
  ]), "CI001");

  const firstClaims = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.claimRecoverable(context, {
      worker_id: `worker:synthetic:v010:${fixture.suffix}:first`,
      now: fixture.timestamps.first_claim_at,
      lease_ms: 100,
      limit: 100,
    }));
  const firstLease = requiredLease(firstClaims, fixture.import_command.operation_id);
  const secondClaims = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.claimRecoverable(context, {
      worker_id: `worker:synthetic:v010:${fixture.suffix}:second`,
      now: fixture.timestamps.second_claim_at,
      lease_ms: 60_000,
      limit: 100,
    }));
  const secondLease = requiredLease(secondClaims, fixture.import_command.operation_id);
  assert(secondLease.fencing_token === firstLease.fencing_token + 1,
    "MARATHON_V010_FENCING_TOKEN_NOT_INCREMENTED");
  await expectSqlstate(service, controlledImportStatement(CONTROLLED_IMPORT_SQL.stageExactBytes, [
    firstLease.operation_id,
    firstLease.worker_id,
    firstLease.fencing_token,
    fixture.import_bytes,
    fixture.import_artifact_sha256,
    controlledImportSha256(fixture.import_identity_token),
    fixture.timestamps.stale_stage_at,
  ]), "CI002");

  await withAutocommitContext(service, (context) => expectControlledImportError(
    () => repository.stageExactBytes(context, {
      lease: secondLease,
      source: changingExactSource(fixture.import_bytes, fixture.import_identity_token),
      expected_artifact_sha256: fixture.import_artifact_sha256,
      occurred_at: fixture.timestamps.stage_at,
    }),
    "IMPORT_TOCTOU_REOPEN_MISMATCH",
  ));
  const staged = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.stageExactBytes(context, {
      lease: secondLease,
      source: immutableExactSource(fixture.import_bytes, fixture.import_identity_token),
      expected_artifact_sha256: fixture.import_artifact_sha256,
      occurred_at: fixture.timestamps.stage_at,
    }));
  assert(staged.status.state === "validated" && !staged.status.visible,
    "MARATHON_V010_IMPORT_STAGE_INVALID");
  const published = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.publish(context, {
      lease: secondLease,
      request_sha256: fixture.import_command.request_sha256,
      artifact_sha256: fixture.import_artifact_sha256,
      occurred_at: fixture.timestamps.publish_at,
    }));
  const publicationReplay = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.publish(context, {
      lease: secondLease,
      request_sha256: fixture.import_command.request_sha256,
      artifact_sha256: fixture.import_artifact_sha256,
      occurred_at: fixture.timestamps.publish_at,
    }));
  assert(published.visible && published.state === "published"
    && publicationReplay.publication_id === published.publication_id,
  "MARATHON_V010_IMPORT_PUBLICATION_REPLAY_INVALID");
  const opened = await withMaintenanceTransaction(manager, buildIdentitySha, fixture.identity.tenant_id,
    (context) => repository.openPublishedBytes(context, fixture.import_command.operation_id));
  assertBytes(opened.bytes, fixture.import_bytes, "MARATHON_V010_IMPORT_PUBLISHED_BYTES_MISMATCH");
  assert(opened.artifact_sha256 === fixture.import_artifact_sha256
    && opened.byte_count === fixture.import_bytes.byteLength,
  "MARATHON_V010_IMPORT_PUBLISHED_BINDING_MISMATCH");
  assert(published.publication_id !== null && published.publication_receipt_sha256 !== null,
    "MARATHON_V010_IMPORT_PUBLICATION_RECEIPT_MISSING");
  return Object.freeze({
    lease: secondLease,
    publication_id: published.publication_id,
    publication_receipt_sha256: published.publication_receipt_sha256,
  });
}

async function exerciseAfterRestartReplay(
  managers: MarathonRuntimeManagers,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
  checkpoint: MarathonV010Checkpoint,
) {
  const provider = createSyntheticReadOnlyProvider(fixture.report.provider_locator, fixture.report_bytes);
  await withMaintenanceTransaction(
    managers.maintenance,
    buildIdentitySha,
    fixture.identity.tenant_id,
    async (context) => {
    const imports = new PostgresControlledImportLedgerRepository();
    const status = await imports.getStatus(context, fixture.import_command.operation_id);
    assert(status?.state === "published" && status.visible
      && status.publication_id === checkpoint.import_publication_id
      && status.publication_receipt_sha256 === checkpoint.import_publication_receipt_sha256,
    "MARATHON_V010_IMPORT_STATUS_NOT_RELOADED");
    const publicationReplay = await imports.publish(context, {
      lease: checkpoint.import_lease,
      request_sha256: fixture.import_command.request_sha256,
      artifact_sha256: fixture.import_artifact_sha256,
      occurred_at: fixture.timestamps.publish_at,
    });
    assert(publicationReplay.publication_id === checkpoint.import_publication_id,
      "MARATHON_V010_IMPORT_PUBLICATION_NOT_REPLAYED");
    const opened = await imports.openPublishedBytes(context, fixture.import_command.operation_id);
    assertBytes(opened.bytes, fixture.import_bytes, "MARATHON_V010_IMPORT_BYTES_NOT_RELOADED");
  });

  await managers.identity.transaction(async (context) => {
    const sessions = new PostgresIdentitySessionRepository(context.client);
    const session = await sessions.read(fixture.identity.session_id);
    assert(session?.status === "active" && session.current_token_id === fixture.identity.current_token_id
      && session.rotation_counter === 1, "MARATHON_V010_IDENTITY_NOT_RELOADED");
  });

  await withVerifiedRuntimeTransaction(managers.web, buildIdentitySha, fixture, "web",
    "owner-replay-read", async (context) => {
    const owner = await new PostgresCaseOwnerRepository(context.client).requireActive({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
    });
    assert(owner.status === "active", "MARATHON_V010_OWNER_NOT_RELOADED");
  });

  await withVerifiedRuntimeTransaction(managers.worker, buildIdentitySha, fixture, "worker",
    "report-replay-read", (context) => assertReportReadableAsWorker(context, fixture));

  await withVerifiedRuntimeTransaction(managers.operations, buildIdentitySha, fixture, "operations",
    "privacy-report-replay", async (context) => {
    const privacy = await new PostgresPrivacyRequestRepository(context.client)
      .append(fixture.privacy_revision_2);
    assert(privacy.revision === 2 && privacy.state === "acknowledged",
      "MARATHON_V010_PRIVACY_REPLAY_FAILED");
    const reports = new PostgresPrivateReportObjectRepository(context.client);
    const downloaded = await new DurableApprovedReportObjectReader(reports, provider.provider)
      .download(reportReadInput(fixture));
    assertBytes(downloaded.bytes, fixture.report_bytes, "MARATHON_V010_REPORT_BYTES_NOT_RELOADED");
    assert(provider.readCount() === 1, "MARATHON_V010_REPORT_REPLAY_READ_COUNT_INVALID");
  });

  return Object.freeze({
    import_status_reloaded: true as const,
    import_publication_replayed: true as const,
    published_exact_bytes_reopened: true as const,
    identity_rotation_reloaded: true as const,
    owner_binding_reloaded: true as const,
    privacy_revision_replayed: true as const,
    approved_report_exact_bytes_reloaded: true as const,
  });
}

async function exerciseFailClosedRevocation(
  managers: MarathonRuntimeManagers,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
) {
  const provider = createSyntheticReadOnlyProvider(fixture.report.provider_locator, fixture.report_bytes);
  await withVerifiedRuntimeTransaction(managers.operations, buildIdentitySha, fixture, "operations",
    "boundary-revocation", async (context) => {
    await new PostgresPrivateReportObjectRepository(context.client).revoke({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      object_version_id: fixture.report.object_version_id,
      expected_grant_epoch: 1,
      revocation_receipt_sha256: fixture.privacy_revision_3.grant_revocation_receipt_sha256,
      revoked_at: fixture.timestamps.revoked_at,
      canonical_identity: fixture.report.approved_identity,
    });
    await new PostgresCaseOwnerRepository(context.client).revoke({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
      revoked_at: fixture.timestamps.revoked_at,
    });
    const privacy = await new PostgresPrivacyRequestRepository(context.client)
      .append(fixture.privacy_revision_3);
    assert(privacy.revision === 3 && privacy.state === "completed_by_authorized_operations",
      "MARATHON_V010_PRIVACY_COMPLETION_NOT_PERSISTED");
    const owners = new PostgresCaseOwnerRepository(context.client);
    const owner = await owners.lookup({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
    });
    assert(owner === null, "MARATHON_V010_REVOKED_OWNER_VISIBLE");
    await expectDurableBoundaryError(() => owners.requireActive({
      tenant_id: fixture.identity.tenant_id,
      case_id: fixture.identity.case_id,
      subject: fixture.identity.subject,
    }), "DURABLE_BOUNDARY_OWNER_DENIED");
    const reports = new PostgresPrivateReportObjectRepository(context.client);
    const report = await reports.approvedRead(reportReadInput(fixture));
    assert(report === null, "MARATHON_V010_REVOKED_REPORT_VISIBLE");
    await expectDurableBoundaryError(
      () => new DurableApprovedReportObjectReader(reports, provider.provider).download(reportReadInput(fixture)),
      "DURABLE_BOUNDARY_REPORT_DENIED",
    );
    assert(provider.readCount() === 0, "MARATHON_V010_REVOKED_REPORT_REACHED_PROVIDER");
  });

  await withMaintenanceTransaction(
    managers.maintenance,
    buildIdentitySha,
    fixture.identity.tenant_id,
    async (context) => {
      const sessions = new PostgresIdentitySessionRepository(context.client);
      await sessions.revoke({
        tenant_id: fixture.identity.tenant_id,
        session_id: fixture.identity.session_id,
        revoked_at: fixture.timestamps.revoked_at,
      });
      await expectDurableBoundaryError(() => sessions.rotate({
        tenant_id: fixture.identity.tenant_id,
        session_id: fixture.identity.session_id,
        next_token_id: fixture.identity.rejected_token_id,
        expected_rotation_counter: 1,
        rotated_at: fixture.timestamps.revoked_at,
      }), "DURABLE_BOUNDARY_OPERATION_REJECTED");
    },
  );

  await managers.identity.transaction(async (context) => {
    const session = await new PostgresIdentitySessionRepository(context.client)
      .read(fixture.identity.session_id);
    assert(session?.status === "revoked", "MARATHON_V010_IDENTITY_REVOCATION_NOT_VISIBLE");
  });
  await expectVerifiedRuntimeDenied(() => withVerifiedRuntimeTransaction(
    managers.operations,
    buildIdentitySha,
    fixture,
    "operations",
    "revoked-session-probe",
    async () => undefined,
  ));

  return Object.freeze({
    identity_revoked: true as const,
    revoked_identity_rotation_denied: true as const,
    owner_revoked: true as const,
    owner_read_denied: true as const,
    report_revoked: true as const,
    report_read_denied_before_provider_access: true as const,
    privacy_completion_revision_persisted: true as const,
  });
}

const ROW_DEFINITIONS = Object.freeze([
  rowDefinition("private.controlled_import_requests", "operation_id", statement(
    "marathon_v010_count_import_requests",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from private.controlled_import_requests matrix_row where matrix_row.operation_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("private.controlled_import_artifacts", "operation_id", statement(
    "marathon_v010_count_import_artifacts",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from private.controlled_import_artifacts matrix_row where matrix_row.operation_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("private.controlled_import_audit_events", "operation_id", statement(
    "marathon_v010_count_import_audit",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from private.controlled_import_audit_events matrix_row where matrix_row.operation_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("public.controlled_import_publication_markers", "operation_id", statement(
    "marathon_v010_count_import_publications",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from public.controlled_import_publication_markers matrix_row where matrix_row.operation_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("public.product_identity_sessions", "tenant_id", statement(
    "marathon_v010_count_identity_sessions",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from public.product_identity_sessions matrix_row where matrix_row.tenant_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("public.product_case_owners", "tenant_id", statement(
    "marathon_v010_count_case_owners",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from public.product_case_owners matrix_row where matrix_row.tenant_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("public.product_privacy_request_versions", "tenant_id", statement(
    "marathon_v010_count_privacy_versions",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from public.product_privacy_request_versions matrix_row where matrix_row.tenant_id = $1`,
    ["placeholder"],
  )),
  rowDefinition("public.product_private_report_objects", "tenant_id", statement(
    "marathon_v010_count_report_objects",
    `select count(*)::text as row_count,
      encode(public.digest(coalesce(string_agg(to_jsonb(matrix_row)::text, E'\\n'
        order by to_jsonb(matrix_row)::text), ''), 'sha256'), 'hex') as state_sha256
      from public.product_private_report_objects matrix_row where matrix_row.tenant_id = $1`,
    ["placeholder"],
  )),
]);

async function collectMarathonRows(
  admin: NodePostgresConnectionFactory,
  fixture: MarathonV010DeterministicFixture,
): Promise<readonly MarathonV010TableState[]> {
  const manager = new CanonicalPostgresTransactionManager(admin);
  return manager.transaction(async (context) => {
    const rows: MarathonV010TableState[] = [];
    for (const definition of ROW_DEFINITIONS) {
      const scope = definition.scope === "operation_id"
        ? fixture.import_command.operation_id : fixture.identity.tenant_id;
      const result = await context.client.query(Object.freeze({
        ...definition.query,
        values: Object.freeze([scope]),
      }));
      const row = result.rows[0];
      const rowCount = decimal(row?.row_count);
      const digest = row?.state_sha256;
      assert(result.row_count === 1 && Number.isSafeInteger(rowCount)
        && typeof digest === "string" && HASH.test(digest),
      "MARATHON_V010_ROW_COUNT_MALFORMED");
      rows.push(Object.freeze({ table: definition.table, row_count: rowCount, state_sha256: digest }));
    }
    return Object.freeze(rows);
  });
}

function rowDefinition(
  table: string,
  scope: "operation_id" | "tenant_id",
  query: PostgresStatement,
) {
  return Object.freeze({ table, scope, query });
}

function assertExpectedRows(rows: readonly MarathonV010TableState[], privacyRevisions: 2 | 3): void {
  const expected = new Map<string, number>([
    ["private.controlled_import_requests", 1],
    ["private.controlled_import_artifacts", 1],
    ["private.controlled_import_audit_events", 5],
    ["public.controlled_import_publication_markers", 1],
    ["public.product_identity_sessions", 1],
    ["public.product_case_owners", 1],
    ["public.product_privacy_request_versions", privacyRevisions],
    ["public.product_private_report_objects", 1],
  ]);
  assert(rows.length === expected.size, "MARATHON_V010_ROW_COUNT_TABLE_SET_INVALID");
  for (const row of rows) {
    assert(expected.get(row.table) === row.row_count, `MARATHON_V010_ROW_COUNT_INVALID:${row.table}`);
  }
}

function assertRowsUnchanged(
  actual: readonly MarathonV010TableState[],
  expected: readonly MarathonV010TableState[],
): void {
  assert(canonicalSha256(actual) === canonicalSha256(expected),
    "MARATHON_V010_PRE_RESTART_ROWS_CHANGED");
}

async function withMaintenanceTransaction<T>(
  manager: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  tenantId: string,
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (context) => {
    await context.client.query(Object.freeze({
      ...MAINTENANCE_CONTEXT,
      values: Object.freeze([buildIdentitySha, tenantId, "service_role"]),
    }));
    return operation(context);
  });
}

async function withVerifiedRuntimeTransaction<T>(
  manager: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
  role: MarathonRuntimeRole,
  operationSuffix: string,
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  return manager.transaction(async (context) => {
    await context.client.query(Object.freeze({
      ...RUNTIME_BUILD_CONTEXT,
      values: Object.freeze([buildIdentitySha]),
    }));
    const installed = await context.client.query(Object.freeze({
      ...VERIFIED_RUNTIME_CONTEXT,
      values: Object.freeze([
        fixture.identity.session_id,
        fixture.identity.current_token_id,
        `marathon:${fixture.suffix}:${role}:${operationSuffix}`,
      ]),
    }));
    const row = installed.rows[0];
    assert(installed.row_count === 1 && installed.rows.length === 1
      && row?.tenant_id === fixture.identity.tenant_id
      && row.actor_id === fixture.identity.subject
      && row.runtime_role === role
      && row.reviewer_organization_id === fixture.identity.reviewer_organization_id
      && row.session_rotation_counter === "1",
    "MARATHON_V010_VERIFIED_RUNTIME_CONTEXT_INVALID");
    return operation(context);
  });
}

async function assertCanonicalReportIdentityForWorker(
  operations: CanonicalPostgresTransactionManager,
  buildIdentitySha: string,
  fixture: MarathonV010DeterministicFixture,
): Promise<void> {
  await withVerifiedRuntimeTransaction(operations, buildIdentitySha, fixture, "operations",
    "worker-report-identity", async (context) => {
    const identity = await new PostgresPrivateReportObjectRepository(context.client)
      .currentCanonicalIdentity({
        tenant_id: fixture.identity.tenant_id,
        case_id: fixture.identity.case_id,
        report_id: fixture.report.report_id,
        report_revision: fixture.report.report_revision,
        download_grant_revision: 0,
      });
    assert(identity?.identity_sha256 === fixture.report.staged_identity.identity_sha256,
      "MARATHON_V010_WORKER_REPORT_IDENTITY_INVALID");
  });
}

async function bindReportAsWorker(
  context: PostgresTransactionContext,
  fixture: MarathonV010DeterministicFixture,
): Promise<Readonly<{ object_version_id: string }>> {
  const result = await context.client.query(durableBoundaryStatements.reportBind([
    fixture.identity.tenant_id,
    fixture.identity.case_id,
    fixture.report.report_id,
    fixture.report.report_revision,
    fixture.report.report_sha256,
    fixture.report.object_version_id,
    fixture.report.provider_locator,
    fixture.report.byte_length,
    fixture.report.artifact_sha256,
    fixture.timestamps.created_at,
  ]));
  const row = result.rows[0];
  assert(result.row_count === 1 && result.rows.length === 1
    && row?.tenant_id === fixture.identity.tenant_id
    && row.canonical_case_id === fixture.identity.case_id
    && row.report_id === fixture.report.report_id
    && decimal(row.report_revision) === fixture.report.report_revision
    && row.report_sha256 === fixture.report.report_sha256
    && row.object_version_id === fixture.report.object_version_id
    && row.provider_locator === fixture.report.provider_locator
    && decimal(row.byte_length) === fixture.report.byte_length
    && row.artifact_sha256 === fixture.report.artifact_sha256
    && row.state === "staged"
    && decimal(row.grant_epoch) === 0
    && row.revocation_receipt_sha256 === null
    && row.revoked_at === null
    && row.created_at === fixture.timestamps.created_at,
  "MARATHON_V010_WORKER_REPORT_BIND_INVALID");
  return Object.freeze({ object_version_id: fixture.report.object_version_id });
}

async function assertReportReadableAsWorker(
  context: PostgresTransactionContext,
  fixture: MarathonV010DeterministicFixture,
): Promise<void> {
  const result = await context.client.query(durableBoundaryStatements.reportApprovedRead([
    fixture.identity.tenant_id,
    fixture.identity.case_id,
    fixture.report.report_id,
    fixture.report.report_revision,
    fixture.report.report_sha256,
    fixture.report.artifact_sha256,
  ]));
  const row = result.rows[0];
  assert(result.row_count === 1 && result.rows.length === 1
    && row?.object_version_id === fixture.report.object_version_id
    && row.provider_locator === fixture.report.provider_locator
    && decimal(row.byte_length) === fixture.report.byte_length
    && row.artifact_sha256 === fixture.report.artifact_sha256
    && decimal(row.grant_epoch) === 1,
  "MARATHON_V010_WORKER_REPORT_READ_INVALID");
}

async function expectVerifiedRuntimeDenied(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CanonicalPostgresError && error.sqlstate === "42501") return;
    throw error;
  }
  throw new Error("MARATHON_V010_REVOKED_RUNTIME_CONTEXT_ACCEPTED");
}

async function withAutocommitContext<T>(
  factory: PostgresConnectionFactory,
  operation: (context: PostgresTransactionContext) => Promise<T>,
): Promise<T> {
  const client = await factory.acquire();
  try {
    return await operation(Object.freeze({ client, transaction_id: "marathon-v010-autocommit-probe" }));
  } finally {
    await client.release();
  }
}

async function expectSqlstate(
  factory: PostgresConnectionFactory,
  query: PostgresStatement,
  sqlstate: "CI001" | "CI002",
): Promise<void> {
  await withAutocommitContext(factory, async (context) => {
    try {
      await context.client.query(query);
    } catch (error) {
      if (error instanceof CanonicalPostgresError && error.sqlstate === sqlstate) return;
      throw error;
    }
    throw new Error(`MARATHON_V010_EXPECTED_SQLSTATE_MISSING:${sqlstate}`);
  });
}

async function expectControlledImportError(
  operation: () => Promise<unknown>,
  code: ControlledImportLedgerError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ControlledImportLedgerError && error.code === code) return;
    throw error;
  }
  throw new Error(`MARATHON_V010_EXPECTED_IMPORT_ERROR_MISSING:${code}`);
}

async function expectDurableBoundaryError(
  operation: () => Promise<unknown>,
  code: DurableBoundaryError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DurableBoundaryError && error.code === code) return;
    throw error;
  }
  throw new Error(`MARATHON_V010_EXPECTED_BOUNDARY_ERROR_MISSING:${code}`);
}

async function expectCanonicalReportIdentityError(
  operation: () => Promise<unknown>,
  code: CanonicalReportIdentityError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CanonicalReportIdentityError && error.code === code) return;
    throw error;
  }
  throw new Error(`MARATHON_V010_EXPECTED_REPORT_IDENTITY_ERROR_MISSING:${code}`);
}

function immutableExactSource(bytes: Uint8Array, identityToken: string): ExactByteReopenSource {
  return Object.freeze({
    reopenExact: async () => Object.freeze({ bytes: Uint8Array.from(bytes), identity_token: identityToken }),
  });
}

function changingExactSource(bytes: Uint8Array, identityToken: string): ExactByteReopenSource {
  let reads = 0;
  return Object.freeze({
    reopenExact: async () => {
      reads += 1;
      const value = Uint8Array.from(bytes);
      if (reads > 1) value[value.byteLength - 1] = (value[value.byteLength - 1] ?? 0) ^ 1;
      return Object.freeze({ bytes: value, identity_token: identityToken });
    },
  });
}

function createSyntheticReadOnlyProvider(locator: string, bytes: Uint8Array): Readonly<{
  provider: PrivateBlobProvider;
  readCount(): number;
}> {
  let reads = 0;
  const sha256 = byteSha256(bytes);
  const unsupported = async (): Promise<never> => {
    throw new Error("MARATHON_SYNTHETIC_PROVIDER_READ_ONLY");
  };
  const provider: PrivateBlobProvider = Object.freeze({
    provider_kind: "hermetic_filesystem" as const,
    managed_platform_verified: false,
    putQuarantined: unsupported,
    promoteQuarantined: unsupported,
    readExact: async (input) => {
      reads += 1;
      if (input.locator !== locator || input.expected_sha256 !== sha256
        || input.expected_length !== bytes.byteLength) {
        throw new Error("MARATHON_SYNTHETIC_PROVIDER_BINDING_MISMATCH");
      }
      return Uint8Array.from(bytes);
    },
    deleteExact: unsupported,
    inventory: async (): Promise<readonly PrivateBlobInventoryEntry[]> => Object.freeze([]),
  });
  return Object.freeze({ provider, readCount: () => reads });
}

function reportReadInput(fixture: MarathonV010DeterministicFixture) {
  return Object.freeze({
    tenant_id: fixture.identity.tenant_id,
    case_id: fixture.identity.case_id,
    report_id: fixture.report.report_id,
    report_revision: fixture.report.report_revision,
    report_sha256: fixture.report.report_sha256,
    artifact_sha256: fixture.report.artifact_sha256,
    canonical_identity: fixture.report.approved_identity,
  });
}

function requiredLease(leases: readonly ControlledImportLease[], operationId: string): ControlledImportLease {
  const lease = leases.find((candidate) => candidate.operation_id === operationId);
  assert(lease !== undefined, "MARATHON_V010_IMPORT_LEASE_MISSING");
  return lease;
}

function assertCapabilitySeed(capability: CapabilityMatrixReceipt, fixtureSuffix: string): void {
  assert(capability.matrix.length === 14 && capability.matrix.every((row) => row.status === "PASS"),
    "MARATHON_V010_CAPABILITY_SEED_FAILED");
  assert(capability.findings_persisted === 0 && capability.customer_documents_used === 0
    && capability.real_legal_activations === 0, "MARATHON_V010_CAPABILITY_TRUTH_COUNTER_INVALID");
  assert(capability.durable_state.fixture_suffix === fixtureSuffix,
    "MARATHON_V010_CAPABILITY_FIXTURE_SUFFIX_MISMATCH");
  assertDurableCapabilityState(capability.durable_state);
}

function assertDurableCapabilityState(
  state: DurableCapabilityState,
): ReturnType<typeof createSyntheticCapabilityFixtures> {
  const { durable_state_sha256: stateSha256, ...seed } = state;
  assert(canonicalSha256(seed) === stateSha256, "MARATHON_V010_DURABLE_STATE_HASH_INVALID");
  const fixture = createSyntheticCapabilityFixtures(state.fixture_suffix);
  assert(fixture.tenant_id === state.tenant_id && fixture.case_id === state.case_id
    && fixture.analysis_run_id === state.analysis_run_id && fixture.report_id === state.report_id
    && fixture.report_artifacts.report_sha256 === state.report_sha256
    && fixture.review_task_id === state.review_task_id && fixture.job_id === state.job_id
    && fixture.outbox_id === state.outbox_id && fixture.idempotency_key === state.idempotency_key,
  "MARATHON_V010_DURABLE_STATE_IDENTITY_INVALID");
  return fixture;
}

function assertCheckpoint(checkpoint: MarathonV010Checkpoint): void {
  const { checkpoint_sha256: checkpointSha256, ...seed } = checkpoint;
  assert(canonicalSha256(seed) === checkpointSha256, "MARATHON_V010_CHECKPOINT_HASH_INVALID");
  assert(checkpoint.schema_version === "tivdoc-marathon-v010-postgresql-checkpoint-v1"
    && checkpoint.tenant_ordinal === 3 && BUILD_IDENTITY.test(checkpoint.build_identity_sha)
    && FIXTURE_SUFFIX.test(checkpoint.fixture_suffix) && HASH.test(checkpoint.import_artifact_sha256)
    && HASH.test(checkpoint.import_publication_id) && HASH.test(checkpoint.import_publication_receipt_sha256),
  "MARATHON_V010_CHECKPOINT_CONTRACT_INVALID");
  assert(canonicalSha256(checkpoint.runtime_boundary) === canonicalSha256(MARATHON_V010_RUNTIME_BOUNDARY),
    "MARATHON_V010_CHECKPOINT_RUNTIME_BOUNDARY_INVALID");
  assertDurableCapabilityState(checkpoint.capability_state);
}

function assertCheckpointMatchesFixture(
  checkpoint: MarathonV010Checkpoint,
  fixture: MarathonV010DeterministicFixture,
): void {
  assert(checkpoint.fixture_suffix === fixture.suffix
    && checkpoint.import_command.operation_id === fixture.import_command.operation_id
    && checkpoint.import_artifact_sha256 === fixture.import_artifact_sha256
    && checkpoint.import_byte_count === fixture.import_bytes.byteLength
    && checkpoint.identity.tenant_id === fixture.identity.tenant_id
    && checkpoint.identity.case_id === fixture.identity.case_id
    && checkpoint.identity.session_id === fixture.identity.session_id
    && checkpoint.identity.subject === fixture.identity.subject
    && checkpoint.identity.current_token_id === fixture.identity.current_token_id
    && checkpoint.report.report_id === fixture.report.report_id
    && checkpoint.report.report_sha256 === fixture.report.report_sha256
    && checkpoint.report.artifact_sha256 === fixture.report.artifact_sha256
    && checkpoint.report.canonical_identity.identity_sha256 === fixture.report.approved_identity.identity_sha256
    && checkpoint.report.bytes_base64 === Buffer.from(fixture.report_bytes).toString("base64")
    && checkpoint.before_restart_rows_sha256 === canonicalSha256(checkpoint.before_restart_rows),
  "MARATHON_V010_CHECKPOINT_FIXTURE_MISMATCH");
}

function assertBeforeInput(input: MarathonV010BeforeRestartInput): void {
  assert(input.tenant_ordinal === 3 && BUILD_IDENTITY.test(input.build_identity_sha)
    && FIXTURE_SUFFIX.test(input.fixture_suffix), "MARATHON_V010_INPUT_INVALID");
}

function assertRestartObservation(input: MarathonV010AfterRestartInput["restart_observation"]): void {
  assert(input.externally_managed_genuine_stop_start === true
    && input.same_cluster_restarted === true && input.all_pre_restart_pools_closed === true,
  "MARATHON_V010_GENUINE_RESTART_OBSERVATION_REQUIRED");
}

function createDriver(connectionUrl: string, applicationName: string): NodePostgresConnectionFactory {
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: 8,
    connection_timeout_ms: 5_000,
    application_name: applicationName,
  });
}

function assertSameTarget(
  expectedTargetId: string,
  ...drivers: readonly NodePostgresConnectionFactory[]
): void {
  const reference = drivers[0]?.target;
  assert(reference !== undefined && drivers.length >= 2 && drivers.every((driver) =>
    driver.target.target_id === expectedTargetId
      && driver.target.host === reference.host
      && driver.target.port === reference.port
      && driver.target.database === reference.database), "MARATHON_V010_POSTGRES_TARGET_MISMATCH");
}

async function closeDrivers(...drivers: readonly NodePostgresConnectionFactory[]): Promise<void> {
  let firstError: unknown = null;
  for (const driver of drivers) {
    try {
      await driver.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, code: string): void {
  assert(Buffer.from(actual).equals(Buffer.from(expected)), code);
}

function byteSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decimal(value: unknown): number {
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : Number.NaN;
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
