import type { CaseConfirmation } from "../../../../engine/persistence-contracts";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type { TopicAnalysisResult } from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import { assertSafeIdentifier, assertSevenTopics } from "./validation";

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
  }>): Promise<void> {
    assertSevenTopics(input.topic_results);
    try {
      for (const result of input.topic_results) {
        if (result.trace === null) continue;
        const traceSha256 = canonicalSha256(result.trace);
        const traceId = `trace:${input.analysis_run_id}:${result.topic}:${traceSha256}`;
        await this.context.client.query(statement(
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
           on conflict (trace_id) do nothing`,
          [this.tenantId, input.analysis_run_id, input.case_id, traceId, result.topic, JSON.stringify(result.trace), traceSha256],
        ));
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "IMMUTABLE_COMPLETED_RUN_MISMATCH");
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

function validateCanonicalConfirmation(value: CaseConfirmation): CaseConfirmation {
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
