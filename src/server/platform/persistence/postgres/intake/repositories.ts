import type { PostgresParameter, PostgresQueryResult, PostgresTransactionContext } from "../contracts";
import {
  artifactReceiptRowSchema, artifactWriteSchema, caseLifecycleWriteSchema, caseStateRowSchema,
  conversationReceiptRowSchema, conversationWriteSchema, documentReceiptRowSchema, documentWriteSchema,
  extractionReceiptRowSchema, extractionWriteSchema, factReceiptRowSchema, factWriteSchema,
  hypothesisReceiptRowSchema, hypothesisWriteSchema, messageReceiptRowSchema, messageWriteSchema,
  ownerSchema, parseInput, parseRow, paymentEvidenceRowSchema, paymentEvidenceWriteSchema, requireContext,
  ruleInputReceiptRowSchema, ruleInputWriteSchema, tenantIdSchema,
} from "./codecs";
import { PostgresIntakeError } from "./errors";
import { INTAKE_SQL, intakeStatement } from "./sql";

type SchemaOutput<S> = S extends { parse(input: unknown): infer T } ? T : never;
type CaseWrite = SchemaOutput<typeof caseLifecycleWriteSchema>;
type PaymentWrite = SchemaOutput<typeof paymentEvidenceWriteSchema>;
type ConversationWrite = SchemaOutput<typeof conversationWriteSchema>;
type MessageWrite = SchemaOutput<typeof messageWriteSchema>;
type DocumentWrite = SchemaOutput<typeof documentWriteSchema>;
type ArtifactWrite = SchemaOutput<typeof artifactWriteSchema>;
type ExtractionWrite = SchemaOutput<typeof extractionWriteSchema>;
type FactWrite = SchemaOutput<typeof factWriteSchema>;
type HypothesisWrite = SchemaOutput<typeof hypothesisWriteSchema>;
type RuleInputWrite = SchemaOutput<typeof ruleInputWriteSchema>;

async function query(context: PostgresTransactionContext, definition: (typeof INTAKE_SQL)[keyof typeof INTAKE_SQL], values: readonly PostgresParameter[], operation: string): Promise<PostgresQueryResult> {
  const transaction = requireContext(context);
  try {
    return await transaction.client.query(intakeStatement(definition, values));
  } catch (error) {
    if (error instanceof PostgresIntakeError) throw error;
    throw new PostgresIntakeError("INTAKE_QUERY_FAILED", operation);
  }
}

function one(result: PostgresQueryResult, operation: string): Readonly<Record<string, unknown>> {
  const row = result.rows[0];
  if (result.row_count !== 1 || !row) throw new PostgresIntakeError("INTAKE_RECORD_NOT_FOUND", operation);
  return row;
}

function json(value: object | null): string | null { return value === null ? null : JSON.stringify(value); }
function nullableCanonicalId(value: string | null): string | null { return value; }

export class PostgresCaseLifecycleRepository {
  async get(context: PostgresTransactionContext, owner: unknown) {
    const input = parseInput(ownerSchema, owner, "case.get");
    const result = await query(context, INTAKE_SQL.caseSelect, [input.tenant_id, input.case_id], "case.get");
    if (result.row_count === 0) return null;
    return parseRow(caseStateRowSchema, one(result, "case.get"), "case.get");
  }

  async append(context: PostgresTransactionContext, command: unknown) {
    const input: CaseWrite = parseInput(caseLifecycleWriteSchema, command, "case.append");
    const initial = input.expected_revision === 0;
    const values: readonly PostgresParameter[] = initial
      ? [input.case_id, input.tenant_id, input.state_after, input.state_sha256, input.occurred_at, input.expected_revision]
      : [input.tenant_id, input.case_id, input.state_after, input.state_sha256, input.occurred_at, input.expected_revision];
    const result = await query(context, initial ? INTAKE_SQL.caseInsert : INTAKE_SQL.caseUpdate, values, "case.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_REVISION_CONFLICT", "case.append");
    const state = parseRow(caseStateRowSchema, one(result, "case.append"), "case.append");
    const lifecycle = await query(context, INTAKE_SQL.lifecycleInsert, [
      input.case_id, input.tenant_id, state.revision, input.state_before, input.state_after, input.event_kind,
      input.command_sha256, input.event_sha256, input.previous_sha256, input.occurred_at,
    ], "case.lifecycle.append");
    if (lifecycle.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "case.lifecycle.append");
    return state;
  }
}

export class PostgresPaymentEvidenceRepository {
  async append(context: PostgresTransactionContext, value: unknown) {
    const input: PaymentWrite = parseInput(paymentEvidenceWriteSchema, value, "payment.append");
    const result = await query(context, INTAKE_SQL.paymentInsert, [input.tenant_id, input.case_id, input.evidence_id,
      input.evidence_revision, input.evidence_sha256, input.status, input.bound_at], "payment.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "payment.append");
    return parseRow(paymentEvidenceRowSchema, one(result, "payment.append"), "payment.append");
  }

  async list(context: PostgresTransactionContext, owner: unknown) {
    const input = parseInput(ownerSchema, owner, "payment.list");
    const result = await query(context, INTAKE_SQL.paymentSelect, [input.tenant_id, input.case_id], "payment.list");
    return result.rows.map((row) => parseRow(paymentEvidenceRowSchema, row, "payment.list"));
  }
}

export class PostgresConversationRepository {
  async appendConversation(context: PostgresTransactionContext, value: unknown) {
    const input: ConversationWrite = parseInput(conversationWriteSchema, value, "conversation.append");
    const result = await query(context, INTAKE_SQL.conversationInsert, [input.tenant_id, input.case_id,
      input.conversation_id, nullableCanonicalId(input.analysis_run_id), input.status, input.idempotency_key,
      input.created_at, input.closed_at], "conversation.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IDEMPOTENCY_MISMATCH", "conversation.append");
    return parseRow(conversationReceiptRowSchema, one(result, "conversation.append"), "conversation.append");
  }

  async appendMessage(context: PostgresTransactionContext, value: unknown) {
    const input: MessageWrite = parseInput(messageWriteSchema, value, "message.append");
    const result = await query(context, INTAKE_SQL.messageInsert, [input.tenant_id, input.case_id, input.message_id,
      input.conversation_id, nullableCanonicalId(input.analysis_run_id), input.role, input.agent, input.question_id,
      input.question_version, JSON.stringify(input.selected_option_ids), input.free_text_answer, input.content,
      input.model_provider, input.model_identifier, input.prompt_version, input.idempotency_key, input.created_at], "message.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IDEMPOTENCY_MISMATCH", "message.append");
    return parseRow(messageReceiptRowSchema, one(result, "message.append"), "message.append");
  }
}

export class PostgresDocumentArtifactRepository {
  async appendDocument(context: PostgresTransactionContext, value: unknown) {
    const input: DocumentWrite = parseInput(documentWriteSchema, value, "document.append");
    const result = await query(context, INTAKE_SQL.documentInsert, [input.tenant_id, input.case_id, input.document_id,
      input.declared_type, input.storage_path, input.original_filename, input.mime_type, input.size_bytes,
      input.created_at, input.detected_type, input.classification_confidence, input.content_sha256,
      input.period_start, input.period_end, nullableCanonicalId(input.supersedes_document_id), input.processing_status], "document.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "document.append");
    return parseRow(documentReceiptRowSchema, one(result, "document.append"), "document.append");
  }

  async appendArtifact(context: PostgresTransactionContext, value: unknown) {
    const input: ArtifactWrite = parseInput(artifactWriteSchema, value, "artifact.append");
    const result = await query(context, INTAKE_SQL.artifactInsert, [input.tenant_id, input.case_id,
      input.reservation_id, input.opaque_key, input.expected_sha256, input.expected_length, input.detected_mime,
      input.retention_class, input.state, input.revision, input.staged_sha256, input.staged_length,
      input.object_version_id, input.visible, input.created_at, input.updated_at], "artifact.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "artifact.append");
    return parseRow(artifactReceiptRowSchema, one(result, "artifact.append"), "artifact.append");
  }
}

export class PostgresExtractionRepository {
  async append(context: PostgresTransactionContext, value: unknown) {
    const input: ExtractionWrite = parseInput(extractionWriteSchema, value, "extraction.append");
    const result = await query(context, INTAKE_SQL.extractionInsert, [input.tenant_id, input.case_id,
      input.extraction_id, input.document_id, nullableCanonicalId(input.analysis_run_id), input.extractor_id,
      input.extractor_version, input.model_version, input.source_content_sha256, input.status, json(input.payload),
      json(input.quality_metrics), input.raw_artifact_path, input.idempotency_key, input.created_at,
      input.completed_at, input.error_code], "extraction.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IDEMPOTENCY_MISMATCH", "extraction.append");
    return parseRow(extractionReceiptRowSchema, one(result, "extraction.append"), "extraction.append");
  }
}

async function requirePrior(context: PostgresTransactionContext, definition: typeof INTAKE_SQL.factPrior | typeof INTAKE_SQL.ruleInputPrior, owner: { tenant_id: string; case_id: string }, id: string, expected: number, operation: string) {
  const result = await query(context, definition, [owner.tenant_id, owner.case_id, id], operation);
  if (expected === 0 && result.row_count === 0) return;
  const row = result.rows[0];
  const raw = row?.revision;
  const parsed = typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new PostgresIntakeError("INTAKE_ROW_INVALID", operation);
  if (parsed !== expected) throw new PostgresIntakeError("INTAKE_REVISION_CONFLICT", operation);
}

export class PostgresCanonicalFactsRepository {
  async append(context: PostgresTransactionContext, value: unknown) {
    const input: FactWrite = parseInput(factWriteSchema, value, "fact.append");
    requireContext(context);
    await requirePrior(context, INTAKE_SQL.factPrior, input, input.fact_id, input.expected_prior_revision, "fact.prior");
    const result = await query(context, INTAKE_SQL.factInsert, [input.tenant_id, input.case_id, input.fact_id,
      input.revision, nullableCanonicalId(input.analysis_run_id), json(input.payload), input.payload_sha256, input.created_at], "fact.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "fact.append");
    return parseRow(factReceiptRowSchema, one(result, "fact.append"), "fact.append");
  }
}

export class PostgresInvestigationRepository {
  async appendHypothesis(context: PostgresTransactionContext, value: unknown) {
    const input: HypothesisWrite = parseInput(hypothesisWriteSchema, value, "hypothesis.append");
    const result = await query(context, INTAKE_SQL.hypothesisInsert, [input.tenant_id, input.case_id,
      input.analysis_run_id, input.hypothesis_id, input.hypothesis_key, input.category, input.status,
      input.priority, json(input.payload), input.idempotency_key, input.created_at], "hypothesis.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IDEMPOTENCY_MISMATCH", "hypothesis.append");
    return parseRow(hypothesisReceiptRowSchema, one(result, "hypothesis.append"), "hypothesis.append");
  }

  async appendRuleInput(context: PostgresTransactionContext, value: unknown) {
    const input: RuleInputWrite = parseInput(ruleInputWriteSchema, value, "rule_input.append");
    requireContext(context);
    await requirePrior(context, INTAKE_SQL.ruleInputPrior, input, input.rule_input_id, input.expected_prior_revision, "rule_input.prior");
    const result = await query(context, INTAKE_SQL.ruleInputInsert, [input.tenant_id, input.case_id,
      input.rule_input_id, input.revision, input.analysis_run_id, input.topic, json(input.payload),
      input.payload_sha256, input.created_at], "rule_input.append");
    if (result.row_count !== 1) throw new PostgresIntakeError("INTAKE_IMMUTABLE_VERSION_MISMATCH", "rule_input.append");
    return parseRow(ruleInputReceiptRowSchema, one(result, "rule_input.append"), "rule_input.append");
  }
}

export type PostgresIntakeAdapterBundle = Readonly<{
  context: PostgresTransactionContext;
  tenant_id: string;
  case_lifecycle: PostgresCaseLifecycleRepository;
  payment_evidence: PostgresPaymentEvidenceRepository;
  conversations: PostgresConversationRepository;
  documents_and_artifacts: PostgresDocumentArtifactRepository;
  extractions: PostgresExtractionRepository;
  canonical_facts: PostgresCanonicalFactsRepository;
  investigation: PostgresInvestigationRepository;
}>;

/** Construct only inside the transaction callback; adapters never own a client or transaction. */
export function intake_factory(context: PostgresTransactionContext, tenantId: unknown): PostgresIntakeAdapterBundle {
  const transaction = requireContext(context);
  const tenant_id = parseInput(tenantIdSchema, tenantId, "intake_factory.tenant");
  return Object.freeze({
    context: transaction,
    tenant_id,
    case_lifecycle: new PostgresCaseLifecycleRepository(),
    payment_evidence: new PostgresPaymentEvidenceRepository(),
    conversations: new PostgresConversationRepository(),
    documents_and_artifacts: new PostgresDocumentArtifactRepository(),
    extractions: new PostgresExtractionRepository(),
    canonical_facts: new PostgresCanonicalFactsRepository(),
    investigation: new PostgresInvestigationRepository(),
  });
}
