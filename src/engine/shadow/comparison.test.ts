import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { buildSyntheticEvaluationSnapshot, buildSyntheticShadowThresholdPolicy } from "../../server/engine/shadow/durable-synthetic-fixtures.ts";
import { compareShadowCandidateToApprovedBaseline } from "./comparison.ts";

describe("MC-24 / V010-W7.2 approved-baseline comparison", () => {
  it("reports field/topic deltas, blocked and uncertainty regressions without promotion", () => {
    const baseline = buildSyntheticEvaluationSnapshot({ snapshot_id: "snapshot.baseline.001" });
    const candidate = buildSyntheticEvaluationSnapshot({
      snapshot_id: "snapshot.candidate.001",
      changed_topic: "pension",
      state: "blocked",
      uncertainty: "high",
    });
    const thresholds = buildSyntheticShadowThresholdPolicy({ max_regressions: 0 });
    const comparison = compareShadowCandidateToApprovedBaseline({
      comparison_id: "comparison.synthetic.001",
      baseline,
      baseline_approval_receipt_sha256: canonicalSha256({ approval: "synthetic" }),
      candidate,
      thresholds,
    });
    const pension = comparison.topic_deltas.find((topic) => topic.topic === "pension")!;
    expect(pension.field_deltas[0]).toMatchObject({ taxonomy: "blocked_added", baseline_state: "complete", candidate_state: "blocked", uncertainty_change: "increased", blocked_state_change: "added", regression: true });
    expect(comparison.totals).toMatchObject({ regressions: 1, uncertainty_increases: 1, changed_fields: 1, blocked_state_changes: 1 });
    expect(comparison.non_degradation).toBe("failed");
    expect(comparison).toMatchObject({ human_review_required: true, automatic_customer_promotion: false, automatic_production_promotion: false });
  });

  it("classifies an identical field set as passed while retaining mandatory human review", () => {
    const baseline = buildSyntheticEvaluationSnapshot({ snapshot_id: "snapshot.baseline.002" });
    const candidate = buildSyntheticEvaluationSnapshot({ snapshot_id: "snapshot.candidate.002" });
    const thresholds = buildSyntheticShadowThresholdPolicy();
    const comparison = compareShadowCandidateToApprovedBaseline({
      comparison_id: "comparison.synthetic.002",
      baseline,
      baseline_approval_receipt_sha256: canonicalSha256({ approval: "synthetic-2" }),
      candidate,
      thresholds,
    });
    expect(comparison.totals.changed_fields).toBe(0);
    expect(comparison.non_degradation).toBe("passed");
    expect(comparison.human_review_required).toBe(true);
  });
});
