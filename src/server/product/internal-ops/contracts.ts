import "./server-boundary.ts";

import { z } from "zod";
import { V07_ROLES, type V07Role, type VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { WAVE3_TOPICS, type CaseLifecycleState, type Wave3Topic } from "../../../engine/wave3/contracts.ts";

export const INTERNAL_OPS_SCHEMA_VERSION = "tivdoc-internal-ops-v0.7.0" as const;

const opaqueId = z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoInstant = z.string().datetime({ offset: true });
const safeReason = z.string().trim().min(8).max(500).regex(/^[^<>\u0000-\u001f]+$/);
const idempotencyKey = z.string().min(12).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const commandId = z.string().min(8).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
const caseId = opaqueId;

export const internalOpsActorSchema = z.object({
  actor_id: opaqueId,
  role: z.enum(V07_ROLES),
  tenant_id: opaqueId.nullable(),
  assigned_case_ids: z.array(caseId).max(1_000),
  verified_server_side: z.literal(true),
  break_glass_reason: z.string().min(8).max(500).nullable(),
  break_glass_expires_at: isoInstant.nullable(),
}).strict();

export const clientMutationEnvelopeSchema = z.object({
  schema_version: z.literal(INTERNAL_OPS_SCHEMA_VERSION),
  command_id: commandId,
  idempotency_key: idempotencyKey,
  expected_revision: z.number().int().min(0),
  reason: safeReason,
}).strict();

const caseCreatePayload = z.object({
  action: z.literal("case_create"),
  case_id: caseId,
  intake_reference_sha256: sha256,
}).strict();

const paymentReconcilePayload = z.object({
  action: z.literal("payment_reconcile"),
  case_id: caseId,
  payment_reference_sha256: sha256,
}).strict();

const documentReferencePayload = z.object({
  action: z.literal("document_reference_add"),
  case_id: caseId,
  object_version_id: opaqueId,
  object_sha256: sha256,
  byte_length: z.number().int().positive().max(50_000_000),
  detected_mime: z.enum(["application/pdf", "image/png", "image/jpeg"]),
}).strict();

const extractionReviewPayload = z.object({
  action: z.literal("extraction_review"),
  case_id: caseId,
  extraction_snapshot_sha256: sha256,
  field_ids: z.array(opaqueId).min(1).max(100),
  decision: z.enum(["approved", "rejected", "changes_requested"]),
}).strict();

const factResolutionPayload = z.object({
  action: z.literal("fact_resolution"),
  case_id: caseId,
  facts_snapshot_sha256: sha256,
  fact_ids: z.array(opaqueId).min(1).max(100),
  decision: z.enum(["confirmed", "rejected", "needs_confirmation"]),
}).strict();

const analysisPayload = z.object({
  action: z.enum(["analysis_request", "analysis_resume", "analysis_replay"]),
  case_id: caseId,
  analysis_run_id: opaqueId.nullable(),
  mode: z.enum(["real", "synthetic_test"]),
  requested_topics: z.array(z.enum(WAVE3_TOPICS)).length(WAVE3_TOPICS.length),
  input_snapshot_sha256: sha256,
}).strict();

const reportDecisionPayload = z.object({
  action: z.enum(["report_submit", "report_approve", "report_reject"]),
  case_id: caseId,
  report_id: opaqueId,
  report_revision: z.number().int().min(0),
  report_sha256: sha256,
  analysis_result_sha256: sha256,
  decision: z.enum(["submitted", "approved", "rejected", "changes_requested"]),
}).strict();

const reportExportPayload = z.object({
  action: z.literal("report_manual_export"),
  case_id: caseId,
  report_id: opaqueId,
  report_revision: z.number().int().min(0),
  report_sha256: sha256,
  approval_receipt_sha256: sha256,
  format: z.enum(["json", "html", "pdf", "manifest"]),
  destination: z.literal("local_operator_download"),
}).strict();

export const internalOpsMutationPayloadSchema = z.discriminatedUnion("action", [
  caseCreatePayload,
  paymentReconcilePayload,
  documentReferencePayload,
  extractionReviewPayload,
  factResolutionPayload,
  analysisPayload,
  reportDecisionPayload,
  reportExportPayload,
]);

export const internalOpsMutationRequestSchema = clientMutationEnvelopeSchema.extend({
  payload: internalOpsMutationPayloadSchema,
}).strict().superRefine((request, context) => {
  const payload = request.payload;
  if (payload.action === "report_submit" && payload.decision !== "submitted") {
    context.addIssue({ code: "custom", path: ["payload", "decision"], message: "report_decision_mismatch" });
  }
  if (payload.action === "report_approve" && payload.decision !== "approved") {
    context.addIssue({ code: "custom", path: ["payload", "decision"], message: "report_decision_mismatch" });
  }
  if (payload.action === "report_reject" && payload.decision !== "rejected" && payload.decision !== "changes_requested") {
    context.addIssue({ code: "custom", path: ["payload", "decision"], message: "report_decision_mismatch" });
  }
  if ((payload.action === "analysis_request" || payload.action === "analysis_resume" || payload.action === "analysis_replay")
    && (new Set(payload.requested_topics).size !== WAVE3_TOPICS.length || WAVE3_TOPICS.some((topic) => !payload.requested_topics.includes(topic)))) {
    context.addIssue({ code: "custom", path: ["payload", "requested_topics"], message: "all_seven_topics_required" });
  }
});

export type InternalOpsMutationPayload = z.infer<typeof internalOpsMutationPayloadSchema>;
export type InternalOpsMutationRequest = z.infer<typeof internalOpsMutationRequestSchema>;
export type InternalOpsAction = InternalOpsMutationPayload["action"];

export type TrustedInternalOpsCommand = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  command_id: string;
  idempotency_key: string;
  expected_revision: number;
  reason: string;
  actor: VerifiedActor;
  payload: InternalOpsMutationPayload;
}>;

export type OpsProblemCode =
  | "OPS_DISABLED"
  | "OPS_BACKEND_UNAVAILABLE"
  | "OPS_AUTH_REQUIRED"
  | "OPS_FORBIDDEN"
  | "OPS_INVALID_REQUEST"
  | "OPS_NOT_FOUND"
  | "OPS_REVISION_CONFLICT"
  | "OPS_IDEMPOTENCY_CONFLICT"
  | "OPS_LEGAL_READINESS_BLOCKED"
  | "OPS_EXACT_REPORT_APPROVAL_REQUIRED"
  | "OPS_MANUAL_EXPORT_DISABLED"
  | "OPS_SYNTHETIC_DISABLED"
  | "OPS_PRODUCTION_FIXTURE_FORBIDDEN"
  | "OPS_UPSTREAM_INVALIDATED"
  | "OPS_COMMAND_REJECTED";

export type OpsProblem = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  code: OpsProblemCode;
  correlation_id: string;
  retryable: boolean;
}>;

export type OpsCapability =
  | "ops.read"
  | "queue.read"
  | "case.read"
  | "payment.read"
  | "document.read"
  | "extraction.read"
  | "fact.read"
  | "readiness.read"
  | "analysis.read"
  | "report.read"
  | "audit.read"
  | `command.${InternalOpsAction}`;

export type OpsCapabilityProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  actor_role: V07Role;
  capabilities: readonly OpsCapability[];
  manual_export_enabled: boolean;
  synthetic_enabled: boolean;
  customer_processing_enabled: boolean;
  customer_shadow_enabled: boolean;
  production_delivery_enabled: false;
}>;

export type QueueItemProjection = Readonly<{
  case_id: string;
  revision: number;
  state: CaseLifecycleState;
  blocker_count: number;
  next_action_code: string;
  updated_at: string;
}>;

export type QueueProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  items: readonly QueueItemProjection[];
  next_cursor: string | null;
}>;

export type TopicReadinessProjection = Readonly<{
  topic: Wave3Topic;
  status: "READY" | "BLOCKED_NOT_READY" | "NOT_APPLICABLE";
  blocker_codes: readonly string[];
  decision_sha256: string | null;
  decision_source: "evaluateLegalReadiness";
}>;

export type InternalOpsCaseProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  revision: number;
  state: CaseLifecycleState;
  mode: "real" | "synthetic_test";
  created_at: string;
  updated_at: string;
  snapshot_hashes: Readonly<{
    documents: string | null;
    extraction: string | null;
    facts: string | null;
    analysis: string | null;
    report: string | null;
  }>;
  invalidation_codes: readonly string[];
  blocker_codes: readonly string[];
}>;

export type TimelineProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  events: readonly Readonly<{
    sequence: number;
    event_code: string;
    revision: number;
    occurred_at: string;
    actor_role: V07Role;
    event_sha256: string;
  }>[];
}>;

export type PaymentProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  status: "unmatched" | "pending" | "settled" | "failed" | "refunded" | "chargeback";
  evidence_revision: string | null;
  evidence_sha256: string | null;
  reference_sha256: string | null;
  hold: boolean;
}>;

export type DocumentProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  documents: readonly Readonly<{
    object_version_id: string;
    object_sha256: string;
    byte_length: number;
    detected_mime: string;
    status: "staged" | "accepted" | "quarantined";
  }>[];
}>;

export type ExtractionProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  snapshot_sha256: string | null;
  fields: readonly Readonly<{
    field_id: string;
    canonical_path: string;
    status: "missing" | "candidate" | "confirmed" | "conflicted";
    confidence_micros: number | null;
    source_document_id: string | null;
  }>[];
}>;

export type FactsProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  snapshot_sha256: string | null;
  facts: readonly Readonly<{
    fact_id: string;
    canonical_path: string;
    status: "missing" | "needs_confirmation" | "confirmed" | "conflicted" | "not_applicable";
    provenance_count: number;
    conflict_count: number;
  }>[];
}>;

export type ReadinessProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  topics: readonly TopicReadinessProjection[];
  all_topics_ready: boolean;
}>;

export type AnalysisProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  runs: readonly Readonly<{
    analysis_run_id: string;
    status: "requested" | "running" | "blocked" | "complete" | "failed";
    input_snapshot_sha256: string;
    result_sha256: string | null;
    known_subtotal_minor_units: string | null;
    coverage_complete: boolean;
    blocker_codes: readonly string[];
  }>[];
}>;

export type ReportProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  report_id: string | null;
  report_revision: number | null;
  report_sha256: string | null;
  analysis_result_sha256: string | null;
  status: "not_created" | "internal_draft" | "awaiting_approval" | "approved" | "invalidated" | "rejected";
  coverage_complete: boolean;
  watermark: "INTERNAL_DRAFT_NOT_FOR_CUSTOMER";
  exact_hash_approval_receipt_sha256: string | null;
  manual_export_eligible: boolean;
  blocker_codes: readonly string[];
}>;

export type AuditProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  chain_valid: boolean;
  event_count: number;
  tail_sha256: string | null;
  events: readonly Readonly<{
    sequence: number;
    action: string;
    resource_revision: number;
    resource_sha256: string;
    event_sha256: string;
    occurred_at: string;
  }>[];
}>;

export type OpsReadProjection =
  | OpsCapabilityProjection
  | QueueProjection
  | InternalOpsCaseProjection
  | TimelineProjection
  | PaymentProjection
  | DocumentProjection
  | ExtractionProjection
  | FactsProjection
  | ReadinessProjection
  | AnalysisProjection
  | ReportProjection
  | AuditProjection;

export type MutationResultProjection = Readonly<{
  schema_version: typeof INTERNAL_OPS_SCHEMA_VERSION;
  case_id: string;
  revision: number;
  state: CaseLifecycleState;
  command_sha256: string;
  audit_event_sha256: string;
  idempotent_replay: boolean;
  snapshot_hashes: InternalOpsCaseProjection["snapshot_hashes"];
  invalidation_codes: readonly string[];
  blocker_codes: readonly string[];
  correlation_id: string;
}>;

export type ManualExportResult = Readonly<{
  mutation: MutationResultProjection;
  format: "json" | "html" | "pdf" | "manifest";
  media_type: "application/json" | "text/html; charset=utf-8" | "application/pdf";
  artifact_sha256: string;
  bytes: Uint8Array;
}>;

export type InternalOpsCommandResult = MutationResultProjection | ManualExportResult;

export function trustedCommand(request: InternalOpsMutationRequest, actor: VerifiedActor): TrustedInternalOpsCommand {
  internalOpsActorSchema.parse(actor);
  return Object.freeze({ ...request, actor, payload: Object.freeze({ ...request.payload }) });
}
