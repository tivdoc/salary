import type { DateRange } from "../../../engine/domain/primitives.ts";
import {
  dateRangeSchema,
  isoTimestampSchema,
  uuidSchema,
} from "../../../engine/domain/primitives.ts";
import type { ImmutableDocument } from "../../../engine/domain/documents.ts";
import { immutableDocumentSchema } from "../../../engine/domain/documents.ts";
import type { ExtractionResult } from "../../../engine/extraction/contracts.ts";
import { extractionResultSchema } from "../../../engine/extraction/contracts.ts";
import {
  buildMultiDocumentIntake,
  ruleInputScopeRequirementSchema,
  type MultiDocumentIntakeResult,
  type RuleInputScopeRequirement,
} from "../../../engine/extraction/multi-document-intake.ts";
import type { EmploymentSnapshot } from "../../../engine/facts/snapshot.ts";
import { employmentSnapshotSchema } from "../../../engine/facts/snapshot.ts";
import type { FactPath } from "../../../engine/facts/fact-paths.ts";
import type { InterviewQuestion } from "../../../engine/interview/contracts.ts";
import { interviewQuestionSchema } from "../../../engine/interview/contracts.ts";
import type { RegisteredRuleInputMappingRegistry } from "../../../engine/rule-input/mapping-registry.ts";
import { registeredRuleInputMappingRegistrySchema } from "../../../engine/rule-input/mapping-registry.ts";
import { canonicalSha256, deepFreeze } from "../../../engine/rule-runtime/canonical.ts";
import { ruleInputSnapshotSchema, type RuleInputSnapshot } from "../../../engine/wave1/contracts.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../../../engine/wave3/contracts.ts";
import type {
  PostgresAnalysisRepositories,
} from "../../platform/persistence/postgres/analysis/index.ts";
import { validateCanonicalConfirmation } from "../../platform/persistence/postgres/analysis/traces.ts";
import type {
  PostgresIntakeAdapterBundle,
} from "../../platform/persistence/postgres/intake/index.ts";
import type {
  PostgresQueryResult,
  PostgresTransactionContext,
} from "../../platform/persistence/postgres/contracts.ts";
import { statement } from "../../platform/persistence/postgres/contracts.ts";
import type { TransactionScopedPostgresBundle } from "../../platform/composition/canonical-postgres.ts";
import type { CaseConfirmation } from "../persistence-contracts.ts";

export const DURABLE_MULTI_DOCUMENT_INTAKE_SCHEMA_VERSION =
  "tivdoc-durable-multi-document-intake-v0.10.2" as const;

export type DurableMultiDocumentSourceSnapshot = Readonly<{
  documents: readonly ImmutableDocument[];
  extractions: readonly ExtractionResult[];
  fact_snapshot: EmploymentSnapshot;
  prior_confirmations: readonly CaseConfirmation[];
  prior_warning_codes: readonly string[];
}>;

/**
 * The product composition supplies this reader from the same verified
 * PostgreSQL transaction as the canonical intake and analysis adapters. The
 * port deliberately returns the existing Document, Extraction and Fact
 * contracts instead of defining a second persistence-facing model.
 */
export interface DurableMultiDocumentSnapshotPort {
  readonly persistence_mode: "isolated_postgres";
  readonly product_reachable_memory_fallbacks: 0;
  load(
    context: PostgresTransactionContext,
    input: Readonly<{ tenant_id: string; case_id: string; analysis_run_id: string }>,
  ): Promise<DurableMultiDocumentSourceSnapshot>;
}

export type DurableMultiDocumentTransactionBundle = Pick<
  TransactionScopedPostgresBundle<PostgresIntakeAdapterBundle, PostgresAnalysisRepositories>,
  "context" | "intake" | "analysis"
>;

export type DurableMultiDocumentIntakeCommand = Readonly<{
  case_id: string;
  analysis_run_id: string;
  required_period: DateRange;
  mapping_registry: RegisteredRuleInputMappingRegistry;
  scopes: readonly RuleInputScopeRequirement[];
  approved_question_bank: readonly InterviewQuestion[];
  prepared_at: string;
  expected_rule_input_revisions: Readonly<Record<Wave3Topic, number>>;
}>;

export type DurableClarificationReceipt = Readonly<{
  confirmation_id: string;
  conversation_id: string;
  question_message_id: string;
  question_id: string;
  question_version: number;
  target_fact_path: FactPath;
  dependency_sha256: string;
  status: CaseConfirmation["status"];
  persistence_action: "appended" | "already_pending" | "already_answered";
}>;

export type DurableRuleInputReceipt = Readonly<{
  topic: Wave3Topic;
  rule_input_id: string;
  revision: number;
  snapshot: RuleInputSnapshot;
  payload_sha256: string;
  idempotent_replay: boolean;
}>;

export type DurableMultiDocumentIntakeReceipt = Readonly<{
  schema_version: typeof DURABLE_MULTI_DOCUMENT_INTAKE_SCHEMA_VERSION;
  case_id: string;
  analysis_run_id: string;
  required_period: DateRange;
  projection: MultiDocumentIntakeResult;
  clarification_receipts: readonly DurableClarificationReceipt[];
  rule_input_receipts: readonly DurableRuleInputReceipt[];
  proof: Readonly<{
    persistence_mode: "isolated_postgres";
    transaction_context_reused: true;
    product_reachable_memory_fallbacks: 0;
    canonical_document_contract_reused: true;
    canonical_extraction_contract_reused: true;
    canonical_fact_contract_reused: true;
    canonical_rule_input_contract_reused: true;
    legal_conclusions_created: 0;
    calculations_created: 0;
  }>;
  receipt_sha256: string;
}>;

type ValidatedCommand = Readonly<{
  caseId: string;
  analysisRunId: string;
  requiredPeriod: DateRange;
  mappingRegistry: RegisteredRuleInputMappingRegistry;
  scopes: readonly RuleInputScopeRequirement[];
  questions: readonly InterviewQuestion[];
  preparedAt: string;
  expectedRevisions: Readonly<Record<Wave3Topic, number>>;
}>;

type ClarificationPlan = Readonly<{
  confirmation: CaseConfirmation;
  question: InterviewQuestion;
  message_id: string;
  dependency_sha256: string;
}>;

type CurrentRuleInput = Readonly<{
  rule_input_id: string;
  revision: number;
  analysis_run_id: string;
  topic: Wave3Topic;
  payload: RuleInputSnapshot;
  payload_sha256: string;
}>;

const CURRENT_RULE_INPUT_SQL = `
select rule_input_id, revision::text, canonical_analysis_run_id as analysis_run_id,
       topic, payload, payload_sha256
from public.engine_rule_input_versions
where tenant_id = $1 and canonical_case_id = $2 and rule_input_id = $3
order by revision desc
limit 1
for update`;

export function createDurableMultiDocumentIntakeApplication(
  source: DurableMultiDocumentSnapshotPort,
): DurableMultiDocumentIntakeApplication {
  return new DurableMultiDocumentIntakeApplication(source);
}

export class DurableMultiDocumentIntakeApplication {
  readonly #source: DurableMultiDocumentSnapshotPort;

  constructor(source: DurableMultiDocumentSnapshotPort) {
    if (
      source.persistence_mode !== "isolated_postgres"
      || source.product_reachable_memory_fallbacks !== 0
      || typeof source.load !== "function"
    ) {
      throw new Error("DURABLE_MULTI_DOCUMENT_POSTGRES_SOURCE_REQUIRED");
    }
    this.#source = source;
  }

  async reconcile(
    bundle: DurableMultiDocumentTransactionBundle,
    untrustedCommand: DurableMultiDocumentIntakeCommand,
  ): Promise<DurableMultiDocumentIntakeReceipt> {
    assertTransactionBundle(bundle);
    const command = validateCommand(untrustedCommand);
    const tenantId = bundle.intake.tenant_id;
    const source = validateSourceSnapshot(
      await this.#source.load(bundle.context, {
        tenant_id: tenantId,
        case_id: command.caseId,
        analysis_run_id: command.analysisRunId,
      }),
      command,
    );

    const projection = buildMultiDocumentIntake({
      case_id: command.caseId,
      documents: source.documents,
      extractions: source.extractions,
      fact_snapshot: source.fact_snapshot,
      mapping_registry: command.mappingRegistry,
      scopes: command.scopes,
      prepared_at: command.preparedAt,
      required_period: command.requiredPeriod,
      prior_warning_codes: source.prior_warning_codes,
    });

    const plans = makeClarificationPlans(projection, command);
    const clarificationReceipts = await persistClarifications(bundle, command, source.prior_confirmations, plans);
    const ruleInputReceipts = await persistRuleInputs(bundle, command, projection);
    const proof = deepFreeze({
      persistence_mode: "isolated_postgres" as const,
      transaction_context_reused: true as const,
      product_reachable_memory_fallbacks: 0 as const,
      canonical_document_contract_reused: true as const,
      canonical_extraction_contract_reused: true as const,
      canonical_fact_contract_reused: true as const,
      canonical_rule_input_contract_reused: true as const,
      legal_conclusions_created: 0 as const,
      calculations_created: 0 as const,
    });
    const unsigned = {
      schema_version: DURABLE_MULTI_DOCUMENT_INTAKE_SCHEMA_VERSION,
      case_id: command.caseId,
      analysis_run_id: command.analysisRunId,
      required_period: command.requiredPeriod,
      projection,
      clarification_receipts: clarificationReceipts,
      rule_input_receipts: ruleInputReceipts,
      proof,
    };
    return deepFreeze({ ...unsigned, receipt_sha256: canonicalSha256(unsigned) });
  }
}

function validateCommand(command: DurableMultiDocumentIntakeCommand): ValidatedCommand {
  const caseId = uuidSchema.parse(command.case_id);
  const analysisRunId = uuidSchema.parse(command.analysis_run_id);
  const requiredPeriod = dateRangeSchema.parse(command.required_period);
  if (monthsInRange(requiredPeriod).length !== 12) {
    throw new Error("DURABLE_MULTI_DOCUMENT_EXACT_TWELVE_MONTH_PERIOD_REQUIRED");
  }
  const mappingRegistry = registeredRuleInputMappingRegistrySchema.parse(command.mapping_registry);
  const scopes = command.scopes.map((scope) => ruleInputScopeRequirementSchema.parse(scope));
  const actualTopics = scopes.map((scope) => scope.topic);
  if (
    scopes.length !== WAVE3_TOPICS.length
    || new Set(actualTopics).size !== WAVE3_TOPICS.length
    || WAVE3_TOPICS.some((topic) => !actualTopics.includes(topic))
    || scopes.some((scope) => !samePeriod(scope.period, requiredPeriod))
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_SEVEN_TOPIC_SCOPE_REQUIRED");
  }
  const questions = command.approved_question_bank.map((question) => interviewQuestionSchema.parse(question));
  const questionKeys = questions.map((question) => `${question.question_id}:${question.version}`);
  if (questions.length === 0 || new Set(questionKeys).size !== questionKeys.length) {
    throw new Error("DURABLE_MULTI_DOCUMENT_APPROVED_QUESTION_BANK_INVALID");
  }
  const preparedAt = isoTimestampSchema.parse(command.prepared_at);
  const revisionKeys = Object.keys(command.expected_rule_input_revisions).sort(compareStrings);
  const expectedKeys = [...WAVE3_TOPICS].sort(compareStrings);
  if (
    revisionKeys.length !== expectedKeys.length
    || revisionKeys.some((key, index) => key !== expectedKeys[index])
    || WAVE3_TOPICS.some((topic) => {
      const revision = command.expected_rule_input_revisions[topic];
      return !Number.isSafeInteger(revision) || revision < 0;
    })
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_RULE_INPUT_REVISIONS_INVALID");
  }
  return deepFreeze({
    caseId,
    analysisRunId,
    requiredPeriod,
    mappingRegistry,
    scopes: [...scopes].sort((left, right) => compareStrings(left.topic, right.topic)),
    questions: [...questions].sort(compareQuestions),
    preparedAt,
    expectedRevisions: Object.freeze({ ...command.expected_rule_input_revisions }),
  });
}

function validateSourceSnapshot(
  source: DurableMultiDocumentSourceSnapshot,
  command: ValidatedCommand,
): DurableMultiDocumentSourceSnapshot {
  const documents = source.documents.map((document) => immutableDocumentSchema.parse(document));
  const extractions = source.extractions.map((extraction) => extractionResultSchema.parse(extraction));
  const factSnapshot = employmentSnapshotSchema.parse(source.fact_snapshot);
  const confirmations = source.prior_confirmations.map((confirmation) => validateCanonicalConfirmation(confirmation));
  if (
    factSnapshot.case_id !== command.caseId
    || factSnapshot.analysis_run_id !== command.analysisRunId
    || documents.some((document) => document.case_id !== command.caseId)
    || confirmations.some((confirmation) =>
      confirmation.case_id !== command.caseId
      || confirmation.source_analysis_run_id !== command.analysisRunId)
    || new Set(confirmations.map((confirmation) => confirmation.confirmation_id)).size !== confirmations.length
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_SOURCE_BOUNDARY_VIOLATION");
  }
  for (const document of documents) {
    if (document.document_period !== null && !periodsOverlap(document.document_period, command.requiredPeriod)) {
      throw new Error("DURABLE_MULTI_DOCUMENT_SOURCE_OUTSIDE_REQUIRED_PERIOD");
    }
  }
  return deepFreeze({
    documents,
    extractions,
    fact_snapshot: factSnapshot,
    prior_confirmations: confirmations,
    prior_warning_codes: uniqueSorted(source.prior_warning_codes.map((code) => String(code))),
  });
}

function makeClarificationPlans(
  projection: MultiDocumentIntakeResult,
  command: ValidatedCommand,
): readonly ClarificationPlan[] {
  const requirementsByPath = new Map<FactPath, string[]>();
  for (const requirement of projection.declared_rule_input_requirements) {
    requirementsByPath.set(requirement.fact_path, [
      ...(requirementsByPath.get(requirement.fact_path) ?? []),
      requirement.requirement_sha256,
    ]);
  }
  return projection.clarification_fact_states.map((state): ClarificationPlan => {
    const question = command.questions
      .filter((candidate) => candidate.target_fact_path === state.fact_path)
      .sort((left, right) => right.version - left.version || compareStrings(left.question_id, right.question_id))[0];
    if (!question) {
      throw new Error(`DURABLE_MULTI_DOCUMENT_APPROVED_QUESTION_UNAVAILABLE:${state.fact_path}`);
    }
    const dependencySha256 = canonicalSha256({
      schema_version: DURABLE_MULTI_DOCUMENT_INTAKE_SCHEMA_VERSION,
      case_id: command.caseId,
      analysis_run_id: command.analysisRunId,
      result_sha256: projection.result_sha256,
      clarification_fact_state: state,
      requirement_sha256s: uniqueSorted(requirementsByPath.get(state.fact_path) ?? []),
      question: { question_id: question.question_id, version: question.version },
    });
    const confirmationId = uuidFromHash(dependencySha256);
    const messageId = uuidFromHash(canonicalSha256({ dependency_sha256: dependencySha256, kind: "question_message" }));
    return deepFreeze({
      question,
      message_id: messageId,
      dependency_sha256: dependencySha256,
      confirmation: validateCanonicalConfirmation({
        confirmation_id: confirmationId,
        case_id: command.caseId,
        source_analysis_run_id: command.analysisRunId,
        target_fact_path: state.fact_path,
        question_id: question.question_id,
        question_version: question.version,
        proposed_value: null,
        answer: null,
        status: "pending",
        source_message_id: null,
        idempotency_key: `clarification.${dependencySha256}`,
        created_at: command.preparedAt,
        answered_at: null,
      }),
    });
  });
}

async function persistClarifications(
  bundle: DurableMultiDocumentTransactionBundle,
  command: ValidatedCommand,
  priorConfirmations: readonly CaseConfirmation[],
  plans: readonly ClarificationPlan[],
): Promise<readonly DurableClarificationReceipt[]> {
  const existing = new Map(priorConfirmations.map((confirmation) => [confirmation.confirmation_id, confirmation] as const));
  const conversationSha256 = canonicalSha256({
    schema_version: DURABLE_MULTI_DOCUMENT_INTAKE_SCHEMA_VERSION,
    case_id: command.caseId,
    analysis_run_id: command.analysisRunId,
    kind: "adaptive_clarification_conversation",
  });
  const conversationId = uuidFromHash(conversationSha256);
  const additions = plans.filter((plan) => !existing.has(plan.confirmation.confirmation_id));
  if (additions.length > 0) {
    await bundle.intake.conversations.appendConversation(bundle.context, {
      tenant_id: bundle.intake.tenant_id,
      case_id: command.caseId,
      conversation_id: conversationId,
      analysis_run_id: command.analysisRunId,
      status: "waiting_for_customer",
      idempotency_key: `clarification.batch.${conversationSha256}`,
      created_at: command.preparedAt,
      closed_at: null,
    });
  }
  const receipts: DurableClarificationReceipt[] = [];
  for (const plan of plans) {
    const prior = existing.get(plan.confirmation.confirmation_id);
    const alreadyAnswered = prior !== undefined && prior.status !== "pending";
    if (prior === undefined) {
      await bundle.intake.conversations.appendMessage(bundle.context, {
        tenant_id: bundle.intake.tenant_id,
        case_id: command.caseId,
        message_id: plan.message_id,
        conversation_id: conversationId,
        analysis_run_id: command.analysisRunId,
        role: "system",
        agent: null,
        question_id: plan.question.question_id,
        question_version: plan.question.version,
        selected_option_ids: [],
        free_text_answer: null,
        content: plan.question.text,
        model_provider: null,
        model_identifier: null,
        prompt_version: null,
        idempotency_key: `clarification.question.${plan.dependency_sha256}`,
        created_at: command.preparedAt,
      });
      await bundle.analysis.traceFindings.persistConfirmation(plan.confirmation);
    }
    receipts.push(deepFreeze({
      confirmation_id: plan.confirmation.confirmation_id,
      conversation_id: conversationId,
      question_message_id: plan.message_id,
      question_id: plan.question.question_id,
      question_version: plan.question.version,
      target_fact_path: plan.confirmation.target_fact_path,
      dependency_sha256: plan.dependency_sha256,
      status: prior?.status ?? "pending",
      persistence_action: alreadyAnswered
        ? "already_answered"
        : prior?.status === "pending"
          ? "already_pending"
          : "appended",
    }));
  }
  return Object.freeze(receipts);
}

async function persistRuleInputs(
  bundle: DurableMultiDocumentTransactionBundle,
  command: ValidatedCommand,
  projection: MultiDocumentIntakeResult,
): Promise<readonly DurableRuleInputReceipt[]> {
  const viewByTopic = new Map(projection.rule_input_views.map((view) => [view.scope.topic, view] as const));
  const receipts: DurableRuleInputReceipt[] = [];
  for (const topic of WAVE3_TOPICS) {
    const view = viewByTopic.get(topic);
    if (!view) throw new Error(`DURABLE_MULTI_DOCUMENT_RULE_INPUT_VIEW_MISSING:${topic}`);
    const snapshot = ruleInputSnapshotSchema.parse(view.snapshot);
    const payloadSha256 = canonicalSha256(snapshot);
    const ruleInputId = `rule-input:${topic}:${canonicalSha256({ case_id: command.caseId }).slice(0, 32)}`;
    const current = await readCurrentRuleInput(bundle.context, bundle.intake.tenant_id, command.caseId, ruleInputId);
    if (
      current !== null
      && current.analysis_run_id === command.analysisRunId
      && current.topic === topic
      && current.payload_sha256 === payloadSha256
      && canonicalSha256(current.payload) === payloadSha256
    ) {
      receipts.push(deepFreeze({
        topic,
        rule_input_id: ruleInputId,
        revision: current.revision,
        snapshot,
        payload_sha256: payloadSha256,
        idempotent_replay: true,
      }));
      continue;
    }
    const expected = command.expectedRevisions[topic];
    if ((current?.revision ?? 0) !== expected) {
      throw new Error(`DURABLE_MULTI_DOCUMENT_RULE_INPUT_REVISION_CONFLICT:${topic}`);
    }
    const revision = expected + 1;
    const stored = await bundle.intake.investigation.appendRuleInput(bundle.context, {
      tenant_id: bundle.intake.tenant_id,
      case_id: command.caseId,
      rule_input_id: ruleInputId,
      revision,
      expected_prior_revision: expected,
      analysis_run_id: command.analysisRunId,
      topic,
      payload: snapshot,
      payload_sha256: payloadSha256,
      created_at: command.preparedAt,
    });
    if (
      stored.rule_input_id !== ruleInputId
      || stored.revision !== revision
      || stored.topic !== topic
      || stored.payload_sha256 !== payloadSha256
    ) {
      throw new Error("DURABLE_MULTI_DOCUMENT_RULE_INPUT_RECEIPT_MISMATCH");
    }
    receipts.push(deepFreeze({
      topic,
      rule_input_id: ruleInputId,
      revision,
      snapshot,
      payload_sha256: payloadSha256,
      idempotent_replay: false,
    }));
  }
  return Object.freeze(receipts);
}

async function readCurrentRuleInput(
  context: PostgresTransactionContext,
  tenantId: string,
  caseId: string,
  ruleInputId: string,
): Promise<CurrentRuleInput | null> {
  const result = await context.client.query(statement(
    "multi_document_rule_input_current",
    CURRENT_RULE_INPUT_SQL,
    [tenantId, caseId, ruleInputId],
  ));
  if (result.row_count === 0) return null;
  if (result.row_count !== 1 || result.rows.length !== 1 || !result.rows[0]) {
    throw new Error("DURABLE_MULTI_DOCUMENT_RULE_INPUT_ROW_INVALID");
  }
  return parseCurrentRuleInput(result, ruleInputId);
}

function parseCurrentRuleInput(result: PostgresQueryResult, expectedId: string): CurrentRuleInput {
  const row = result.rows[0]!;
  const revision = typeof row.revision === "string" && /^\d+$/u.test(row.revision)
    ? Number(row.revision)
    : Number.NaN;
  const topic = typeof row.topic === "string" && WAVE3_TOPICS.includes(row.topic as Wave3Topic)
    ? row.topic as Wave3Topic
    : null;
  const payload = ruleInputSnapshotSchema.safeParse(row.payload);
  if (
    row.rule_input_id !== expectedId
    || !Number.isSafeInteger(revision)
    || revision < 1
    || typeof row.analysis_run_id !== "string"
    || topic === null
    || !payload.success
    || typeof row.payload_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.payload_sha256)
    || canonicalSha256(payload.data) !== row.payload_sha256
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_RULE_INPUT_ROW_INVALID");
  }
  return deepFreeze({
    rule_input_id: expectedId,
    revision,
    analysis_run_id: row.analysis_run_id,
    topic,
    payload: payload.data,
    payload_sha256: row.payload_sha256,
  });
}

function assertTransactionBundle(bundle: DurableMultiDocumentTransactionBundle): void {
  if (
    !bundle
    || !bundle.context
    || typeof bundle.context.transaction_id !== "string"
    || bundle.context.transaction_id.length === 0
    || !bundle.context.client
    || typeof bundle.context.client.query !== "function"
    || bundle.intake?.context !== bundle.context
    || typeof bundle.intake.tenant_id !== "string"
    || bundle.intake.tenant_id.length === 0
    || typeof bundle.intake.conversations?.appendConversation !== "function"
    || typeof bundle.intake.conversations?.appendMessage !== "function"
    || typeof bundle.intake.investigation?.appendRuleInput !== "function"
    || typeof bundle.analysis?.traceFindings?.persistConfirmation !== "function"
  ) {
    throw new Error("DURABLE_MULTI_DOCUMENT_TRANSACTION_BUNDLE_REQUIRED");
  }
}

function monthsInRange(period: DateRange): readonly string[] {
  const first = period.start_date.slice(0, 7);
  const last = (period.end_date ?? period.start_date).slice(0, 7);
  const months: string[] = [];
  for (let cursor = first; cursor <= last; cursor = nextMonth(cursor)) months.push(cursor);
  return months;
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

function samePeriod(left: DateRange, right: DateRange): boolean {
  return left.start_date === right.start_date && left.end_date === right.end_date;
}

function periodsOverlap(left: DateRange, right: DateRange): boolean {
  const leftEnd = left.end_date ?? left.start_date;
  const rightEnd = right.end_date ?? right.start_date;
  return left.start_date <= rightEnd && right.start_date <= leftEnd;
}

function uuidFromHash(hash: string): string {
  const value = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return uuidSchema.parse(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareQuestions(left: InterviewQuestion, right: InterviewQuestion): number {
  return compareStrings(`${left.target_fact_path}\u0000${left.question_id}\u0000${left.version}`,
    `${right.target_fact_path}\u0000${right.question_id}\u0000${right.version}`);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareStrings));
}
