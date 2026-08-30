import { describe, expect, it } from "vitest";
import { buildGroundTruthNegativeMatrix, buildRuleInputNegativeMatrix } from "./negative-matrices.ts";

describe("Wave 2.1 omitted negative matrices", () => {
  it("proves every required Rule Input rejection without partial values", () => {
    const report = buildRuleInputNegativeMatrix();
    expect(report.passed).toBe(true);
    expect(report.cases.map((entry) => entry.expected_rejection)).toEqual([
      "fact.missing",
      "fact.conflicted",
      "fact.unconfirmed",
      "fact.stale",
      "fact.below_confidence_threshold",
    ]);
    expect(report.cases.every((entry) => entry.partial_values_published === 0)).toBe(true);
  });

  it("proves canonical money reuse and every required Ground Truth denial", () => {
    const report = buildGroundTruthNegativeMatrix();
    expect(report.passed).toBe(true);
    expect(report.canonical_calculation_value_schema_reused).toBe(true);
    expect(report.negative_cases).toHaveLength(7);
    expect(report.positive_cases.map((entry) => entry.id)).toEqual([
      "GT_POS_001_CANONICAL_MONEY_REUSE",
      "GT_POS_002_REVISION_PRESERVATION",
    ]);
  });
});
