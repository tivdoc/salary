import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { normalizePayslipExtraction } from "@/engine/extraction/normalization";
import { syntheticPayslipFixtures } from "@/engine/extraction/fixtures/source-fixtures";
import type { PreparedPayslipDocument } from "../../preprocessing";
import { OpenAiPayslipV2PassExtractor } from "./v2-adapter";
import { mapOpenAiV2Output } from "./v2-mapper";
import { buildOpenAiV2ResponsesRequest } from "./v2-request";
import { openAiPayslipV2StructuredOutputSchema, type OpenAiPayslipV2StructuredOutput } from "./v2-schema";

const fixture = syntheticPayslipFixtures[0];

function value(raw: string, label: string, confidence: "high" | "medium" | "low" = "high") {
  return {
    raw_value: raw,
    confidence,
    evidence: { page: 1, region: "pension" as const, source_label: label },
    warnings: [],
  };
}

const output: OpenAiPayslipV2StructuredOutput = {
  detected_document_type: "payslip",
  document_quality: "medium",
  page_count: 1,
  rotation_degrees: 0,
  source_resolution_dpi: 96,
  salary_type: {
    documented_value: null,
    documented_raw_value: null,
    documented_confidence: "low",
    documented_evidence: { page: 1, region: "header", source_label: null },
    inferred_value: "hourly",
    inferred_confidence: "medium",
    inference_basis: ["hourly_rate", "regular_hours", "payroll_structure"],
    warnings: [],
  },
  generic_fields: [{ field: "salary_period", candidates: [value("08/2026", "תקופת שכר")] }],
  payroll_rows: [
    {
      source_label: "שעות רגילות",
      semantic_kind: "hourly_base",
      quantity_raw: "160",
      rate_raw: "50.00",
      percentage_raw: null,
      amount_raw: "8,000.00",
      confidence: "high",
      evidence: { page: 1, region: "earnings", source_label: "שעות רגילות" },
      warnings: [],
    },
    {
      source_label: "רכיב ותיק 431",
      semantic_kind: "unknown",
      quantity_raw: "2",
      rate_raw: "125.00",
      percentage_raw: "6%",
      amount_raw: "250.00",
      confidence: "medium",
      evidence: { page: 1, region: "earnings", source_label: "רכיב ותיק 431" },
      warnings: ["unknown_component"],
    },
  ],
  totals: {
    visible: true,
    gross_candidates: [value("8,500.00", "ברוטו"), value("8,050.00", "סך תשלומים", "medium")],
    deductions_candidates: [value("1,300.00", "סהכ ניכויים")],
    net_candidates: [value("7,200.00", "נטו")],
  },
  pension: {
    visible: true,
    base_candidates: [value("8,000.00", "שכר מבוטח")],
    employee: {
      rate_candidates: [value("6%", "עובד אחוז")],
      amount_candidates: [value("480.00", "עובד סכום")],
    },
    employer: {
      rate_candidates: [value("6.5%", "מעסיק אחוז")],
      amount_candidates: [value("520.00", "מעסיק סכום")],
    },
    severance: {
      rate_candidates: [value("8.33%", "פיצויים אחוז")],
      amount_candidates: [value("666.40", "פיצויים סכום")],
    },
  },
  earnings_components_complete: false,
  warnings: ["low_resolution"],
};

const prepared: PreparedPayslipDocument = {
  original: { bytes: new Uint8Array([1, 2]), mime_type: "image/png", sha256: "a".repeat(64) },
  processed_full_page: null,
  crops: [{
    region: "pension",
    image: { bytes: new Uint8Array([3, 4]), mime_type: "image/png", width: 100, height: 100, sha256: "b".repeat(64) },
  }],
  metadata: {
    preprocessing_version: "payslip-raster-preprocess-1",
    crop_plan_version: "payslip-semantic-bands-1",
    applied: true,
    source_width: 600,
    source_height: 800,
    upscale_factor: 3,
    deskew_degrees: 0,
    grayscale: true,
    contrast_gain: 1.08,
    sharpen_sigma: 1,
    reason: "low_resolution_raster",
  },
};

describe("OpenAI payslip V2 schema and mapping", () => {
  it("keeps inferred salary type outside documented candidate fields", () => {
    const mapped = mapOpenAiV2Output({
      request: fixture.request,
      output,
      model: "gpt-5.6-sol",
      extractorVersion: "2.0",
      durationMs: 100,
      providerResponseId: "resp_v2",
      tokenUsage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
      extractedAt: fixture.request.requested_at,
    });
    expect(mapped.extraction.fields.some((field) => field.field === "salary_type")).toBe(false);
    expect(mapped.salary_type_assessment).toMatchObject({
      documented: null,
      inferred: { value: "hourly", basis: ["hourly_rate", "regular_hours", "payroll_structure"] },
    });
    expect(mapped.critical_context.hourly_analysis_implied).toBe(true);
  });

  it("maps row columns, total ambiguity, and dedicated pension values without collapsing them", () => {
    const mapped = mapOpenAiV2Output({
      request: fixture.request,
      output,
      model: "gpt-5.6-sol",
      extractorVersion: "2.0",
      durationMs: 100,
      providerResponseId: "resp_v2",
      tokenUsage: null,
      extractedAt: fixture.request.requested_at,
    });
    const normalized = normalizePayslipExtraction(mapped.extraction);
    expect(normalized.fields.find((field) => field.field === "hourly_rate")?.normalized_value)
      .toEqual({ currency: "ILS", minor_units: 5_000 });
    expect(normalized.fields.find((field) => field.field === "regular_hours")?.normalized_value)
      .toEqual({ amount: "160", unit: "hours_per_month" });
    expect(normalized.fields.filter((field) => field.field === "gross_salary")).toHaveLength(2);
    expect(normalized.fields.find((field) => field.field === "pension_base")?.normalized_value)
      .toEqual({ currency: "ILS", minor_units: 800_000 });
    expect(normalized.fields.find((field) => field.field === "pension_employee_rate")?.normalized_value)
      .toEqual({ basis_points: 600 });
    expect(normalized.additional_components[1]).toMatchObject({
      semantic_kind: "unknown",
      normalized_label: null,
      quantity: "2",
      percentage: { basis_points: 600 },
      amount: { currency: "ILS", minor_units: 25_000 },
    });
  });

  it("normalizes an explicitly documented salary type and rejects arbitrary prose", () => {
    const documented = {
      ...output,
      salary_type: {
        ...output.salary_type,
        documented_value: "hourly" as const,
        documented_raw_value: "סוג שכר: שעתי",
        documented_confidence: "high" as const,
        inferred_value: null,
        inference_basis: [],
      },
    };
    const mapped = mapOpenAiV2Output({
      request: fixture.request,
      output: documented,
      model: "gpt-5.6-sol",
      extractorVersion: "2.0",
      durationMs: 1,
      providerResponseId: "resp_doc",
      tokenUsage: null,
      extractedAt: fixture.request.requested_at,
    });
    expect(normalizePayslipExtraction(mapped.extraction).fields.find((field) => field.field === "salary_type")?.normalized_value)
      .toBe("hourly");
    expect(openAiPayslipV2StructuredOutputSchema.safeParse({ ...output, legal_conclusion: "violation" }).success).toBe(false);
  });
});
describe("OpenAI payslip V2 requests and safe logging", () => {
  it("sends original context plus bounded crops and asks recovery only for selected fields", () => {
    const request = buildOpenAiV2ResponsesRequest({
      model: "gpt-5.6-sol",
      prepared,
      kind: "targeted_recovery",
      requested_fields: ["pension_base", "pension_employee_contribution"],
    });
    const serialized = JSON.stringify(request);
    expect(serialized).toContain("pension_base, pension_employee_contribution");
    expect(serialized).toContain("Do not use or assume any numeric value from a previous pass");
    expect(request.input[0].content.filter((item) => item.type === "input_image")).toHaveLength(2);
    expect(request.store).toBe(false);
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });

  it("logs only operational metadata for a V2 pass", async () => {
    const logs: unknown[] = [];
    let tick = 0;
    const extractor = new OpenAiPayslipV2PassExtractor(
      { apiKey: "unit-test-key", model: "gpt-5.6-sol", timeoutMs: 10_000 },
      {
        transport: {
          parse: vi.fn(async () => ({
            id: "resp_v2_safe",
            status: "completed",
            outputParsed: output,
            usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
          })),
        },
        clock: () => new Date(fixture.request.requested_at),
        durationClock: () => tick += 10,
        log: (entry) => logs.push(entry),
      },
    );
    await extractor.extractPreparedPass({
      request: fixture.request,
      prepared,
      kind: "targeted_recovery",
      requestedFields: ["pension_base"],
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      pass_kind: "targeted_recovery",
      requested_field_count: 1,
      region_count: 1,
      preprocessing_version: "payslip-raster-preprocess-1",
    });
    expect(JSON.stringify(logs)).not.toMatch(/raw_value|source_label|file_data|image_url|unit-test-key/);
  });
});
