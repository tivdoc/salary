import type { CaseAnalysisStage } from "../../../engine/case-analysis/contracts";
import type { CaseReviewDecision } from "../../../engine/wave3/contracts";
import { assertSha256, canonicalSha256 } from "./canonical";
import { PlatformPersistenceError } from "./contracts";
import type { TransactionReceipt } from "./contracts";
import { LocalDurablePlatformStore } from "./transactional-store";

const REVIEW_DECISION_KEYS = [
  "decided_at", "decision", "input_sha256", "output_sha256", "reason",
  "reviewer_id", "reviewer_role", "schema_version", "task_id", "task_kind",
] as const;

export class CanonicalPlatformRepository {
  constructor(private readonly store: LocalDurablePlatformStore) {}

  persistAnalysisStage(input: Readonly<{
    tenant_id: string;
    case_id: string;
    actor_id: string;
    analysis_run_id: string;
    stage: CaseAnalysisStage;
    stage_expected_revision: number;
    run_expected_revision: number;
    expected_case_revision: number;
    payload_sha256: string;
    payload: unknown;
    resume_cursor: Readonly<{ next_stage: CaseAnalysisStage | null }>;
    idempotency_key: string;
    occurred_at: string;
  }>): Promise<TransactionReceipt> {
    assertSha256(input.payload_sha256);
    const runPayload = {
      analysis_run_id: input.analysis_run_id,
      completed_stage: input.stage,
      resume_cursor: input.resume_cursor,
      stage_payload_sha256: input.payload_sha256,
    };
    const command = {
      action: "persist_analysis_stage",
      analysis_run_id: input.analysis_run_id,
      stage: input.stage,
      payload_sha256: input.payload_sha256,
      resume_cursor: input.resume_cursor,
    };
    return this.store.execute({
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      actor_id: input.actor_id,
      scope: "analysis.stage.persist",
      idempotency_key: input.idempotency_key,
      expected_case_revision: input.expected_case_revision,
      command,
      command_sha256: canonicalSha256(command),
      occurred_at: input.occurred_at,
      writes: [
        { entity: "analysis_stages", record_id: `${input.analysis_run_id}:${input.stage}`, expected_revision: input.stage_expected_revision, payload: input.payload, payload_sha256: input.payload_sha256 },
        { entity: "analysis_runs", record_id: input.analysis_run_id, expected_revision: input.run_expected_revision, payload: runPayload, payload_sha256: canonicalSha256(runPayload) },
      ],
      invalidates: [],
      outbox: [],
    });
  }

  async approveExactReport(input: Readonly<{
    tenant_id: string;
    case_id: string;
    actor_id: string;
    report_id: string;
    report_revision: number;
    report_sha256: string;
    expected_case_revision: number;
    review_expected_revision: number;
    lifecycle_expected_revision: number;
    decision: CaseReviewDecision;
    idempotency_key: string;
    occurred_at: string;
  }>): Promise<TransactionReceipt> {
    assertSha256(input.report_sha256);
    assertSha256(input.decision.input_sha256);
    assertSha256(input.decision.output_sha256);
    const report = this.store.current("reports", input.report_id);
    const reportPayload = report?.payload as Record<string, unknown> | undefined;
    if (!report?.visible || report.revision !== input.report_revision || reportPayload?.report_sha256 !== input.report_sha256) {
      throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", "report_exact_hash_binding");
    }
    const decisionKeys = Object.keys(input.decision).sort();
    if (decisionKeys.length !== REVIEW_DECISION_KEYS.length || decisionKeys.some((key, index) => key !== [...REVIEW_DECISION_KEYS].sort()[index])) {
      throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", "review_decision_shape");
    }
    if (input.decision.task_kind !== "report_approval" || input.decision.decision !== "approved" || input.decision.output_sha256 !== input.report_sha256) {
      throw new PlatformPersistenceError("IMMUTABLE_VERSION_MISMATCH", "approval_exact_hash_binding");
    }
    const release = {
      lifecycle_state: "report_ready",
      report_id: input.report_id,
      report_revision: input.report_revision,
      report_sha256: input.report_sha256,
      approval_task_id: input.decision.task_id,
      approval_decision_sha256: canonicalSha256(input.decision),
    };
    const command = { action: "approve_exact_report", release };
    const effect = { case_id: input.case_id, report_id: input.report_id, report_sha256: input.report_sha256 };
    return await this.store.execute({
      tenant_id: input.tenant_id,
      case_id: input.case_id,
      actor_id: input.actor_id,
      scope: "report.release.approve",
      idempotency_key: input.idempotency_key,
      expected_case_revision: input.expected_case_revision,
      command,
      command_sha256: canonicalSha256(command),
      occurred_at: input.occurred_at,
      writes: [
        { entity: "review_tasks", record_id: input.decision.task_id, expected_revision: input.review_expected_revision, payload: input.decision, payload_sha256: canonicalSha256(input.decision) },
        { entity: "lifecycle_revisions", record_id: `report-ready:${input.report_id}`, expected_revision: input.lifecycle_expected_revision, payload: release, payload_sha256: canonicalSha256(release) },
      ],
      invalidates: [],
      outbox: [{ logical_effect_id: `report-release:${input.case_id}:${input.report_sha256}`, effect_kind: "report_release_eligible", payload: effect, payload_sha256: canonicalSha256(effect) }],
    });
  }
}
