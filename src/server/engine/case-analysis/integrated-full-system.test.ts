import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { CaseLifecycleState, CaseReviewDecision, PaymentEvidenceSnapshot } from "../../../engine/wave3/contracts.ts";
import { COMPLETE_THREE_PERIOD_FIXTURE, PARTIAL_THREE_PERIOD_FIXTURE, buildSyntheticCaseFixture } from "../../../engine/case-analysis/synthetic-fixtures.ts";
import { SYNTHETIC_CATALOG_DATE, SYNTHETIC_POPULATION, SYNTHETIC_SECTOR } from "../../../engine/legal-operations/synthetic-fixtures.ts";
import { HEBREW_REPORT_PAGE_COUNT } from "../../reports/deterministic-hebrew-pdf.ts";
import { createIntegratedFullSystemHarness } from "./integrated-harness.ts";

function integratedCommand(fixture: ReturnType<typeof buildSyntheticCaseFixture>, revision = 1) {
  return {
    ...fixture.command,
    case_revision: revision,
    period: { start_date: SYNTHETIC_CATALOG_DATE, end_date: SYNTHETIC_CATALOG_DATE },
    as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
  };
}

async function advanceToReportReview(harness: ReturnType<typeof createIntegratedFullSystemHarness>, caseId: string) {
  const payment: PaymentEvidenceSnapshot = {
    evidence_id: "payment:evidence:integrated:001",
    evidence_revision: "1",
    evidence_sha256: "a".repeat(64),
    case_reference: caseId,
    customer_reference: "customer:opaque:integrated:001",
    amount: { currency: "ZZZ", minor_units: 9999 },
    status: "settled",
    duplicate_of_evidence_id: null,
  };
  harness.payments.appendVerifiedEvidence(payment);
  harness.caseOperations.createCase(caseId);
  let state = await harness.caseOperations.reconcilePayment(caseId, payment.amount, payment.customer_reference);
  const targets: CaseLifecycleState[] = [
    "awaiting_extraction_review",
    "awaiting_fact_resolution",
    "ready_for_legal_evaluation",
    "awaiting_legal_review",
    "awaiting_report_approval",
  ];
  for (const [index, target] of targets.entries()) {
    state = await harness.caseOperations.transition({
      case_id: caseId,
      expected_revision: state.revision,
      target_state: target,
      actor_id: "actor:synthetic:integrated",
      actor_role: "synthetic_reviewer",
      reason: `integrated_stage_${index}`,
      idempotency_key: `integrated:transition:${index}`,
    });
  }
  return state;
}

describe("merged Wave 3 full-system path", () => {
  it("connects verified payment evidence through W2 execution and W1 exact-hash report approval", async () => {
    const fixture = COMPLETE_THREE_PERIOD_FIXTURE;
    const harness = createIntegratedFullSystemHarness([fixture.stored]);
    const caseState = await advanceToReportReview(harness, fixture.command.case_id);
    const command = integratedCommand(fixture, caseState.revision);
    const bundle = await harness.application.runCaseAnalysis(command);
    const run = await harness.service.getCompletedRun(bundle.analysis_run_id);
    expect(bundle.topic_results.map((result) => result.status)).toEqual(Array(7).fill("calculated"));
    expect(bundle.topic_results.every((result) => result.amount?.currency === "ZZZ" && result.trace !== null)).toBe(true);
    expect(bundle.known_subtotal).toEqual({ currency: "ZZZ", minor_units: 2800 });
    expect(run?.report?.json_sha256).toMatch(/^[a-f0-9]{64}$/);
    const parsedPdf = await PDFDocument.load(run!.report!.pdf);
    expect(parsedPdf.getPageCount()).toBe(HEBREW_REPORT_PAGE_COUNT);
    expect(parsedPdf.getSubject()).toContain(`case=${bundle.case_id}`);
    const replay = await harness.application.replay(bundle.analysis_run_id);
    const repeated = await harness.application.runCaseAnalysis(command);
    expect(replay).toEqual(bundle);
    expect(repeated).toEqual(bundle);
    expect(harness.repository.runCount()).toBe(1);

    const task = harness.caseReviews.tasksForCase(bundle.case_id).at(-1)!;
    const decision: CaseReviewDecision = {
      task_id: task.task_id,
      task_kind: "report_approval",
      reviewer_id: "reviewer:human:integrated:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: run!.report!.report_sha256,
      output_sha256: run!.report!.report_sha256,
      decided_at: harness.clock.now(),
      reason: "synthetic_fixture_exact_hash_review",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    };
    const receipt = await harness.review.decide(decision);
    harness.caseOperations.bindReportApproval(bundle.case_id, run!.report!.report_sha256, receipt.receipt_sha256);
    const beforeReady = await harness.caseOperations.get(bundle.case_id);
    await harness.caseOperations.transition({
      case_id: bundle.case_id,
      expected_revision: beforeReady!.revision,
      target_state: "report_ready",
      actor_id: "reviewer:human:integrated:001",
      actor_role: "case_report_reviewer",
      reason: "exact_report_hash_approved",
      idempotency_key: "integrated:report-ready",
    });
    expect(await harness.manualExport.isEligible(bundle.case_id, run!.report!.report_sha256)).toBe(true);
    expect(harness.executor.counters).toEqual({ execute_calls: 7, external_calls: 0 });
    expect(harness.payments.provider_call_count).toBe(0);
    expect(harness.snapshots.counters.openai_calls).toBe(0);
  });

  it("keeps the current 17-source catalog and incomplete synthetic case fail-closed", async () => {
    const realFixture = buildSyntheticCaseFixture({ fixture_id: "integrated-real", mode: "real" });
    const realHarness = createIntegratedFullSystemHarness([realFixture.stored]);
    const real = await realHarness.application.runCaseAnalysis({ ...integratedCommand(realFixture), mode: "real" });
    const realRun = await realHarness.service.getCompletedRun(real.analysis_run_id);
    expect(real.topic_results.every((result) => result.status === "blocked_legal_readiness")).toBe(true);
    expect(new Set(realRun!.selections.flatMap((selection) => selection.source_version_ids)).size).toBe(17);
    expect(realHarness.executor.counters.execute_calls).toBe(0);
    expect(realHarness.review.counters.approvals).toBe(0);
    const realTask = realHarness.caseReviews.tasksForCase(real.case_id).at(-1)!;
    await expect(realHarness.review.decide({
      task_id: realTask.task_id,
      task_kind: "report_approval",
      reviewer_id: "reviewer:human:integrated:002",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: realRun!.report!.report_sha256,
      output_sha256: realRun!.report!.report_sha256,
      decided_at: realHarness.clock.now(),
      reason: "must_be_denied",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    })).rejects.toThrowError("report_review_not_eligible");

    const partialHarness = createIntegratedFullSystemHarness([PARTIAL_THREE_PERIOD_FIXTURE.stored]);
    const partial = await partialHarness.application.runCaseAnalysis(integratedCommand(PARTIAL_THREE_PERIOD_FIXTURE));
    const partialRun = await partialHarness.service.getCompletedRun(partial.analysis_run_id);
    const json = new TextDecoder().decode(partialRun!.report!.json);
    const html = new TextDecoder().decode(partialRun!.report!.html);
    expect(partial.coverage_complete).toBe(false);
    expect(partial.topic_results.filter((result) => result.status === "calculated")).toHaveLength(5);
    expect(json).toContain("known_subtotal_only_not_total_entitlement");
    expect(html).toContain("אינו הסכום הכולל המגיע");
  });
});
