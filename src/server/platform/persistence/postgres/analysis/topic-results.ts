import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type { TopicAnalysisResult } from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import { assertSafeIdentifier, assertSevenTopics, validateTopicResult } from "./validation";

export class PostgresTopicResultRepository {
  constructor(
    private readonly context: PostgresTransactionContext,
    private readonly tenantId: string,
  ) {
    assertSafeIdentifier(tenantId);
  }

  async persistSeven(input: Readonly<{
    case_id: string;
    analysis_run_id: string;
    topic_results: readonly TopicAnalysisResult[];
  }>): Promise<void> {
    assertSevenTopics(input.topic_results);
    try {
      for (const untrusted of input.topic_results) {
        const result = validateTopicResult(untrusted);
        const resultSha256 = canonicalSha256(result);
        const inserted = await this.context.client.query(statement(
          "analysis_topic_insert",
          `insert into public.engine_topic_result_versions
             (analysis_run_id, tenant_id, case_id, topic, status, result, result_sha256, created_at)
           select ar.id, $1, ecs.case_id, $4, $5, $6::jsonb, $7, transaction_timestamp()
             from public.analysis_runs ar
             join public.engine_case_state ecs on ecs.case_id = ar.case_id
            where ar.canonical_analysis_run_id = $2
              and ar.canonical_case_id = $3
              and ar.tenant_id = $1
              and ecs.tenant_id = $1
           on conflict (analysis_run_id, topic) do nothing
           returning result_sha256`,
          [this.tenantId, input.analysis_run_id, input.case_id, result.topic, result.status, JSON.stringify(result), resultSha256],
        ));
        if (inserted.row_count === 0) {
          const existing = await this.context.client.query(statement(
            "analysis_topic_existing",
            `select r.result_sha256
               from public.engine_topic_result_versions r
               join public.analysis_runs ar on ar.id = r.analysis_run_id
              where ar.canonical_analysis_run_id = $2
                and ar.canonical_case_id = $3
                and ar.tenant_id = $1
                and r.tenant_id = $1
                and r.topic = $4`,
            [this.tenantId, input.analysis_run_id, input.case_id, result.topic],
          ));
          if (existing.rows[0]?.result_sha256 !== resultSha256) {
            throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
          }
        }
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "IMMUTABLE_COMPLETED_RUN_MISMATCH");
    }
  }
}
