import "server-only";
import { z } from "zod";
import { immutableDocumentSchema } from "@/engine/domain/documents";
import { confidenceSchema, isoTimestampSchema, uuidSchema } from "@/engine/domain/primitives";
import { employmentSnapshotSchema } from "@/engine/facts/snapshot";
import { findingSchema } from "@/engine/findings/contracts";
import { analysisRunSchema } from "@/engine/investigation/analysis-run";
import { investigationHypothesisSchema } from "@/engine/investigation/hypothesis";
import { conversationMessageSchema, conversationSchema } from "@/engine/interview/conversation";
import { hashCanonicalJson } from "./idempotency";
import {
  analysisJobSchema,
  analysisRunPersistenceInputSchema,
  caseConfirmationSchema,
  conversationPersistenceInputSchema,
  documentExtractionAttemptSchema,
  employmentSnapshotPersistenceInputSchema,
  findingPersistenceInputSchema,
  hypothesisPersistenceInputSchema,
  legacyDocumentSchema,
  messagePersistenceInputSchema,
  type AnalysisJob,
  type AnalysisRunPersistenceInput,
  type CaseConfirmation,
  type ConversationPersistenceInput,
  type DocumentExtractionAttempt,
  type EmploymentSnapshotPersistenceInput,
  type FindingPersistenceInput,
  type HypothesisPersistenceInput,
  type MessagePersistenceInput,
} from "./persistence-contracts";

const databaseConfidenceSchema = z
  .union([confidenceSchema, z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/).transform(Number)])
  .pipe(confidenceSchema);
const databaseSafeIntegerSchema = z
  .union([z.number().int().safe(), z.string().regex(/^(?:0|[1-9]\d*)$/).transform(Number)])
  .pipe(z.number().int().nonnegative().safe());

const analysisRunRowSchema = z.object({
  id: uuidSchema,
  case_id: uuidSchema,
  parent_run_id: uuidSchema.nullable(),
  run_type: z.enum(["initial_scan", "full_investigation", "shadow"]),
  status: z.enum(["queued", "running", "waiting_for_customer", "partial", "blocked", "completed", "failed"]),
  trigger_reason: z.string(),
  engine_version: z.string(),
  engine_git_sha: z.string(),
  contract_version: z.string(),
  ontology_version: z.string(),
  rule_set_hash: z.string().nullable(),
  input_snapshot: z.unknown(),
  input_snapshot_hash: z.string(),
  idempotency_key: z.string(),
  started_at: isoTimestampSchema.nullable(),
  completed_at: isoTimestampSchema.nullable(),
  created_at: isoTimestampSchema,
  error_code: z.string().nullable(),
  error_stage: z.string().nullable(),
});

export function analysisRunToRow(input: AnalysisRunPersistenceInput) {
  const parsed = analysisRunPersistenceInputSchema.parse(input);
  return {
    id: parsed.run.analysis_run_id,
    case_id: parsed.run.case_id,
    parent_run_id: parsed.run.parent_run_id,
    run_type: parsed.run.run_type,
    status: parsed.run.state,
    trigger_reason: parsed.trigger_reason,
    engine_version: parsed.run.engine_version,
    engine_git_sha: parsed.engine_git_sha,
    contract_version: parsed.run.contract_version,
    ontology_version: parsed.ontology_version,
    rule_set_hash: parsed.rule_set_hash,
    input_snapshot: parsed.input_snapshot,
    input_snapshot_hash: hashCanonicalJson(parsed.input_snapshot),
    idempotency_key: parsed.idempotency_key,
    started_at: parsed.run.started_at,
    completed_at: parsed.run.completed_at,
    created_at: parsed.run.created_at,
    error_code: parsed.run.failure_code,
    error_stage: parsed.error_stage,
  };
}

export function analysisRunFromRow(row: unknown) {
  const parsed = analysisRunRowSchema.parse(row);
  return analysisRunSchema.parse({
    analysis_run_id: parsed.id,
    case_id: parsed.case_id,
    parent_run_id: parsed.parent_run_id,
    run_type: parsed.run_type,
    state: parsed.status,
    engine_version: parsed.engine_version,
    contract_version: parsed.contract_version,
    created_at: parsed.created_at,
    started_at: parsed.started_at,
    completed_at: parsed.completed_at,
    failure_code: parsed.error_code,
  });
}

export function employmentSnapshotToRow(input: EmploymentSnapshotPersistenceInput) {
  const parsed = employmentSnapshotPersistenceInputSchema.parse(input);
  const computedHash = hashCanonicalJson(parsed.snapshot);
  if (computedHash !== parsed.payload_hash) {
    throw new TypeError("Employment snapshot payload hash does not match the validated payload");
  }
  return {
    id: parsed.snapshot.snapshot_id,
    analysis_run_id: parsed.snapshot.analysis_run_id,
    schema_version: parsed.snapshot.schema_version,
    payload: parsed.snapshot,
    payload_hash: parsed.payload_hash,
    created_at: parsed.snapshot.created_at,
  };
}

export function employmentSnapshotFromRow(row: unknown) {
  const parsed = z.object({ payload: z.unknown() }).parse(row);
  return employmentSnapshotSchema.parse(parsed.payload);
}

export function hypothesisToRow(input: HypothesisPersistenceInput) {
  const parsed = hypothesisPersistenceInputSchema.parse(input);
  return {
    id: parsed.hypothesis.hypothesis_id,
    analysis_run_id: parsed.hypothesis.analysis_run_id,
    hypothesis_key: parsed.hypothesis_key,
    category: parsed.hypothesis.category,
    status: parsed.hypothesis.status,
    priority: parsed.hypothesis.priority,
    payload: parsed.hypothesis,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.created_at,
  };
}

export function hypothesisFromRow(row: unknown) {
  return investigationHypothesisSchema.parse(z.object({ payload: z.unknown() }).parse(row).payload);
}

export function conversationToRow(input: ConversationPersistenceInput) {
  const parsed = conversationPersistenceInputSchema.parse(input);
  return {
    id: parsed.conversation.conversation_id,
    case_id: parsed.conversation.case_id,
    analysis_run_id: parsed.conversation.analysis_run_id,
    status: parsed.conversation.status,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.conversation.created_at,
    closed_at: parsed.conversation.closed_at,
  };
}

export function conversationFromRow(row: unknown) {
  const parsed = z
    .object({
      id: uuidSchema,
      case_id: uuidSchema,
      analysis_run_id: uuidSchema,
      status: z.enum(["open", "waiting_for_customer", "closed"]),
      created_at: isoTimestampSchema,
      closed_at: isoTimestampSchema.nullable(),
    })
    .parse(row);
  return conversationSchema.parse({
    conversation_id: parsed.id,
    case_id: parsed.case_id,
    analysis_run_id: parsed.analysis_run_id,
    status: parsed.status,
    created_at: parsed.created_at,
    closed_at: parsed.closed_at,
  });
}

export function messageToRow(input: MessagePersistenceInput) {
  const parsed = messagePersistenceInputSchema.parse(input);
  const message = parsed.message;
  return {
    id: message.message_id,
    case_id: message.case_id,
    conversation_id: message.conversation_id,
    analysis_run_id: message.analysis_run_id,
    role: message.role,
    agent: message.agent,
    question_id: message.question?.question_id ?? null,
    question_version: message.question?.version ?? null,
    selected_option_ids: message.selected_option_ids,
    free_text_answer: message.free_text_answer,
    content: message.content,
    model_provider: message.model?.provider ?? null,
    model_identifier: message.model?.model ?? null,
    prompt_version: message.prompt_version,
    idempotency_key: parsed.idempotency_key,
    created_at: message.created_at,
  };
}

export function messageFromRow(row: unknown) {
  const parsed = z
    .object({
      id: uuidSchema,
      case_id: uuidSchema,
      conversation_id: uuidSchema,
      analysis_run_id: uuidSchema,
      role: z.enum(["system", "assistant", "customer"]),
      agent: z.string().nullable(),
      question_id: z.string().nullable(),
      question_version: z.number().int().positive().nullable(),
      selected_option_ids: z.array(z.string()),
      free_text_answer: z.string().nullable(),
      content: z.string().nullable(),
      model_provider: z.string().nullable(),
      model_identifier: z.string().nullable(),
      prompt_version: z.string().nullable(),
      created_at: isoTimestampSchema,
    })
    .parse(row);
  return conversationMessageSchema.parse({
    message_id: parsed.id,
    case_id: parsed.case_id,
    conversation_id: parsed.conversation_id,
    analysis_run_id: parsed.analysis_run_id,
    role: parsed.role,
    agent: parsed.agent,
    question:
      parsed.question_id === null || parsed.question_version === null
        ? null
        : { question_id: parsed.question_id, version: parsed.question_version },
    selected_option_ids: parsed.selected_option_ids,
    free_text_answer: parsed.free_text_answer,
    content: parsed.content,
    model:
      parsed.model_provider === null || parsed.model_identifier === null
        ? null
        : { provider: parsed.model_provider, model: parsed.model_identifier },
    prompt_version: parsed.prompt_version,
    created_at: parsed.created_at,
  });
}

export function findingToRow(input: FindingPersistenceInput) {
  const parsed = findingPersistenceInputSchema.parse(input);
  const finding = parsed.finding;
  const money = [finding.paid, finding.expected, finding.potential_gap].find((value) => value !== null);
  return {
    id: finding.finding_id,
    analysis_run_id: finding.analysis_run_id,
    category: finding.category,
    status: finding.status,
    period_start: finding.period?.start_date ?? null,
    period_end: finding.period?.end_date ?? null,
    currency: money?.currency ?? null,
    paid_minor_units: finding.paid?.minor_units ?? null,
    expected_minor_units: finding.expected?.minor_units ?? null,
    potential_gap_minor_units: finding.potential_gap?.minor_units ?? null,
    confidence: finding.confidence,
    confidence_tier: finding.confidence_tier,
    rule_id: finding.rule.rule_id,
    rule_version: finding.rule.rule_version,
    calculation_payload: finding.calculation_trace,
    fact_references: finding.fact_references,
    evidence_references: finding.evidence_references,
    requires_confirmation: finding.requires_confirmation,
    idempotency_key: parsed.idempotency_key,
    created_at: finding.created_at,
  };
}

export function findingFromRow(row: unknown, caseId: string) {
  const parsed = z
    .object({
      id: uuidSchema,
      analysis_run_id: uuidSchema,
      category: z.string(),
      status: z.enum(["candidate", "needs_confirmation", "verified", "rejected", "blocked"]),
      period_start: z.string().nullable(),
      period_end: z.string().nullable(),
      currency: z.string().nullable(),
      paid_minor_units: databaseSafeIntegerSchema.nullable(),
      expected_minor_units: databaseSafeIntegerSchema.nullable(),
      potential_gap_minor_units: databaseSafeIntegerSchema.nullable(),
      confidence: databaseConfidenceSchema,
      confidence_tier: z.enum(["low", "medium", "high"]),
      rule_id: z.string(),
      rule_version: z.string(),
      calculation_payload: z.unknown().nullable(),
      fact_references: z.array(uuidSchema),
      evidence_references: z.unknown(),
      requires_confirmation: z.boolean(),
      created_at: isoTimestampSchema,
    })
    .parse(row);
  const money = (minor_units: number | null) =>
    minor_units === null || parsed.currency === null ? null : { currency: parsed.currency, minor_units };
  return findingSchema.parse({
    finding_id: parsed.id,
    case_id: caseId,
    analysis_run_id: parsed.analysis_run_id,
    category: parsed.category,
    status: parsed.status,
    period:
      parsed.period_start === null
        ? null
        : { start_date: parsed.period_start, end_date: parsed.period_end },
    paid: money(parsed.paid_minor_units),
    expected: money(parsed.expected_minor_units),
    potential_gap: money(parsed.potential_gap_minor_units),
    confidence: parsed.confidence,
    confidence_tier: parsed.confidence_tier,
    fact_references: parsed.fact_references,
    evidence_references: parsed.evidence_references,
    rule: { rule_id: parsed.rule_id, rule_version: parsed.rule_version },
    calculation_trace: parsed.calculation_payload,
    requires_confirmation: parsed.requires_confirmation,
    created_at: parsed.created_at,
  });
}

export function extractionToRow(input: DocumentExtractionAttempt) {
  const parsed = documentExtractionAttemptSchema.parse(input);
  return {
    id: parsed.extraction_id,
    document_id: parsed.document_id,
    analysis_run_id: parsed.analysis_run_id,
    extractor_id: parsed.extractor_id,
    extractor_version: parsed.extractor_version,
    model_version: parsed.model_version,
    source_content_sha256: parsed.source_content_sha256,
    status: parsed.status,
    payload: parsed.payload,
    quality_metrics: parsed.quality_metrics,
    raw_artifact_path: parsed.raw_artifact_path,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.created_at,
    completed_at: parsed.completed_at,
    error_code: parsed.error_code,
  };
}

export function extractionFromRow(row: unknown) {
  const parsed = z.object({
    id: uuidSchema,
    document_id: uuidSchema,
    analysis_run_id: uuidSchema.nullable(),
    extractor_id: z.string(),
    extractor_version: z.string(),
    model_version: z.string().nullable(),
    source_content_sha256: z.string(),
    status: z.enum(["queued", "running", "partial", "completed", "failed"]),
    payload: z.unknown().nullable(),
    quality_metrics: z.unknown(),
    raw_artifact_path: z.string().nullable(),
    idempotency_key: z.string(),
    created_at: isoTimestampSchema,
    completed_at: isoTimestampSchema.nullable(),
    error_code: z.string().nullable(),
  }).parse(row);
  return documentExtractionAttemptSchema.parse({
    extraction_id: parsed.id,
    document_id: parsed.document_id,
    analysis_run_id: parsed.analysis_run_id,
    extractor_id: parsed.extractor_id,
    extractor_version: parsed.extractor_version,
    model_version: parsed.model_version,
    source_content_sha256: parsed.source_content_sha256,
    status: parsed.status,
    payload: parsed.payload,
    quality_metrics: parsed.quality_metrics,
    raw_artifact_path: parsed.raw_artifact_path,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.created_at,
    completed_at: parsed.completed_at,
    error_code: parsed.error_code,
  });
}

export function confirmationToRow(input: CaseConfirmation) {
  const parsed = caseConfirmationSchema.parse(input);
  return {
    id: parsed.confirmation_id,
    case_id: parsed.case_id,
    source_analysis_run_id: parsed.source_analysis_run_id,
    target_fact_path: parsed.target_fact_path,
    question_id: parsed.question_id,
    question_version: parsed.question_version,
    proposed_value: parsed.proposed_value,
    answer: parsed.answer,
    status: parsed.status,
    source_message_id: parsed.source_message_id,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.created_at,
    answered_at: parsed.answered_at,
  };
}

export function confirmationFromRow(row: unknown) {
  const parsed = z.object({
    id: uuidSchema,
    case_id: uuidSchema,
    source_analysis_run_id: uuidSchema,
    target_fact_path: z.string(),
    question_id: z.string(),
    question_version: z.number().int(),
    proposed_value: z.unknown().nullable(),
    answer: z.unknown().nullable(),
    status: z.enum(["pending", "confirmed", "rejected", "corrected"]),
    source_message_id: uuidSchema.nullable(),
    idempotency_key: z.string(),
    created_at: isoTimestampSchema,
    answered_at: isoTimestampSchema.nullable(),
  }).parse(row);
  return caseConfirmationSchema.parse({
    confirmation_id: parsed.id,
    case_id: parsed.case_id,
    source_analysis_run_id: parsed.source_analysis_run_id,
    target_fact_path: parsed.target_fact_path,
    question_id: parsed.question_id,
    question_version: parsed.question_version,
    proposed_value: parsed.proposed_value,
    answer: parsed.answer,
    status: parsed.status,
    source_message_id: parsed.source_message_id,
    idempotency_key: parsed.idempotency_key,
    created_at: parsed.created_at,
    answered_at: parsed.answered_at,
  });
}

export function jobToRow(input: AnalysisJob) {
  const parsed = analysisJobSchema.parse(input);
  return {
    id: parsed.job_id,
    analysis_run_id: parsed.analysis_run_id,
    document_id: parsed.document_id,
    extraction_id: parsed.extraction_id,
    stage: parsed.stage,
    status: parsed.status,
    payload: parsed.payload,
    idempotency_key: parsed.idempotency_key,
    retry_count: parsed.retry_count,
    max_attempts: parsed.max_attempts,
    available_at: parsed.available_at,
    locked_at: parsed.locked_at,
    completed_at: parsed.completed_at,
    error_code: parsed.error_code,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

export function jobFromRow(row: unknown) {
  const parsed = z.object({
    id: uuidSchema,
    analysis_run_id: uuidSchema,
    document_id: uuidSchema.nullable(),
    extraction_id: uuidSchema.nullable(),
    stage: z.string(),
    status: z.string(),
    payload: z.unknown(),
    idempotency_key: z.string(),
    retry_count: z.number().int(),
    max_attempts: z.number().int(),
    available_at: isoTimestampSchema,
    locked_at: isoTimestampSchema.nullable(),
    completed_at: isoTimestampSchema.nullable(),
    error_code: z.string().nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  }).parse(row);
  return analysisJobSchema.parse({
    job_id: parsed.id,
    analysis_run_id: parsed.analysis_run_id,
    document_id: parsed.document_id,
    extraction_id: parsed.extraction_id,
    stage: parsed.stage,
    status: parsed.status,
    payload: parsed.payload,
    idempotency_key: parsed.idempotency_key,
    retry_count: parsed.retry_count,
    max_attempts: parsed.max_attempts,
    available_at: parsed.available_at,
    locked_at: parsed.locked_at,
    completed_at: parsed.completed_at,
    error_code: parsed.error_code,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  });
}

export function immutableDocumentToRow(input: unknown) {
  const document = immutableDocumentSchema.parse(input);
  return {
    id: document.document_id,
    case_id: document.case_id,
    document_type: document.document_type,
    declared_type: document.document_type,
    detected_type: null,
    classification_confidence: null,
    content_sha256: document.content_sha256,
    storage_path: document.storage_path,
    original_filename: document.original_filename,
    mime_type: document.mime_type,
    size: document.size_bytes,
    period_start: document.document_period?.start_date ?? null,
    period_end: document.document_period?.end_date ?? null,
    supersedes_document_id: document.supersedes_document_id,
    processing_status: "uploaded",
    storage_layout: "immutable_v1",
    created_at: document.created_at,
  };
}

export function documentFromRow(row: unknown) {
  const parsed = z.object({
    id: uuidSchema,
    case_id: uuidSchema,
    document_type: z.string(),
    declared_type: z.string().nullable(),
    content_sha256: z.string().nullable(),
    storage_path: z.string(),
    original_filename: z.string(),
    mime_type: z.string(),
    size: databaseSafeIntegerSchema,
    period_start: z.string().nullable(),
    period_end: z.string().nullable(),
    supersedes_document_id: uuidSchema.nullable(),
    processing_status: z.string(),
    storage_layout: z.enum(["legacy_slot", "immutable_v1"]),
    created_at: isoTimestampSchema,
  }).parse(row);

  if (parsed.storage_layout === "legacy_slot") {
    return legacyDocumentSchema.parse({
      storage_layout: parsed.storage_layout,
      document_id: parsed.id,
      case_id: parsed.case_id,
      document_type: parsed.document_type,
      storage_path: parsed.storage_path,
      original_filename: parsed.original_filename,
      mime_type: parsed.mime_type,
      size_bytes: parsed.size,
      processing_status: parsed.processing_status,
      created_at: parsed.created_at,
    });
  }

  return immutableDocumentSchema.parse({
    document_id: parsed.id,
    case_id: parsed.case_id,
    document_type: parsed.declared_type,
    original_filename: parsed.original_filename,
    mime_type: parsed.mime_type,
    size_bytes: parsed.size,
    content_sha256: parsed.content_sha256,
    storage_path: parsed.storage_path,
    document_period:
      parsed.period_start === null ? null : { start_date: parsed.period_start, end_date: parsed.period_end },
    supersedes_document_id: parsed.supersedes_document_id,
    created_at: parsed.created_at,
  });
}
