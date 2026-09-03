import { z } from "zod";
import { immutableDocumentSchema } from "../domain/documents.ts";
import {
  confidenceSchema,
  domainCodeSchema,
  isoTimestampSchema,
  uuidSchema,
  versionSchema,
} from "../domain/primitives.ts";

export const extractionMethodSchema = z.enum(["text_native", "ocr", "template", "fixture", "ai_vision"]);
export const extractionStatusSchema = z.enum(["completed", "partial", "failed"]);
export const detectedDocumentTypeSchema = z.enum(["payslip", "unknown"]);

export const boundingBoxSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    coordinate_space: z.enum(["normalized", "pixels"]),
  })
  .strict();

export const candidateSourceSchema = z
  .object({
    document_id: uuidSchema,
    page: z.number().int().positive(),
    text_fragment: z.string().trim().min(1).max(500).optional(),
    bounding_box: boundingBoxSchema.optional(),
  })
  .strict();

export const payslipFieldKeySchema = z.enum([
  "document_type",
  "salary_period",
  "employment_start_date",
  "salary_type",
  "base_monthly_salary",
  "hourly_rate",
  "regular_hours",
  "overtime_125_hours",
  "overtime_150_hours",
  "gross_salary",
  "total_deductions",
  "net_salary",
  "travel_amount",
  "convalescence_amount",
  "pension_employee_contribution",
  "pension_employer_contribution",
  "severance_contribution",
  "pension_base",
  "pension_employee_rate",
  "pension_employer_rate",
  "severance_rate",
  "vacation_balance",
  "sick_balance",
]);

export const payrollRowSemanticSchema = z.enum([
  "base_salary",
  "hourly_base",
  "overtime_125",
  "overtime_150",
  "travel",
  "convalescence",
  "bonus",
  "deduction",
  "other",
  "unknown",
]);

export const candidateWarningSchema = domainCodeSchema;

export const rawCandidateFieldSchema = z
  .object({
    candidate_id: uuidSchema,
    field: payslipFieldKeySchema,
    raw_value: z.string().trim().min(1).max(500),
    confidence: confidenceSchema,
    source: candidateSourceSchema,
    extraction_method: extractionMethodSchema,
    warning_flags: z.array(candidateWarningSchema),
  })
  .strict()
  .refine((candidate) => new Set(candidate.warning_flags).size === candidate.warning_flags.length, {
    message: "Candidate warning flags must be unique",
    path: ["warning_flags"],
  });

export const rawAdditionalComponentSchema = z
  .object({
    component_id: uuidSchema,
    source_label: z.string().trim().min(1).max(160),
    normalized_label: domainCodeSchema.nullable(),
    semantic_kind: payrollRowSemanticSchema.default("unknown"),
    quantity_raw: z.string().trim().min(1).max(120).nullable(),
    rate_raw: z.string().trim().min(1).max(120).nullable(),
    percentage_raw: z.string().trim().min(1).max(120).nullable().default(null),
    amount_raw: z.string().trim().min(1).max(120).nullable(),
    confidence: confidenceSchema,
    source: candidateSourceSchema,
    extraction_method: extractionMethodSchema,
    warning_flags: z.array(candidateWarningSchema),
  })
  .strict()
  .refine(
    (component) =>
      component.quantity_raw !== null ||
      component.rate_raw !== null ||
      component.percentage_raw !== null ||
      component.amount_raw !== null,
    { message: "An additional component requires quantity, rate, percentage, or amount" },
  );

export const sensitiveMetadataKindSchema = z.enum(["employee_name", "employer_name", "national_id"]);

export const sensitiveMetadataCandidateSchema = z
  .object({
    metadata_id: uuidSchema,
    kind: sensitiveMetadataKindSchema,
    raw_value: z.string().trim().min(1).max(500),
    confidence: confidenceSchema,
    source: candidateSourceSchema,
    extraction_method: extractionMethodSchema,
  })
  .strict();

export const extractionRequestSchema = z
  .object({
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    extraction_id: uuidSchema,
    document: immutableDocumentSchema,
    declared_document_type: detectedDocumentTypeSchema.nullable(),
    requested_at: isoTimestampSchema,
  })
  .strict()
  .refine((request) => request.document.case_id === request.case_id, {
    message: "Extraction document must belong to the request case",
    path: ["document", "case_id"],
  });

export const extractionProviderSchema = z
  .object({
    provider_id: domainCodeSchema,
    extractor_version: versionSchema,
    model_version: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

export const extractionTokenUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().safe(),
    output_tokens: z.number().int().nonnegative().safe(),
    total_tokens: z.number().int().nonnegative().safe(),
  })
  .strict()
  .refine((usage) => usage.total_tokens >= usage.input_tokens + usage.output_tokens, {
    message: "Total token usage cannot be lower than input plus output tokens",
    path: ["total_tokens"],
  });

export const extractionOperationSchema = z
  .object({
    duration_ms: z.number().int().nonnegative().safe(),
    provider_response_id: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_-]+$/).nullable(),
    token_usage: extractionTokenUsageSchema.nullable(),
  })
  .strict();

export const documentQualityMetricsSchema = z
  .object({
    page_count: z.number().int().positive(),
    text_coverage: confidenceSchema.nullable(),
    rotation_degrees: z.number().min(-360).max(360).nullable(),
    source_resolution_dpi: z.number().int().positive().nullable(),
  })
  .strict();

export const extractionResultSchema = z
  .object({
    extraction_id: uuidSchema,
    document_id: uuidSchema,
    status: extractionStatusSchema,
    detected_document_type: detectedDocumentTypeSchema,
    document_quality_confidence: confidenceSchema,
    quality_metrics: documentQualityMetricsSchema,
    fields: z.array(rawCandidateFieldSchema),
    additional_components: z.array(rawAdditionalComponentSchema),
    sensitive_metadata: z.array(sensitiveMetadataCandidateSchema),
    earnings_components_complete: z.boolean(),
    warnings: z.array(candidateWarningSchema),
    provider: extractionProviderSchema,
    operation: extractionOperationSchema,
    extracted_at: isoTimestampSchema,
    error_code: domainCodeSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const candidateIds = [
      ...result.fields.map((field) => field.candidate_id),
      ...result.additional_components.map((component) => component.component_id),
      ...result.sensitive_metadata.map((metadata) => metadata.metadata_id),
    ];
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({ code: "custom", message: "Extraction candidate IDs must be unique", path: ["fields"] });
    }
    if (result.fields.some((field) => field.source.document_id !== result.document_id)) {
      context.addIssue({ code: "custom", message: "Every field source must reference the extracted document", path: ["fields"] });
    }
    if (
      result.additional_components.some((component) => component.source.document_id !== result.document_id) ||
      result.sensitive_metadata.some((metadata) => metadata.source.document_id !== result.document_id)
    ) {
      context.addIssue({ code: "custom", message: "Every extraction source must reference the extracted document", path: ["document_id"] });
    }
    if ((result.status === "failed") !== (result.error_code !== null)) {
      context.addIssue({ code: "custom", message: "Only failed extractions carry an error code", path: ["error_code"] });
    }
    if (result.status === "failed" && (result.fields.length > 0 || result.additional_components.length > 0)) {
      context.addIssue({ code: "custom", message: "Failed extractions cannot emit candidate values", path: ["fields"] });
    }
  });

export type ExtractionRequest = Readonly<z.infer<typeof extractionRequestSchema>>;
export type ExtractionResult = Readonly<z.infer<typeof extractionResultSchema>>;
export type RawCandidateField = Readonly<z.infer<typeof rawCandidateFieldSchema>>;
export type RawAdditionalComponent = Readonly<z.infer<typeof rawAdditionalComponentSchema>>;
export type CandidateSource = Readonly<z.infer<typeof candidateSourceSchema>>;
export type PayslipFieldKey = z.infer<typeof payslipFieldKeySchema>;
