import type { ExtractionRequest, ExtractionResult, PayslipFieldKey } from "../contracts";

export type SyntheticPayslipFixture = Readonly<{
  fixture_id: string;
  scenario: string;
  request: ExtractionRequest;
  extraction: ExtractionResult;
}>;

const caseId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-08-29T08:00:00.000Z";

function uuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function field(
  documentId: string,
  candidateNumber: number,
  fieldName: PayslipFieldKey,
  rawValue: string,
  options: { confidence?: number; warnings?: string[]; method?: "text_native" | "ocr" | "template" | "fixture" | "ai_vision" } = {},
) {
  return {
    candidate_id: uuid(candidateNumber),
    field: fieldName,
    raw_value: rawValue,
    confidence: options.confidence ?? 0.98,
    source: {
      document_id: documentId,
      page: 1,
      text_fragment: `${fieldName}: ${rawValue}`,
      bounding_box: {
        x: 0.1,
        y: 0.1 + (candidateNumber % 10) / 20,
        width: 0.3,
        height: 0.03,
        coordinate_space: "normalized" as const,
      },
    },
    extraction_method: options.method ?? "fixture" as const,
    warning_flags: options.warnings ?? [],
  };
}

function fixture(input: {
  number: number;
  fixture_id: string;
  scenario: string;
  fields: ReturnType<typeof field>[];
  quality?: number;
  complete?: boolean;
  additional?: ExtractionResult["additional_components"];
  sensitive?: ExtractionResult["sensitive_metadata"];
  warnings?: string[];
}): SyntheticPayslipFixture {
  const documentId = uuid(1000 + input.number);
  const extractionId = uuid(2000 + input.number);
  const document = {
    document_id: documentId,
    case_id: caseId,
    document_type: "payslip",
    original_filename: `${input.fixture_id}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 10_000 + input.number,
    content_sha256: input.number.toString(16).padStart(64, "0"),
    storage_path: `cases/${caseId}/documents/${documentId}/original.pdf`,
    document_period: null,
    supersedes_document_id: null,
    created_at: timestamp,
  };
  return {
    fixture_id: input.fixture_id,
    scenario: input.scenario,
    request: {
      case_id: caseId,
      analysis_run_id: runId,
      extraction_id: extractionId,
      document,
      declared_document_type: "payslip",
      requested_at: timestamp,
    },
    extraction: {
      extraction_id: extractionId,
      document_id: documentId,
      status: "completed",
      detected_document_type: "payslip",
      document_quality_confidence: input.quality ?? 0.98,
      quality_metrics: {
        page_count: 1,
        text_coverage: input.quality ?? 0.98,
        rotation_degrees: 0,
        source_resolution_dpi: input.quality !== undefined && input.quality < 0.8 ? 72 : 300,
      },
      fields: input.fields.map((candidate) => ({
        ...candidate,
        source: { ...candidate.source, document_id: documentId },
      })),
      additional_components: input.additional ?? [],
      sensitive_metadata: input.sensitive ?? [],
      earnings_components_complete: input.complete ?? false,
      warnings: input.warnings ?? [],
      provider: { provider_id: "synthetic_fixture", extractor_version: "1.0", model_version: null },
      operation: { duration_ms: 0, provider_response_id: null, token_usage: null },
      extracted_at: timestamp,
      error_code: null,
    },
  };
}

const documentIds = Array.from({ length: 10 }, (_, index) => uuid(1001 + index));

export const syntheticPayslipFixtures: readonly SyntheticPayslipFixture[] = [
  fixture({
    number: 1,
    fixture_id: "clean_monthly",
    scenario: "Clean text-native monthly payslip with synthetic identity metadata",
    complete: true,
    fields: [
      field(documentIds[0], 1, "document_type", "payslip", { method: "text_native" }),
      field(documentIds[0], 2, "salary_period", "08/2026", { method: "text_native" }),
      field(documentIds[0], 3, "employment_start_date", "15/01/2020", { method: "text_native" }),
      field(documentIds[0], 4, "salary_type", "monthly", { method: "text_native" }),
      field(documentIds[0], 5, "base_monthly_salary", "8,500.00 ₪", { method: "text_native" }),
      field(documentIds[0], 6, "gross_salary", "8,500.00", { method: "text_native" }),
      field(documentIds[0], 7, "net_salary", "7,200.00", { method: "text_native" }),
      field(documentIds[0], 8, "vacation_balance", "10 ימים", { method: "text_native" }),
      field(documentIds[0], 9, "sick_balance", "20 ימים", { method: "text_native" }),
    ],
    sensitive: [
      {
        metadata_id: uuid(101),
        kind: "employee_name",
        raw_value: "נועה לדוגמה",
        confidence: 0.99,
        source: { document_id: documentIds[0], page: 1, text_fragment: "שם עובד: נועה לדוגמה" },
        extraction_method: "text_native",
      },
      {
        metadata_id: uuid(102),
        kind: "employer_name",
        raw_value: "חברת דוגמה בע״מ",
        confidence: 0.99,
        source: { document_id: documentIds[0], page: 1, text_fragment: "מעסיק: חברת דוגמה בע״מ" },
        extraction_method: "text_native",
      },
      {
        metadata_id: uuid(103),
        kind: "national_id",
        raw_value: "000000018",
        confidence: 0.99,
        source: { document_id: documentIds[0], page: 1, text_fragment: "ת.ז. 000000018" },
        extraction_method: "text_native",
      },
    ],
  }),
  fixture({
    number: 2,
    fixture_id: "clean_hourly",
    scenario: "Clean OCR hourly payslip",
    complete: true,
    fields: [
      field(documentIds[1], 11, "document_type", "payslip", { method: "ocr" }),
      field(documentIds[1], 12, "salary_period", "8/26", { method: "ocr" }),
      field(documentIds[1], 13, "salary_type", "hourly", { method: "ocr" }),
      field(documentIds[1], 14, "hourly_rate", "50.00", { method: "ocr" }),
      field(documentIds[1], 15, "regular_hours", "182,50", { method: "ocr" }),
      field(documentIds[1], 16, "base_monthly_salary", "9,125.00", { method: "ocr" }),
      field(documentIds[1], 17, "gross_salary", "9,125.00", { method: "ocr" }),
      field(documentIds[1], 18, "net_salary", "7,750.00", { method: "ocr" }),
    ],
  }),
  fixture({
    number: 3,
    fixture_id: "overtime_bands",
    scenario: "Payslip with explicit 125% and 150% overtime hours",
    fields: [
      field(documentIds[2], 21, "document_type", "payslip"),
      field(documentIds[2], 22, "salary_period", "08/2026"),
      field(documentIds[2], 23, "salary_type", "monthly"),
      field(documentIds[2], 24, "base_monthly_salary", "8,500"),
      field(documentIds[2], 25, "overtime_125_hours", "12.5"),
      field(documentIds[2], 26, "overtime_150_hours", "4,25"),
      field(documentIds[2], 27, "gross_salary", "9,650"),
    ],
  }),
  fixture({
    number: 4,
    fixture_id: "pension_components",
    scenario: "Payslip with employee, employer, and severance pension components",
    complete: true,
    fields: [
      field(documentIds[3], 31, "document_type", "payslip"),
      field(documentIds[3], 32, "salary_period", "08/2026"),
      field(documentIds[3], 33, "salary_type", "monthly"),
      field(documentIds[3], 34, "base_monthly_salary", "10,000"),
      field(documentIds[3], 35, "gross_salary", "10,000"),
      field(documentIds[3], 36, "pension_base", "10,000"),
      field(documentIds[3], 37, "pension_employee_rate", "6%"),
      field(documentIds[3], 38, "pension_employee_contribution", "600"),
      field(documentIds[3], 39, "pension_employer_rate", "6,5%"),
      field(documentIds[3], 40, "pension_employer_contribution", "650"),
      field(documentIds[3], 41, "severance_rate", "8.33%"),
      field(documentIds[3], 42, "severance_contribution", "833.00"),
    ],
  }),
  fixture({
    number: 5,
    fixture_id: "travel_component",
    scenario: "Payslip with a separately identified travel component",
    complete: true,
    fields: [
      field(documentIds[4], 51, "document_type", "payslip"),
      field(documentIds[4], 52, "salary_period", "2026-08"),
      field(documentIds[4], 53, "salary_type", "monthly"),
      field(documentIds[4], 54, "base_monthly_salary", "8.500,00"),
      field(documentIds[4], 55, "travel_amount", "500,00 ₪"),
      field(documentIds[4], 56, "gross_salary", "9.000,00"),
    ],
  }),
  fixture({
    number: 6,
    fixture_id: "missing_base_salary",
    scenario: "Payslip whose base salary field is genuinely absent",
    fields: [
      field(documentIds[5], 61, "document_type", "payslip"),
      field(documentIds[5], 62, "salary_period", "08/2026"),
      field(documentIds[5], 63, "salary_type", "monthly"),
      field(documentIds[5], 64, "gross_salary", "8,500"),
      field(documentIds[5], 65, "net_salary", "7,200"),
    ],
  }),
  fixture({
    number: 7,
    fixture_id: "contradictory_arithmetic",
    scenario: "Payslip with a deliberately contradictory complete component sum",
    complete: true,
    fields: [
      field(documentIds[6], 71, "document_type", "payslip"),
      field(documentIds[6], 72, "salary_period", "08/2026"),
      field(documentIds[6], 73, "salary_type", "monthly"),
      field(documentIds[6], 74, "base_monthly_salary", "8,500"),
      field(documentIds[6], 75, "travel_amount", "500"),
      field(documentIds[6], 76, "gross_salary", "12,000"),
    ],
  }),
  fixture({
    number: 8,
    fixture_id: "ocr_magnitude_ambiguity",
    scenario: "OCR output with a deliberate tenfold base-salary ambiguity",
    complete: true,
    quality: 0.72,
    fields: [
      field(documentIds[7], 81, "document_type", "payslip", { method: "ocr", confidence: 0.91 }),
      field(documentIds[7], 82, "salary_period", "08/2026", { method: "ocr", confidence: 0.91 }),
      field(documentIds[7], 83, "salary_type", "monthly", { method: "ocr", confidence: 0.9 }),
      field(documentIds[7], 84, "base_monthly_salary", "85,000", {
        method: "ocr",
        confidence: 0.55,
        warnings: ["ocr_ambiguous", "possible_scale_error"],
      }),
      field(documentIds[7], 85, "gross_salary", "8,500", { method: "ocr", confidence: 0.88 }),
    ],
    warnings: ["low_resolution"],
  }),
  fixture({
    number: 9,
    fixture_id: "hebrew_rtl_labels",
    scenario: "Text-native payslip values associated with Hebrew RTL labels",
    complete: true,
    fields: [
      field(documentIds[8], 91, "document_type", "תלוש שכר", { method: "text_native" }),
      field(documentIds[8], 92, "salary_period", "אוגוסט 2026", { method: "text_native" }),
      field(documentIds[8], 93, "salary_type", "משכורת חודשית", { method: "text_native" }),
      field(documentIds[8], 94, "base_monthly_salary", "₪ 8,500.00", { method: "text_native" }),
      field(documentIds[8], 95, "gross_salary", "8,500 ש״ח", { method: "text_native" }),
      field(documentIds[8], 96, "regular_hours", "182 שעות", { method: "text_native" }),
    ],
  }),
  fixture({
    number: 10,
    fixture_id: "unknown_component",
    scenario: "Payslip with a structured but semantically unknown salary component",
    complete: true,
    fields: [
      field(documentIds[9], 111, "document_type", "payslip"),
      field(documentIds[9], 112, "salary_period", "08/2026"),
      field(documentIds[9], 113, "salary_type", "monthly"),
      field(documentIds[9], 114, "base_monthly_salary", "8,000"),
      field(documentIds[9], 115, "gross_salary", "8,750"),
    ],
    additional: [
      {
        component_id: uuid(116),
        source_label: "בונוס פרויקט",
        normalized_label: null,
        semantic_kind: "unknown",
        quantity_raw: "1",
        rate_raw: null,
        percentage_raw: null,
        amount_raw: "750.00 ₪",
        confidence: 0.96,
        source: { document_id: documentIds[9], page: 1, text_fragment: "בונוס פרויקט 750.00" },
        extraction_method: "fixture",
        warning_flags: ["unmapped_component"],
      },
    ],
  }),
];

export const syntheticFixtureCaseId = caseId;
export const syntheticFixtureRunId = runId;
export const syntheticFixtureTimestamp = timestamp;
