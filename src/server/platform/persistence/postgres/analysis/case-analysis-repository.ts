import type {
  CaseAnalysisRepositoryPort,
  PersistedCaseAnalysisRun,
  PinnedAnalysisDependencies,
} from "../../../../../engine/case-analysis/contracts";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type {
  AnalysisResultBundle,
  CaseAnalysisCommand,
  DeterministicReportArtifacts,
  LegalCatalogSelection,
} from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import { PostgresLegalPinsRepository } from "./legal-pins";
import { PostgresReportReviewRepository } from "./reports";
import { PostgresTopicResultRepository } from "./topic-results";
import { PostgresTraceFindingRepository } from "./traces";
import {
  array,
  assertSafeIdentifier,
  assertSha256,
  decodeBundle,
  decodeCommand,
  decodeDependencies,
  decodeReport,
  decodeSelection,
  decodeStage,
  encodeReport,
  object,
  parseJson,
  validateReport,
  validateSelections,
} from "./validation";

export type PostgresAnalysisRepositoryDependencies = Readonly<{
  legalPins: PostgresLegalPinsRepository;
  topicResults: PostgresTopicResultRepository;
  traceFindings: PostgresTraceFindingRepository;
  reports: PostgresReportReviewRepository;
}>;

export class PostgresCaseAnalysisRepository implements CaseAnalysisRepositoryPort {
  constructor(
    private readonly context: PostgresTransactionContext,
    private readonly tenantId: string,
    private readonly repositories: PostgresAnalysisRepositoryDependencies,
  ) {
    assertSafeIdentifier(tenantId);
  }

  async begin(input: Readonly<{
    analysis_run_id: string;
    idempotency_key: string;
    command_sha256: string;
    command: CaseAnalysisCommand;
  }>): Promise<PersistedCaseAnalysisRun> {
    assertSafeIdentifier(input.analysis_run_id);
    assertSafeIdentifier(input.idempotency_key);
    assertSha256(input.command_sha256);
    const command = decodeCommand(input.command);
    if (canonicalSha256(command) !== input.command_sha256 || command.idempotency_key !== input.idempotency_key) {
      throw new PostgresAnalysisError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
    }
    const existing = await this.getByIdempotency(input.command.case_id, input.idempotency_key);
    if (existing) {
      if (existing.command_sha256 !== input.command_sha256) {
        throw new PostgresAnalysisError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
      }
      return existing;
    }
    const collision = await this.getByRunId(input.analysis_run_id);
    if (collision) throw new PostgresAnalysisError("ANALYSIS_RUN_ID_COLLISION");
    try {
      const inserted = await this.context.client.query(statement(
        "analysis_run_begin",
        `insert into public.analysis_runs
           (id, case_id, run_type, status, trigger_reason, engine_version, engine_git_sha,
            contract_version, ontology_version, rule_set_hash, input_snapshot,
            input_snapshot_hash, idempotency_key, started_at, created_at,
            tenant_id, canonical_case_id, canonical_analysis_run_id, command_sha256,
            command_payload, case_revision, completion_payload)
         select
           private.canonical_text_uuid('analysis_run', $3), private.resolve_engine_case_id($1, $2),
           'full_investigation', 'running',
           'canonical_case_analysis', 'case-analysis@0.6.0',
           nullif(current_setting('tivdoc.engine_git_sha', true), ''),
           'tivdoc-case-analysis-v0.6.0', 'tivdoc-canonical-persistence-v0.9.0', null,
           $6::jsonb, $5, $4, transaction_timestamp(), transaction_timestamp(),
           $1, $2, $3, $5, $6::jsonb, $7, null
           from public.engine_case_state ecs
          where ecs.tenant_id = $1 and ecs.canonical_case_id = $2 and ecs.revision = $7
         returning canonical_analysis_run_id`,
        [
          this.tenantId, command.case_id, input.analysis_run_id, input.idempotency_key,
          input.command_sha256, JSON.stringify(command), command.case_revision,
        ],
      ));
      if (inserted.row_count !== 1) throw new PostgresAnalysisError("STALE_CASE_REVISION");
      const created = await this.getByRunId(input.analysis_run_id);
      if (!created) throw new PostgresAnalysisError("POSTGRES_PERSISTENCE_UNAVAILABLE");
      return created;
    } catch (error) {
      mapPostgresAnalysisError(error, "ANALYSIS_RUN_ID_COLLISION");
    }
  }

  async persistStage(input: Readonly<{
    analysis_run_id: string;
    stage: Parameters<CaseAnalysisRepositoryPort["persistStage"]>[0]["stage"];
    payload_sha256: string;
    payload: unknown;
  }>): Promise<void> {
    assertSha256(input.payload_sha256);
    if (canonicalSha256(input.payload) !== input.payload_sha256) {
      throw new PostgresAnalysisError("STAGE_HASH_MISMATCH");
    }
    try {
      const inserted = await this.context.client.query(statement(
        "analysis_stage_insert",
        `insert into public.engine_analysis_stage_versions
           (analysis_run_id, tenant_id, case_id, stage, resume_cursor, payload, payload_sha256, created_at)
         select ar.id, $1, ar.case_id, $3, '{}'::jsonb, $4::jsonb, $5, transaction_timestamp()
           from public.analysis_runs ar
          where ar.tenant_id = $1 and ar.canonical_analysis_run_id = $2
         on conflict (analysis_run_id, stage) do nothing
         returning payload_sha256`,
        [this.tenantId, input.analysis_run_id, input.stage, JSON.stringify(input.payload), input.payload_sha256],
      ));
      if (inserted.row_count === 1) return;
      const existing = await this.context.client.query(statement(
        "analysis_stage_existing",
        `select s.payload_sha256
           from public.engine_analysis_stage_versions s
           join public.analysis_runs ar on ar.id = s.analysis_run_id
          where ar.tenant_id = $1 and ar.canonical_analysis_run_id = $2 and s.stage = $3`,
        [this.tenantId, input.analysis_run_id, input.stage],
      ));
      if (existing.row_count !== 1) throw new PostgresAnalysisError("ANALYSIS_RUN_NOT_FOUND");
      if (existing.rows[0]?.payload_sha256 !== input.payload_sha256) {
        throw new PostgresAnalysisError("IMMUTABLE_STAGE_MISMATCH");
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "IMMUTABLE_STAGE_MISMATCH");
    }
  }

  async complete(input: Readonly<{
    analysis_run_id: string;
    selections: readonly LegalCatalogSelection[];
    dependencies: PinnedAnalysisDependencies;
    bundle: AnalysisResultBundle;
    report: DeterministicReportArtifacts;
  }>): Promise<PersistedCaseAnalysisRun> {
    validateSelections(input.selections);
    const bundle = decodeBundle(input.bundle);
    validateReport(input.report);
    if (bundle.analysis_run_id !== input.analysis_run_id
        || input.report.analysis_result_sha256 !== bundle.result_sha256
        || input.dependencies.extraction_snapshot_sha256 !== bundle.extraction_snapshot_sha256
        || input.dependencies.facts_snapshot_sha256 !== bundle.facts_snapshot_sha256
        || input.dependencies.catalog_sha256 !== bundle.catalog_sha256) {
      throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
    }
    const existing = await this.getByRunId(input.analysis_run_id);
    if (!existing) throw new PostgresAnalysisError("ANALYSIS_RUN_NOT_FOUND");
    if (existing.completed) {
      if (existing.bundle?.result_sha256 !== bundle.result_sha256
          || existing.report?.report_sha256 !== input.report.report_sha256) {
        throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
      }
      return existing;
    }
    if (existing.command.case_id !== bundle.case_id || existing.command.case_revision !== bundle.case_revision) {
      throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
    }

    await this.repositories.legalPins.persist({
      case_id: bundle.case_id,
      analysis_run_id: input.analysis_run_id,
      dependencies: input.dependencies,
      selections: input.selections,
    });
    await this.repositories.topicResults.persistSeven({
      case_id: bundle.case_id,
      analysis_run_id: input.analysis_run_id,
      topic_results: bundle.topic_results,
    });
    await this.repositories.traceFindings.persistTraces({
      case_id: bundle.case_id,
      analysis_run_id: input.analysis_run_id,
      topic_results: bundle.topic_results,
    });
    await this.repositories.traceFindings.assertFindingsDisabled({
      case_id: bundle.case_id,
      analysis_run_id: input.analysis_run_id,
    });
    await this.repositories.reports.persistReport({
      case_id: bundle.case_id,
      analysis_run_id: input.analysis_run_id,
      report: input.report,
      review_eligible: existing.command.mode === "synthetic_test" && bundle.coverage_complete,
    });

    const completionPayload = {
      schema_version: "tivdoc-postgres-analysis-completion-v0.9.0",
      selections: input.selections,
      dependencies: input.dependencies,
      bundle,
      report: encodeReport(input.report),
    } as const;
    try {
      const updated = await this.context.client.query(statement(
        "analysis_run_complete",
        `update public.analysis_runs
            set status = 'completed', completed_at = transaction_timestamp(), completion_payload = $3::jsonb
          where tenant_id = $1 and canonical_analysis_run_id = $2 and status = 'running'
          returning canonical_analysis_run_id`,
        [this.tenantId, input.analysis_run_id, JSON.stringify(completionPayload)],
      ));
      if (updated.row_count !== 1) throw new PostgresAnalysisError("IMMUTABLE_COMPLETED_RUN_MISMATCH");
      const completed = await this.getByRunId(input.analysis_run_id);
      if (!completed?.completed) throw new PostgresAnalysisError("POSTGRES_PERSISTENCE_UNAVAILABLE");
      return completed;
    } catch (error) {
      mapPostgresAnalysisError(error, "IMMUTABLE_COMPLETED_RUN_MISMATCH");
    }
  }

  async getByRunId(analysisRunId: string): Promise<PersistedCaseAnalysisRun | null> {
    assertSafeIdentifier(analysisRunId);
    try {
      const result = await this.context.client.query(statement(
        "analysis_run_by_id",
        `${RUN_SELECT}
          where ar.tenant_id = $1 and ar.canonical_analysis_run_id = $2
          group by ar.id`,
        [this.tenantId, analysisRunId],
      ));
      return result.row_count === 0 ? null : decodeRunRow(result.rows[0]);
    } catch (error) {
      mapPostgresAnalysisError(error, "ANALYSIS_ROW_MALFORMED");
    }
  }

  async getCompletedByIdempotencyKey(idempotencyKey: string): Promise<PersistedCaseAnalysisRun | null> {
    assertSafeIdentifier(idempotencyKey);
    try {
      const result = await this.context.client.query(statement(
        "analysis_run_completed_idem",
        `${RUN_SELECT}
          where ar.tenant_id = $1 and ar.idempotency_key = $2 and ar.status = 'completed'
          group by ar.id
          order by ar.completed_at desc
          limit 1`,
        [this.tenantId, idempotencyKey],
      ));
      return result.row_count === 0 ? null : decodeRunRow(result.rows[0]);
    } catch (error) {
      mapPostgresAnalysisError(error, "ANALYSIS_ROW_MALFORMED");
    }
  }

  async assertPinnedDependenciesAvailable(dependencies: PinnedAnalysisDependencies): Promise<void> {
    decodeDependencies(dependencies);
    await this.repositories.legalPins.assertAvailable(dependencies);
  }

  private async getByIdempotency(caseId: string, idempotencyKey: string): Promise<PersistedCaseAnalysisRun | null> {
    try {
      const result = await this.context.client.query(statement(
        "analysis_run_by_idem",
        `${RUN_SELECT}
          where ar.tenant_id = $1 and ar.canonical_case_id = $2 and ar.idempotency_key = $3
          group by ar.id`,
        [this.tenantId, caseId, idempotencyKey],
      ));
      return result.row_count === 0 ? null : decodeRunRow(result.rows[0]);
    } catch (error) {
      mapPostgresAnalysisError(error, "ANALYSIS_ROW_MALFORMED");
    }
  }
}

const RUN_SELECT = `select
    ar.canonical_analysis_run_id as analysis_run_id,
    ar.idempotency_key,
    ar.command_sha256,
    ar.command_payload as command,
    (ar.status = 'completed') as completed,
    coalesce(jsonb_agg(jsonb_build_object(
      'stage', s.stage, 'payload_sha256', s.payload_sha256, 'payload', s.payload
    ) order by s.created_at) filter (where s.stage is not null), '[]'::jsonb) as stages,
    ar.completion_payload
  from public.analysis_runs ar
  left join public.engine_analysis_stage_versions s on s.analysis_run_id = ar.id`;

function decodeRunRow(value: unknown): PersistedCaseAnalysisRun {
  const row = object(value, [
    "analysis_run_id", "idempotency_key", "command_sha256", "command", "completed", "stages", "completion_payload",
  ]);
  const analysisRunId = requiredString(row.analysis_run_id);
  const idempotencyKey = requiredString(row.idempotency_key);
  assertSha256(row.command_sha256);
  const command = decodeCommand(row.command);
  if (canonicalSha256(command) !== row.command_sha256 || command.idempotency_key !== idempotencyKey) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  if (typeof row.completed !== "boolean") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  const stages = Object.freeze(array(row.stages).map(decodeStage));
  if (!row.completed) {
    if (row.completion_payload !== null) throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
    return Object.freeze({
      analysis_run_id: analysisRunId,
      idempotency_key: idempotencyKey,
      command_sha256: row.command_sha256,
      command,
      stages,
      selections: [],
      dependencies: null,
      bundle: null,
      report: null,
      completed: false,
    });
  }
  const completion = object(parseJson(row.completion_payload), ["schema_version", "selections", "dependencies", "bundle", "report"]);
  if (completion.schema_version !== "tivdoc-postgres-analysis-completion-v0.9.0") {
    throw new PostgresAnalysisError("ANALYSIS_ROW_VERSION_UNSUPPORTED");
  }
  const selections = Object.freeze(array(completion.selections).map(decodeSelection));
  validateSelections(selections);
  const dependencies = decodeDependencies(completion.dependencies);
  const bundle = decodeBundle(completion.bundle);
  const report = decodeReport(completion.report);
  if (bundle.analysis_run_id !== analysisRunId || bundle.case_id !== command.case_id
      || report.analysis_result_sha256 !== bundle.result_sha256) {
    throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  }
  return Object.freeze({
    analysis_run_id: analysisRunId,
    idempotency_key: idempotencyKey,
    command_sha256: row.command_sha256,
    command,
    stages,
    selections,
    dependencies,
    bundle,
    report,
    completed: true,
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new PostgresAnalysisError("ANALYSIS_ROW_MALFORMED");
  return value;
}
