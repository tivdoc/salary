import { describe, expect, it } from "vitest";
import { extractionResultSchema, type RawCandidateField } from "./contracts.ts";
import { normalizePayslipExtraction } from "./normalization.ts";
import type { NormalizedPayslipExtraction } from "./payslip.ts";
import { validatePayslipGate0 } from "./validation.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const documentId = uuid(1);
const mappings = [
  ["base_monthly_salary", "base_salary"],
  ["travel_amount", "travel"],
  ["convalescence_amount", "convalescence"],
] as const;

// Independently constructed synthetic observations of one 3,300 ILS earnings
// row. V2 emits both an amount field and a component, with different fragments.
function fixture(field: typeof mappings[number][0] = "base_monthly_salary", semantic: typeof mappings[number][1] = "base_salary") {
  const candidate = (id: number, name: RawCandidateField["field"], value: string) => ({
    candidate_id: uuid(id), field: name, raw_value: value, confidence: 0.94,
    source: { document_id: documentId, page: 1, text_fragment: `Synthetic regular base salary: ${value}` },
    extraction_method: "ai_vision" as const, warning_flags: [],
  });
  return normalizePayslipExtraction(extractionResultSchema.parse({
    extraction_id: uuid(2), document_id: documentId, status: "completed", detected_document_type: "payslip",
    document_quality_confidence: 0.96,
    quality_metrics: { page_count: 2, text_coverage: null, rotation_degrees: 0, source_resolution_dpi: null },
    fields: [candidate(3, field, "3300.00"), candidate(4, "gross_salary", "3300.00")],
    additional_components: [{
      component_id: uuid(5), source_label: "Regular base salary", normalized_label: semantic, semantic_kind: semantic,
      quantity_raw: null, rate_raw: null, percentage_raw: null, amount_raw: "3300.00", confidence: 0.94,
      source: { document_id: documentId, page: 1, text_fragment: "Regular base salary" },
      extraction_method: "ai_vision", warning_flags: [],
    }],
    sensitive_metadata: [], earnings_components_complete: true, warnings: [],
    provider: { provider_id: "synthetic_fixture", extractor_version: "1.0", model_version: null },
    operation: { duration_ms: 0, provider_response_id: null, token_usage: null },
    extracted_at: "2026-09-09T00:00:00Z", error_code: null,
  }));
}

function codes(extraction: NormalizedPayslipExtraction) {
  return validatePayslipGate0(extraction, { reference_year: 2026 }).issues.map(issue => issue.code);
}

function gross(extraction: NormalizedPayslipExtraction, minorUnits: number) {
  const field = extraction.fields.find(candidate => candidate.field === "gross_salary")!;
  field.normalized_value = { currency: "ILS", minor_units: minorUnits };
}

describe("complete earnings reconcile field projections of the same synthetic row once", () => {
  it.each(mappings)("does not double-count %s and its %s row", (field, semantic) => {
    const extraction = fixture(field, semantic), before = structuredClone(extraction);
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
    expect(validatePayslipGate0(extraction, { reference_year: 2026 }).status).toBe("valid");
    expect(extraction).toEqual(before);
    expect(extraction.fields[0].confidence).toBe(0.94);
  });

  it("still rejects a real gross difference after eliminating only the represented row", () => {
    const extraction = fixture();
    gross(extraction, 340_000);
    expect(codes(extraction)).toContain("gross_component_mismatch");
  });

  it.each(["bonus", "other", "unknown"] as const)("counts a genuine %s row even with the same amount and locator", semantic => {
    const extraction = fixture();
    const row = extraction.additional_components[0];
    extraction.additional_components.push({ ...structuredClone(row), component_id: uuid(6), semantic_kind: semantic, normalized_label: semantic });
    expect(codes(extraction)).toContain("gross_component_mismatch");
    gross(extraction, 660_000);
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
  });

  it("counts standalone fields and additional rows that have no known field projection", () => {
    const extraction = fixture();
    extraction.additional_components[0].semantic_kind = "bonus";
    extraction.additional_components[0].normalized_label = "bonus";
    expect(codes(extraction)).toContain("gross_component_mismatch");
    gross(extraction, 660_000);
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
  });

  it.each(["page", "document", "amount", "method", "box", "one-sided-box"] as const)("does not collapse a row with a different %s", difference => {
    const extraction = fixture(), row = extraction.additional_components[0];
    if (difference === "page") row.source.page = 2;
    if (difference === "document") row.source.document_id = uuid(50);
    if (difference === "amount") row.amount!.minor_units = 320_000;
    if (difference === "method") row.extraction_method = "ocr";
    if (difference === "box" || difference === "one-sided-box") {
      row.source.bounding_box = { x: 1, y: 20, width: 50, height: 10, coordinate_space: "pixels" };
      if (difference === "box") extraction.fields[0].source.bounding_box = { ...row.source.bounding_box, y: 50 };
    }
    expect(codes(extraction)).toContain("gross_component_mismatch");
  });

  it("matches an exact bounding box when both projections carry one", () => {
    const extraction = fixture();
    const box = { x: 1, y: 20, width: 50, height: 10, coordinate_space: "pixels" as const };
    extraction.fields[0].source.bounding_box = { ...box };
    extraction.additional_components[0].source.bounding_box = { ...box };
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
  });

  it("retains ambiguity when two different raw readings normalize to the same amount", () => {
    const extraction = fixture();
    extraction.additional_components[0].amount_raw = "3,300.00";
    expect(extraction.additional_components[0].amount).toEqual(extraction.fields[0].normalized_value);
    expect(codes(extraction)).toContain("gross_component_mismatch");
  });

  it("ignores only surrounding whitespace in the identical raw amount", () => {
    const extraction = fixture();
    extraction.additional_components[0].amount_raw = " 3300.00 ";
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
  });

  it.each([false, true])("preserves duplicate-row rejection (different values: %s)", different => {
    const extraction = fixture(), other = structuredClone(extraction.additional_components[0]);
    other.component_id = uuid(6);
    if (different) other.amount!.minor_units = 10_000;
    extraction.additional_components.push(other);
    expect(codes(extraction)).toEqual(expect.arrayContaining(["duplicate_mapped_component", "gross_component_mismatch"]));
  });

  it.each([false, true])("preserves duplicate field rejection (different values: %s)", different => {
    const extraction = fixture(), other = structuredClone(extraction.fields[0]);
    other.candidate_id = uuid(6);
    if (different && other.field === "base_monthly_salary") other.normalized_value!.minor_units = 10_000;
    extraction.fields.push(other);
    expect(codes(extraction)).toEqual(expect.arrayContaining([different ? "conflicting_candidates" : "duplicate_candidate", "gross_component_mismatch"]));
  });

  it("preserves the original scale and rounding-tolerance checks", () => {
    const extraction = fixture();
    gross(extraction, 3_300_000);
    expect(codes(extraction)).toContain("ocr_scale_mismatch");
    gross(extraction, 330_100);
    expect(codes(extraction)).not.toContain("gross_component_mismatch");
    gross(extraction, 330_101);
    expect(codes(extraction)).toContain("gross_component_mismatch");
  });
});
