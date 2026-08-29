import "server-only";
import { createHash } from "node:crypto";
import {
  extractionResultSchema,
  type ExtractionRequest,
  type PayslipFieldKey,
  type RawCandidateField,
} from "@/engine/extraction/contracts";
import type { Gate0CriticalContext } from "@/engine/extraction/validation";
import { salaryTypeAssessmentSchema, type SalaryTypeAssessment } from "@/engine/extraction/v2";
import { openAiPayslipV2StructuredOutputSchema, type OpenAiPayslipV2StructuredOutput } from "./v2-schema";

type ValueCandidate = OpenAiPayslipV2StructuredOutput["totals"]["gross_candidates"][number];
type ModelConfidence = ValueCandidate["confidence"];

const modelConfidence = { high: 0.94, medium: 0.72, low: 0.42 } as const;
const qualityConfidence = { high: 0.96, medium: 0.76, low: 0.48 } as const;

function uuidFrom(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function candidateConfidence(
  confidence: ModelConfidence,
  quality: OpenAiPayslipV2StructuredOutput["document_quality"],
  warningCount: number,
) {
  return Math.max(0, Math.min(modelConfidence[confidence], qualityConfidence[quality]) - Math.min(0.3, warningCount * 0.1));
}

function candidateSource(input: {
  documentId: string;
  candidate: ValueCandidate;
  fallbackLabel: string;
}) {
  const label = input.candidate.evidence.source_label ?? input.fallbackLabel;
  return {
    document_id: input.documentId,
    page: input.candidate.evidence.page ?? 1,
    text_fragment: `${label}: ${input.candidate.raw_value}`.slice(0, 500),
  };
}

export type MappedOpenAiV2Pass = Readonly<{
  extraction: ReturnType<typeof extractionResultSchema.parse>;
  salary_type_assessment: SalaryTypeAssessment;
  critical_context: Gate0CriticalContext;
  pension_section_visible: boolean;
  totals_section_visible: boolean;
}>;

export function mapOpenAiV2Output(input: {
  request: ExtractionRequest;
  output: OpenAiPayslipV2StructuredOutput;
  model: string;
  extractorVersion: string;
  durationMs: number;
  providerResponseId: string;
  tokenUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  extractedAt: string;
  allowedFields?: readonly PayslipFieldKey[];
}): MappedOpenAiV2Pass {
  const output = openAiPayslipV2StructuredOutputSchema.parse(input.output);
  if ((output.salary_type.documented_value === null) !== (output.salary_type.documented_raw_value === null)) {
    throw new TypeError("Documented salary type value and raw evidence must be present together");
  }
  if ((output.salary_type.inferred_value === null) !== (output.salary_type.inference_basis.length === 0)) {
    throw new TypeError("Inferred salary type and its basis must be present together");
  }
  const documentId = input.request.document.document_id;
  const allowed = input.allowedFields ? new Set(input.allowedFields) : null;
  const fields: RawCandidateField[] = [];
  let sequence = 0;
  const addCandidate = (field: PayslipFieldKey, value: ValueCandidate, fallbackLabel: string) => {
    if (allowed && !allowed.has(field)) return null;
    const candidateId = uuidFrom(`${input.request.extraction_id}:v2:${sequence++}:${field}`);
    fields.push({
      candidate_id: candidateId,
      field,
      raw_value: value.raw_value,
      confidence: candidateConfidence(value.confidence, output.document_quality, value.warnings.length),
      source: candidateSource({ documentId, candidate: value, fallbackLabel }),
      extraction_method: "ai_vision",
      warning_flags: value.warnings,
    });
    return candidateId;
  };

  const documentTypeId = uuidFrom(`${input.request.extraction_id}:v2:document-type`);
  if (!allowed || allowed.has("document_type")) {
    fields.push({
      candidate_id: documentTypeId,
      field: "document_type",
      raw_value: output.detected_document_type,
      confidence: qualityConfidence[output.document_quality],
      source: { document_id: documentId, page: 1, text_fragment: "document type" },
      extraction_method: "ai_vision",
      warning_flags: [],
    });
  }

  for (const group of output.generic_fields) {
    for (const value of group.candidates) addCandidate(group.field, value, group.field);
  }

  let documentedCandidateId: string | null = null;
  if (
    output.salary_type.documented_value !== null &&
    output.salary_type.documented_raw_value !== null &&
    (!allowed || allowed.has("salary_type"))
  ) {
    const salaryCandidate: ValueCandidate = {
      raw_value: output.salary_type.documented_raw_value,
      confidence: output.salary_type.documented_confidence,
      evidence: output.salary_type.documented_evidence,
      warnings: output.salary_type.warnings,
    };
    documentedCandidateId = addCandidate("salary_type", salaryCandidate, "salary type");
  }

  const semanticFieldMap: Readonly<Partial<Record<OpenAiPayslipV2StructuredOutput["payroll_rows"][number]["semantic_kind"], {
    quantity?: PayslipFieldKey;
    rate?: PayslipFieldKey;
    amount?: PayslipFieldKey;
  }>>> = {
    base_salary: { amount: "base_monthly_salary" },
    hourly_base: { quantity: "regular_hours", rate: "hourly_rate" },
    overtime_125: { quantity: "overtime_125_hours" },
    overtime_150: { quantity: "overtime_150_hours" },
    travel: { amount: "travel_amount" },
    convalescence: { amount: "convalescence_amount" },
  };
  for (const row of output.payroll_rows) {
    const mapping = semanticFieldMap[row.semantic_kind];
    const rowValue = (rawValue: string): ValueCandidate => ({
      raw_value: rawValue,
      confidence: row.confidence,
      evidence: row.evidence,
      warnings: row.warnings,
    });
    if (mapping?.quantity && row.quantity_raw) addCandidate(mapping.quantity, rowValue(row.quantity_raw), row.source_label);
    if (mapping?.rate && row.rate_raw) addCandidate(mapping.rate, rowValue(row.rate_raw), row.source_label);
    if (mapping?.amount && row.amount_raw) addCandidate(mapping.amount, rowValue(row.amount_raw), row.source_label);
  }

  for (const value of output.totals.gross_candidates) addCandidate("gross_salary", value, "gross total");
  for (const value of output.totals.deductions_candidates) addCandidate("total_deductions", value, "deductions total");
  for (const value of output.totals.net_candidates) addCandidate("net_salary", value, "net total");

  for (const value of output.pension.base_candidates) addCandidate("pension_base", value, "pension base");
  for (const value of output.pension.employee.rate_candidates) addCandidate("pension_employee_rate", value, "employee pension rate");
  for (const value of output.pension.employee.amount_candidates) addCandidate("pension_employee_contribution", value, "employee pension amount");
  for (const value of output.pension.employer.rate_candidates) addCandidate("pension_employer_rate", value, "employer pension rate");
  for (const value of output.pension.employer.amount_candidates) addCandidate("pension_employer_contribution", value, "employer pension amount");
  for (const value of output.pension.severance.rate_candidates) addCandidate("severance_rate", value, "severance rate");
  for (const value of output.pension.severance.amount_candidates) addCandidate("severance_contribution", value, "severance amount");

  const additionalComponents = allowed ? [] : output.payroll_rows.flatMap((row, index) => {
    if (
      row.quantity_raw === null && row.rate_raw === null &&
      row.percentage_raw === null && row.amount_raw === null
    ) return [];
    return [{
      component_id: uuidFrom(`${input.request.extraction_id}:v2:row:${index}`),
      source_label: row.source_label,
      normalized_label: ["unknown", "other"].includes(row.semantic_kind) ? null : row.semantic_kind,
      semantic_kind: row.semantic_kind,
      quantity_raw: row.quantity_raw,
      rate_raw: row.rate_raw,
      percentage_raw: row.percentage_raw,
      amount_raw: row.amount_raw,
      confidence: candidateConfidence(row.confidence, output.document_quality, row.warnings.length),
      source: {
        document_id: documentId,
        page: row.evidence.page ?? 1,
        text_fragment: row.source_label,
      },
      extraction_method: "ai_vision" as const,
      warning_flags: row.warnings,
    }];
  });

  const salaryTypeAssessment = salaryTypeAssessmentSchema.parse({
    documented: documentedCandidateId && output.salary_type.documented_value && output.salary_type.documented_raw_value
      ? {
          value: output.salary_type.documented_value,
          raw_value: output.salary_type.documented_raw_value,
          confidence: candidateConfidence(
            output.salary_type.documented_confidence,
            output.document_quality,
            output.salary_type.warnings.length,
          ),
          candidate_id: documentedCandidateId,
        }
      : null,
    inferred: output.salary_type.inferred_value && (!allowed || allowed.has("salary_type"))
      ? {
          value: output.salary_type.inferred_value,
          confidence: candidateConfidence(
            output.salary_type.inferred_confidence,
            output.document_quality,
            output.salary_type.warnings.length,
          ),
          basis: output.salary_type.inference_basis,
          warning_flags: [...new Set([...output.salary_type.warnings, "inferred_not_documented"])],
        }
      : null,
  });
  const inferredHourly = salaryTypeAssessment.inferred?.value === "hourly" || salaryTypeAssessment.inferred?.value === "mixed";
  const documentedHourly = salaryTypeAssessment.documented?.value === "hourly" || salaryTypeAssessment.documented?.value === "mixed";
  const hourlyRows = output.payroll_rows.some((row) => ["hourly_base", "overtime_125", "overtime_150"].includes(row.semantic_kind));
  const totalsVisible = output.totals.visible && (!allowed || [...allowed].some((field) => ["gross_salary", "total_deductions", "net_salary"].includes(field)));
  const pensionVisible = output.pension.visible && (!allowed || [...allowed].some((field) => field.startsWith("pension_") || field.startsWith("severance_")));
  const requiredFields: PayslipFieldKey[] = [];
  if (!allowed || allowed.has("salary_period")) requiredFields.push("salary_period");

  const extraction = extractionResultSchema.parse({
    extraction_id: input.request.extraction_id,
    document_id: documentId,
    status: fields.length > 1 ? "completed" : "partial",
    detected_document_type: output.detected_document_type,
    document_quality_confidence: qualityConfidence[output.document_quality],
    quality_metrics: {
      page_count: output.page_count,
      text_coverage: null,
      rotation_degrees: output.rotation_degrees,
      source_resolution_dpi: output.source_resolution_dpi,
    },
    fields,
    additional_components: additionalComponents,
    sensitive_metadata: [],
    earnings_components_complete: output.earnings_components_complete,
    warnings: output.warnings,
    provider: { provider_id: "openai", extractor_version: input.extractorVersion, model_version: input.model },
    operation: {
      duration_ms: input.durationMs,
      provider_response_id: input.providerResponseId,
      token_usage: input.tokenUsage,
    },
    extracted_at: input.extractedAt,
    error_code: null,
  });
  return {
    extraction,
    salary_type_assessment: salaryTypeAssessment,
    critical_context: {
      required_fields: requiredFields,
      hourly_analysis_implied: documentedHourly || inferredHourly || hourlyRows,
      pension_section_visible: pensionVisible,
      totals_section_visible: totalsVisible,
    },
    pension_section_visible: pensionVisible,
    totals_section_visible: totalsVisible,
  };
}
