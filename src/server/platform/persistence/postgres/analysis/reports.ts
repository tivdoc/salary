import type { ReportRegistrationPort } from "../../../../../engine/case-analysis/contracts";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical";
import type {
  CaseReviewDecision,
  CaseReviewPort,
  DeterministicReportArtifacts,
} from "../../../../../engine/wave3/contracts";
import { statement, type PostgresTransactionContext } from "../contracts";
import { mapPostgresAnalysisError, PostgresAnalysisError } from "./errors";
import {
  assertSafeIdentifier,
  assertSha256,
  encodeReport,
  validateReport,
} from "./validation";

export class PostgresReportReviewRepository implements CaseReviewPort, ReportRegistrationPort {
  constructor(
    private readonly context: PostgresTransactionContext,
    private readonly tenantId: string,
  ) {
    assertSafeIdentifier(tenantId);
  }

  /**
   * The canonical registration port is synchronous. This adapter therefore
   * performs only boundary validation here; `PostgresCaseAnalysisRepository.complete`
   * persists the authoritative report in the surrounding transaction.
   */
  registerReport(input: Readonly<{
    case_id: string;
    report_sha256: string;
    analysis_result_sha256: string;
    export_eligible_after_review: boolean;
  }>): void {
    assertSafeIdentifier(input.case_id);
    assertSha256(input.report_sha256);
    assertSha256(input.analysis_result_sha256);
    if (typeof input.export_eligible_after_review !== "boolean") {
      throw new PostgresAnalysisError("REPORT_HASH_BINDING_INVALID");
    }
  }

  async persistReport(input: Readonly<{
    case_id: string;
    analysis_run_id: string;
    report: DeterministicReportArtifacts;
    review_eligible: boolean;
  }>): Promise<void> {
    validateReport(input.report);
    const encoded = encodeReport(input.report);
    try {
      const inserted = await this.context.client.query(statement(
        "analysis_report_insert",
        `insert into public.engine_report_versions
           (report_id, revision, tenant_id, case_id, analysis_run_id, analysis_result_sha256,
            report_sha256, manifest_sha256, json_sha256, html_sha256, pdf_sha256,
            artifacts_payload, review_eligible, object_version_id, visible, created_at,
            canonical_case_id, canonical_analysis_run_id)
         select $4, $5, $1, ecs.case_id, ar.id, $6, $7, $8, $9, $10, $11,
                $12::jsonb, $13, null, false, transaction_timestamp(), $3, $2
           from public.analysis_runs ar
           join public.engine_case_state ecs on ecs.case_id = ar.case_id
          where ar.canonical_analysis_run_id = $2
            and ar.canonical_case_id = $3
            and ar.tenant_id = $1
            and ecs.tenant_id = $1
            and ecs.revision = $14
         on conflict (report_id, revision) do nothing
         returning report_sha256, pdf_sha256`,
        [
          this.tenantId, input.analysis_run_id, input.case_id, input.report.report_id,
          input.report.report_revision, input.report.analysis_result_sha256, input.report.report_sha256,
          input.report.manifest_sha256, input.report.json_sha256, input.report.html_sha256,
          input.report.pdf_sha256, JSON.stringify(encoded), input.review_eligible, input.report.report_revision,
        ],
      ));
      if (inserted.row_count === 0) {
        const existing = await this.context.client.query(statement(
          "analysis_report_existing",
          `select r.report_sha256, r.pdf_sha256, r.analysis_result_sha256
             from public.engine_report_versions r
             join public.engine_case_state ecs on ecs.case_id = r.case_id
            where r.report_id = $2
              and r.revision = $3
              and r.tenant_id = $1
              and ecs.tenant_id = $1`,
          [this.tenantId, input.report.report_id, input.report.report_revision],
        ));
        const row = existing.rows[0];
        if (row?.report_sha256 !== input.report.report_sha256
            || row.pdf_sha256 !== input.report.pdf_sha256
            || row.analysis_result_sha256 !== input.report.analysis_result_sha256) {
          throw new PostgresAnalysisError("REPORT_HASH_BINDING_INVALID");
        }
      }
    } catch (error) {
      mapPostgresAnalysisError(error, "REPORT_HASH_BINDING_INVALID");
    }
  }

  async decide(decision: CaseReviewDecision) {
    assertReviewDecision(decision);
    const decisionSha256 = canonicalSha256(decision);
    try {
      const inserted = await this.context.client.query(statement(
        "analysis_review_approve",
        `insert into public.engine_review_task_versions
           (task_id, revision, tenant_id, case_id, task_kind, input_sha256, output_sha256,
            task_sha256, decision_payload, decision_sha256, invalidated_at, created_at,
            report_id, report_revision, report_sha256, release_state, canonical_case_id)
         select $2, 1, $1, r.case_id, $3, $4, $5, $6, $7::jsonb, $6,
                null, $8::timestamptz, r.report_id, r.revision, r.report_sha256, 'approved',
                ecs.canonical_case_id
           from public.engine_report_versions r
           join public.engine_case_state ecs on ecs.case_id = r.case_id
          where r.tenant_id = $1
            and ecs.tenant_id = $1
            and r.report_sha256 = $4
            and r.review_eligible = true
            and r.revision = ecs.revision
            and ecs.lifecycle_state not in ('release_hold', 'cancelled')
         on conflict (task_id, revision) do nothing
         returning task_id, revision, decision_sha256`,
        [
          this.tenantId, decision.task_id, decision.task_kind, decision.input_sha256,
          decision.output_sha256, decisionSha256, JSON.stringify(decision), decision.decided_at,
        ],
      ));
      if (inserted.row_count === 1) {
        return Object.freeze({ task_id: decision.task_id, revision: 1, receipt_sha256: decisionSha256 });
      }
      const existing = await this.context.client.query(statement(
        "analysis_review_existing",
        `select revision, decision_sha256
           from public.engine_review_task_versions
          where tenant_id = $1 and task_id = $2 and revision = 1`,
        [this.tenantId, decision.task_id],
      ));
      if (existing.row_count !== 1 || existing.rows[0]?.decision_sha256 !== decisionSha256) {
        throw new PostgresAnalysisError("REPORT_REVIEW_NOT_ELIGIBLE");
      }
      return Object.freeze({ task_id: decision.task_id, revision: 1, receipt_sha256: decisionSha256 });
    } catch (error) {
      mapPostgresAnalysisError(error, "REPORT_REVIEW_NOT_ELIGIBLE");
    }
  }

  async invalidate(input: Readonly<{
    case_id: string;
    report_sha256: string;
    task_id: string;
    expected_revision: number;
    invalidated_at: string;
    reason_sha256: string;
  }>): Promise<Readonly<{ task_id: string; revision: number; receipt_sha256: string }>> {
    assertSha256(input.report_sha256);
    assertSha256(input.reason_sha256);
    if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
      throw new PostgresAnalysisError("STALE_REPORT_REVISION");
    }
    const nextRevision = input.expected_revision + 1;
    const receiptSha256 = canonicalSha256({ ...input, next_revision: nextRevision, release_state: "invalidated" });
    try {
      const result = await this.context.client.query(statement(
        "analysis_review_invalidate",
        `insert into public.engine_review_task_versions
           (task_id, revision, tenant_id, case_id, task_kind, input_sha256, output_sha256,
            task_sha256, decision_payload, decision_sha256, invalidated_at, created_at,
            report_id, report_revision, report_sha256, release_state, canonical_case_id)
         select prior.task_id, $5, prior.tenant_id, prior.case_id, prior.task_kind,
                prior.input_sha256, $6, $7, $8::jsonb, $7, $9::timestamptz, $9::timestamptz,
                prior.report_id, prior.report_revision, prior.report_sha256, 'invalidated',
                prior.canonical_case_id
           from public.engine_review_task_versions prior
           join public.engine_case_state ecs on ecs.case_id = prior.case_id
          where prior.tenant_id = $1
            and ecs.tenant_id = $1
            and ecs.canonical_case_id = $2
            and prior.report_sha256 = $3
            and prior.task_id = $4
            and prior.revision = $10
            and prior.release_state = 'approved'
         on conflict (task_id, revision) do nothing
         returning task_id, revision`,
        [
          this.tenantId, input.case_id, input.report_sha256, input.task_id, nextRevision,
          input.reason_sha256, receiptSha256, JSON.stringify({ reason_sha256: input.reason_sha256 }),
          input.invalidated_at, input.expected_revision,
        ],
      ));
      if (result.row_count !== 1) throw new PostgresAnalysisError("STALE_REPORT_REVISION");
      return Object.freeze({ task_id: input.task_id, revision: nextRevision, receipt_sha256: receiptSha256 });
    } catch (error) {
      mapPostgresAnalysisError(error, "STALE_REPORT_REVISION");
    }
  }

  async isReportExportEligible(caseId: string, reportSha256: string): Promise<boolean> {
    assertSafeIdentifier(caseId);
    assertSha256(reportSha256);
    try {
      const result = await this.context.client.query(statement(
        "analysis_report_eligible",
        `select 1 as eligible
           from public.engine_report_versions r
           join public.engine_case_state ecs on ecs.case_id = r.case_id
          where r.tenant_id = $1
            and ecs.tenant_id = $1
            and ecs.canonical_case_id = $2
            and r.report_sha256 = $3
            and r.review_eligible = true
            and r.revision = ecs.revision
            and ecs.lifecycle_state not in ('release_hold', 'cancelled')
            and (select rv.release_state
                   from public.engine_review_task_versions rv
                  where rv.tenant_id = $1 and rv.case_id = r.case_id and rv.report_sha256 = r.report_sha256
                  order by rv.revision desc limit 1) = 'approved'
          limit 1`,
        [this.tenantId, caseId, reportSha256],
      ));
      return result.row_count === 1;
    } catch (error) {
      mapPostgresAnalysisError(error, "REPORT_REVIEW_NOT_ELIGIBLE");
    }
  }
}

function assertReviewDecision(decision: CaseReviewDecision): void {
  assertSafeIdentifier(decision.task_id);
  assertSafeIdentifier(decision.reviewer_id);
  if (decision.task_kind !== "report_approval" || decision.decision !== "approved"
      || decision.input_sha256 !== decision.output_sha256) {
    throw new PostgresAnalysisError("REPORT_REVIEW_NOT_ELIGIBLE");
  }
  assertSha256(decision.input_sha256);
}
