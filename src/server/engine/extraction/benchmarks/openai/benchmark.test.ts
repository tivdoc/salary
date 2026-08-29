import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { benchmarkPayslipExtractor } from "@/engine/extraction/benchmark";
import { FixtureDocumentExtractor, SyntheticDocumentSource } from "@/engine/extraction/fixture-extractor";
import { syntheticPayslipGroundTruth } from "@/engine/extraction/fixtures/ground-truth";
import { syntheticPayslipFixtures } from "@/engine/extraction/fixtures/source-fixtures";
import { runPayslipExtractionPipeline } from "@/engine/extraction/pipeline";
import { assessExtractionConfidence } from "@/engine/extraction/confidence-policy";
import { minimizePayslipForSemanticProcessing } from "@/engine/extraction/minimize";
import { normalizePayslipExtraction } from "@/engine/extraction/normalization";
import { resolvedPayslipFactPaths } from "@/engine/extraction/resolver";
import { validatePayslipGate0 } from "@/engine/extraction/validation";
import { scoreOpenAiBenchmarkRuns, sensitiveValuesPresent } from "./benchmark";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

describe("OpenAI rendered benchmark aggregation", () => {
  it("reports critical fields, quality, Gate 0, latency, tokens, and authoritative estimated cost without PII", async () => {
    const fixture = syntheticPayslipFixtures[0];
    const result = await runPayslipExtractionPipeline({
      request: fixture.request,
      source: new SyntheticDocumentSource(),
      extractor: new FixtureDocumentExtractor([fixture]),
      snapshot_context: {
        snapshot_id: uuid(70_000),
        case_id: fixture.request.case_id,
        analysis_run_id: fixture.request.analysis_run_id,
        schema_version: "1.0",
        created_at: fixture.request.requested_at,
        fact_ids: Object.fromEntries(resolvedPayslipFactPaths.map((field, index) => [field, uuid(71_000 + index)])),
      },
      reference_year: 2026,
    });
    const truth = syntheticPayslipGroundTruth[0];
    const report = scoreOpenAiBenchmarkRuns({
      runs: [{
        artifact: {
          fixture_id: truth.fixture_id,
          quality: "clean",
          format: "pdf",
          file_path: "synthetic-only.pdf",
          sha256: "0".repeat(64),
          request: fixture.request,
        },
        result: {
          ...result,
          raw_extraction: {
            ...result.raw_extraction,
            provider: { provider_id: "openai", extractor_version: "1.0", model_version: "gpt-5.6-sol" },
            operation: {
              duration_ms: 250,
              provider_response_id: "resp_synthetic",
              token_usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
            },
          },
        },
      }],
      groundTruth: [{ ...truth, critical_fields: ["salary_period", "salary_type", "gross_salary"] }],
      model: "gpt-5.6-sol",
      extractorVersion: "1.0",
    });

    expect(report.exact_field_accuracy).toBe(1);
    expect(report.critical_field_accuracy).toEqual({ expected: 3, correct: 3, accuracy: 1 });
    expect(report.by_quality).toEqual([{ quality: "clean", fixtures: 1, expected: 9, correct: 9, accuracy: 1 }]);
    expect(report.average_duration_ms).toBe(250);
    expect(report.token_usage).toEqual({ complete: true, input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 });
    expect(report.estimated_cost_usd).toBeCloseTo(0.008);
    expect(report.report_version).toBe("1.1");
    expect(report.per_fixture[0]).toMatchObject({
      provider: {
        provider_id: "openai",
        model_version: "gpt-5.6-sol",
        extractor_version: "1.0",
        prompt_version: "payslip-extraction-openai-v1",
      },
      mismatches: [],
      gate0_issue_codes: [],
      unexpected_gate0_issue_codes: [],
      extraction_warnings: [],
      estimated_cost_usd: 0.008,
    });
    expect(JSON.stringify(report)).not.toContain("נועה לדוגמה");
    expect(JSON.stringify(report)).not.toContain("8,500.00");
  });

  it("persists field-level abstentions and permits legitimate employee/employer schema identifiers", async () => {
    const fixture = syntheticPayslipFixtures[0];
    const result = await runPayslipExtractionPipeline({
      request: fixture.request,
      source: new SyntheticDocumentSource(),
      extractor: new FixtureDocumentExtractor([fixture]),
      snapshot_context: {
        snapshot_id: uuid(72_000),
        case_id: fixture.request.case_id,
        analysis_run_id: fixture.request.analysis_run_id,
        schema_version: "1.0",
        created_at: fixture.request.requested_at,
        fact_ids: Object.fromEntries(resolvedPayslipFactPaths.map((field, index) => [field, uuid(73_000 + index)])),
      },
      reference_year: 2026,
    });
    const truth = syntheticPayslipGroundTruth[0];
    const report = scoreOpenAiBenchmarkRuns({
      runs: [{
        artifact: {
          fixture_id: truth.fixture_id,
          quality: "clean",
          format: "pdf",
          file_path: "synthetic-only.pdf",
          sha256: "0".repeat(64),
          request: fixture.request,
        },
        result: {
          ...result,
          normalized_extraction: {
            ...result.normalized_extraction,
            fields: result.normalized_extraction.fields.filter((field) => field.field !== "gross_salary"),
          },
          raw_extraction: {
            ...result.raw_extraction,
            warnings: ["low_resolution"],
            provider: { provider_id: "openai", extractor_version: "1.0", model_version: "gpt-5.6-sol" },
          },
        },
      }],
      groundTruth: [{ ...truth, critical_fields: ["gross_salary"] }],
      model: "gpt-5.6-sol",
      extractorVersion: "1.0",
    });

    expect(report.per_fixture[0]?.mismatches).toEqual([{
      field: "gross_salary",
      kind: "missing",
      expected_value: { currency: "ILS", minor_units: 850_000 },
      extracted_value: null,
      critical: true,
      confidence: null,
      warning_flags: [],
      gate0_result: { status: null, issue_codes: [] },
    }]);
    expect(report.per_fixture[0]?.extraction_warnings).toEqual(["low_resolution"]);
    expect(report.field_metrics.find((metric) => metric.field === "gross_salary")).toMatchObject({ missing: 1, wrong: 0 });
    expect(sensitiveValuesPresent(JSON.stringify({
      pension_employee_contribution: 1,
      pension_employer_contribution: 2,
    }), ["Example Person", "123456789"])).toEqual([]);
    expect(sensitiveValuesPresent(JSON.stringify({ value: "Example Person" }), ["Example Person"])).toEqual(["Example Person"]);
  });

  it("retains the V0 benchmark behavior after operational metadata was added", async () => {
    const report = await benchmarkPayslipExtractor({
      extractor: new FixtureDocumentExtractor(syntheticPayslipFixtures),
      source: new SyntheticDocumentSource(),
      fixtures: syntheticPayslipFixtures,
      ground_truth: syntheticPayslipGroundTruth,
      reference_year: 2026,
    });
    expect(report.fixtures_total).toBe(10);
    expect(report.exact_matches).toBe(68);
  });

  it("stores full hallucinated-field evidence and Gate 0 status", async () => {
    const fixture = syntheticPayslipFixtures[0];
    const base = await runPayslipExtractionPipeline({
      request: fixture.request,
      source: new SyntheticDocumentSource(),
      extractor: new FixtureDocumentExtractor([fixture]),
      snapshot_context: {
        snapshot_id: uuid(74_000),
        case_id: fixture.request.case_id,
        analysis_run_id: fixture.request.analysis_run_id,
        schema_version: "1.0",
        created_at: fixture.request.requested_at,
        fact_ids: Object.fromEntries(resolvedPayslipFactPaths.map((field, index) => [field, uuid(75_000 + index)])),
      },
      reference_year: 2026,
    });
    const gross = base.raw_extraction.fields.find((field) => field.field === "gross_salary");
    if (!gross) throw new TypeError("Synthetic gross candidate is missing");
    const raw = {
      ...base.raw_extraction,
      fields: [
        ...base.raw_extraction.fields,
        {
          ...gross,
          candidate_id: uuid(76_000),
          field: "hourly_rate" as const,
          raw_value: "85.00",
          confidence: 0.94,
          warning_flags: ["unexpected_field"],
        },
      ],
    };
    const normalized = normalizePayslipExtraction(raw);
    const validation = validatePayslipGate0(normalized, { reference_year: 2026 });
    const report = scoreOpenAiBenchmarkRuns({
      runs: [{
        artifact: {
          fixture_id: fixture.fixture_id,
          quality: "clean",
          format: "pdf",
          file_path: "synthetic-only.pdf",
          sha256: "0".repeat(64),
          request: fixture.request,
        },
        result: {
          raw_extraction: raw,
          normalized_extraction: normalized,
          validation,
          confidence_assessment: assessExtractionConfidence(normalized, validation),
          minimized_representation: minimizePayslipForSemanticProcessing(normalized),
          snapshot: base.snapshot,
        },
      }],
      groundTruth: [{
        ...syntheticPayslipGroundTruth[0],
        expected_absent_fields: ["hourly_rate"],
        critical_fields: ["gross_salary"],
        classification_complete: true,
      }],
      model: "gpt-5.6-sol",
      extractorVersion: "2.0",
    });

    expect(report.per_fixture[0].hallucinated_field_details).toEqual([{
      field: "hourly_rate",
      raw_extracted_value: "85.00",
      normalized_value: { currency: "ILS", minor_units: 8_500 },
      confidence: 0.94,
      warning_flags: ["unexpected_field"],
      gate0_result: { status: "valid", issue_codes: [] },
    }]);
  });
});
