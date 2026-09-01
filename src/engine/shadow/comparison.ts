import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import {
  shadowEvaluationSnapshotSchema,
  shadowThresholdPolicySchema,
  type ShadowComparison,
  type ShadowFieldDelta,
} from "./contracts.ts";

type Field = ReturnType<typeof shadowEvaluationSnapshotSchema.parse>["topics"][number]["fields"][number];

const uncertaintyRank = Object.freeze({ none: 0, low: 1, high: 2, unknown: 3 });

function classify(baseline: Field | undefined, candidate: Field | undefined): ShadowFieldDelta["taxonomy"] {
  if (!candidate || (candidate.state === "error" && baseline?.state !== "error")) return "regression";
  if (!baseline) return "changed";
  if (baseline.state !== "blocked" && candidate.state === "blocked") return "blocked_added";
  if (baseline.state === "blocked" && candidate.state !== "blocked") return "blocked_removed";
  if (uncertaintyRank[candidate.uncertainty] > uncertaintyRank[baseline.uncertainty]) return "uncertainty_increased";
  if (uncertaintyRank[candidate.uncertainty] < uncertaintyRank[baseline.uncertainty]) return "uncertainty_decreased";
  if (baseline.state === "error" && candidate.state !== "error") return "improvement";
  return baseline.value_fingerprint === candidate.value_fingerprint && baseline.state === candidate.state
    ? "stable"
    : "changed";
}

function uncertaintyChange(baseline: Field | undefined, candidate: Field | undefined): ShadowFieldDelta["uncertainty_change"] {
  if (!baseline || !candidate) return "stable";
  if (uncertaintyRank[candidate.uncertainty] > uncertaintyRank[baseline.uncertainty]) return "increased";
  if (uncertaintyRank[candidate.uncertainty] < uncertaintyRank[baseline.uncertainty]) return "decreased";
  return "stable";
}

function blockedStateChange(baseline: Field | undefined, candidate: Field | undefined): ShadowFieldDelta["blocked_state_change"] {
  if (baseline?.state !== "blocked" && candidate?.state === "blocked") return "added";
  if (baseline?.state === "blocked" && candidate?.state !== "blocked") return "removed";
  return "stable";
}

export function compareShadowCandidateToApprovedBaseline(input: Readonly<{
  comparison_id: string;
  baseline: unknown;
  baseline_approval_receipt_sha256: string;
  candidate: unknown;
  thresholds: unknown;
}>): ShadowComparison {
  if (!/^[a-z][a-z0-9:._-]{2,159}$/u.test(input.comparison_id)) throw new Error("SHADOW_COMPARISON_ID_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(input.baseline_approval_receipt_sha256)) throw new Error("SHADOW_APPROVED_BASELINE_RECEIPT_REQUIRED");
  const baseline = shadowEvaluationSnapshotSchema.parse(input.baseline);
  const candidate = shadowEvaluationSnapshotSchema.parse(input.candidate);
  const thresholds = shadowThresholdPolicySchema.parse(input.thresholds);
  const topicDeltas = WAVE3_TOPICS.map((topic) => {
    const baselineTopic = baseline.topics.find((item) => item.topic === topic)!;
    const candidateTopic = candidate.topics.find((item) => item.topic === topic)!;
    const baselineFields = new Map(baselineTopic.fields.map((field) => [field.field_id, field]));
    const candidateFields = new Map(candidateTopic.fields.map((field) => [field.field_id, field]));
    const fieldIds = [...new Set([...baselineFields.keys(), ...candidateFields.keys()])].sort((left, right) => left.localeCompare(right, "en"));
    const fieldDeltas = fieldIds.map((fieldId) => {
      const baselineField = baselineFields.get(fieldId);
      const candidateField = candidateFields.get(fieldId);
      const taxonomy = classify(baselineField, candidateField);
      const uncertainty = uncertaintyChange(baselineField, candidateField);
      const blocked = blockedStateChange(baselineField, candidateField);
      const content = {
        topic,
        field_id: fieldId,
        baseline_fingerprint: baselineField?.value_fingerprint ?? null,
        candidate_fingerprint: candidateField?.value_fingerprint ?? null,
        baseline_state: baselineField?.state ?? "missing" as const,
        candidate_state: candidateField?.state ?? "missing" as const,
        baseline_uncertainty: baselineField?.uncertainty ?? "missing" as const,
        candidate_uncertainty: candidateField?.uncertainty ?? "missing" as const,
        regression: taxonomy === "regression" || blocked === "added",
        uncertainty_change: uncertainty,
        blocked_state_change: blocked,
        taxonomy,
      };
      return deepFreeze({ ...content, delta_sha256: canonicalSha256(content) }) as ShadowFieldDelta;
    });
    const regressionCount = fieldDeltas.filter((delta) => delta.regression).length;
    const uncertaintyIncreaseCount = fieldDeltas.filter((delta) => delta.uncertainty_change === "increased").length;
    const changedFieldCount = fieldDeltas.filter((delta) => delta.taxonomy !== "stable").length;
    const content = {
      topic,
      field_deltas: fieldDeltas,
      regression_count: regressionCount,
      uncertainty_increase_count: uncertaintyIncreaseCount,
      changed_field_count: changedFieldCount,
      requires_human_review: changedFieldCount > 0,
    };
    return deepFreeze({ ...content, topic_sha256: canonicalSha256(content) });
  });
  const totals = {
    regressions: topicDeltas.reduce((sum, topic) => sum + topic.regression_count, 0),
    uncertainty_increases: topicDeltas.reduce((sum, topic) => sum + topic.uncertainty_increase_count, 0),
    changed_fields: topicDeltas.reduce((sum, topic) => sum + topic.changed_field_count, 0),
    blocked_state_changes: topicDeltas.flatMap((topic) => topic.field_deltas).filter((delta) => delta.blocked_state_change !== "stable").length,
  };
  const thresholdsFailed = totals.regressions > thresholds.max_regressions
    || totals.uncertainty_increases > thresholds.max_uncertainty_increases
    || totals.changed_fields > thresholds.max_changed_fields;
  const nonDegradation = thresholdsFailed
    ? "failed" as const
    : totals.changed_fields > 0 || totals.blocked_state_changes > 0
      ? "manual_review" as const
      : "passed" as const;
  const content = {
    schema_version: "tivdoc-shadow-comparison-v0.10.0" as const,
    comparison_id: input.comparison_id,
    baseline_snapshot_sha256: baseline.snapshot_sha256,
    baseline_approval_receipt_sha256: input.baseline_approval_receipt_sha256,
    candidate_snapshot_sha256: candidate.snapshot_sha256,
    threshold_policy_sha256: thresholds.policy_sha256,
    topic_deltas: topicDeltas,
    totals,
    non_degradation: nonDegradation,
    human_review_required: true as const,
    automatic_customer_promotion: false as const,
    automatic_production_promotion: false as const,
  };
  return deepFreeze({ ...content, comparison_sha256: canonicalSha256(content) }) as ShadowComparison;
}
