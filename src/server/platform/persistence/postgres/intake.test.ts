import { describe, expect, it } from "vitest";
import type { PostgresClient, PostgresQueryResult, PostgresStatement, PostgresTransactionContext } from "./contracts";
import {
  INTAKE_SQL, INTAKE_SQL_INVENTORY,
  PostgresCanonicalFactsRepository,
  PostgresCaseLifecycleRepository,
  PostgresConversationRepository,
  PostgresDocumentArtifactRepository,
  PostgresExtractionRepository,
  PostgresIntakeError,
  PostgresInvestigationRepository,
  PostgresPaymentEvidenceRepository,
  intakeCodecSchemas,
  intake_factory,
} from "./intake/index.ts";

const tenant = "tenant:synthetic:001";
const caseId = "case:synthetic:001";
const at = "2026-08-31T10:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

type QueuedResult = PostgresQueryResult | Error;
class RecordingClient implements PostgresClient {
  readonly statements: PostgresStatement[] = [];
  constructor(private readonly queued: QueuedResult[]) {}
  async query(statement: PostgresStatement): Promise<PostgresQueryResult> {
    this.statements.push(statement);
    const result = this.queued.shift();
    if (!result) throw new Error("unplanned query contains private driver detail");
    if (result instanceof Error) throw result;
    return result;
  }
}

const result = (...rows: Readonly<Record<string, unknown>>[]): PostgresQueryResult => ({ rows, row_count: rows.length });
function context(...results: QueuedResult[]) {
  const client = new RecordingClient(results);
  return { client, context: Object.freeze({ client, transaction_id: "tx:synthetic:001" }) satisfies PostgresTransactionContext };
}

const owner = { tenant_id: tenant, case_id: caseId };
const initialCase = {
  ...owner, expected_revision: 0, state_before: null, state_after: "awaiting_documents" as const,
  event_kind: "case.intake", command_sha256: hashA, event_sha256: hashB, previous_sha256: null,
  state_sha256: hashA, occurred_at: at,
};
const payment = {
  ...owner, evidence_id: "evidence:001", evidence_revision: "revision:001", evidence_sha256: hashA,
  status: "settled" as const, bound_at: at,
};
const conversation = {
  ...owner, conversation_id: "conversation:001", analysis_run_id: "run:001", status: "open" as const,
  idempotency_key: "conversation:001", created_at: at, closed_at: null,
};
const message = {
  ...owner, message_id: "message:001", conversation_id: "conversation:001", analysis_run_id: "run:001",
  role: "customer" as const, agent: null, question_id: null, question_version: null, selected_option_ids: [],
  free_text_answer: null, content: "synthetic message", model_provider: null, model_identifier: null,
  prompt_version: null, idempotency_key: "message:001", created_at: at,
};
const document = {
  ...owner, document_id: "document:001", declared_type: "payslip", detected_type: "payslip",
  classification_confidence: 1, content_sha256: hashA,
  storage_path: `${caseId.startsWith("case:") ? `cases/${caseId}` : caseId}/documents/document:001/original.pdf`,
  original_filename: "synthetic.pdf", mime_type: "application/pdf" as const, size_bytes: 100,
  period_start: "2026-01-01", period_end: "2026-01-31", supersedes_document_id: null,
  processing_status: "ready" as const, created_at: at,
};
const artifact = {
  ...owner, reservation_id: "reservation:001", opaque_key: "object:001", expected_sha256: hashA,
  expected_length: 100, detected_mime: "application/pdf", retention_class: "case_record",
  state: "reserved" as const, revision: 1, staged_sha256: null, staged_length: null,
  object_version_id: null, visible: false, created_at: at, updated_at: at,
};
const extraction = {
  ...owner, extraction_id: "extraction:001", document_id: "document:001", analysis_run_id: "run:001",
  extractor_id: "extractor:synthetic", extractor_version: "1.0.0", model_version: null,
  source_content_sha256: hashA, status: "queued" as const, payload: null,
  quality_metrics: { page_count: 1, mean_confidence: 1, warning_codes: [] }, raw_artifact_path: null, idempotency_key: "extraction:001",
  created_at: at, completed_at: null, error_code: null,
};
const fact = {
  ...owner, fact_id: "fact:001", revision: 1, expected_prior_revision: 0, analysis_run_id: "run:001",
  payload: { schema_version: "synthetic-fact-v1", status: "conflicted" }, payload_sha256: hashA, created_at: at,
};
const hypothesis = {
  ...owner, hypothesis_id: "hypothesis:001", analysis_run_id: "run:001", hypothesis_key: "hypothesis.minimum_wage",
  category: "minimum_wage", status: "open" as const, priority: "high" as const,
  payload: { schema_version: "synthetic-hypothesis-v1", reason: "synthetic" },
  idempotency_key: "hypothesis:001", created_at: at,
};
const ruleInput = {
  ...owner, rule_input_id: "rule-input:001", revision: 1, expected_prior_revision: 0, analysis_run_id: "run:001",
  topic: "minimum_wage" as const, payload: { snapshot_id: "snapshot:001", snapshot_version: "v1.0.0", snapshot_sha256: hashA },
  payload_sha256: hashB, created_at: at,
};

describe("V0.9 W1 PostgreSQL intake contract", () => {
  it("exports one transaction-scoped factory with all seven ledger adapters", () => {
    const recording = context();
    const bundle = intake_factory(recording.context, tenant);
    expect(bundle.context).toBe(recording.context);
    expect(bundle.tenant_id).toBe(tenant);
    expect(Object.keys(bundle).sort()).toEqual([
      "canonical_facts", "case_lifecycle", "context", "conversations", "documents_and_artifacts",
      "extractions", "investigation", "payment_evidence", "tenant_id",
    ]);
    expect(() => intake_factory({} as PostgresTransactionContext, tenant)).toThrowError(/INTAKE_TRANSACTION_CONTEXT_INVALID/);
  });

  it("records only named parameterized SQL and carries the supplied transaction context", async () => {
    const recording = context(
      result({ case_id: caseId, tenant_id: tenant, revision: "1", lifecycle_state: "awaiting_documents", state_sha256: hashA, updated_at: at }),
      result({ revision: "1" }),
      result(payment),
      result(payment),
      result({ conversation_id: conversation.conversation_id, case_id: caseId, analysis_run_id: "run:001", status: "open", idempotency_key: conversation.idempotency_key, created_at: at, closed_at: null }),
      result({ message_id: message.message_id, case_id: caseId, conversation_id: message.conversation_id, idempotency_key: message.idempotency_key }),
      result({ document_id: document.document_id, case_id: caseId, content_sha256: hashA }),
      result({ reservation_id: artifact.reservation_id, revision: "1", expected_sha256: hashA, state: "reserved", visible: false }),
      result({ extraction_id: extraction.extraction_id, document_id: extraction.document_id, source_content_sha256: hashA, status: "queued", payload: null, quality_metrics: extraction.quality_metrics }),
      result(), result({ fact_id: fact.fact_id, revision: "1", payload: fact.payload, payload_sha256: hashA }),
      result({ hypothesis_id: hypothesis.hypothesis_id, analysis_run_id: "run:001", hypothesis_key: hypothesis.hypothesis_key, status: "open", priority: "high", payload: hypothesis.payload, idempotency_key: hypothesis.idempotency_key }),
      result(), result({ rule_input_id: ruleInput.rule_input_id, revision: "1", topic: "minimum_wage", payload: ruleInput.payload, payload_sha256: hashB }),
    );
    await new PostgresCaseLifecycleRepository().append(recording.context, initialCase);
    const payments = new PostgresPaymentEvidenceRepository();
    await payments.append(recording.context, payment);
    await payments.list(recording.context, owner);
    const conversations = new PostgresConversationRepository();
    await conversations.appendConversation(recording.context, conversation);
    await conversations.appendMessage(recording.context, message);
    const documents = new PostgresDocumentArtifactRepository();
    await documents.appendDocument(recording.context, document);
    await documents.appendArtifact(recording.context, artifact);
    await new PostgresExtractionRepository().append(recording.context, extraction);
    await new PostgresCanonicalFactsRepository().append(recording.context, fact);
    const investigation = new PostgresInvestigationRepository();
    await investigation.appendHypothesis(recording.context, hypothesis);
    await investigation.appendRuleInput(recording.context, ruleInput);

    expect(recording.client.statements).toHaveLength(14);
    for (const statement of recording.client.statements) {
      expect(statement.name).toMatch(/^intake_[a-z0-9_]+$/);
      expect(statement.text).not.toContain("${");
      expect(statement.text).not.toContain(tenant);
      expect(statement.text).not.toContain(caseId);
      expect(Object.isFrozen(statement.values)).toBe(true);
    }
    expect(recording.client.statements.flatMap((statement) => statement.values)).toContain(tenant);
    expect(recording.client.statements.flatMap((statement) => statement.values)).toContain(caseId);
  });

  it("publishes a complete, non-interpolated SQL inventory", () => {
    expect(INTAKE_SQL_INVENTORY).toHaveLength(16);
    expect(new Set(INTAKE_SQL_INVENTORY.map((entry) => entry.name)).size).toBe(INTAKE_SQL_INVENTORY.length);
    expect(INTAKE_SQL_INVENTORY.every((entry) => entry.parameter_count > 0 && !entry.interpolated)).toBe(true);
    expect(INTAKE_SQL_INVENTORY.flatMap((entry) => entry.tables)).toEqual(expect.arrayContaining([
      "engine_case_state", "engine_case_lifecycle_revisions", "engine_payment_evidence_refs",
      "case_conversations", "case_messages", "documents", "engine_object_write_sagas",
      "document_extractions", "engine_canonical_fact_versions", "analysis_hypotheses", "engine_rule_input_versions",
    ]));
    const text = recordingSqlText();
    expect(text).toContain("private.resolve_engine_case_id");
    expect(text).toContain("private.canonical_text_uuid");
    expect(text).toContain("canonical_case_id");
    expect(text).toContain("canonical_document_id");
    expect(text).toContain("canonical_conversation_id");
    expect(text).not.toMatch(/\$\d+::uuid/u);
  });

  it("conceals ownership misses and detects stale or immutable versions", async () => {
    const missing = context(result());
    expect(await new PostgresCaseLifecycleRepository().get(missing.context, { ...owner, tenant_id: "tenant:other" })).toBeNull();
    expect(missing.client.statements[0]?.values).toEqual(["tenant:other", caseId]);

    const stale = context(result());
    await expect(new PostgresCaseLifecycleRepository().append(stale.context, { ...initialCase, expected_revision: 1, state_before: "awaiting_payment" }))
      .rejects.toMatchObject({ code: "INTAKE_REVISION_CONFLICT", operation: "case.append" });
    const duplicate = context(result());
    await expect(new PostgresPaymentEvidenceRepository().append(duplicate.context, payment))
      .rejects.toMatchObject({ code: "INTAKE_IMMUTABLE_VERSION_MISMATCH" });
    const changedReplay = context(result());
    await expect(new PostgresConversationRepository().appendMessage(changedReplay.context, { ...message, content: "changed" }))
      .rejects.toMatchObject({ code: "INTAKE_IDEMPOTENCY_MISMATCH", operation: "message.append" });
  });

  it("maps driver failures to safe typed errors without leaking SQL or driver detail", async () => {
    const recording = context(new Error("password=secret relation customer_private missing"));
    const rejection = new PostgresCaseLifecycleRepository().get(recording.context, owner);
    await expect(rejection).rejects.toBeInstanceOf(PostgresIntakeError);
    await expect(rejection).rejects.toMatchObject({ code: "INTAKE_QUERY_FAILED", operation: "case.get" });
    await expect(rejection).rejects.not.toThrow(/password|secret|relation|select|customer/iu);
  });
});

function recordingSqlText() {
  return Object.values(INTAKE_SQL).map((definition) => definition.text).join("\n");
}

describe("V0.9 W1 strict negative codecs", () => {
  it.each([
    ["missing ownership", intakeCodecSchemas.paymentEvidenceWriteSchema, { ...payment, tenant_id: undefined }],
    ["unknown property", intakeCodecSchemas.conversationWriteSchema, { ...conversation, unexpected: true }],
    ["wrong enum", intakeCodecSchemas.paymentEvidenceWriteSchema, { ...payment, status: "paid" }],
    ["unexpected null", intakeCodecSchemas.paymentEvidenceWriteSchema, { ...payment, evidence_sha256: null }],
    ["corrupted hash", intakeCodecSchemas.factWriteSchema, { ...fact, payload_sha256: "A".repeat(64) }],
    ["integer overflow", intakeCodecSchemas.artifactWriteSchema, { ...artifact, expected_length: Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong version", intakeCodecSchemas.extractionWriteSchema, { ...extraction, extractor_version: "v1.0.0" }],
    ["wrong revision", intakeCodecSchemas.ruleInputWriteSchema, { ...ruleInput, revision: 3 }],
    ["malformed JSON", intakeCodecSchemas.hypothesisWriteSchema, { ...hypothesis, payload: "{bad" }],
    ["unsafe confidence", intakeCodecSchemas.documentWriteSchema, { ...document, classification_confidence: Number.POSITIVE_INFINITY }],
    ["invalid null combination", intakeCodecSchemas.extractionWriteSchema, { ...extraction, status: "completed", completed_at: at, payload: null }],
    ["idempotency provenance mismatch", intakeCodecSchemas.messageWriteSchema, { ...message, role: "assistant" }],
  ])("rejects %s", (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["malformed bigint", intakeCodecSchemas.caseStateRowSchema, { case_id: caseId, tenant_id: tenant, revision: "NaN", lifecycle_state: "awaiting_documents", state_sha256: hashA, updated_at: at }],
    ["bigint overflow", intakeCodecSchemas.caseStateRowSchema, { case_id: caseId, tenant_id: tenant, revision: "9007199254740992", lifecycle_state: "awaiting_documents", state_sha256: hashA, updated_at: at }],
    ["wrong row enum", intakeCodecSchemas.artifactReceiptRowSchema, { reservation_id: "reservation:001", revision: "1", expected_sha256: hashA, state: "published", visible: true }],
    ["row hash corruption", intakeCodecSchemas.documentReceiptRowSchema, { document_id: "document:001", case_id: caseId, content_sha256: hashA.slice(1) }],
    ["row JSON string", intakeCodecSchemas.factReceiptRowSchema, { fact_id: "fact:001", revision: "1", payload: "{}", payload_sha256: hashA }],
    ["row unexpected null", intakeCodecSchemas.ruleInputReceiptRowSchema, { rule_input_id: "rule:001", revision: "1", topic: "travel", payload: null, payload_sha256: hashA }],
    ["row unknown field", intakeCodecSchemas.messageReceiptRowSchema, { message_id: "message:001", case_id: caseId, conversation_id: "conversation:001", idempotency_key: "message:001", extra: true }],
  ])("rejects %s", (_label, schema, row) => {
    expect(schema.safeParse(row).success).toBe(false);
  });
});
