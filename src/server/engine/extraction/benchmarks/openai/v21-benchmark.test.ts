import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ExtractionResult, PayslipFieldKey } from "@/engine/extraction/contracts";
import { syntheticPayslipFixtures } from "@/engine/extraction/fixtures/source-fixtures";
import { buildPassEvaluation, type PayslipExtractionPass } from "@/engine/extraction/v2";
import {
  recoveryDecisionForV21,
  recoveryDecisionSchema,
  resolvePayslipExtractionPassesV21,
} from "@/engine/extraction/v21";
import type { BenchmarkGroundTruth } from "./benchmark";
import { buildOpenAiV21BenchmarkReport } from "./v21-benchmark";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

const fixture = syntheticPayslipFixtures[0];
const money = (minor_units: number) => ({ currency: "ILS" as const, minor_units });

function raw(input: {
  id: string;
  fields: readonly Readonly<{ field: PayslipFieldKey; raw: string; confidence?: number }>[];
}): ExtractionResult {
  return {
    ...fixture.extraction,
    extraction_id: input.id,
    fields: input.fields.map((field, index) => ({
      candidate_id: uuid(80_000 + Number(input.id.slice(-2)) * 100 + index),
      field: field.field,
      raw_value: field.raw,
      confidence: field.confidence ?? 0.95,
      source: {
        document_id: fixture.request.document.document_id,
        page: 1,
        text_fragment: `${field.field}: ${field.raw}`,
      },
      extraction_method: "ai_vision" as const,
      warning_flags: [],
    })),
    additional_components: [],
    earnings_components_complete: false,
    provider: { provider_id: "openai", extractor_version: "2.1", model_version: "gpt-5.6-sol" },
    operation: {
      duration_ms: 100,
      provider_response_id: `resp_${input.id.slice(-4)}`,
      token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  };
}

function pass(input: {
  id: string;
  kind: "first_pass" | "targeted_recovery";
  fields: Parameters<typeof raw>[0]["fields"];
  requested: readonly PayslipFieldKey[];
}): PayslipExtractionPass {
  return buildPassEvaluation({
    pass_id: input.id,
    kind: input.kind,
    requested_fields: input.requested,
    selected_regions: ["totals"],
    prompt_version: input.kind === "first_pass" ? "v2-first" : "v2.1-recovery",
    model: "gpt-5.6-sol",
    raw_extraction: raw({ id: input.id, fields: input.fields }),
    salary_type_assessment: { documented: null, inferred: null },
    pension_section_visible: false,
    totals_section_visible: false,
    critical_context: { required_fields: input.requested },
    reference_year: 2026,
  });
}

function recoveryDecision(fields: readonly PayslipFieldKey[]) {
  return recoveryDecisionSchema.parse({
    requested: true,
    skipped: false,
    fields_requested: fields,
    regions: ["totals"],
    reason_codes: ["unit_test_recovery"],
    expected_information_gain: "missing_critical_field",
  });
}

function groundTruth(expectedAbsent: readonly PayslipFieldKey[] = []): BenchmarkGroundTruth {
  return {
    fixture_id: fixture.fixture_id,
    expected_fields: { gross_salary: money(850_000) },
    expected_absent_fields: expectedAbsent,
    ambiguous_fields: [],
    critical_fields: ["gross_salary"],
    expected_validation_issue_codes: [],
    classification_complete: false,
  };
}

function report(input: {
  firstFields: Parameters<typeof raw>[0]["fields"];
  recoveryFields?: Parameters<typeof raw>[0]["fields"];
  expectedAbsent?: readonly PayslipFieldKey[];
}) {
  const first = pass({ id: uuid(801), kind: "first_pass", fields: input.firstFields, requested: ["gross_salary"] });
  const recovery = input.recoveryFields
    ? pass({ id: uuid(802), kind: "targeted_recovery", fields: input.recoveryFields, requested: ["gross_salary"] })
    : null;
  const result = resolvePayslipExtractionPassesV21({
    first_pass: first,
    recovery_passes: recovery ? [recovery] : [],
    recovery_decision: recovery ? recoveryDecision(["gross_salary"]) : recoveryDecisionForV21(null),
    final_extraction_id: fixture.request.extraction_id,
    critical_context: { required_fields: ["gross_salary"] },
    reference_year: 2026,
  });
  return buildOpenAiV21BenchmarkReport({
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
    groundTruth: [groundTruth(input.expectedAbsent)],
    model: "gpt-5.6-sol",
  });
}

describe("V2.1 benchmark safety metrics", () => {
  it("counts a correct first-pass value that becomes conflicted as a recovery regression", () => {
    const result = report({
      firstFields: [
        { field: "gross_salary", raw: "8,500.00" },
        { field: "travel_amount", raw: "10.00" },
        { field: "hourly_rate", raw: "50.00" },
      ],
      recoveryFields: [{ field: "gross_salary", raw: "6,500.00" }],
      expectedAbsent: ["travel_amount"],
    });
    expect(result.safety_metrics.recovery_regressions).toMatchObject({
      count: 1,
      silent_count: 0,
      details: [{ field: "gross_salary", final_outcome: "conflicted" }],
    });
    expect(result.safety_metrics.correctly_introduced_conflicts.count).toBe(1);
    expect(result.safety_metrics.wrong_accepted_critical_values.count).toBe(0);
    expect(result.first_pass.hallucinated_fields).toBe(1);
    expect(result.field_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "travel_amount", ground_truth_classification: "expected_absent", counted_as_hallucination: true }),
      expect.objectContaining({ field: "hourly_rate", ground_truth_classification: "unscored_not_annotated", counted_as_hallucination: false }),
    ]));
  });

  it("does not attribute a pre-existing first-pass conflict to recovery", () => {
    const result = report({
      firstFields: [
        { field: "gross_salary", raw: "8,500.00" },
        { field: "gross_salary", raw: "6,500.00" },
      ],
    });
    expect(result.safety_metrics.recovery_regressions).toMatchObject({ count: 0, silent_count: 0, details: [] });
  });

  it("counts a wrong critical value only when resolution and Gate 0 accept it", () => {
    const result = report({ firstFields: [{ field: "gross_salary", raw: "6,500.00" }] });
    expect(result.safety_metrics.wrong_accepted_critical_values).toMatchObject({
      count: 1,
      details: [{ field: "gross_salary", resolution_state: "confirmed", gate0_status: "valid" }],
    });
  });

  it("counts suspicious agreement as preserved without treating it as independent proof", () => {
    const result = report({
      firstFields: [{ field: "gross_salary", raw: "8,500.00", confidence: 0.7 }],
      recoveryFields: [{ field: "gross_salary", raw: "8,500.00" }],
    });
    expect(result.safety_metrics.suspicious_preserved.count).toBe(1);
    expect(result.safety_metrics.recovery_regressions.count).toBe(0);
  });

  it("measures recovery yield only for a correctly recovered missing critical field", () => {
    const result = report({
      firstFields: [],
      recoveryFields: [{ field: "gross_salary", raw: "8,500.00" }],
    });
    expect(result.safety_metrics.recovery_yield).toEqual({
      recovered_missing_critical_fields: 1,
      additional_api_calls: 1,
      recovered_fields_per_call: 1,
    });
  });
});
