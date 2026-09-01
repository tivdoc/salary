import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { VerifiedProductIdentity } from "../auth/identity-session.ts";

export const DURABLE_PRODUCT_SCHEMA_VERSION = "tivdoc-durable-product-postgresql-v0.10.0" as const;

export const DURABLE_PRODUCT_CAPABILITIES = Object.freeze([
  "W2_POSTGRES_CASE_REVISION",
  "W2_EXACT_REPORT_APPROVAL",
  "W2_DURABLE_JOB_RECOVERY",
  "W2_OUTBOX_LOGICAL_EFFECT_DEDUPLICATION",
  "W2_APPROVED_EXACT_BYTE_DOWNLOAD",
  "W2_AUDIT_CHAIN_CONTINUITY",
  "MC_09_NO_PRODUCT_MEMORY_FALLBACK",
] as const);

export type DurableProductCapability = (typeof DURABLE_PRODUCT_CAPABILITIES)[number];

export type DurableCaseScope = Readonly<{
  tenant_id: string;
  case_id: string;
}>;

export type DurableReportReference = Readonly<{
  report_id: string;
  report_revision: number;
  report_sha256: string;
  pdf_sha256: string;
}>;

export type DurablePipelineReference = Readonly<{
  analysis_run_id: string;
  job_id: string;
  outbox_id: string;
  logical_effect_id: string;
  logical_effect_sha256: string;
}>;

export type DurableApprovalInput = DurableCaseScope & Readonly<{
  identity: VerifiedProductIdentity;
  report: DurableReportReference;
  task_id: string;
  idempotency_key: string;
  expected_revision: number;
  decided_at: string;
  reason: string;
}>;

export type DurableApprovalReceipt = Readonly<{
  schema_version: typeof DURABLE_PRODUCT_SCHEMA_VERSION;
  case_id: string;
  case_revision: number;
  report_sha256: string;
  command_sha256: string;
  audit_event_sha256: string;
  idempotent_replay: boolean;
  export_eligible: true;
}>;

export type DurableWorkerReceipt = Readonly<{
  schema_version: typeof DURABLE_PRODUCT_SCHEMA_VERSION;
  case_id: string;
  job_id: string;
  job_revision: number;
  job_state: "running" | "succeeded";
  fencing_token: number;
  logical_effect_sha256: string | null;
  outbox_published: boolean;
  audit_event_sha256: string | null;
}>;

export type DurableDownloadReceipt = Readonly<{
  schema_version: typeof DURABLE_PRODUCT_SCHEMA_VERSION;
  report: DurableReportReference;
  bytes: Uint8Array;
  content_type: "application/pdf";
}>;

export type DurableProductSnapshot = Readonly<{
  schema_version: typeof DURABLE_PRODUCT_SCHEMA_VERSION;
  case_revision: number;
  lifecycle_state: string;
  report_versions: number;
  approval_versions: number;
  durable_jobs: number;
  outbox_events: number;
  logical_effects: number;
  audit_events: number;
  audit_chain_valid: boolean;
  audit_tail_sha256: string | null;
}>;

export type DurableProductActor = VerifiedActor;

export type DurableProductBlocker = Readonly<{
  blocker_id: string;
  acceptance_ids: readonly ("MC-06" | "MC-07" | "MC-08")[];
  status: "BLOCKED_SCHEMA" | "BLOCKED_COMPOSITION";
  exact_reason: string;
  requested_migration_or_wiring: string;
  safe_behavior: "FAIL_CLOSED";
}>;

/**
 * Exact non-claims for schema/wiring that does not exist in the frozen V0.9
 * migration chain. Keeping these machine-readable prevents a PostgreSQL-only
 * subset from being mislabeled as a complete rendered product journey.
 */
export const DURABLE_PRODUCT_BLOCKERS: readonly DurableProductBlocker[] = Object.freeze([
  Object.freeze({
    blocker_id: "W2_DURABLE_IDENTITY_SESSION_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "BLOCKED_SCHEMA",
    exact_reason: "No canonical PostgreSQL table/adapter persists sid, current jti, rotation, valid-after, expiry, revocation and reviewer-organization session state.",
    requested_migration_or_wiring: "Add an append-safe canonical identity-session migration and IdentitySessionStateReader adapter before restart-continuous product sessions are enabled.",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_CUSTOMER_OWNER_BINDING_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06"] as const),
    status: "BLOCKED_SCHEMA",
    exact_reason: "The canonical case schema has tenant/case scope but no durable verified-subject to customer-owner binding.",
    requested_migration_or_wiring: "Add a tenant-scoped immutable owner binding consumed only after canonical identity verification.",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVACY_WORKFLOW_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "BLOCKED_SCHEMA",
    exact_reason: "The frozen migration chain has no durable privacy-request revision/idempotency/legal-hold-conflict workflow.",
    requested_migration_or_wiring: "Add a revisioned privacy-request ledger with legal-hold conflict and grant-revocation bindings.",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVATE_REPORT_OBJECT_METADATA_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-08"] as const),
    status: "BLOCKED_SCHEMA",
    exact_reason: "Report rows persist deterministic artifacts, but no durable provider locator/length/grant/revocation metadata binds them to the new private-storage provider across restart.",
    requested_migration_or_wiring: "Add immutable report-object metadata and durable private-grant/revocation bindings before claiming storage-backed report delivery.",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_RENDERED_NEXT_COMPOSITION_BOOTSTRAP_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "BLOCKED_COMPOSITION",
    exact_reason: "Stable Next routes still resolve their pre-existing test runtime; no non-test startup path installs the canonical PostgreSQL product composition and canonical identity session verifier.",
    requested_migration_or_wiring: "Wire one server bootstrap to install the durable product adapters and canonical verifier, then run rendered browser E2E.",
    safe_behavior: "FAIL_CLOSED",
  }),
]);
