import { describe, expect, it } from "vitest";
import { benchmarkPayslipExtractor } from "./benchmark.ts";
import { FixtureDocumentExtractor, SyntheticDocumentSource } from "./fixture-extractor.ts";
import { syntheticPayslipGroundTruth } from "./fixtures/ground-truth.ts";
import { syntheticPayslipFixtures } from "./fixtures/source-fixtures.ts";

describe("synthetic payslip extraction benchmark", () => {
  it("reports field-level accuracy and expected validation catches", async () => {
    const report = await benchmarkPayslipExtractor({
      extractor: new FixtureDocumentExtractor(syntheticPayslipFixtures),
      source: new SyntheticDocumentSource(),
      fixtures: syntheticPayslipFixtures,
      ground_truth: syntheticPayslipGroundTruth,
      reference_year: 2026,
    });

    console.info(`PAYSLIP_BENCHMARK ${JSON.stringify(report)}`);
    expect(report.fixtures_total).toBe(10);
    expect(report.extraction_failures).toBe(0);
    expect(report.fields_expected).toBe(69);
    expect(report.exact_matches).toBe(68);
    expect(report.missing_expected_fields).toBe(0);
    expect(report.hallucinated_fields).toBe(0);
    expect(report.expected_absent_fields).toBe(1);
    expect(report.absent_field_false_positives).toBe(0);
    expect(report.money_accuracy).toEqual({ expected: 29, correct: 28 });
    expect(report.hours_accuracy).toEqual({ expected: 4, correct: 4 });
    expect(report.period_accuracy).toEqual({ expected: 10, correct: 10 });
    expect(report.validation_catches).toEqual({ expected: 3, correct: 3 });
    expect(report.confidence_calibration.samples).toBe(69);
  });
});
