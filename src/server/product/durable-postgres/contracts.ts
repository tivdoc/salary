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
  status: "IMPLEMENTED_REQUIRES_MIGRATION_INSTALLATION" | "BLOCKED_COMPOSITION";
  exact_reason: string;
  requested_migration_or_wiring: string;
  installed_contract_path: string | null;
  safe_behavior: "FAIL_CLOSED";
}>;

/** Machine-readable installation/composition receipts; none may be treated as a rendered journey claim. */
export const DURABLE_PRODUCT_BLOCKERS: readonly DurableProductBlocker[] = Object.freeze([
  Object.freeze({
    blocker_id: "W2_DURABLE_IDENTITY_SESSION_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "IMPLEMENTED_REQUIRES_MIGRATION_INSTALLATION",
    exact_reason: "The typed adapter is present and fail-closed; it cannot operate until the forward-only durable-product migration is installed by the integration branch.",
    requested_migration_or_wiring: "Install the declared migration and provide the canonical PostgreSQL connection factory; never substitute an in-memory session cache.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_CUSTOMER_OWNER_BINDING_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06"] as const),
    status: "IMPLEMENTED_REQUIRES_MIGRATION_INSTALLATION",
    exact_reason: "The typed exact-owner adapter is present and fail-closed; its server-only table/functions require installation by the integration branch.",
    requested_migration_or_wiring: "Install the declared migration and wire the adapter only after canonical identity verification.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVACY_WORKFLOW_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-07"] as const),
    status: "IMPLEMENTED_REQUIRES_MIGRATION_INSTALLATION",
    exact_reason: "The typed revisioned privacy adapter is present and fail-closed; its append-only ledger requires installation by the integration branch.",
    requested_migration_or_wiring: "Install the declared migration before enabling privacy-request HTTP composition.",
    installed_contract_path: "supabase/migrations/202609010002_durable_product_boundaries.sql",
    safe_behavior: "FAIL_CLOSED",
  }),
  Object.freeze({
    blocker_id: "W2_PRIVATE_REPORT_OBJECT_METADATA_SCHEMA_ABSENT",
    acceptance_ids: Object.freeze(["MC-06", "MC-08"] as const),
    status: "IMPLEMENTED_REQUIRES_MIGRATION_INSTALLATION",
    exact_reason: "The typed exact-object adapter and integrity reader are present and fail-closed; their durable metadata contract requires installation by the integration branch.",
    requested_migration_or_wiring: "Install the declared migration and wire it to the verified private-storage provider before report delivery.",
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
