import "server-only";
import { z } from "zod";
import { documentExtractionSchema } from "@/engine/agents/contracts";
import {
  confidenceSchema,
  domainCodeSchema,
  isoTimestampSchema,
  uuidSchema,
  versionSchema,
} from "@/engine/domain/primitives";
import { employmentSnapshotSchema } from "@/engine/facts/snapshot";
import { factPathSchema } from "@/engine/facts/fact-paths";
import { findingSchema } from "@/engine/findings/contracts";
import { analysisRunSchema, analysisRunStateSchema } from "@/engine/investigation/analysis-run";
import { investigationHypothesisSchema } from "@/engine/investigation/hypothesis";
import { conversationMessageSchema, conversationSchema } from "@/engine/interview/conversation";

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const idempotencyKeySchema = z
  .string()
  .min(3)
  .max(240)
  .regex(/^[a-z][a-z0-9._:-]*$/);

function uniqueUuidArray(label: string) {
  return z.array(uuidSchema).refine((ids) => new Set(ids).size === ids.length, `${label} must be unique`);
}

export const analysisRunInputSnapshotSchema = z
  .object({
    schema_version: versionSchema,
    document_ids: uniqueUuidArray("Document IDs"),
    extraction_ids: uniqueUuidArray("Extraction IDs"),
    conversation_message_ids: uniqueUuidArray("Conversation message IDs"),
    questionnaire_response_id: uuidSchema.nullable(),
    parent_snapshot_id: uuidSchema.nullable(),
  })
  .strict();

export const analysisRunPersistenceInputSchema = z
  .object({
    run: analysisRunSchema,
    trigger_reason: domainCodeSchema,
    engine_git_sha: gitCommitSchema,
    ontology_version: versionSchema,
    rule_set_hash: sha256Schema.nullable(),
    input_snapshot: analysisRunInputSnapshotSchema,
    idempotency_key: idempotencyKeySchema,
    error_stage: domainCodeSchema.nullable().default(null),
  })
  .strict();

export const employmentSnapshotPersistenceInputSchema = z
  .object({
    snapshot: employmentSnapshotSchema,
    payload_hash: sha256Schema,
  })
  .strict();

export const hypothesisPersistenceInputSchema = z
  .object({
    hypothesis: investigationHypothesisSchema,
    hypothesis_key: domainCodeSchema,
    idempotency_key: idempotencyKeySchema,
    created_at: isoTimestampSchema,
  })
  .strict();

export const findingPersistenceInputSchema = z
  .object({
    finding: findingSchema,
    idempotency_key: idempotencyKeySchema,
  })
  .strict();

export const conversationPersistenceInputSchema = z
  .object({
    conversation: conversationSchema,
    idempotency_key: idempotencyKeySchema,
  })
  .strict();

export const messagePersistenceInputSchema = z
  .object({
    message: conversationMessageSchema,
    idempotency_key: idempotencyKeySchema,
  })
  .strict();

export const extractionStatusSchema = z.enum(["queued", "running", "partial", "completed", "failed"]);

export const extractionQualityMetricsSchema = z
  .object({
    page_count: z.number().int().nonnegative().nullable(),
    mean_confidence: confidenceSchema.nullable(),
    warning_codes: z.array(domainCodeSchema),
  })
  .strict();

const privateStoragePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((path) => path.startsWith("cases/") && !path.includes("..") && !path.includes("://"), {
    message: "Raw artifacts must use a relative path in private case storage",
  });

export const documentExtractionAttemptSchema = z
  .object({
    extraction_id: uuidSchema,
    document_id: uuidSchema,
    analysis_run_id: uuidSchema.nullable(),
    extractor_id: domainCodeSchema,
    extractor_version: versionSchema,
    model_version: z.string().trim().min(1).max(200).nullable(),
    source_content_sha256: sha256Schema,
    status: extractionStatusSchema,
    payload: documentExtractionSchema.nullable(),
    quality_metrics: extractionQualityMetricsSchema,
    raw_artifact_path: privateStoragePathSchema.nullable(),
    idempotency_key: idempotencyKeySchema,
    created_at: isoTimestampSchema,
    completed_at: isoTimestampSchema.nullable(),
    error_code: domainCodeSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const terminal = new Set(["partial", "completed", "failed"]).has(attempt.status);
    if (terminal !== (attempt.completed_at !== null)) {
      context.addIssue({ code: "custom", message: "Only terminal attempts have a completion time", path: ["completed_at"] });
    }
    if ((attempt.status === "failed") !== (attempt.error_code !== null)) {
      context.addIssue({ code: "custom", message: "Only failed attempts have an error code", path: ["error_code"] });
    }
    if (attempt.status === "completed" && attempt.payload === null) {
      context.addIssue({ code: "custom", message: "Completed extraction requires a validated payload", path: ["payload"] });
    }
    if (attempt.payload !== null) {
      if (attempt.payload.content_sha256 !== attempt.source_content_sha256) {
        context.addIssue({ code: "custom", message: "Payload hash must match the extraction source", path: ["payload", "content_sha256"] });
      }
      if (attempt.payload.extraction_id !== attempt.extraction_id) {
        context.addIssue({ code: "custom", message: "Payload extraction ID must match the attempt", path: ["payload", "extraction_id"] });
      }
      if (attempt.payload.document.document_id !== attempt.document_id) {
        context.addIssue({ code: "custom", message: "Payload document ID must match the attempt", path: ["payload", "document", "document_id"] });
      }
    }
  });

export const confirmationStatusSchema = z.enum(["pending", "confirmed", "rejected", "corrected"]);

export const caseConfirmationSchema = z
  .object({
    confirmation_id: uuidSchema,
    case_id: uuidSchema,
    source_analysis_run_id: uuidSchema,
    target_fact_path: factPathSchema,
    question_id: domainCodeSchema,
    question_version: z.number().int().positive(),
    proposed_value: z.json().nullable(),
    answer: z.json().nullable(),
    status: confirmationStatusSchema,
    source_message_id: uuidSchema.nullable(),
    idempotency_key: idempotencyKeySchema,
    created_at: isoTimestampSchema,
    answered_at: isoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((confirmation, context) => {
    const answered = confirmation.status !== "pending";
    if (
      answered !==
      (confirmation.answered_at !== null && confirmation.source_message_id !== null && confirmation.answer !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Answered confirmations require answer, message provenance, and timestamp",
        path: ["answer"],
      });
    }
    if (!answered && (confirmation.answered_at !== null || confirmation.source_message_id !== null || confirmation.answer !== null)) {
      context.addIssue({ code: "custom", message: "Pending confirmations cannot contain an answer", path: ["answer"] });
    }
  });

export const analysisJobStageSchema = z.enum([
  "classify_document",
  "extract_document",
  "normalize",
  "resolve_facts",
  "investigate",
  "calculate",
  "build_findings",
  "generate_report",
]);
export const analysisJobStatusSchema = z.enum([
  "queued",
  "running",
  "retry_scheduled",
  "completed",
  "failed",
  "cancelled",
]);

export const analysisJobSchema = z
  .object({
    job_id: uuidSchema,
    analysis_run_id: uuidSchema,
    document_id: uuidSchema.nullable(),
    extraction_id: uuidSchema.nullable(),
    stage: analysisJobStageSchema,
    status: analysisJobStatusSchema,
    payload: z.record(z.string(), z.json()),
    idempotency_key: idempotencyKeySchema,
    retry_count: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    available_at: isoTimestampSchema,
    locked_at: isoTimestampSchema.nullable(),
    completed_at: isoTimestampSchema.nullable(),
    error_code: domainCodeSchema.nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((job, context) => {
    const terminal = new Set(["completed", "failed", "cancelled"]).has(job.status);
    if (terminal !== (job.completed_at !== null)) {
      context.addIssue({ code: "custom", message: "Only terminal jobs have a completion time", path: ["completed_at"] });
    }
    if (job.status === "failed" && job.error_code === null) {
      context.addIssue({ code: "custom", message: "Failed jobs require a safe error code", path: ["error_code"] });
    }
    if (!terminal && job.retry_count >= job.max_attempts) {
      context.addIssue({ code: "custom", message: "Active jobs must have a remaining attempt", path: ["retry_count"] });
    }
  });

export const legacyDocumentSchema = z
  .object({
    storage_layout: z.literal("legacy_slot"),
    document_id: uuidSchema,
    case_id: uuidSchema,
    document_type: z.enum(["payslip", "contract", "attendance"]),
    storage_path: z.string().trim().min(1).max(1_000),
    original_filename: z.string().trim().min(1).max(240),
    mime_type: z.string().trim().min(1).max(120),
    size_bytes: z.number().int().positive().safe(),
    processing_status: domainCodeSchema,
    created_at: isoTimestampSchema,
  })
  .strict();

export const analysisRunLifecycleUpdateSchema = z
  .object({
    analysis_run_id: uuidSchema,
    from: analysisRunStateSchema,
    to: analysisRunStateSchema,
    occurred_at: isoTimestampSchema,
    failure_code: domainCodeSchema.nullable(),
    error_stage: domainCodeSchema.nullable(),
  })
  .strict();

export type AnalysisRunPersistenceInput = z.infer<typeof analysisRunPersistenceInputSchema>;
export type EmploymentSnapshotPersistenceInput = z.infer<typeof employmentSnapshotPersistenceInputSchema>;
export type HypothesisPersistenceInput = z.infer<typeof hypothesisPersistenceInputSchema>;
export type FindingPersistenceInput = z.infer<typeof findingPersistenceInputSchema>;
export type ConversationPersistenceInput = z.infer<typeof conversationPersistenceInputSchema>;
export type MessagePersistenceInput = z.infer<typeof messagePersistenceInputSchema>;
export type DocumentExtractionAttempt = z.infer<typeof documentExtractionAttemptSchema>;
export type CaseConfirmation = z.infer<typeof caseConfirmationSchema>;
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
