import { describe, expect, it } from "vitest";
import type { ExtractionResult, PayslipFieldKey } from "./contracts.ts";
import {
  buildPassEvaluation,
  resolvePayslipExtractionPasses,
  selectTargetedRecovery,
  type PayslipExtractionPass,
} from "./v2.ts";
import { syntheticPayslipFixtures } from "./fixtures/source-fixtures.ts";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

const fixture = syntheticPayslipFixtures[0];

function rawExtraction(input: {
  extractionId: string;
  fields: readonly Readonly<{ field: PayslipFieldKey; raw: string; confidence?: number; warning?: string }>[];
  tokenBase?: number;
}): ExtractionResult {
  return {
    ...fixture.extraction,
    extraction_id: input.extractionId,
    fields: input.fields.map((field, index) => ({
      candidate_id: uuid(40_000 + Number(input.extractionId.slice(-2)) * 100 + index),
      field: field.field,
      raw_value: field.raw,
      confidence: field.confidence ?? 0.95,
      source: { document_id: fixture.request.document.document_id, page: 1, text_fragment: `${field.field}: ${field.raw}` },
      extraction_method: "ai_vision" as const,
      warning_flags: field.warning ? [field.warning] : [],
    })),
    additional_components: [],
    earnings_components_complete: false,
    provider: { provider_id: "openai", extractor_version: "2.0", model_version: "gpt-5.6-sol" },
    operation: {
      duration_ms: 100,
      provider_response_id: `resp_${input.extractionId.slice(-4)}`,
      token_usage: { input_tokens: input.tokenBase ?? 100, output_tokens: 20, total_tokens: (input.tokenBase ?? 100) + 20 },
    },
  };
}

function pass(input: {
  id: string;
  kind: "first_pass" | "targeted_recovery";
  fields: Parameters<typeof rawExtraction>[0]["fields"];
  requested: readonly PayslipFieldKey[];
  pension?: boolean;
  totals?: boolean;
}): PayslipExtractionPass {
  return buildPassEvaluation({
    pass_id: input.id,
    kind: input.kind,
    requested_fields: input.requested,
    selected_regions: input.pension ? ["pension"] : input.totals ? ["totals"] : ["earnings"],
    prompt_version: input.kind === "first_pass" ? "v2-first" : "v2-recovery",
    model: "gpt-5.6-sol",
    raw_extraction: rawExtraction({ extractionId: input.id, fields: input.fields }),
    salary_type_assessment: { documented: null, inferred: null },
    pension_section_visible: input.pension ?? false,
    totals_section_visible: input.totals ?? false,
    critical_context: {
      required_fields: input.requested,
      pension_section_visible: input.pension,
      totals_section_visible: input.totals,
    },
    reference_year: 2026,
  });
}

describe("V2 targeted recovery and deterministic resolution", () => {
  it("selects only contextually critical missing or unsafe fields", () => {
    const first = pass({
      id: uuid(501),
      kind: "first_pass",
      requested: ["salary_period", "pension_base", "pension_employee_contribution"],
      pension: true,
      fields: [
        { field: "salary_period", raw: "08/2026" },
        { field: "pension_employee_contribution", raw: "510.00", confidence: 0.6 },
      ],
    });
    const plan = selectTargetedRecovery(first);
    expect(plan?.fields).toEqual(expect.arrayContaining(["pension_base", "pension_employee_contribution"]));
    expect(plan?.regions).toEqual(expect.arrayContaining(["pension"]));
    expect(plan?.regions.length).toBeLessThanOrEqual(4);
    expect(plan?.reason_codes).toContain("critical_field_missing");
  });

  it("promotes a recovery candidate when pass one is missing", () => {
    const first = pass({
      id: uuid(502),
      kind: "first_pass",
      requested: ["pension_base"],
      pension: true,
      fields: [],
    });
    const recovery = pass({
      id: uuid(503),
      kind: "targeted_recovery",
      requested: ["pension_base"],
      pension: true,
      fields: [{ field: "pension_base", raw: "8,500.00" }],
    });
    const result = resolvePayslipExtractionPasses({
      first_pass: first,
      recovery_passes: [recovery],
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { pension_section_visible: true },
      reference_year: 2026,
    });
    expect(result.resolutions.find((item) => item.field === "pension_base")?.status).toBe("promoted_recovery");
    expect(result.final_extraction.fields.find((item) => item.field === "pension_base")?.normalized_value)
      .toEqual({ currency: "ILS", minor_units: 850_000 });
  });

  it("keeps cross-pass disagreement conflicted and never selects a winner", () => {
    const first = pass({
      id: uuid(504),
      kind: "first_pass",
      requested: ["gross_salary"],
      totals: true,
      fields: [{ field: "gross_salary", raw: "8,500.00", confidence: 0.7 }],
    });
    const recovery = pass({
      id: uuid(505),
      kind: "targeted_recovery",
      requested: ["gross_salary"],
      totals: true,
      fields: [{ field: "gross_salary", raw: "6,500.00" }],
    });
    const result = resolvePayslipExtractionPasses({
      first_pass: first,
      recovery_passes: [recovery],
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["gross_salary"] },
      reference_year: 2026,
    });
    expect(result.resolutions.find((item) => item.field === "gross_salary")).toMatchObject({
      status: "conflicted",
      selected_candidate_id: null,
      reason_codes: ["cross_pass_disagreement"],
    });
    expect(result.final_validation.issues.some((issue) => issue.code === "conflicting_candidates")).toBe(true);
  });

  it("boosts only explicit agreement and makes a targeted field missing when recovery abstains", () => {
    const first = pass({
      id: uuid(506),
      kind: "first_pass",
      requested: ["gross_salary", "net_salary"],
      fields: [
        { field: "gross_salary", raw: "8,500.00", confidence: 0.7 },
        { field: "net_salary", raw: "7,200.00", confidence: 0.7 },
      ],
    });
    const recovery = pass({
      id: uuid(507),
      kind: "targeted_recovery",
      requested: ["gross_salary", "net_salary"],
      fields: [{ field: "gross_salary", raw: "8,500.00", confidence: 0.8 }],
    });
    const result = resolvePayslipExtractionPasses({
      first_pass: first,
      recovery_passes: [recovery],
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["gross_salary", "net_salary"] },
      reference_year: 2026,
    });
    expect(result.resolutions.find((item) => item.field === "gross_salary")?.status).toBe("cross_pass_agreement");
    expect(result.final_extraction.fields.find((item) => item.field === "gross_salary")?.confidence).toBeCloseTo(0.83);
    expect(result.resolutions.find((item) => item.field === "net_salary")?.status).toBe("missing");
    expect(result.final_extraction.fields.some((item) => item.field === "net_salary")).toBe(false);
    expect(result.final_validation.issues.some((issue) =>
      issue.code === "critical_field_missing" && issue.field_keys.includes("net_salary")
    )).toBe(true);
  });
});
