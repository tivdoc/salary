import type { V07Role } from "../../../engine/wave4/contracts";

export const PLATFORM_SCHEMA_VERSION = "tivdoc-engine-platform-v0.7.0" as const;

export const REPOSITORY_ENTITIES = [
  "cases",
  "lifecycle_revisions",
  "payment_evidence_references",
  "documents",
  "extractions",
  "canonical_facts",
  "rule_inputs",
  "legal_version_pins",
  "analysis_runs",
  "analysis_stages",
  "topic_results",
  "calculation_traces",
  "reports",
  "review_tasks",
  "idempotency_records",
  "jobs",
  "outbox",
  "audit_events",
  "object_write_reservations",
] as const;

export type RepositoryEntity = (typeof REPOSITORY_ENTITIES)[number];
export type RetentionClass = "case_record" | "legal_record" | "report_record" | "audit_record" | "operational";

export type RepositoryMapping = Readonly<{
  entity: RepositoryEntity;
  table: string;
  primary_key: readonly string[];
  tenant_ownership: "tenant_id" | "through_case";
  case_ownership: "case_id" | "through_document" | "through_analysis_run" | "not_applicable";
  revision_column: string | null;
  hash_column: string;
  retention_class: RetentionClass;
  authorized_actors: readonly V07Role[];
  delete_behavior: "restrict" | "append_only";
}>;

const worker = ["scoped_background_worker"] as const;
const reviewers = ["extraction_reviewer", "fact_reviewer", "legal_reviewer", "report_approver"] as const;

export const CANONICAL_REPOSITORY_MAPPING: readonly RepositoryMapping[] = Object.freeze([
  map("cases", "engine_case_state", ["case_id"], "tenant_id", "case_id", "revision", "state_sha256", "case_record", ["intake_operator", ...worker], "append_only"),
  map("lifecycle_revisions", "engine_case_lifecycle_revisions", ["case_id", "revision"], "through_case", "case_id", "revision", "event_sha256", "audit_record", ["intake_operator", ...worker], "append_only"),
  map("payment_evidence_references", "engine_payment_evidence_refs", ["case_id", "evidence_id", "evidence_revision"], "through_case", "case_id", "evidence_revision", "evidence_sha256", "case_record", [...worker], "append_only"),
  map("documents", "documents", ["id"], "through_case", "case_id", null, "content_sha256", "case_record", ["intake_operator", ...worker], "restrict"),
  map("extractions", "document_extractions", ["id"], "through_case", "through_document", null, "source_content_sha256", "case_record", ["extraction_reviewer", ...worker], "append_only"),
  map("canonical_facts", "engine_canonical_fact_versions", ["fact_id", "revision"], "through_case", "case_id", "revision", "payload_sha256", "case_record", ["fact_reviewer", ...worker], "append_only"),
  map("rule_inputs", "engine_rule_input_versions", ["rule_input_id", "revision"], "through_case", "case_id", "revision", "payload_sha256", "case_record", ["fact_reviewer", ...worker], "append_only"),
  map("legal_version_pins", "engine_legal_version_pins", ["analysis_run_id", "pin_kind", "version_id"], "through_case", "case_id", null, "version_sha256", "legal_record", ["legal_reviewer", ...worker], "restrict"),
  map("analysis_runs", "analysis_runs", ["id"], "through_case", "case_id", null, "input_snapshot_hash", "case_record", [...worker], "append_only"),
  map("analysis_stages", "engine_analysis_stage_versions", ["analysis_run_id", "stage"], "through_case", "case_id", null, "payload_sha256", "case_record", [...worker], "append_only"),
  map("topic_results", "engine_topic_result_versions", ["analysis_run_id", "topic"], "through_case", "case_id", null, "result_sha256", "case_record", [...worker], "append_only"),
  map("calculation_traces", "engine_calculation_trace_versions", ["trace_id"], "through_case", "case_id", null, "trace_sha256", "case_record", [...worker], "append_only"),
  map("reports", "engine_report_versions", ["report_id", "revision"], "through_case", "case_id", "revision", "report_sha256", "report_record", ["report_approver", ...worker], "append_only"),
  map("review_tasks", "engine_review_task_versions", ["task_id", "revision"], "through_case", "case_id", "revision", "task_sha256", "audit_record", [...reviewers], "append_only"),
  map("idempotency_records", "engine_idempotency_records", ["tenant_id", "scope", "idempotency_key"], "tenant_id", "case_id", null, "command_sha256", "operational", [...worker], "restrict"),
  map("jobs", "engine_durable_jobs", ["job_id"], "tenant_id", "case_id", "revision", "payload_sha256", "operational", [...worker], "append_only"),
  map("outbox", "engine_outbox_events", ["outbox_id"], "tenant_id", "case_id", null, "payload_sha256", "operational", [...worker], "append_only"),
  map("audit_events", "engine_platform_audit_events", ["sequence"], "tenant_id", "case_id", null, "event_sha256", "audit_record", ["auditor", ...worker], "append_only"),
  map("object_write_reservations", "engine_object_write_sagas", ["reservation_id"], "tenant_id", "case_id", "revision", "expected_sha256", "case_record", ["intake_operator", ...worker], "append_only"),
]);

function map(
  entity: RepositoryEntity,
  table: string,
  primary_key: readonly string[],
  tenant_ownership: RepositoryMapping["tenant_ownership"],
  case_ownership: RepositoryMapping["case_ownership"],
  revision_column: string | null,
  hash_column: string,
  retention_class: RetentionClass,
  authorized_actors: readonly V07Role[],
  delete_behavior: RepositoryMapping["delete_behavior"],
): RepositoryMapping {
  return Object.freeze({ entity, table, primary_key, tenant_ownership, case_ownership, revision_column, hash_column, retention_class, authorized_actors, delete_behavior });
}

export type PlatformErrorCode =
  | "CASE_REVISION_CONFLICT"
  | "ENTITY_REVISION_CONFLICT"
  | "IDEMPOTENCY_KEY_COMMAND_MISMATCH"
  | "PAYLOAD_HASH_MISMATCH"
  | "RECORD_NOT_FOUND"
  | "IMMUTABLE_VERSION_MISMATCH"
  | "STALE_FENCING_TOKEN"
  | "INVALID_STATE_TRANSITION"
  | "LOGICAL_EFFECT_MISMATCH"
  | "PINNED_VERSION_UNAVAILABLE"
  | "OBJECT_STAGE_INVALID"
  | "INJECTED_FAILURE";

export class PlatformPersistenceError extends Error {
  readonly code: PlatformErrorCode;
  readonly detail: string | null;

  constructor(code: PlatformErrorCode, detail: string | null = null) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "PlatformPersistenceError";
    this.code = code;
    this.detail = detail;
  }
}

export type DurableRecord = Readonly<{
  entity: RepositoryEntity;
  tenant_id: string;
  case_id: string | null;
  record_id: string;
  revision: number;
  payload_sha256: string;
  payload: unknown;
  visible: boolean;
  created_at: string;
}>;

export type DomainWrite = Readonly<{
  entity: Exclude<RepositoryEntity, "idempotency_records" | "jobs" | "outbox" | "audit_events" | "object_write_reservations">;
  record_id: string;
  expected_revision: number;
  payload_sha256: string;
  payload: unknown;
  visible?: boolean;
}>;

export type AtomicCommand = Readonly<{
  tenant_id: string;
  case_id: string;
  actor_id: string;
  scope: string;
  idempotency_key: string;
  expected_case_revision: number;
  command_sha256: string;
  command: unknown;
  occurred_at: string;
  writes: readonly DomainWrite[];
  invalidates: readonly Readonly<{ entity: DurableRecord["entity"]; record_id: string; expected_revision: number }>[];
  outbox: readonly Readonly<{ logical_effect_id: string; effect_kind: string; payload_sha256: string; payload: unknown }>[];
}>;

export type TransactionReceipt = Readonly<{
  tenant_id: string;
  case_id: string;
  case_revision: number;
  command_sha256: string;
  audit_event_sha256: string;
  outbox_ids: readonly string[];
  idempotent_replay: boolean;
}>;
