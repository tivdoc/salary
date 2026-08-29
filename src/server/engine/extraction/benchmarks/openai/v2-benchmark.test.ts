import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { syntheticPayslipFixtures } from "@/engine/extraction/fixtures/source-fixtures";
import { syntheticPayslipGroundTruth } from "@/engine/extraction/fixtures/ground-truth";
import { buildPassEvaluation, resolvePayslipExtractionPasses } from "@/engine/extraction/v2";
import { buildOpenAiV2BenchmarkReport, groundTruthForDocumentedSalaryType } from "./v2-benchmark";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

describe("V2 benchmark aggregation", () => {
  it("keeps frozen V1 salary-type scoring separate and aggregates calls, tokens, latency, and cost", () => {
    const fixture = syntheticPayslipFixtures[0];
    const truth = {
      ...syntheticPayslipGroundTruth[0],
      critical_fields: ["salary_period", "salary_type", "gross_salary"] as const,
      classification_complete: true,
    };
    const projected = groundTruthForDocumentedSalaryType([truth]);
    expect(projected[0].expected_fields.salary_type).toBeUndefined();
    expect(truth.expected_fields.salary_type).toBe("monthly");

    const passId = uuid(78_000);
    const raw = {
      ...fixture.extraction,
      extraction_id: passId,
      provider: { provider_id: "openai", extractor_version: "2.0", model_version: "gpt-5.6-sol" },
      operation: {
        duration_ms: 250,
        provider_response_id: "resp_v2_benchmark",
        token_usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
      },
    };
    const firstPass = buildPassEvaluation({
      pass_id: passId,
      kind: "first_pass",
      requested_fields: [],
      selected_regions: ["header", "earnings", "totals", "pension"],
      prompt_version: "payslip-extraction-openai-v2-first",
      model: "gpt-5.6-sol",
      raw_extraction: raw,
      salary_type_assessment: {
        documented: {
          value: "monthly",
          raw_value: "monthly",
          confidence: 0.98,
          candidate_id: fixture.extraction.fields.find((field) => field.field === "salary_type")!.candidate_id,
        },
        inferred: null,
      },
      pension_section_visible: false,
      totals_section_visible: false,
      critical_context: { required_fields: ["salary_period", "gross_salary", "net_salary"] },
      reference_year: 2026,
    });
    const result = resolvePayslipExtractionPasses({
      first_pass: firstPass,
      recovery_passes: [],
      final_extraction_id: fixture.request.extraction_id,
      critical_context: { required_fields: ["salary_period", "gross_salary", "net_salary"] },
      reference_year: 2026,
    });
    const report = buildOpenAiV2BenchmarkReport({
      runs: [{
        artifact: {
          fixture_id: fixture.fixture_id,
          quality: "clean",
          format: "pdf",
          file_path: "synthetic-only.pdf",
          sha256: "0".repeat(64),
          request: fixture.request,
        },
        run: { result, snapshot: null, preprocessing: [] },
      }],
      groundTruth: [truth],
      model: "gpt-5.6-sol",
    });

    expect(report.first_pass.critical_field_accuracy).toEqual({ expected: 2, correct: 2, accuracy: 1 });
    expect(report.final_after_targeted_recovery.provider_calls).toBe(1);
    expect(report.additional_api_calls).toBe(0);
    expect(report.total_latency_ms).toEqual({ first_pass: 250, recovery: 0, final: 250 });
    expect(report.total_token_usage).toEqual({
      complete: true,
      first_pass: 1_200,
      recovery: 0,
      final: 1_200,
    });
    expect(report.total_cost).toEqual({
      first_pass_usd: 0.008,
      recovery_usd: 0,
      final_usd: 0.008,
    });
    expect(report.field_comparison.find((field) => field.field === "explicit_salary_type")).toMatchObject({
      v1: null,
      v2_first_pass: null,
      v2_final: null,
    });
  });
});
