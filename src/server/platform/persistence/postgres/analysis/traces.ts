import type { CaseConfirmation } from "../../../../engine/persistence-contracts";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type { SourceCalculationTrace } from "../../../../../engine/calculations/source-trace";
import {WAVE3_TOPICS, type Wave3Topic, type TopicAnalysisResult } from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import { assertSafeIdentifier, assertRequestedTopics, assertSourceTraceScope, validateTopicResult, type SourceTraceScope } from "./validation";

export class PostgresTraceFindingRepository {
  constructor(
    private readonly context: PostgresTransactionContext,
    private readonly tenantId: string,
  ) {
    assertSafeIdentifier(tenantId);
  }

  async persistTraces(input: Readonly<{
    case_id: string;
    analysis_run_id: string;
    topic_results: readonly TopicAnalysisResult[];
    expected_topics?: readonly Wave3Topic[];
    source_scope?: SourceTraceScope;
  }>): Promise<void> {
    assertRequestedTopics(input.topic_results,input.expected_topics??WAVE3_TOPICS);
    // Validate the entire batch before the first write, including callers that
    // use this repository directly rather than through complete().
    const results = input.topic_results.map(validateTopicResult);
    for (const result of results) {
      if (result.trace !== null && "schema_version" in result.trace) {
        if (!input.source_scope || input.source_scope.case_id !== input.case_id
            || input.source_scope.analysis_run_id !== input.analysis_run_id) {
          throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
        }
        assertSourceTraceScope(result, input.source_scope);
      }
    }
    try {
      for (const result of results) {
        if (result.trace && "schema_version" in result.trace) await this.assertSavedSource(result.trace);
      }
      for (const result of results) {
        if (result.trace === null) continue;
        const traceSha256 = canonicalSha256(result.trace);
        const traceId = `trace:${input.analysis_run_id}:${result.topic}:${traceSha256}`;
        const inserted = await this.context.client.query(statement(
          "analysis_trace_insert",
          `insert into public.engine_calculation_trace_versions
             (trace_id, tenant_id, case_id, analysis_run_id, topic, trace, trace_sha256, created_at)
           select $4, $1, ecs.case_id, ar.id, $5, $6::jsonb, $7, transaction_timestamp()
             from public.analysis_runs ar
             join public.engine_case_state ecs on ecs.case_id = ar.case_id
            where ar.canonical_analysis_run_id = $2
              and ar.canonical_case_id = $3
              and ar.tenant_id = $1
              and ecs.tenant_id = $1
           on conflict (trace_id) do nothing
           returning trace_sha256`,
          [this.tenantId, input.analysis_run_id, input.case_id, traceId, result.topic, JSON.stringify(result.trace), traceSha256],
        ));
        if (inserted.row_count !== 1) {
          const existing = await this.context.client.query(statement(
            "analysis_trace_existing",
            `select t.trace_sha256 from public.engine_calculation_trace_versions t
               join public.analysis_runs ar on ar.id = t.analysis_run_id and ar.case_id = t.case_id
              where t.tenant_id = $1 and ar.tenant_id = $1
                and ar.canonical_analysis_run_id = $2 and ar.canonical_case_id = $3 and t.trace_id = $4`,
            [this.tenantId, input.analysis_run_id, input.case_id, traceId],
          ));
          if (existing.row_count !== 1 || existing.rows[0]?.trace_sha256 !== traceSha256) {
            throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
          }
        }
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "IMMUTABLE_COMPLETED_RUN_MISMATCH");
    }
  }

  private async assertSavedSource(trace: SourceCalculationTrace): Promise<void> {
    const saved = await this.context.client.query(statement(
      "analysis_trace_source_stages",
      `select s.stage, s.payload, s.payload_sha256 from public.engine_analysis_stage_versions s
         join public.analysis_runs ar on ar.id = s.analysis_run_id and ar.case_id = s.case_id
        where s.tenant_id = $1 and ar.tenant_id = $1
          and ar.canonical_analysis_run_id = $2 and ar.canonical_case_id = $3
          and s.stage in ('canonical_facts', 'rule_inputs', 'analysis_run')`,
      [this.tenantId, trace.analysis_run_id, trace.case_id],
    ));
    if (saved.row_count !== 3 || new Set(saved.rows.map(row => row.stage)).size !== 3
        || saved.rows.some(row => canonicalSha256(row.payload ?? null) !== row.payload_sha256)) {
      throw new PostgresAnalysisError("STAGE_HASH_MISMATCH");
    }
    const payload = (name: string) => saved.rows.find(row => row.stage === name)?.payload as Record<string, unknown> | undefined;
    const facts = payload('canonical_facts'), rules = payload('rule_inputs');
    const dependencies = payload('analysis_run')?.dependencies as Record<string, unknown> | undefined;
    if (canonicalSha256(facts?.facts ?? null) !== trace.facts_snapshot_sha256
        || facts?.facts_snapshot_sha256 !== trace.facts_snapshot_sha256
        || dependencies?.facts_snapshot_sha256 !== trace.facts_snapshot_sha256
        || dependencies?.catalog_sha256 !== trace.catalog_sha256
        || !Array.isArray(rules?.rule_inputs)
        || rules.rule_inputs.filter((input: {snapshot_sha256?: unknown} | null) => input?.snapshot_sha256 === trace.rule_input_sha256).length !== 1) {
      throw new PostgresAnalysisError("STAGE_HASH_MISMATCH");
    }
  }

  persistFindingDisabled(input: unknown): never {
    void input;
    throw new PostgresAnalysisError("FINDINGS_DISABLED");
  }

  async assertFindingsDisabled(input: Readonly<{ case_id: string; analysis_run_id: string }>): Promise<void> {
    try {
      const result = await this.context.client.query(statement(
        "analysis_findings_disabled",
        `select count(*)::text as finding_count
           from public.analysis_findings f
           join public.analysis_runs ar on ar.id = f.analysis_run_id
           join public.engine_case_state ecs on ecs.case_id = ar.case_id
          where ar.tenant_id = $1
            and ar.canonical_analysis_run_id = $2
            and ar.canonical_case_id = $3
            and ecs.tenant_id = $1`,
        [this.tenantId, input.analysis_run_id, input.case_id],
      ));
      if (result.row_count !== 1 || result.rows[0]?.finding_count !== "0") {
        throw new PostgresAnalysisError("FINDINGS_DISABLED");
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "FINDINGS_DISABLED");
    }
  }

  async persistConfirmation(untrusted: CaseConfirmation): Promise<void> {
    const confirmation = validateCanonicalConfirmation(untrusted);
    try {
      const inserted = await this.context.client.query(statement(
        "analysis_confirmation_insert",
        `insert into public.case_confirmations
           (id, case_id, source_analysis_run_id, target_fact_path, question_id, question_version,
            proposed_value, answer, status, source_message_id, idempotency_key, created_at, answered_at,
            tenant_id, canonical_confirmation_id, canonical_case_id, canonical_analysis_run_id,
            canonical_source_message_id)
         select private.canonical_text_uuid('confirmation', $4), ecs.case_id, ar.id, $5, $6, $7,
                $8::jsonb, $9::jsonb, $10,
                case when $11::text is null then null else private.canonical_text_uuid('message', $11) end,
                $12, $13::timestamptz, $14::timestamptz,
                $1, $4, $3, $2, $11
           from public.analysis_runs ar
           join public.engine_case_state ecs on ecs.case_id = ar.case_id
          where ar.canonical_analysis_run_id = $2
            and ar.canonical_case_id = $3
            and ar.tenant_id = $1
            and ecs.tenant_id = $1
         on conflict (case_id, idempotency_key) do nothing
         returning id`,
        [
          this.tenantId, confirmation.source_analysis_run_id, confirmation.case_id, confirmation.confirmation_id,
          confirmation.target_fact_path, confirmation.question_id, confirmation.question_version,
          nullableJson(confirmation.proposed_value), nullableJson(confirmation.answer), confirmation.status,
          confirmation.source_message_id, confirmation.idempotency_key, confirmation.created_at, confirmation.answered_at,
        ],
      ));
      if (inserted.row_count === 0) {
        const existing = await this.context.client.query(statement(
          "analysis_confirmation_existing",
          `select canonical_confirmation_id, canonical_analysis_run_id, status, answer
             from public.case_confirmations
            where tenant_id = $1 and canonical_case_id = $2
              and idempotency_key = $3`,
          [this.tenantId, confirmation.case_id, confirmation.idempotency_key],
        ));
        if (existing.row_count !== 1 || existing.rows[0]?.canonical_confirmation_id !== confirmation.confirmation_id
            || existing.rows[0]?.canonical_analysis_run_id !== confirmation.source_analysis_run_id
            || canonicalSha256(existing.rows[0]?.answer) !== canonicalSha256(confirmation.answer)) {
          throw new PostgresAnalysisError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
        }
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    }
  }
}

function nullableJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** Reuses the canonical confirmation boundary without importing its server-only schema at runtime. */
export function validateCanonicalConfirmation(value: CaseConfirmation): CaseConfirmation {
  const expectedKeys = [
    "confirmation_id", "case_id", "source_analysis_run_id", "target_fact_path", "question_id",
    "question_version", "proposed_value", "answer", "status", "source_message_id", "idempotency_key",
    "created_at", "answered_at",
  ].sort();
  if (typeof value !== "object" || value === null
      || Object.keys(value).sort().some((key, index) => key !== expectedKeys[index])
      || Object.keys(value).length !== expectedKeys.length
      || !Number.isSafeInteger(value.question_version) || value.question_version < 1
      || !["pending", "confirmed", "rejected", "corrected"].includes(value.status)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  const answered = value.status !== "pending";
  if (answered !== (value.answered_at !== null && value.source_message_id !== null && value.answer !== null)) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  for (const identifier of [
    value.confirmation_id, value.case_id, value.source_analysis_run_id, value.question_id, value.idempotency_key,
  ]) assertSafeIdentifier(identifier);
  return value;
}
