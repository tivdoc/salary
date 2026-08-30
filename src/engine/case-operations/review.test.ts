import { describe, expect, it } from "vitest";
import type { DeterministicClockPort } from "../wave3/contracts";
import { ContentAddressedIdPort, Sha256CanonicalHashPort } from "./canonical";
import { CaseReviewError, InMemoryCaseReviewService } from "./review";

const clock: DeterministicClockPort = { now: () => "2026-08-30T12:00:00.000Z" };
const hash = new Sha256CanonicalHashPort();
const ids = new ContentAddressedIdPort();

describe("immutable human case review tasks", () => {
  it("creates all four task kinds, preserves versions, and binds decisions to exact hashes", async () => {
    const reviews = new InMemoryCaseReviewService({ clock, ids, hash });
    const kinds = ["extraction_review", "fact_conflict", "legal_evaluation", "report_approval"] as const;
    const tasks = kinds.map((task_kind, index) => reviews.createTask({
      case_id: "case:synthetic:review",
      task_kind,
      input_sha256: `${index + 1}`.repeat(64),
      output_sha256: `${index + 5}`.repeat(64),
    }));
    expect(reviews.tasksForCase("case:synthetic:review")).toHaveLength(4);
    const report = tasks[3];
    await expect(reviews.decide({
      task_id: report.task_id,
      task_kind: report.task_kind,
      reviewer_id: "reviewer:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: "f".repeat(64),
      output_sha256: report.output_sha256,
      decided_at: clock.now(),
      reason: "wrong_input",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    })).rejects.toThrowError("review_hash_binding_mismatch");
    const receipt = await reviews.decide({
      task_id: report.task_id,
      task_kind: report.task_kind,
      reviewer_id: "reviewer:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved",
      input_sha256: report.input_sha256,
      output_sha256: report.output_sha256,
      decided_at: clock.now(),
      reason: "synthetic_fixture_exact_hash_review",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
    });
    expect(await reviews.isReportExportEligible(report.case_id, report.output_sha256)).toBe(true);
    expect(receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
    reviews.invalidateCase(report.case_id, clock.now(), "analysis_changed", "a".repeat(64));
    const newReport = reviews.createTask({ case_id: report.case_id, task_kind: "report_approval", input_sha256: "b".repeat(64), output_sha256: "c".repeat(64) });
    expect(newReport.task_revision).toBe(2);
    expect(newReport.supersedes_task_id).toBe(report.task_id);
    expect(reviews.tasksForCase(report.case_id)).toHaveLength(5);
    expect(await reviews.isReportExportEligible(report.case_id, report.output_sha256)).toBe(false);
  });

  it("rejects a manual monetary override field at the strict decision boundary", async () => {
    const reviews = new InMemoryCaseReviewService({ clock, ids, hash });
    const task = reviews.createTask({ case_id: "case:synthetic:no-override", task_kind: "report_approval", input_sha256: "1".repeat(64), output_sha256: "2".repeat(64) });
    const unsafe = {
      task_id: task.task_id,
      task_kind: task.task_kind,
      reviewer_id: "reviewer:001",
      reviewer_role: "case_report_reviewer",
      decision: "approved" as const,
      input_sha256: task.input_sha256,
      output_sha256: task.output_sha256,
      decided_at: clock.now(),
      reason: "attempted_override",
      schema_version: "tivdoc-case-review-decision-v0.6.0",
      replacement_monetary_total: { currency: "XTS", minor_units: 1 },
    };
    await expect(reviews.decide(unsafe)).rejects.toEqual(expect.objectContaining<Partial<CaseReviewError>>({ code: "review_decision_unknown_or_missing_field" }));
  });
});
