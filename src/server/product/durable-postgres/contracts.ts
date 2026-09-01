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
  status: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED" | "BLOCKED_COMPOSITION";
  exact_reason: string;
  requested_migration_or_wiring: string;
  installed_contract_path: string | null;
  safe_behavior: "FAIL_CLOSED";
}>;

/** Machine-readable installation/composition receipts; none may be treated as a rendered journey claim. */
export const DURABLE_PRODUCT_BLOCKERS: readonly DurableProductBlocker[] = Object.freeze([
  Object.freeze({
    blocker_id: "W2_DURABLE_IDENTITY_SESSION_NOT_WIRED",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
    exact_reason: "The typed adapter and installed forward migration are present and fail-closed; the stable rendered product composition does not provide the canonical PostgreSQL connection factory.",
    requested_migration_or_wiring: "Wire the canonical PostgreSQL connection factory into the stable product composition; never substitute an in-memory session cache.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_CUSTOMER_OWNER_BINDING_NOT_WIRED",
    acceptance_ids: Object.freeze(["MC-06"] as const),
    status: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
    exact_reason: "The typed exact-owner adapter and installed server-only table/functions are present and fail-closed; stable product composition does not call them.",
    requested_migration_or_wiring: "Wire the adapter only after canonical identity verification.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVACY_WORKFLOW_NOT_WIRED",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
    exact_reason: "The typed revisioned privacy adapter and installed append-only ledger are present and fail-closed; privacy-request HTTP composition does not call them.",
    requested_migration_or_wiring: "Wire the installed adapter before enabling privacy-request HTTP composition.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVATE_REPORT_OBJECT_METADATA_NOT_WIRED",
    acceptance_ids: Object.freeze(["MC-06", "MC-08"] as const),
    status: "IMPLEMENTED_SCHEMA_INSTALLED_NOT_WIRED",
    exact_reason: "The typed exact-object adapter, integrity reader and installed durable metadata contract are present and fail-closed; stable report delivery does not call them.",
    requested_migration_or_wiring: "Wire the adapter to the verified private-storage provider before report delivery.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_RENDERED_NEXT_COMPOSITION_BOOTSTRAP_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "BLOCKED_COMPOSITION",
    exact_reason: "Stable Next routes still resolve their pre-existing test runtime; no non-test startup path installs the canonical PostgreSQL product composition and canonical identity session verifier.",
    requested_migration_or_wiring: "Wire one server bootstrap to install the durable product adapters and canonical verifier, then run rendered browser E2E.",
    installed_contract_path: null,
    safe_behavior: "FAIL_CLOSED",
  }),
]);
