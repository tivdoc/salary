import type { FactPath } from "../../../engine/facts/fact-paths";
import type { CaseLifecycleState } from "../../../engine/wave3/contracts";
import type { ServerFeatureFlagPort, VerifiedActor } from "../../../engine/wave4/contracts";

export const PORTAL_SCHEMA_VERSION = "tivdoc-customer-portal-v0.7.0" as const;
export type PortalRuntimeMode = "test" | "development" | "production";
export type CustomerSafeStatus =
  | "awaiting_payment"
  | "awaiting_documents"
  | "under_review"
  | "clarification_needed"
  | "blocked"
  | "report_available"
  | "hold"
  | "closed";

export type DocumentReferenceStatus = "awaiting_upload" | "received" | "processing" | "needs_review" | "accepted" | "rejected";
export type ClarificationOrigin = "missing_fact" | "conflicted_fact" | "legal_input_requirement" | "human_operations_request";
export type ReportEdition = "screening_summary" | "full_reviewed_report";
export type PrivacyRequestKind = "data_export" | "correction" | "deletion";

export type PortalCaseRecord = Readonly<{
  case_id: string;
  tenant_id: string;
  owner_actor_id: string;
  revision: number;
  lifecycle_state: CaseLifecycleState;
  lifecycle_history: readonly Readonly<{
    revision: number;
    lifecycle_state: CaseLifecycleState;
    occurred_at: string;
  }>[];
  blocker_codes: readonly string[];
  document_references: readonly Readonly<{
    document_id: string;
    declared_type: string;
    status: DocumentReferenceStatus;
    revision: number;
  }>[];
  retention: Readonly<{ retention_class: string; legal_hold: boolean; deletion_status: "not_requested" | "requested" | "restricted_by_hold" }>;
}>;

export type PortalCaseProjection = Readonly<{
  schema_version: typeof PORTAL_SCHEMA_VERSION;
  case_id: string;
  revision: number;
  status: CustomerSafeStatus;
  status_label_he: string;
  status_timeline: readonly Readonly<{
    revision: number;
    status: CustomerSafeStatus;
    status_label_he: string;
    occurred_at: string;
  }>[];
  blocker_codes: readonly string[];
  document_references: PortalCaseRecord["document_references"];
  clarification_tasks: readonly CustomerClarificationTask[];
  reports: readonly CustomerReportProjection[];
  retention: PortalCaseRecord["retention"];
  projection_sha256: string;
}>;

export type ClarificationFactState = Readonly<{
  fact_path: FactPath;
  status: "missing" | "conflicted";
  fact_ids: readonly string[];
  state_sha256: string;
}>;

export type LegalInputRequirement = Readonly<{
  requirement_id: string;
  requirement_version: string;
  fact_path: FactPath;
  requirement_sha256: string;
}>;

export type CustomerClarificationTask = Readonly<{
  task_id: string;
  case_id: string;
  fact_path: FactPath;
  origin: ClarificationOrigin;
  question_code: string;
  question_version: number;
  prompt_he: string;
  dependency_sha256: string;
  conflicting_fact_ids: readonly string[];
  status: "open" | "answered" | "invalidated";
  requires_human_review: true;
  task_sha256: string;
}>;

export type DeclaredFactCandidate = Readonly<{
  candidate_id: string;
  case_id: string;
  fact_path: FactPath;
  revision: number;
  value: unknown;
  status: "candidate";
  provenance: Readonly<{
    source_type: "declared";
    source_reference: Readonly<{
      kind: "portal_clarification_answer";
      answer_id: string;
      question_id: string;
      question_version: number;
      consent_version: string;
      terms_version: string;
      explicit_confirmation: true;
    }>;
  }>;
  conflicting_documented_fact_ids: readonly string[];
  requires_human_review: true;
  candidate_sha256: string;
}>;

export type VerifiedProductEvidence = Readonly<{
  evidence_id: string;
  evidence_sha256: string;
  case_id: string;
  owner_actor_id: string;
  edition: ReportEdition;
  status: "verified" | "revoked" | "refunded" | "chargeback";
  source: "verified_server_evidence";
}>;

export type StoredReportEdition = Readonly<{
  report_id: string;
  report_revision: number;
  case_id: string;
  edition: ReportEdition;
  report_sha256: string;
  artifact_sha256: string;
  object_version_id: string;
  release_receipt_sha256: string | null;
  release_state: "pending_review" | "released" | "invalidated" | "hold";
  coverage_complete: boolean;
  blocker_codes: readonly string[];
  created_at: string;
}>;

export type CustomerReportProjection = Readonly<{
  report_id: string;
  report_revision: number;
  edition: ReportEdition;
  report_sha256: string;
  scope_status: "complete_reviewed" | "screening_with_blockers";
  blocker_codes: readonly string[];
  customer_message_he: string;
  released: true;
}>;

export type ConsentRevision = Readonly<{
  consent_id: string;
  case_id: string;
  revision: number;
  consent_version: string;
  terms_version: string;
  granted: boolean;
  occurred_at: string;
  receipt_sha256: string;
}>;

export type PrivacyRequestRevision = Readonly<{
  request_id: string;
  case_id: string;
  request_kind: PrivacyRequestKind;
  revision: number;
  status: "requested" | "acknowledged" | "restricted_by_legal_hold" | "completed_by_authorized_operations";
  idempotency_key: string;
  command_sha256: string;
  receipt_sha256: string;
  created_at: string;
}>;

export type PortalAuditReceipt = Readonly<{
  sequence: number;
  case_id: string;
  actor_id: string;
  action: string;
  resource_sha256: string;
  previous_sha256: string | null;
  occurred_at: string;
  receipt_sha256: string;
}>;

export type UploadSession = Readonly<{
  upload_session_id: string;
  case_id: string;
  document_id: string;
  expected_sha256: string;
  expected_length: number;
  detected_mime: string;
  state: "reserved";
  expires_at: string;
  session_sha256: string;
}>;

export type ReportAccessGrant = Readonly<{
  grant_id: string;
  case_id: string;
  report_id: string;
  artifact_sha256: string;
  object_version_id: string;
  expires_at: string;
  grant_sha256: string;
}>;

export interface PortalClockPort { now(): string; }
export type PortalFlagsPort = Pick<ServerFeatureFlagPort, "isEnabled">;
export interface PortalRequestIdentityPort {
  verify(request: Request): Promise<Readonly<{ actor: VerifiedActor; csrf_valid: boolean }> | null>;
}

export class PortalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PortalError";
    this.code = code;
  }
}

export function customerSafeStatus(state: CaseLifecycleState, hasOpenClarification: boolean, blockerCount: number, hasReleasedReport = false): CustomerSafeStatus {
  if (state === "awaiting_payment") return "awaiting_payment";
  if (state === "awaiting_documents") return "awaiting_documents";
  if (hasOpenClarification) return "clarification_needed";
  if (state === "release_hold") return "hold";
  if (state === "delivered" || state === "cancelled") return "closed";
  if (state === "report_ready") return hasReleasedReport ? "report_available" : "under_review";
  if (blockerCount > 0) return "blocked";
  return "under_review";
}

export const STATUS_LABELS_HE: Readonly<Record<CustomerSafeStatus, string>> = Object.freeze({
  awaiting_payment: "ממתינים לאימות התשלום",
  awaiting_documents: "ממתינים למסמכים",
  under_review: "הבדיקה בתהליך",
  clarification_needed: "נדרש ממך מידע נוסף",
  blocked: "הבדיקה ממתינה להשלמת מידע או ביקורת",
  report_available: "דוח ששוחרר זמין",
  hold: "הגישה לדוח מושהית",
  closed: "התיק נסגר",
});
