import { describe, expect, it } from "vitest";

import type { ImmutableDocument } from "../../../engine/domain/documents.ts";
import type { ExtractionResult } from "../../../engine/extraction/contracts.ts";
import type { CanonicalFact } from "../../../engine/facts/contracts.ts";
import type { EmploymentSnapshot } from "../../../engine/facts/snapshot.ts";
import type { InterviewQuestion } from "../../../engine/interview/contracts.ts";
import { registerRuleInputMappingRegistry } from "../../../engine/rule-input/mapping-registry.ts";
import type { PostgresStatement, PostgresTransactionContext } from "../../platform/persistence/postgres/contracts.ts";
import type { CaseConfirmation } from "../persistence-contracts.ts";
import {
  DurableMultiDocumentIntakeApplication,
  type DurableMultiDocumentIntakeCommand,
  type DurableMultiDocumentSnapshotPort,
  type DurableMultiDocumentSourceSnapshot,
  type DurableMultiDocumentTransactionBundle,
} from "./application.ts";

const CASE_ID = id(1);
const ANALYSIS_RUN_ID = id(2);
const PREPARED_AT = "2031-01-04T00:00:00.000Z";
const REQUIRED_PERIOD = Object.freeze({ start_date: "2030-01-01", end_date: "2030-12-31" });

const TOPIC_FACT_PATH = Object.freeze({
  minimum_wage: "compensation.base_monthly_salary",
  working_time: "work.regular_hours",
  pension: "pension.base_salary",
  travel: "travel.reimbursement",
  convalescence: "convalescence.payment",
  vacation: "leave.vacation_balance",
  sick_leave: "leave.sick_balance",
} as const);

type Topic = keyof typeof TOPIC_FACT_PATH;

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function document(
  number: number,
  month: string,
  options: Readonly<{ hash?: string; supersedes?: string | null }> = {},
): ImmutableDocument {
  const documentId = id(number);
  return Object.freeze({
    document_id: documentId,
    case_id: CASE_ID,
    document_type: "payslip",
    original_filename: `synthetic-${number}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 256,
    content_sha256: options.hash ?? number.toString(16).padStart(64, "0"),
    storage_path: `cases/${CASE_ID}/documents/${documentId}/original.pdf`,
    document_period: { start_date: `2030-${month}-01`, end_date: `2030-${month}-28` },
    supersedes_document_id: options.supersedes ?? null,
    created_at: "2031-01-01T00:00:00.000Z",
  });
}

function extraction(number: number, source: ImmutableDocument): ExtractionResult {
  return Object.freeze({
    extraction_id: id(100 + number),
    document_id: source.document_id,
    status: "completed",
    detected_document_type: "payslip",
    document_quality_confidence: 0.95,
    quality_metrics: {
      page_count: 1,
      text_coverage: 0.95,
      rotation_degrees: 0,
      source_resolution_dpi: 300,
    },
    fields: [],
    additional_components: [],
    sensitive_metadata: [],
    earnings_components_complete: true,
    warnings: [],
    provider: { provider_id: "synthetic.fixture", extractor_version: "1.0.0", model_version: null },
    operation: { duration_ms: 1, provider_response_id: null, token_usage: null },
    extracted_at: "2031-01-02T00:00:00.000Z",
    error_code: null,
  });
}

function fact(
  number: number,
  path: CanonicalFact["path"],
  documentId: string,
  status: "missing" | "conflicted",
): CanonicalFact {
  return {
    fact_id: id(700 + number),
    case_id: CASE_ID,
    path,
    status,
    value: null,
    provenance: [{
      source_type: "documented",
      source_reference: { kind: "document", document_id: documentId, locator: { page: 1 } },
    }],
    confidence: status === "conflicted" ? 0.7 : 0,
    conflicting_fact_ids: status === "conflicted" ? [id(800 + number * 2), id(801 + number * 2)] : [],
    resolution: null,
    created_at: "2031-01-03T00:00:00.000Z",
  } as CanonicalFact;
}

function scenario(): DurableMultiDocumentSourceSnapshot {
  const baseDocuments = ["01", "02", "03", "04", "05", "07", "08", "09", "10", "11", "12"]
    .map((month, index) => document(10 + index, month));
  const january = baseDocuments[0]!;
  const february = baseDocuments[1]!;
  const duplicateJanuary = document(30, "01", { hash: january.content_sha256 });
  const correctedFebruary = document(31, "02", { supersedes: february.document_id });
  const documents = [...baseDocuments, duplicateJanuary, correctedFebruary];
  const facts = (Object.entries(TOPIC_FACT_PATH) as readonly [Topic, CanonicalFact["path"]][])
    .map(([, path], index) => fact(
      index,
      path,
      documents[index]!.document_id,
      path === "work.regular_hours" || path === "leave.sick_balance" ? "conflicted" : "missing",
    ));
  const factSnapshot: EmploymentSnapshot = {
    snapshot_id: id(600),
    case_id: CASE_ID,
    analysis_run_id: ANALYSIS_RUN_ID,
    schema_version: "1.0.0",
    facts,
    created_at: "2031-01-03T00:00:00.000Z",
  };
  return Object.freeze({
    documents,
    extractions: documents.map((entry, index) => extraction(index, entry)),
    fact_snapshot: factSnapshot,
    prior_confirmations: [],
    prior_warning_codes: ["synthetic.prior.warning"],
  });
}

function command(): DurableMultiDocumentIntakeCommand {
  const topics = Object.keys(TOPIC_FACT_PATH) as Topic[];
  const mappingRegistry = registerRuleInputMappingRegistry({
    registry_id: "synthetic.multi.document.registry",
    registry_version: "1.0.0",
    mappings: topics.map((topic) => ({
      input_id: `input.${topic}`,
      runtime_fact_path: `synthetic.${topic}.input`,
      fact_path: TOPIC_FACT_PATH[topic],
      minimum_confidence: 0.8,
      max_age_seconds: 31_536_000,
      expected_output: { kind: "decimal" as const, unit: "synthetic_units" },
      transformation: { transformation_id: "synthetic.identity", transformation_version: "1.0.0" },
    })),
  });
  const questions: InterviewQuestion[] = topics.map((topic) => ({
    question_id: `clarification.${topic}`,
    version: 1,
    type: "free_text",
    target_fact_path: TOPIC_FACT_PATH[topic],
    text: `Synthetic clarification for ${topic}`,
    options: [],
    allow_free_text: true,
    reason: "Synthetic technical completeness fixture.",
  }));
  return Object.freeze({
    case_id: CASE_ID,
    analysis_run_id: ANALYSIS_RUN_ID,
    required_period: REQUIRED_PERIOD,
    mapping_registry: mappingRegistry,
    scopes: topics.map((topic) => ({
      scope_id: `scope.${topic}`,
      topic,
      period: REQUIRED_PERIOD,
      input_ids: [`input.${topic}`],
    })),
    approved_question_bank: questions,
    prepared_at: PREPARED_AT,
    expected_rule_input_revisions: Object.freeze(Object.fromEntries(topics.map((topic) => [topic, 0]))) as Record<Topic, number>,
  });
}

class RecordingSource implements DurableMultiDocumentSnapshotPort {
  readonly persistence_mode = "isolated_postgres" as const;
  readonly product_reachable_memory_fallbacks = 0 as const;
  context: PostgresTransactionContext | null = null;
  request: Readonly<{ tenant_id: string; case_id: string; analysis_run_id: string }> | null = null;

  constructor(public snapshot: DurableMultiDocumentSourceSnapshot) {}

  async load(
    context: PostgresTransactionContext,
    input: Readonly<{ tenant_id: string; case_id: string; analysis_run_id: string }>,
  ) {
    this.context = context;
    this.request = input;
    return this.snapshot;
  }
}

class RecordingClient {
  readonly statements: PostgresStatement[] = [];
  readonly ruleInputs = new Map<string, Readonly<Record<string, unknown>>>();

  async query(query: PostgresStatement) {
    this.statements.push(query);
    const idValue = query.values[2];
    const row = typeof idValue === "string" ? this.ruleInputs.get(idValue) : undefined;
    return row ? { rows: [row], row_count: 1 } : { rows: [], row_count: 0 };
  }
}

function harness(snapshot = scenario()) {
  const source = new RecordingSource(snapshot);
  const client = new RecordingClient();
  const context = Object.freeze({ client, transaction_id: "tx:synthetic:multi-document" });
  const conversations: Readonly<Record<string, unknown>>[] = [];
  const messages: Readonly<Record<string, unknown>>[] = [];
  const confirmations: CaseConfirmation[] = [];
  const ruleInputWrites: Readonly<Record<string, unknown>>[] = [];
  const intake = {
    context,
    tenant_id: "tenant:synthetic:multi-document",
    conversations: {
      async appendConversation(_context: PostgresTransactionContext, value: unknown) {
        conversations.push(record(value));
        return value;
      },
      async appendMessage(_context: PostgresTransactionContext, value: unknown) {
        messages.push(record(value));
        return value;
      },
    },
    investigation: {
      async appendRuleInput(_context: PostgresTransactionContext, value: unknown) {
        const input = record(value);
        ruleInputWrites.push(input);
        const row = Object.freeze({
          rule_input_id: input.rule_input_id,
          revision: String(input.revision),
          analysis_run_id: input.analysis_run_id,
          topic: input.topic,
          payload: input.payload,
          payload_sha256: input.payload_sha256,
        });
        client.ruleInputs.set(String(input.rule_input_id), row);
        return Object.freeze({
          rule_input_id: input.rule_input_id,
          revision: input.revision,
          topic: input.topic,
          payload: input.payload,
          payload_sha256: input.payload_sha256,
        });
      },
    },
  };
  const analysis = {
    traceFindings: {
      async persistConfirmation(value: CaseConfirmation) {
        confirmations.push(value);
      },
    },
  };
  const bundle = { context, intake, analysis } as unknown as DurableMultiDocumentTransactionBundle;
  return {
    application: new DurableMultiDocumentIntakeApplication(source),
    source,
    client,
    context,
    bundle,
    conversations,
    messages,
    confirmations,
    ruleInputWrites,
  };
}

describe("durable twelve-month multi-document intake", () => {
  it("persists seven current RuleInput snapshots and approved adaptive questions on one transaction", async () => {
    const fixture = harness();
    const result = await fixture.application.reconcile(fixture.bundle, command());
    const issueCodes = result.projection.technical_issues.map((issue) => issue.code);

    expect(result.projection.timeline.map((month) => month.period_key)).toEqual([
      "2030-01", "2030-02", "2030-03", "2030-04", "2030-05", "2030-06",
      "2030-07", "2030-08", "2030-09", "2030-10", "2030-11", "2030-12",
    ]);
    expect(issueCodes).toEqual(expect.arrayContaining([
      "document.corrected",
      "document.duplicate_content",
      "fact.conflicted",
      "period.missing_month",
      "period.overlap",
    ]));
    expect(result.projection.timeline.find((month) => month.period_key === "2030-06")?.active_document_ids).toEqual([]);
    expect(result.clarification_receipts).toHaveLength(7);
    expect(result.rule_input_receipts).toHaveLength(7);
    expect(result.rule_input_receipts.every((receipt) => !receipt.idempotent_replay)).toBe(true);
    expect(result.rule_input_receipts.every((receipt) => receipt.snapshot.snapshot_sha256.length === 64)).toBe(true);
    expect(result.projection.rule_input_views.every((view) => view.blocker_codes.length > 0)).toBe(true);
    expect(fixture.conversations).toHaveLength(1);
    expect(fixture.messages).toHaveLength(7);
    expect(fixture.confirmations).toHaveLength(7);
    expect(fixture.ruleInputWrites).toHaveLength(7);
    expect(fixture.source.context).toBe(fixture.context);
    expect(fixture.source.request).toEqual({
      tenant_id: "tenant:synthetic:multi-document",
      case_id: CASE_ID,
      analysis_run_id: ANALYSIS_RUN_ID,
    });
    expect(fixture.client.statements).toHaveLength(7);
    expect(fixture.client.statements.every((entry) => entry.name === "multi_document_rule_input_current")).toBe(true);
    expect(result.proof).toMatchObject({
      persistence_mode: "isolated_postgres",
      transaction_context_reused: true,
      product_reachable_memory_fallbacks: 0,
      legal_conclusions_created: 0,
      calculations_created: 0,
    });
    expect(JSON.stringify(result.projection)).not.toMatch(/entitlement|legal conclusion/iu);
  });

  it("replays exact snapshots and treats an exact answered confirmation as current", async () => {
    const fixture = harness();
    const input = command();
    const first = await fixture.application.reconcile(fixture.bundle, input);
    fixture.source.snapshot = Object.freeze({
      ...fixture.source.snapshot,
      prior_confirmations: [...fixture.confirmations],
    });
    const second = await fixture.application.reconcile(fixture.bundle, input);

    expect(second.rule_input_receipts.every((receipt) => receipt.idempotent_replay)).toBe(true);
    expect(second.rule_input_receipts.map((receipt) => receipt.revision)).toEqual(Array(7).fill(1));
    expect(second.projection.result_sha256).toBe(first.projection.result_sha256);
    expect(fixture.ruleInputWrites).toHaveLength(7);

    const answered = fixture.confirmations[0]!;
    const answerMessageId = id(999);
    const answeredConfirmation: CaseConfirmation = {
      ...answered,
      status: "confirmed",
      answer: { synthetic_answer: true },
      source_message_id: answerMessageId,
      answered_at: "2031-01-05T00:00:00.000Z",
    };
    fixture.source.snapshot = Object.freeze({
      ...fixture.source.snapshot,
      prior_confirmations: [answeredConfirmation, ...fixture.confirmations.slice(1, 7)],
    });
    const messageCount = fixture.messages.length;
    const third = await fixture.application.reconcile(fixture.bundle, input);
    const answeredReceipt = third.clarification_receipts.find((receipt) => receipt.confirmation_id === answered.confirmation_id);

    expect(answeredReceipt).toMatchObject({ status: "confirmed", persistence_action: "already_answered" });
    expect(fixture.messages).toHaveLength(messageCount);
    expect(third.rule_input_receipts.every((receipt) => receipt.idempotent_replay)).toBe(true);

    const revisedQuestion = {
      ...input.approved_question_bank.find((question) => question.target_fact_path === answered.target_fact_path)!,
      version: 2,
      text: "Synthetic revised approved clarification",
    };
    const versioned = await fixture.application.reconcile(fixture.bundle, {
      ...input,
      approved_question_bank: [...input.approved_question_bank, revisedQuestion],
    });
    const revisedReceipt = versioned.clarification_receipts.find((receipt) =>
      receipt.target_fact_path === answered.target_fact_path);
    expect(revisedReceipt).toMatchObject({ question_version: 2, status: "pending", persistence_action: "appended" });
    expect(revisedReceipt?.confirmation_id).not.toBe(answered.confirmation_id);
    expect(fixture.messages).toHaveLength(messageCount + 1);
    expect(versioned.rule_input_receipts.every((receipt) => receipt.idempotent_replay)).toBe(true);
  });

  it("fails closed on an incomplete period, question bank, transaction, or stale RuleInput revision", async () => {
    const fixture = harness();
    const valid = command();
    await expect(fixture.application.reconcile(fixture.bundle, {
      ...valid,
      required_period: { start_date: "2030-01-01", end_date: "2030-11-30" },
      scopes: valid.scopes.map((scope) => ({
        ...scope,
        period: { start_date: "2030-01-01", end_date: "2030-11-30" },
      })),
    })).rejects.toThrow("DURABLE_MULTI_DOCUMENT_EXACT_TWELVE_MONTH_PERIOD_REQUIRED");

    await expect(fixture.application.reconcile(fixture.bundle, {
      ...valid,
      approved_question_bank: valid.approved_question_bank.filter((question) => question.target_fact_path !== "travel.reimbursement"),
    })).rejects.toThrow("DURABLE_MULTI_DOCUMENT_APPROVED_QUESTION_UNAVAILABLE:travel.reimbursement");

    expect(() => new DurableMultiDocumentIntakeApplication({
      persistence_mode: "isolated_postgres",
      product_reachable_memory_fallbacks: 1,
      load: fixture.source.load.bind(fixture.source),
    } as unknown as DurableMultiDocumentSnapshotPort)).toThrow("DURABLE_MULTI_DOCUMENT_POSTGRES_SOURCE_REQUIRED");

    await expect(fixture.application.reconcile({
      ...fixture.bundle,
      context: { ...fixture.context, transaction_id: "different" },
    }, valid)).rejects.toThrow("DURABLE_MULTI_DOCUMENT_TRANSACTION_BUNDLE_REQUIRED");

    await fixture.application.reconcile(fixture.bundle, valid);
    const mutated = scenario();
    const first = mutated.documents[0]!;
    fixture.source.snapshot = Object.freeze({
      ...mutated,
      documents: [{ ...first, content_sha256: "f".repeat(64) }, ...mutated.documents.slice(1)],
    });
    await expect(fixture.application.reconcile(fixture.bundle, valid))
      .rejects.toThrow(/DURABLE_MULTI_DOCUMENT_RULE_INPUT_REVISION_CONFLICT/);
    expect(fixture.ruleInputWrites).toHaveLength(7);
  });
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record required");
  return value as Readonly<Record<string, unknown>>;
}
