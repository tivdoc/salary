import { describe, expect, it } from "vitest";
import { assessExtractionConfidence, criticalFieldThresholds } from "./confidence-policy.ts";
import { extractionResultSchema } from "./contracts.ts";
import { syntheticPayslipFixtures } from "./fixtures/source-fixtures.ts";
import { normalizePayslipExtraction } from "./normalization.ts";
import { validatePayslipGate0 } from "./validation.ts";

function assess(fixtureId: string) {
  const fixture = syntheticPayslipFixtures.find((candidate) => candidate.fixture_id === fixtureId);
  if (!fixture) throw new TypeError(`Missing fixture ${fixtureId}`);
  const normalized = normalizePayslipExtraction(fixture.extraction);
  return assessExtractionConfidence(normalized, validatePayslipGate0(normalized, { reference_year: 2026 }));
}

describe("field-specific critical confidence policy", () => {
  it("applies hourly fields only to hourly or mixed salary documents", () => {
    const hourly = assess("clean_hourly");
    expect(hourly.decisions.find((decision) => decision.field === "hourly_rate")).toMatchObject({
      applicable: true,
      status: "reliable",
      threshold: criticalFieldThresholds.hourly_rate,
    });
    expect(hourly.decisions.find((decision) => decision.field === "regular_hours")?.status).toBe("reliable");

    const monthly = assess("clean_monthly");
    expect(monthly.decisions.find((decision) => decision.field === "hourly_rate")?.status).toBe("not_applicable");
  });

  it("marks pension and overtime fields critical when their rows are present", () => {
    const pension = assess("pension_components");
    for (const field of [
      "pension_base",
      "pension_employee_contribution",
      "pension_employer_contribution",
      "severance_contribution",
    ]) {
      expect(pension.decisions.find((decision) => decision.field === field)).toMatchObject({
        applicable: true,
        status: "reliable",
      });
    }

    const overtime = assess("overtime_bands");
    expect(overtime.decisions.find((decision) => decision.field === "overtime_125_hours")?.applicable).toBe(true);
    expect(overtime.decisions.find((decision) => decision.field === "overtime_150_hours")?.applicable).toBe(true);
  });

  it("requires confirmation for missing, conflicting, low-confidence, or Gate 0 suspicious critical fields", () => {
    const fixture = syntheticPayslipFixtures.find((candidate) => candidate.fixture_id === "clean_monthly");
    if (!fixture) throw new TypeError("Missing fixture");
    const withoutGross = extractionResultSchema.parse({
      ...fixture.extraction,
      fields: fixture.extraction.fields.filter((field) => field.field !== "gross_salary"),
    });
    const normalizedMissing = normalizePayslipExtraction(withoutGross);
    const missing = assessExtractionConfidence(
      normalizedMissing,
      validatePayslipGate0(normalizedMissing, { reference_year: 2026 }),
    );
    expect(missing.decisions.find((decision) => decision.field === "gross_salary")).toMatchObject({
      status: "needs_confirmation",
      reason_codes: expect.arrayContaining(["critical_field_missing", "below_field_threshold"]),
    });

    const contradictory = assess("contradictory_arithmetic");
    expect(contradictory.decisions.find((decision) => decision.field === "gross_salary")).toMatchObject({
      status: "needs_confirmation",
      reason_codes: expect.arrayContaining(["gate0_requires_review"]),
    });

    const gross = fixture.extraction.fields.find((field) => field.field === "gross_salary");
    if (!gross) throw new TypeError("Missing gross fixture candidate");
    const conflicting = extractionResultSchema.parse({
      ...fixture.extraction,
      fields: [
        ...fixture.extraction.fields,
        { ...gross, candidate_id: "99999999-9999-4999-8999-999999999999", raw_value: "85,000" },
      ],
    });
    const normalizedConflict = normalizePayslipExtraction(conflicting);
    const conflict = assessExtractionConfidence(
      normalizedConflict,
      validatePayslipGate0(normalizedConflict, { reference_year: 2026 }),
    );
    expect(conflict.decisions.find((decision) => decision.field === "gross_salary")?.reason_codes)
      .toContain("critical_field_conflict");
  });
});
