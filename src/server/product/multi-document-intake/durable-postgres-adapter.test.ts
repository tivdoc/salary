import { describe, expect, it } from "vitest";

import type { CanonicalFact } from "../../../engine/facts/contracts.ts";
import type { InterviewQuestion } from "../../../engine/interview/contracts.ts";
import { registerRuleInputMappingRegistry } from "../../../engine/rule-input/mapping-registry.ts";
import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { PostgresStatement, PostgresTransactionContext } from "../../platform/persistence/postgres/contracts.ts";
import type { CaseConfirmation } from "../../engine/persistence-contracts.ts";
import type { DurableMultiDocumentIntakeCommand } from "../../engine/multi-document-intake/application.ts";
import type { DurableProductRouteContext } from "../routes/durable-registration.ts";
import {
  DURABLE_MULTI_DOCUMENT_PRODUCT_SCHEMA_VERSION,
  PostgresDurableMultiDocumentSnapshotPort,
  __durableMultiDocumentProductTest,
  createDurableMultiDocumentProductRouteAdapter,
} from "./durable-postgres-adapter.ts";

const CASE_ID = id(1);
const RUN_ID = id(2);
const TENANT_ID = "tenant:synthetic:multi-document";
const PREPARED_AT = "2031-01-04T00:00:00.000Z";
const PERIOD = Object.freeze({ start_date: "2030-01-01", end_date: "2030-12-31" });
const PATHS = Object.freeze({
  minimum_wage: "compensation.base_monthly_salary",
  working_time: "work.regular_hours",
  pension: "pension.base_salary",
  travel: "travel.reimbursement",
  convalescence: "convalescence.payment",
  vacation: "leave.vacation_balance",
  sick_leave: "leave.sick_balance",
} as const);
type Topic = keyof typeof PATHS;

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function missingFact(topic: Topic, index: number): CanonicalFact {
  return {
    fact_id: id(100 + index),
    case_id: CASE_ID,
    path: PATHS[topic],
    status: "missing",
    value: null,
    provenance: [{
      source_type: "documented",
      source_reference: { kind: "document", document_id: id(500 + index), locator: { page: 1 } },
    }],
    confidence: 0,
    conflicting_fact_ids: [],
    resolution: null,
    created_at: "2031-01-03T00:00:00.000Z",
  } as CanonicalFact;
}

function command(): DurableMultiDocumentIntakeCommand {
  const topics = Object.keys(PATHS) as Topic[];
  const mappingRegistry = registerRuleInputMappingRegistry({
    registry_id: "synthetic.product.multi.document.registry",
    registry_version: "1.0.0",
    mappings: topics.map((topic) => ({
      input_id: `input.${topic}`,
      runtime_fact_path: `synthetic.${topic}.input`,
      fact_path: PATHS[topic],
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
    target_fact_path: PATHS[topic],
    text: `Synthetic clarification for ${topic}`,
    options: [],
    allow_free_text: true,
    reason: "Synthetic technical completeness fixture.",
  }));
  return Object.freeze({
    case_id: CASE_ID,
    analysis_run_id: RUN_ID,
    required_period: PERIOD,
    mapping_registry: mappingRegistry,
    scopes: topics.map((topic) => ({
      scope_id: `scope.${topic}`,
      topic,
      period: PERIOD,
      input_ids: [`input.${topic}`],
    })),
    approved_question_bank: questions,
    prepared_at: PREPARED_AT,
    expected_rule_input_revisions: Object.freeze(Object.fromEntries(
      topics.map((topic) => [topic, 0]),
    )) as Record<Topic, number>,
  });
}

function pendingConfirmation(): CaseConfirmation {
  return Object.freeze({
    confirmation_id: id(901),
    case_id: CASE_ID,
    source_analysis_run_id: RUN_ID,
    target_fact_path: PATHS.minimum_wage,
    question_id: "clarification.minimum_wage",
    question_version: 1,
    proposed_value: null,
    answer: null,
    status: "pending",
    source_message_id: null,
    idempotency_key: "clarification.pending.001",
    created_at: "2031-01-03T10:00:00.000Z",
    answered_at: null,
  });
}

function answeredConfirmation(): CaseConfirmation {
  return Object.freeze({
    confirmation_id: id(902),
    case_id: CASE_ID,
    source_analysis_run_id: RUN_ID,
    target_fact_path: PATHS.minimum_wage,
    question_id: "clarification.minimum_wage",
    question_version: 1,
    proposed_value: null,
    answer: { amount: "synthetic" },
    status: "confirmed",
    source_message_id: id(903),
    idempotency_key: "confirmation.answer.001",
    created_at: "2031-01-05T10:00:00.000Z",
    answered_at: "2031-01-05T10:00:00.000Z",
  });
}

function sourceRow(confirmations: readonly CaseConfirmation[] = []) {
  const topics = Object.keys(PATHS) as Topic[];
  return Object.freeze({
    documents: [],
    extractions: [],
    facts: topics.map(missingFact),
    confirmations,
    prior_warning_codes: ["synthetic.prior.warning", "synthetic.prior.warning"],
    snapshot_created_at: "2031-01-03T00:00:00.000Z",
  });
}

class RecordingClient {
  readonly statements: PostgresStatement[] = [];
  readonly row: Readonly<Record<string, unknown>>;

  constructor(row = sourceRow()) {
    this.row = row;
  }

  async query(query: PostgresStatement) {
    this.statements.push(query);
    if (query.name === "product_multi_document_source_snapshot") {
      return { rows: [this.row], row_count: 1 };
    }
    if (query.name === "multi_document_rule_input_current") {
      return { rows: [], row_count: 0 };
    }
    throw new Error(`UNEXPECTED_QUERY:${query.name}`);
  }
}

function actor(role: VerifiedActor["role"] = "legal_reviewer"): VerifiedActor {
  return Object.freeze({
    actor_id: "actor:synthetic:legal-reviewer",
    role,
    tenant_id: TENANT_ID,
    assigned_case_ids: [CASE_ID],
    verified_server_side: true,
    break_glass_reason: null,
    break_glass_expires_at: null,
  });
}

function harness() {
  const client = new RecordingClient();
  const context: PostgresTransactionContext = Object.freeze({
    client,
    transaction_id: "tx:synthetic:multi-document-product",
  });
  const conversations: unknown[] = [];
  const messages: unknown[] = [];
  const confirmations: CaseConfirmation[] = [];
  const ruleInputs: Readonly<Record<string, unknown>>[] = [];
  const intake = {
    context,
    tenant_id: TENANT_ID,
    conversations: {
      async appendConversation(_context: PostgresTransactionContext, value: unknown) {
        conversations.push(value);
        return value;
      },
      async appendMessage(_context: PostgresTransactionContext, value: unknown) {
        messages.push(value);
        return value;
      },
    },
    investigation: {
      async appendRuleInput(_context: PostgresTransactionContext, value: unknown) {
        const input = value as Readonly<Record<string, unknown>>;
        ruleInputs.push(input);
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
  const bundle = Object.freeze({ context, intake, analysis, runtime: Object.freeze({}) });
  const postgres = Object.freeze({
    mode: "isolated_postgres" as const,
    durable: true as const,
    target_id: "synthetic-target",
    schema_version: "tivdoc-canonical-postgresql-v0.9.0" as const,
  });
  const transactionInputs: unknown[] = [];
  const sessionContext = Object.freeze({
    proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
    uses_service_role: false as const,
    bypasses_rls: false as const,
    postgres,
    async transaction(input: unknown, operation: (value: typeof bundle) => Promise<unknown>) {
      transactionInputs.push(input);
      return operation(bundle);
    },
  });
  const routeContext = Object.freeze({
    postgres,
    product: Object.freeze({
      proof: () => Object.freeze({
        persistence_mode: "isolated_postgres" as const,
        durable: true as const,
        product_reachable_memory_fallbacks: 0,
      }),
    }),
    session_context: sessionContext,
  }) as unknown as DurableProductRouteContext;
  return {
    adapter: createDurableMultiDocumentProductRouteAdapter(routeContext, {
      now: () => new Date("2031-01-04T00:00:00.000Z"),
    }),
    bundle,
    client,
    conversations,
    messages,
    confirmations,
    ruleInputs,
    transactionInputs,
  };
}

describe("durable multi-document PostgreSQL product adapter", () => {
  it("reads one period-bound PostgreSQL snapshot and resolves the canonical portal answer", async () => {
    const client = new RecordingClient(sourceRow([pendingConfirmation(), answeredConfirmation()]));
    const context = Object.freeze({ client, transaction_id: "tx:source:snapshot" });
    const source = new PostgresDurableMultiDocumentSnapshotPort();
    const snapshot = await source.load(context, {
      tenant_id: TENANT_ID,
      case_id: CASE_ID,
      analysis_run_id: RUN_ID,
      required_period: PERIOD,
    });

    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toMatchObject({
      name: "product_multi_document_source_snapshot",
      values: [TENANT_ID, CASE_ID, RUN_ID, "2030-01-01", "2030-12-31"],
    });
    expect(snapshot.fact_snapshot).toMatchObject({ case_id: CASE_ID, analysis_run_id: RUN_ID });
    expect(snapshot.fact_snapshot.snapshot_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(snapshot.prior_warning_codes).toEqual(["synthetic.prior.warning"]);
    expect(snapshot.prior_confirmations.find((entry) => entry.confirmation_id === id(901))).toMatchObject({
      status: "confirmed",
      answer: { amount: "synthetic" },
      source_message_id: id(903),
      idempotency_key: "clarification.pending.001",
    });
  });

  it("reuses the stable verified operations transaction and all canonical intake contracts", async () => {
    const fixture = harness();
    const result = await fixture.adapter.service.reconcile({
      actor: actor(),
      command: command(),
      correlation_id: "multi-document:synthetic:001",
    });

    expect(fixture.transactionInputs).toEqual([expect.objectContaining({
      audience: "operations",
      case_id: CASE_ID,
      correlation_id: "multi-document:synthetic:001",
    })]);
    expect(fixture.client.statements.filter((entry) =>
      entry.name === "product_multi_document_source_snapshot")).toHaveLength(1);
    expect(fixture.client.statements.filter((entry) =>
      entry.name === "multi_document_rule_input_current")).toHaveLength(7);
    expect(result.clarification_receipts).toHaveLength(7);
    expect(result.rule_input_receipts).toHaveLength(7);
    expect(fixture.conversations).toHaveLength(1);
    expect(fixture.messages).toHaveLength(7);
    expect(fixture.confirmations).toHaveLength(7);
    expect(fixture.ruleInputs).toHaveLength(7);
    expect(fixture.adapter.product_proof).toEqual({
      schema_version: DURABLE_MULTI_DOCUMENT_PRODUCT_SCHEMA_VERSION,
      persistence: "isolated_postgres",
      source_snapshot_statements: 1,
      canonical_transaction_contexts: 1,
      reconcile_audience: "operations",
      clarification_answer_path: "canonical_customer_portal_application",
      canonical_document_contract_reused: true,
      canonical_extraction_contract_reused: true,
      canonical_fact_contract_reused: true,
      canonical_clarification_contract_reused: true,
      product_reachable_memory_fallbacks: 0,
      legal_conclusions_created: 0,
      calculations_created: 0,
    });
  });

  it("supports an already-open canonical transaction and rejects portal authority", async () => {
    const fixture = harness();
    await fixture.adapter.service.reconcileInTransaction({
      transaction: fixture.bundle as never,
      actor: actor(),
      command: command(),
      correlation_id: "multi-document:synthetic:002",
    });
    expect(fixture.transactionInputs).toHaveLength(0);

    await expect(fixture.adapter.service.reconcile({
      actor: actor("customer_owner"),
      command: command(),
      correlation_id: "multi-document:synthetic:003",
    })).rejects.toThrow("DURABLE_MULTI_DOCUMENT_PRODUCT_FORBIDDEN");
    expect(fixture.transactionInputs).toHaveLength(0);
  });

  it("keeps the source query on canonical durable tables without the legacy snapshot repository", () => {
    const sql = __durableMultiDocumentProductTest.SOURCE_SNAPSHOT_SQL;
    for (const table of [
      "public.documents",
      "public.document_extractions",
      "public.engine_canonical_fact_versions",
      "public.case_confirmations",
      "public.analysis_runs",
    ]) expect(sql).toContain(table);
    expect(sql).not.toContain("employment_snapshots");
    expect(sql).toContain("document.storage_layout = 'immutable_v1'");
    expect(sql).toContain("coalesce(document.period_end, document.period_start)");
    expect(sql).toContain("extraction.source_content_sha256 = document.content_sha256");
    expect(sql).toContain("fact.canonical_analysis_run_id = $3");
    expect(sql).toContain("ar.case_revision = state.revision");
    expect(sql).toContain("for update of state, ar");
  });
});
