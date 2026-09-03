import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { safeEngineLogSchema } from "@/server/engine/safe-logging";
import { extractionResultSchema, rawCandidateFieldSchema, sensitiveMetadataCandidateSchema } from "./contracts.ts";
import { FixtureDocumentExtractor, SyntheticDocumentSource } from "./fixture-extractor.ts";
import { syntheticPayslipFixtures } from "./fixtures/source-fixtures.ts";
import { minimizePayslipForSemanticProcessing } from "./minimize.ts";
import {
  normalizeDecimal,
  normalizeExplicitDate,
  normalizeHours,
  normalizeMoney,
  normalizePayslipExtraction,
  normalizePercentage,
  normalizeSalaryPeriod,
} from "./normalization.ts";
import { runPayslipExtractionPipeline } from "./pipeline.ts";
import { resolvePayslipSnapshot, resolvedPayslipFactPaths } from "./resolver.ts";
import { validatePayslipGate0 } from "./validation.ts";

function uuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function context(fixtureIndex: number) {
  const fixture = syntheticPayslipFixtures[fixtureIndex];
  return {
    snapshot_id: uuid(5000 + fixtureIndex),
    case_id: fixture.request.case_id,
    analysis_run_id: fixture.request.analysis_run_id,
    schema_version: "1.0",
    created_at: fixture.request.requested_at,
    fact_ids: Object.fromEntries(
      resolvedPayslipFactPaths.map((path, index) => [path, uuid(10_000 + fixtureIndex * 100 + index)]),
    ),
  };
}

function normalizedFixture(index: number) {
  return normalizePayslipExtraction(syntheticPayslipFixtures[index].extraction);
}

function resolveFixture(index: number) {
  const fixture = syntheticPayslipFixtures[index];
  const extraction = normalizedFixture(index);
  const validation = validatePayslipGate0(extraction, { reference_year: 2026 });
  return resolvePayslipSnapshot({
    document: fixture.request.document,
    extraction,
    validation,
    context: context(index),
  });
}

describe("provider-independent extraction contracts", () => {
  it("requires every candidate to preserve document, page, method, confidence, and source location", () => {
    const candidate = syntheticPayslipFixtures[0].extraction.fields[0];
    expect(rawCandidateFieldSchema.parse(candidate)).toMatchObject({
      source: { document_id: syntheticPayslipFixtures[0].request.document.document_id, page: 1 },
      extraction_method: "text_native",
    });
    expect(candidate.source.bounding_box).toBeDefined();
    expect(rawCandidateFieldSchema.safeParse({ ...candidate, confidence: 1.1 }).success).toBe(false);
  });

  it("rejects sources that point at another document", () => {
    const extraction = syntheticPayslipFixtures[0].extraction;
    expect(
      extractionResultSchema.safeParse({
        ...extraction,
        fields: [
          {
            ...extraction.fields[0],
            source: { ...extraction.fields[0].source, document_id: uuid(999_999) },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps bank data outside even the full sensitive-metadata contract", () => {
    const metadata = syntheticPayslipFixtures[0].extraction.sensitive_metadata[0];
    expect(sensitiveMetadataCandidateSchema.safeParse({ ...metadata, kind: "bank_data" }).success).toBe(false);
  });

  it("runs a fixture adapter through the same private-source interface intended for future providers", async () => {
    const fixture = syntheticPayslipFixtures[0];
    const source = new SyntheticDocumentSource();
    const read = vi.spyOn(source, "read");
    const result = await runPayslipExtractionPipeline({
      request: fixture.request,
      source,
      extractor: new FixtureDocumentExtractor(syntheticPayslipFixtures),
      snapshot_context: context(0),
      reference_year: 2026,
    });
    expect(read).toHaveBeenCalledOnce();
    expect(result.snapshot?.facts.length).toBe(resolvedPayslipFactPaths.length);
    expect(result.raw_extraction.provider).toEqual({
      provider_id: "synthetic_fixture",
      extractor_version: "1.0",
      model_version: null,
    });
    expect(result.raw_extraction.quality_metrics).toEqual({
      page_count: 1,
      text_coverage: 0.98,
      rotation_degrees: 0,
      source_resolution_dpi: 300,
    });
  });
});

describe("deterministic normalization", () => {
  it.each([
    ["8,500.00 ₪", 850_000],
    ["8.500,00", 850_000],
    ["₪ 8500", 850_000],
    ["45.00", 4_500],
    ["0,50", 50],
  ])("normalizes Israeli money %s without floating-point arithmetic", (raw, expected) => {
    expect(normalizeMoney(raw)).toEqual({ currency: "ILS", minor_units: expected });
  });

  it("rejects unsafe or over-precise money while retaining a negative value for Gate 0", () => {
    expect(normalizeMoney("90071992547410.00")).toBeNull();
    expect(normalizeMoney("10.1234")).toBeNull();
    expect(normalizeMoney("-50.00")).toEqual({ currency: "ILS", minor_units: -5_000 });
  });

  it.each([
    ["182", "182"],
    ["182.5", "182.5"],
    ["182,50", "182.5"],
    ["182 שעות", "182"],
  ])("normalizes hours %s to canonical decimal text", (raw, expected) => {
    expect(normalizeHours(raw)).toEqual({ amount: expected, unit: "hours_per_month" });
  });

  it.each([
    ["6%", 600],
    ["6.00", 600],
    ["6,5%", 650],
    ["8.33%", 833],
  ])("normalizes contribution percentage %s to basis points", (raw, expected) => {
    expect(normalizePercentage(raw)).toEqual({ basis_points: expected });
  });

  it("normalizes numeric and Hebrew salary periods but declines arbitrary text", () => {
    const expected = { year: 2026, month: 8, start_date: "2026-08-01", end_date: "2026-08-31" };
    expect(normalizeSalaryPeriod("08/2026")).toEqual(expected);
    expect(normalizeSalaryPeriod("8/26")).toEqual(expected);
    expect(normalizeSalaryPeriod("אוגוסט 2026")).toEqual(expected);
    expect(normalizeSalaryPeriod("summer 2026")).toBeNull();
  });

  it("does not guess an ambiguous arbitrary document date", () => {
    expect(normalizeExplicitDate("01/02/2020")).toBeNull();
    expect(normalizeExplicitDate("15/01/2020")).toBe("2020-01-15");
    expect(normalizeExplicitDate("2020-01-15")).toBe("2020-01-15");
    expect(normalizeDecimal("000182.5000")).toBe("182.5");
  });
});

describe("Gate 0 extraction validation", () => {
  it("keeps clean monthly and hourly arithmetic valid within tolerance", () => {
    expect(validatePayslipGate0(normalizedFixture(0), { reference_year: 2026 }).status).toBe("valid");
    expect(validatePayslipGate0(normalizedFixture(1), { reference_year: 2026 }).status).toBe("valid");
  });

  it("validates pension arithmetic without making a pension entitlement conclusion", () => {
    const result = validatePayslipGate0(normalizedFixture(3), { reference_year: 2026 });
    expect(result.issues.map((issue) => issue.code)).not.toContain("pension_contribution_mismatch");
    expect(JSON.stringify(result)).not.toMatch(/owes|entitlement|violation|debt/i);
  });

  it("flags contradictory complete component arithmetic", () => {
    const result = validatePayslipGate0(normalizedFixture(6), { reference_year: 2026 });
    expect(result.status).toBe("suspicious");
    expect(result.issues.map((issue) => issue.code)).toContain("gross_component_mismatch");
  });

  it("detects OCR scale ambiguity without silently correcting it", () => {
    const extraction = normalizedFixture(7);
    const base = extraction.fields.find((field) => field.field === "base_monthly_salary");
    const result = validatePayslipGate0(extraction, { reference_year: 2026 });
    expect(base?.normalized_value).toEqual({ currency: "ILS", minor_units: 8_500_000 });
    expect(result.status).toBe("requires_confirmation");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["ocr_value_ambiguous", "ocr_scale_mismatch"]),
    );
  });

  it("rejects negative hours, impossible percentages, and malformed normalization", () => {
    const fixture = syntheticPayslipFixtures[1];
    const altered = extractionResultSchema.parse({
      ...fixture.extraction,
      fields: [
        { ...fixture.extraction.fields[4], candidate_id: uuid(9001), raw_value: "-5" },
        { ...fixture.extraction.fields[4], candidate_id: uuid(9002), field: "pension_employee_rate", raw_value: "106%" },
        { ...fixture.extraction.fields[4], candidate_id: uuid(9003), field: "gross_salary", raw_value: "not-a-number" },
      ],
    });
    const result = validatePayslipGate0(normalizePayslipExtraction(altered), { reference_year: 2026 });
    expect(result.status).toBe("invalid");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["negative_hours", "invalid_percentage", "normalization_failed"]),
    );
  });

  it("rejects an impossible salary year after deterministic period parsing", () => {
    const fixture = syntheticPayslipFixtures[0];
    const period = fixture.extraction.fields.find((field) => field.field === "salary_period");
    if (!period) throw new Error("Fixture period is missing");
    const extraction = normalizePayslipExtraction(
      extractionResultSchema.parse({
        ...fixture.extraction,
        fields: [{ ...period, candidate_id: uuid(9200), raw_value: "08/2099" }],
      }),
    );
    const result = validatePayslipGate0(extraction, { reference_year: 2026 });
    expect(result.status).toBe("invalid");
    expect(result.issues.map((issue) => issue.code)).toContain("invalid_salary_period");
  });

  it("flags pension arithmetic outside rounding tolerance", () => {
    const fixture = syntheticPayslipFixtures[3];
    const fields = fixture.extraction.fields.map((field) =>
      field.field === "pension_employee_contribution" ? { ...field, raw_value: "800" } : field,
    );
    const result = validatePayslipGate0(
      normalizePayslipExtraction(extractionResultSchema.parse({ ...fixture.extraction, fields })),
      { reference_year: 2026 },
    );
    expect(result.issues.map((issue) => issue.code)).toContain("pension_contribution_mismatch");
  });

  it("flags duplicate mapped candidates even when their values agree", () => {
    const fixture = syntheticPayslipFixtures[0];
    const base = fixture.extraction.fields.find((field) => field.field === "base_monthly_salary");
    if (!base) throw new Error("Fixture base salary is missing");
    const result = validatePayslipGate0(
      normalizePayslipExtraction(
        extractionResultSchema.parse({
          ...fixture.extraction,
          earnings_components_complete: false,
          fields: [...fixture.extraction.fields, { ...base, candidate_id: uuid(9300) }],
        }),
      ),
      { reference_year: 2026 },
    );
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_candidate");
  });

  it("detects a hundredfold OCR scale mismatch from related hourly fields", () => {
    const fixture = syntheticPayslipFixtures[1];
    const fields = fixture.extraction.fields.map((field) =>
      field.field === "hourly_rate" ? { ...field, raw_value: "5,000" } : field,
    );
    const result = validatePayslipGate0(
      normalizePayslipExtraction(extractionResultSchema.parse({ ...fixture.extraction, fields })),
      { reference_year: 2026 },
    );
    expect(result.issues.map((issue) => issue.code)).toContain("ocr_scale_mismatch");
  });

  it("detects duplicate normalized additional components", () => {
    const fixture = syntheticPayslipFixtures[9];
    const component = fixture.extraction.additional_components[0];
    const additionalComponents = [
      { ...component, normalized_label: "project_bonus" },
      { ...component, component_id: uuid(9400), normalized_label: "project_bonus" },
    ];
    const result = validatePayslipGate0(
      normalizePayslipExtraction(
        extractionResultSchema.parse({ ...fixture.extraction, additional_components: additionalComponents }),
      ),
      { reference_year: 2026 },
    );
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_mapped_component");
  });
});

describe("candidate to canonical snapshot", () => {
  it("confirms strong documentary facts and preserves exact source provenance", () => {
    const snapshot = resolveFixture(0);
    const base = snapshot.facts.find((fact) => fact.path === "compensation.base_monthly_salary");
    expect(base).toMatchObject({ status: "confirmed", value: { currency: "ILS", minor_units: 850_000 } });
    expect(base?.provenance[0]).toMatchObject({
      source_type: "documented",
      source_reference: {
        kind: "document",
        document_id: syntheticPayslipFixtures[0].request.document.document_id,
        locator: { page: 1 },
      },
    });
    expect(
      base?.provenance[0].source_type === "documented" &&
        base.provenance[0].source_reference.locator?.bounding_box,
    ).toBeDefined();
  });

  it("keeps genuinely absent fields explicitly missing", () => {
    const snapshot = resolveFixture(5);
    expect(snapshot.facts.find((fact) => fact.path === "compensation.base_monthly_salary")).toMatchObject({
      status: "missing",
      value: null,
    });
  });

  it("keeps low-confidence OCR values unconfirmed", () => {
    const snapshot = resolveFixture(7);
    expect(snapshot.facts.find((fact) => fact.path === "compensation.base_monthly_salary")?.status).toBe(
      "needs_confirmation",
    );
  });

  it("retains contradictory candidates as an unresolved conflict", () => {
    const fixture = syntheticPayslipFixtures[0];
    const base = fixture.extraction.fields.find((field) => field.field === "base_monthly_salary");
    if (!base) throw new Error("Fixture base salary is missing");
    const extraction = normalizePayslipExtraction(
      extractionResultSchema.parse({
        ...fixture.extraction,
        earnings_components_complete: false,
        fields: [...fixture.extraction.fields, { ...base, candidate_id: uuid(9100), raw_value: "9,000" }],
      }),
    );
    const validation = validatePayslipGate0(extraction, { reference_year: 2026 });
    const snapshot = resolvePayslipSnapshot({
      document: fixture.request.document,
      extraction,
      validation,
      context: context(0),
    });
    expect(snapshot.facts.find((fact) => fact.path === "compensation.base_monthly_salary")).toMatchObject({
      status: "conflicted",
      value: null,
      conflicting_fact_ids: expect.arrayContaining([base.candidate_id, uuid(9100)]),
    });
  });

  it("combines overtime bands without creating a legal finding", () => {
    const snapshot = resolveFixture(2);
    expect(snapshot.facts.find((fact) => fact.path === "work.overtime_hours")).toMatchObject({
      value: { amount: "16.75", unit: "hours_per_month" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/finding|owes|violation|entitlement|debt/i);
  });
});

describe("PII minimization and logging", () => {
  it("removes identity metadata, raw text, and raw labels from future semantic input", () => {
    const extraction = normalizedFixture(0);
    const minimized = minimizePayslipForSemanticProcessing(extraction);
    const serialized = JSON.stringify(minimized);
    expect(serialized).not.toContain("נועה לדוגמה");
    expect(serialized).not.toContain("חברת דוגמה");
    expect(serialized).not.toContain("000000018");
    expect(serialized).not.toContain("text_fragment");
    expect(serialized).not.toContain("raw_value");
    expect(serialized).not.toContain("source_label");
  });

  it("retains unknown components structurally without claiming their meaning", () => {
    const minimized = minimizePayslipForSemanticProcessing(normalizedFixture(9));
    expect(minimized.additional_components).toEqual([
      expect.objectContaining({
        normalized_label: null,
        amount: { currency: "ILS", minor_units: 75_000 },
        warning_flags: ["unmapped_component"],
      }),
    ]);
  });

  it("allows extraction telemetry but rejects OCR, names, IDs, and salary values", () => {
    const safe = {
      event: "extraction_completed",
      timestamp: "2026-08-29T08:00:00.000Z",
      case_id: syntheticPayslipFixtures[0].request.case_id,
      document_id: syntheticPayslipFixtures[0].request.document.document_id,
      extraction_id: syntheticPayslipFixtures[0].request.extraction_id,
      stage: "extract_document",
      status: "completed",
      provider_id: "synthetic_fixture",
      extractor_version: "1.0",
      duration_ms: 12,
    };
    expect(safeEngineLogSchema.safeParse(safe).success).toBe(true);
    for (const field of ["ocr_text", "employee_name", "employer_name", "national_id", "bank_data", "salary_value"]) {
      expect(safeEngineLogSchema.safeParse({ ...safe, [field]: "sensitive" }).success).toBe(false);
    }
  });
});
