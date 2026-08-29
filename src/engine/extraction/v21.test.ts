import { describe, expect, it } from "vitest";
import type { ExtractionResult, PayslipFieldKey } from "./contracts";
import { syntheticPayslipFixtures } from "./fixtures/source-fixtures";
import { buildPassEvaluation, type ExtractionRegion, type PayslipExtractionPass } from "./v2";
import {
  factResolutionStateSchema,
  recoveryDecisionForV21,
  recoveryDecisionSchema,
  resolvePayslipExtractionPassesV21,
  selectTargetedRecoveryV21,
} from "./v21";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

const fixture = syntheticPayslipFixtures[0];

function rawExtraction(input: {
  extractionId: string;
  fields: readonly Readonly<{ field: PayslipFieldKey; raw: string; confidence?: number; warning?: string }>[];
}): ExtractionResult {
  return {
    ...fixture.extraction,
    extraction_id: input.extractionId,
    fields: input.fields.map((field, index) => ({
      candidate_id: uuid(60_000 + Number(input.extractionId.slice(-2)) * 100 + index),
      field: field.field,
      raw_value: field.raw,
      confidence: field.confidence ?? 0.95,
      source: {
        document_id: fixture.request.document.document_id,
        page: 1,
        text_fragment: `${field.field}: ${field.raw}`,
      },
      extraction_method: "ai_vision" as const,
      warning_flags: field.warning ? [field.warning] : [],
    })),
    additional_components: [],
    earnings_components_complete: false,
    provider: { provider_id: "openai", extractor_version: "2.1", model_version: "gpt-5.6-sol" },
    operation: {
      duration_ms: 100,
      provider_response_id: `resp_${input.extractionId.slice(-4)}`,
      token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  };
}

function pass(input: {
  id: string;
  kind: "first_pass" | "targeted_recovery";
  fields: Parameters<typeof rawExtraction>[0]["fields"];
  requested?: readonly PayslipFieldKey[];
  region?: ExtractionRegion;
  pension?: boolean;
  totals?: boolean;
}): PayslipExtractionPass {
  const requested = input.requested ?? input.fields.map((field) => field.field);
  const region = input.region ?? (input.pension ? "pension" : input.totals ? "totals" : "earnings");
  return buildPassEvaluation({
    pass_id: input.id,
    kind: input.kind,
    requested_fields: requested,
    selected_regions: [region],
    prompt_version: input.kind === "first_pass" ? "v2-first" : "v2.1-recovery",
    model: "gpt-5.6-sol",
    raw_extraction: rawExtraction({ extractionId: input.id, fields: input.fields }),
    salary_type_assessment: { documented: null, inferred: null },
    pension_section_visible: input.pension ?? false,
    totals_section_visible: input.totals ?? false,
    critical_context: {
      required_fields: requested,
      pension_section_visible: input.pension,
      totals_section_visible: input.totals,
    },
    reference_year: 2026,
  });
}

function decision(fields: readonly PayslipFieldKey[], region: ExtractionRegion) {
  return recoveryDecisionSchema.parse({
    requested: true,
    skipped: false,
    fields_requested: fields,
    regions: [region],
    reason_codes: ["unit_test_recovery"],
    expected_information_gain: "missing_critical_field",
  });
}

describe("V2.1 selective recovery", () => {
  it("skips recovery when no material critical field exists", () => {
    const first = pass({
      id: uuid(601),
      kind: "first_pass",
      requested: [],
      fields: [
        { field: "salary_period", raw: "08/2026" },
        { field: "gross_salary", raw: "8,500.00" },
        { field: "net_salary", raw: "7,200.00" },
      ],
    });
    expect(selectTargetedRecoveryV21(first)).toBeNull();
    expect(recoveryDecisionForV21(null)).toEqual({
      requested: false,
      skipped: true,
      fields_requested: [],
      regions: [],
      reason_codes: ["recovery_skipped_no_material_gain"],
      expected_information_gain: "none",
    });
  });

  it("requests only a missing critical field from one relevant section", () => {
    const first = pass({
      id: uuid(602),
      kind: "first_pass",
      requested: ["pension_base", "pension_employee_contribution"],
      pension: true,
      fields: [{ field: "pension_employee_contribution", raw: "510.00" }],
    });
    expect(selectTargetedRecoveryV21(first)).toEqual({
      fields: ["pension_base"],
      regions: ["pension"],
      reason_codes: ["critical_field_missing"],
      expected_information_gain: "missing_critical_field",
    });
  });

  it("does not spend recovery on a stable moderate-confidence critical value", () => {
    const first = pass({
      id: uuid(612),
      kind: "first_pass",
      requested: [],
      region: "totals",
      fields: [{ field: "gross_salary", raw: "8,500.00", confidence: 0.75 }],
    });
    expect(selectTargetedRecoveryV21(first)).toBeNull();
  });

  it("targets an unreadable critical value without adding unrelated fields", () => {
    const first = pass({
      id: uuid(613),
      kind: "first_pass",
      requested: [],
      region: "totals",
      fields: [
        { field: "gross_salary", raw: "8,500.00", confidence: 0.8, warning: "ocr_ambiguous" },
        { field: "net_salary", raw: "7,200.00" },
      ],
    });
    expect(selectTargetedRecoveryV21(first)).toMatchObject({
      fields: ["gross_salary"],
      regions: ["totals"],
      expected_information_gain: "unreadable_critical_field",
    });
  });
});

describe("V2.1 non-degrading resolution", () => {
  it("keeps the original suspicious value and confidence when recovery agrees", () => {
    const first = pass({
      id: uuid(603),
      kind: "first_pass",
      requested: ["gross_salary"],
      totals: true,
      fields: [{ field: "gross_salary", raw: "370.68", confidence: 0.7 }],
    });
    const recovery = pass({
      id: uuid(604),
      kind: "targeted_recovery",
      requested: ["gross_salary"],
      region: "totals",
      fields: [{ field: "gross_salary", raw: "370.68", confidence: 0.99 }],
    });
    const result = resolvePayslipExtractionPassesV21({
      first_pass: first,
      recovery_passes: [recovery],
      recovery_decision: decision(["gross_salary"], "totals"),
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["gross_salary"] },
      reference_year: 2026,
    });
    const final = result.final_extraction.fields.find((field) => field.field === "gross_salary");
    expect(final?.raw_value).toBe("370.68");
    expect(final?.confidence).toBe(0.7);
    expect(final?.warning_flags).not.toContain("cross_pass_agreement");
    expect(result.resolutions.find((item) => item.field === "gross_salary")).toMatchObject({
      status: "suspicious",
      selected_candidate_id: first.normalized_extraction.fields[0].candidate_id,
      reason_codes: expect.arrayContaining(["correlated_recovery_agreement_preserved"]),
    });
    expect(result.final_validation.field_assessments.find((item) => item.candidate_id === final?.candidate_id)?.status)
      .toBe("suspicious");
  });

  it("turns disagreement into a conflict without overwriting the first-pass value", () => {
    const first = pass({
      id: uuid(605),
      kind: "first_pass",
      requested: ["gross_salary"],
      totals: true,
      fields: [{ field: "gross_salary", raw: "8,500.00" }],
    });
    const recovery = pass({
      id: uuid(606),
      kind: "targeted_recovery",
      requested: ["gross_salary"],
      region: "totals",
      fields: [{ field: "gross_salary", raw: "6,500.00" }],
    });
    const result = resolvePayslipExtractionPassesV21({
      first_pass: first,
      recovery_passes: [recovery],
      recovery_decision: decision(["gross_salary"], "totals"),
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["gross_salary"] },
      reference_year: 2026,
    });
    expect(result.final_extraction.fields.filter((field) => field.field === "gross_salary")).toHaveLength(1);
    expect(result.final_extraction.fields.find((field) => field.field === "gross_salary")?.raw_value).toBe("8,500.00");
    expect(result.resolutions.find((item) => item.field === "gross_salary")).toMatchObject({
      status: "conflicted",
      selected_candidate_id: null,
      reason_codes: expect.arrayContaining(["cross_pass_disagreement"]),
    });
    expect(result.final_validation.issues.some((issue) => issue.code === "recovery_conflict")).toBe(true);
  });

  it("recovers a missing field only when the targeted candidate passes deterministic validation", () => {
    const first = pass({
      id: uuid(607),
      kind: "first_pass",
      requested: ["pension_base"],
      pension: true,
      fields: [],
    });
    const recovery = pass({
      id: uuid(608),
      kind: "targeted_recovery",
      requested: ["pension_base"],
      region: "pension",
      fields: [{ field: "pension_base", raw: "8,500.00" }],
    });
    const result = resolvePayslipExtractionPassesV21({
      first_pass: first,
      recovery_passes: [recovery],
      recovery_decision: decision(["pension_base"], "pension"),
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["pension_base"] },
      reference_year: 2026,
    });
    expect(result.resolutions.find((item) => item.field === "pension_base")?.status).toBe("recovered");
    expect(result.final_extraction.fields.find((item) => item.field === "pension_base")?.normalized_value)
      .toEqual({ currency: "ILS", minor_units: 850_000 });
    expect(result.resolved_historical_issue_codes).toContain("critical_field_missing");
  });

  it("preserves pension arithmetic warnings despite repeated model agreement", () => {
    const fields = [
      { field: "pension_base" as const, raw: "10,000.00" },
      { field: "pension_employer_rate" as const, raw: "6%" },
      { field: "pension_employer_contribution" as const, raw: "1,000.00" },
    ];
    const first = pass({
      id: uuid(609),
      kind: "first_pass",
      requested: fields.map((field) => field.field),
      pension: true,
      fields,
    });
    const recovery = pass({
      id: uuid(610),
      kind: "targeted_recovery",
      requested: ["pension_employer_contribution"],
      region: "pension",
      fields: [{ field: "pension_employer_contribution", raw: "1,000.00" }],
    });
    const result = resolvePayslipExtractionPassesV21({
      first_pass: first,
      recovery_passes: [recovery],
      recovery_decision: decision(["pension_employer_contribution"], "pension"),
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { pension_section_visible: true },
      reference_year: 2026,
    });
    expect(first.validation.issues.some((issue) => issue.code === "pension_contribution_mismatch")).toBe(true);
    expect(result.final_validation.issues.some((issue) => issue.code === "pension_contribution_mismatch")).toBe(true);
    expect(result.resolutions.find((item) => item.field === "pension_employer_contribution")?.status)
      .toBe("suspicious");
  });

  it("keeps an existing first-pass value when recovery abstains", () => {
    const first = pass({
      id: uuid(611),
      kind: "first_pass",
      requested: ["net_salary"],
      totals: true,
      fields: [{ field: "net_salary", raw: "7,200.00", confidence: 0.7 }],
    });
    const recovery = pass({
      id: uuid(612),
      kind: "targeted_recovery",
      requested: ["net_salary"],
      region: "totals",
      fields: [],
    });
    const result = resolvePayslipExtractionPassesV21({
      first_pass: first,
      recovery_passes: [recovery],
      recovery_decision: decision(["net_salary"], "totals"),
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["net_salary"] },
      reference_year: 2026,
    });
    expect(result.final_extraction.fields.find((field) => field.field === "net_salary")?.raw_value).toBe("7,200.00");
    expect(result.resolutions.find((item) => item.field === "net_salary")?.reason_codes)
      .toContain("recovery_missing_first_pass_preserved");
  });

  it("exposes every required fact resolution state", () => {
    expect(factResolutionStateSchema.options).toEqual(expect.arrayContaining([
      "confirmed",
      "candidate",
      "missing",
      "suspicious",
      "conflicted",
      "requires_confirmation",
      "recovered",
    ]));
  });
});
