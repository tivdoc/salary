import { z } from "zod";
import { confidenceSchema, isoTimestampSchema, versionSchema } from "@/engine/domain/primitives";
import { investigationHypothesisSchema } from "@/engine/investigation/hypothesis";
import { conversationMessageSchema, conversationSchema } from "@/engine/interview/conversation";
import { ruleInputSnapshotSchema } from "@/engine/wave1/contracts";
import { WAVE3_TOPICS } from "@/engine/wave3/contracts";
import type { PostgresTransactionContext } from "../contracts";
import { PostgresIntakeError } from "./errors";

const opaque = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
// Product-facing IDs are opaque. The forward migration maps them to legacy UUID FKs.
const canonicalId = opaque;
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const timestamp = isoTimestampSchema;
const revision = z.number().int().nonnegative().safe();
const positiveRevision = z.number().int().positive().safe();
const jsonObject = z.record(z.string(), z.json());
// Mirrors the server-only canonical extraction port; importing that module in
// recording-driver tests would execute its `server-only` sentinel.
const extractionStatusSchema = z.enum(["queued", "running", "partial", "completed", "failed"]);
const extractionQualityMetricsSchema = z.object({
  page_count: z.number().int().nonnegative().nullable(),
  mean_confidence: confidenceSchema.nullable(),
  warning_codes: z.array(z.string().min(1).max(120)),
}).strict();
const databaseRevision = z.preprocess((value) => {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return Number.NaN;
  return Number(value);
}, revision);

export const tenantIdSchema = opaque;
export const ownerSchema = z.object({ tenant_id: tenantIdSchema, case_id: canonicalId }).strict();
export type IntakeOwner = z.infer<typeof ownerSchema>;

export const lifecycleStateSchema = z.enum([
  "awaiting_payment", "awaiting_documents", "awaiting_extraction_review", "awaiting_fact_resolution",
  "ready_for_legal_evaluation", "awaiting_legal_review", "awaiting_report_approval", "report_ready",
  "release_hold", "delivered", "cancelled",
]);

export const caseLifecycleWriteSchema = ownerSchema.extend({
  expected_revision: revision,
  state_before: lifecycleStateSchema.nullable(),
  state_after: lifecycleStateSchema,
  event_kind: opaque,
  command_sha256: sha256,
  event_sha256: sha256,
  previous_sha256: sha256.nullable(),
  state_sha256: sha256,
  occurred_at: timestamp,
}).strict().superRefine((value, context) => {
  if (value.expected_revision === 0 && value.state_before !== null) {
    context.addIssue({ code: "custom", message: "initial_revision_requires_null_prior_state", path: ["state_before"] });
  }
  if (value.expected_revision > 0 && value.state_before === null) {
    context.addIssue({ code: "custom", message: "existing_revision_requires_prior_state", path: ["state_before"] });
  }
  if (value.previous_sha256 === value.event_sha256) {
    context.addIssue({ code: "custom", message: "event_cannot_chain_to_itself", path: ["previous_sha256"] });
  }
});

export const caseStateRowSchema = z.object({
  case_id: canonicalId, tenant_id: opaque, revision: databaseRevision, lifecycle_state: lifecycleStateSchema,
  state_sha256: sha256, updated_at: timestamp,
}).strict();

export const paymentEvidenceWriteSchema = ownerSchema.extend({
  evidence_id: opaque,
  evidence_revision: opaque,
  evidence_sha256: sha256,
  status: z.enum(["settled", "pending", "failed", "cancelled", "refunded", "chargeback"]),
  bound_at: timestamp,
}).strict();

export const paymentEvidenceRowSchema = paymentEvidenceWriteSchema.omit({}).strict();

export const conversationWriteSchema = ownerSchema.extend({
  conversation_id: canonicalId,
  analysis_run_id: canonicalId.nullable(),
  status: conversationSchema.shape.status,
  idempotency_key: opaque,
  created_at: timestamp,
  closed_at: timestamp.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "closed") !== (value.closed_at !== null)) {
    context.addIssue({ code: "custom", message: "closed_timestamp_mismatch", path: ["closed_at"] });
  }
});

export const messageWriteSchema = ownerSchema.extend({
  message_id: canonicalId,
  conversation_id: canonicalId,
  analysis_run_id: canonicalId.nullable(),
  role: conversationMessageSchema.shape.role,
  agent: conversationMessageSchema.shape.agent,
  question_id: opaque.nullable(),
  question_version: positiveRevision.nullable(),
  selected_option_ids: z.array(opaque).max(100),
  free_text_answer: z.string().trim().min(1).max(10_000).nullable(),
  content: z.string().trim().min(1).max(20_000).nullable(),
  model_provider: opaque.nullable(),
  model_identifier: z.string().trim().min(1).max(200).nullable(),
  prompt_version: z.string().trim().min(1).max(120).nullable(),
  idempotency_key: opaque,
  created_at: timestamp,
}).strict().superRefine((value, context) => {
  if ((value.question_id === null) !== (value.question_version === null)) {
    context.addIssue({ code: "custom", message: "question_version_mismatch", path: ["question_version"] });
  }
  if (new Set(value.selected_option_ids).size !== value.selected_option_ids.length) {
    context.addIssue({ code: "custom", message: "duplicate_selected_option", path: ["selected_option_ids"] });
  }
  if (value.content === null && value.free_text_answer === null && value.selected_option_ids.length === 0) {
    context.addIssue({ code: "custom", message: "message_content_required", path: ["content"] });
  }
  const modelFields = [value.model_provider, value.model_identifier, value.prompt_version];
  if (value.role === "assistant" && (value.agent === null || modelFields.some((item) => item === null))) {
    context.addIssue({ code: "custom", message: "assistant_provenance_required", path: ["role"] });
  }
  if (value.role === "customer" && (value.agent !== null || modelFields.some((item) => item !== null))) {
    context.addIssue({ code: "custom", message: "customer_provenance_forbidden", path: ["role"] });
  }
});

export const documentWriteSchema = ownerSchema.extend({
  document_id: canonicalId,
  declared_type: opaque,
  detected_type: opaque.nullable(),
  classification_confidence: confidenceSchema.finite().nullable(),
  content_sha256: sha256,
  storage_path: z.string().trim().min(1).max(1_000),
  original_filename: z.string().trim().min(1).max(240),
  mime_type: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  size_bytes: z.number().int().positive().max(10_485_760).safe(),
  period_start: z.string().date().nullable(),
  period_end: z.string().date().nullable(),
  supersedes_document_id: canonicalId.nullable(),
  processing_status: z.enum(["uploaded", "queued", "processing", "ready", "partial", "failed", "rejected"]),
  created_at: timestamp,
}).strict().superRefine((value, context) => {
  const expectedPrefix = `cases/${value.case_id}/documents/${value.document_id}/original.`;
  if (!value.storage_path.startsWith(expectedPrefix) || value.storage_path.includes("..") || value.storage_path.includes("://")) {
    context.addIssue({ code: "custom", message: "immutable_storage_path_invalid", path: ["storage_path"] });
  }
  if ((value.period_start === null) !== (value.period_end === null) ||
      (value.period_start !== null && value.period_end !== null && value.period_end < value.period_start)) {
    context.addIssue({ code: "custom", message: "document_period_invalid", path: ["period_end"] });
  }
});

export const artifactWriteSchema = ownerSchema.extend({
  reservation_id: opaque,
  opaque_key: opaque,
  expected_sha256: sha256,
  expected_length: z.number().int().nonnegative().safe(),
  detected_mime: z.string().trim().min(1).max(200),
  retention_class: opaque,
  state: z.enum(["reserved", "staged", "verified", "finalized", "quarantined"]),
  revision: positiveRevision,
  staged_sha256: sha256.nullable(),
  staged_length: z.number().int().nonnegative().safe().nullable(),
  object_version_id: opaque.nullable(),
  visible: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
}).strict().superRefine((value, context) => {
  const finalized = value.state === "finalized";
  if (finalized !== value.visible || (finalized && (value.object_version_id === null ||
      value.staged_sha256 !== value.expected_sha256 || value.staged_length !== value.expected_length))) {
    context.addIssue({ code: "custom", message: "artifact_finalization_invalid", path: ["state"] });
  }
});

export const extractionWriteSchema = ownerSchema.extend({
  extraction_id: canonicalId,
  document_id: canonicalId,
  analysis_run_id: canonicalId.nullable(),
  extractor_id: opaque,
  extractor_version: versionSchema,
  model_version: z.string().trim().min(1).max(200).nullable(),
  source_content_sha256: sha256,
  status: extractionStatusSchema,
  payload: jsonObject.nullable(),
  quality_metrics: extractionQualityMetricsSchema,
  raw_artifact_path: z.string().trim().min(1).max(1_000).nullable(),
  idempotency_key: opaque,
  created_at: timestamp,
  completed_at: timestamp.nullable(),
  error_code: opaque.nullable(),
}).strict().superRefine((value, context) => {
  const terminal = ["partial", "completed", "failed"].includes(value.status);
  if (terminal !== (value.completed_at !== null)) context.addIssue({ code: "custom", message: "completion_timestamp_mismatch", path: ["completed_at"] });
  if ((value.status === "failed") !== (value.error_code !== null)) context.addIssue({ code: "custom", message: "error_code_mismatch", path: ["error_code"] });
  if (value.status === "completed" && value.payload === null) context.addIssue({ code: "custom", message: "completed_payload_required", path: ["payload"] });
  if (value.raw_artifact_path !== null && (!value.raw_artifact_path.startsWith("cases/") || value.raw_artifact_path.includes("..") || value.raw_artifact_path.includes("://"))) {
    context.addIssue({ code: "custom", message: "raw_artifact_path_invalid", path: ["raw_artifact_path"] });
  }
});

export const factWriteSchema = ownerSchema.extend({
  fact_id: opaque,
  revision: positiveRevision,
  expected_prior_revision: revision,
  analysis_run_id: canonicalId.nullable(),
  payload: jsonObject,
  payload_sha256: sha256,
  created_at: timestamp,
}).strict().refine((value) => value.revision === value.expected_prior_revision + 1, { message: "fact_revision_not_sequential", path: ["revision"] });

export const hypothesisWriteSchema = ownerSchema.extend({
  hypothesis_id: canonicalId,
  analysis_run_id: canonicalId,
  hypothesis_key: opaque,
  category: opaque,
  status: investigationHypothesisSchema.shape.status,
  priority: investigationHypothesisSchema.shape.priority,
  payload: jsonObject,
  idempotency_key: opaque,
  created_at: timestamp,
}).strict();

export const ruleInputWriteSchema = ownerSchema.extend({
  rule_input_id: opaque,
  revision: positiveRevision,
  expected_prior_revision: revision,
  analysis_run_id: canonicalId,
  topic: z.enum(WAVE3_TOPICS),
  payload: ruleInputSnapshotSchema,
  payload_sha256: sha256,
  created_at: timestamp,
}).strict().refine((value) => value.revision === value.expected_prior_revision + 1, { message: "rule_input_revision_not_sequential", path: ["revision"] });

export const conversationReceiptRowSchema = z.object({
  conversation_id: canonicalId, case_id: canonicalId, analysis_run_id: canonicalId.nullable(),
  status: conversationSchema.shape.status, idempotency_key: opaque,
  created_at: timestamp, closed_at: timestamp.nullable(),
}).strict();
export const messageReceiptRowSchema = z.object({
  message_id: canonicalId, case_id: canonicalId, conversation_id: canonicalId, idempotency_key: opaque,
}).strict();
export const documentReceiptRowSchema = z.object({ document_id: canonicalId, case_id: canonicalId, content_sha256: sha256 }).strict();
export const artifactReceiptRowSchema = z.object({
  reservation_id: opaque, revision: databaseRevision, expected_sha256: sha256,
  state: z.enum(["reserved", "staged", "verified", "finalized", "quarantined"]), visible: z.boolean(),
}).strict();
export const extractionReceiptRowSchema = z.object({
  extraction_id: canonicalId, document_id: canonicalId, source_content_sha256: sha256,
  status: extractionStatusSchema,
  payload: jsonObject.nullable(), quality_metrics: extractionQualityMetricsSchema,
}).strict();
export const factReceiptRowSchema = z.object({
  fact_id: canonicalId, revision: databaseRevision, payload: jsonObject, payload_sha256: sha256,
}).strict();
export const hypothesisReceiptRowSchema = z.object({
  hypothesis_id: canonicalId, analysis_run_id: canonicalId, hypothesis_key: opaque,
  status: investigationHypothesisSchema.shape.status,
  priority: investigationHypothesisSchema.shape.priority, payload: jsonObject, idempotency_key: opaque,
}).strict();
export const ruleInputReceiptRowSchema = z.object({
  rule_input_id: canonicalId, revision: databaseRevision,
  topic: z.enum(WAVE3_TOPICS), payload: ruleInputSnapshotSchema, payload_sha256: sha256,
}).strict();

export function requireContext(value: PostgresTransactionContext): PostgresTransactionContext {
  if (!value || typeof value.transaction_id !== "string" || value.transaction_id.length === 0 ||
      !value.client || typeof value.client.query !== "function") {
    throw new PostgresIntakeError("INTAKE_TRANSACTION_CONTEXT_INVALID", "transaction_context");
  }
  return value;
}

export function parseInput<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PostgresIntakeError("INTAKE_INPUT_INVALID", operation);
  return result.data;
}

export function parseRow<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PostgresIntakeError("INTAKE_ROW_INVALID", operation);
  return result.data;
}

export const intakeCodecSchemas = Object.freeze({
  ownerSchema, caseLifecycleWriteSchema, caseStateRowSchema, paymentEvidenceWriteSchema,
  paymentEvidenceRowSchema, conversationWriteSchema, messageWriteSchema, documentWriteSchema,
  artifactWriteSchema, extractionWriteSchema, factWriteSchema, hypothesisWriteSchema, ruleInputWriteSchema,
  conversationReceiptRowSchema, messageReceiptRowSchema, documentReceiptRowSchema, artifactReceiptRowSchema,
  extractionReceiptRowSchema, factReceiptRowSchema, hypothesisReceiptRowSchema, ruleInputReceiptRowSchema,
});
