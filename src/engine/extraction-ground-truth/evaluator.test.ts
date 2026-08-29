import { describe, expect, it } from "vitest";
import { evaluateLockedGroundTruth } from "./evaluator.ts";
import {
  buildSyntheticGroundTruthWorkflow,
  syntheticFieldProfiles,
  syntheticPredictions,
  syntheticValues,
} from "./synthetic-fixtures.ts";

function evaluate(predictions = syntheticPredictions) {
  return evaluateLockedGroundTruth({
    benchmark_id: "SYNTHETIC_EXTRACTION_BENCHMARK_001",
    benchmark_version: "1.0",
    manifest: buildSyntheticGroundTruthWorkflow().locked_ground_truth,
    field_profiles: syntheticFieldProfiles,
    predictions,
    evaluated_at: "2040-05-04T10:00:00Z",
  });
}

describe("deterministic Ground Truth evaluator", () => {
  it("reports all required metrics, field errors and conflict errors", () => {
    const report = evaluate();
    expect(report.overall_accuracy).toEqual({ expected: 5, correct: 2, accuracy: "0.4" });
    expect(report.critical_field_accuracy).toEqual({ expected: 3, correct: 2, accuracy: "0.666666" });
    expect(report.monetary_accuracy).toEqual({ expected: 1, correct: 1, accuracy: "1" });
    expect(report.hours_accuracy).toEqual({ expected: 1, correct: 0, accuracy: "0.0" });
    expect(report.pay_period_accuracy).toEqual({ expected: 1, correct: 1, accuracy: "1" });
    expect(report.field_error_matrix.map((row) => [row.field_identity, row.value_outcome])).toEqual([
      ["synthetic.amount", "correct"],
      ["synthetic.duration", "value_mismatch"],
      ["synthetic.label", "missed"],
      ["synthetic.period", "correct"],
      ["synthetic.unexpected", "unexpected"],
    ]);
    expect(report.false_conflicts).toEqual(["synthetic.amount"]);
    expect(report.missed_conflicts).toEqual(["synthetic.duration"]);
    expect(report.report_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is byte-identical despite prediction and profile input order", () => {
    const first = evaluate();
    const second = evaluateLockedGroundTruth({
      benchmark_id: "SYNTHETIC_EXTRACTION_BENCHMARK_001",
      benchmark_version: "1.0",
      manifest: buildSyntheticGroundTruthWorkflow().locked_ground_truth,
      field_profiles: [...syntheticFieldProfiles].reverse(),
      predictions: [...syntheticPredictions].reverse(),
      evaluated_at: "2040-05-04T10:00:00Z",
    });
    expect(second).toEqual(first);
  });

  it("rejects unlocked truth, duplicate predictions and incomplete profiles", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(() => evaluateLockedGroundTruth({
      benchmark_id: "SYNTHETIC_EXTRACTION_BENCHMARK_001",
      benchmark_version: "1.0",
      manifest: workflow.human_adjudication,
      field_profiles: syntheticFieldProfiles,
      predictions: syntheticPredictions,
      evaluated_at: "2040-05-04T10:00:00Z",
    })).toThrow("ground_truth_evaluator_requires_locked_manifest");
    expect(() => evaluate([...syntheticPredictions, syntheticPredictions[0]!])).toThrow("ground_truth_duplicate_prediction_identity");
    expect(() => evaluateLockedGroundTruth({
      benchmark_id: "SYNTHETIC_EXTRACTION_BENCHMARK_001",
      benchmark_version: "1.0",
      manifest: workflow.locked_ground_truth,
      field_profiles: syntheticFieldProfiles.slice(1),
      predictions: syntheticPredictions,
      evaluated_at: "2040-05-04T10:00:00Z",
    })).toThrow("ground_truth_field_profiles_must_cover_locked_fields");
  });

  it("uses the existing canonical money/date/decimal calculation representations", () => {
    const report = evaluate([
      { field_identity: "synthetic.amount", value: syntheticValues.amount_a, conflict_detected: false },
      { field_identity: "synthetic.duration", value: syntheticValues.duration_a, conflict_detected: true },
      { field_identity: "synthetic.period", value: syntheticValues.period, conflict_detected: false },
      { field_identity: "synthetic.label", value: syntheticValues.label, conflict_detected: false },
    ]);
    expect(report.overall_accuracy).toEqual({ expected: 4, correct: 4, accuracy: "1" });
    expect(report.false_conflicts).toEqual([]);
    expect(report.missed_conflicts).toEqual([]);
  });
});
