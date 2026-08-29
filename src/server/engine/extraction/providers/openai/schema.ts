import "server-only";
import { z } from "zod";

export const openAiModelConfidenceSchema = z.enum(["high", "medium", "low"]);

export const openAiExtractionWarningSchema = z.enum([
  "ambiguous_value",
  "conflicting_values",
  "cropped_content",
  "low_contrast",
  "low_resolution",
  "partial_visibility",
  "rotated_document",
  "unreadable_value",
  "unknown_component",
]);

export const openAiPayslipFieldSchema = z.enum([
  "salary_period",
  "employment_start_date",
  "salary_type",
  "base_monthly_salary",
  "hourly_rate",
  "regular_hours",
  "overtime_125_hours",
  "overtime_150_hours",
  "gross_salary",
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

const evidenceSchema = z
  .object({
    page: z.number().int().positive().max(100).nullable(),
    source_label: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

const visibleFieldSchema = z
  .object({
    field: openAiPayslipFieldSchema,
    raw_value: z.string().trim().min(1).max(500).nullable(),
    confidence: openAiModelConfidenceSchema,
    evidence: evidenceSchema,
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

const additionalComponentSchema = z
  .object({
    source_label: z.string().trim().min(1).max(160),
    quantity_raw: z.string().trim().min(1).max(120).nullable(),
    rate_raw: z.string().trim().min(1).max(120).nullable(),
    amount_raw: z.string().trim().min(1).max(120).nullable(),
    confidence: openAiModelConfidenceSchema,
    evidence: evidenceSchema,
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

const sensitiveMetadataSchema = z
  .object({
    kind: z.enum(["employee_name", "employer_name", "national_id"]),
    raw_value: z.string().trim().min(1).max(500).nullable(),
    confidence: openAiModelConfidenceSchema,
    evidence: evidenceSchema,
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

export const openAiPayslipStructuredOutputSchema = z
  .object({
    detected_document_type: z.enum(["payslip", "unknown"]),
    document_quality: z.enum(["high", "medium", "low"]),
    page_count: z.number().int().positive().max(100),
    rotation_degrees: z.number().min(-360).max(360).nullable(),
    source_resolution_dpi: z.number().int().positive().max(10_000).nullable(),
    earnings_components_complete: z.boolean(),
    fields: z.array(visibleFieldSchema),
    additional_components: z.array(additionalComponentSchema),
    sensitive_metadata: z.array(sensitiveMetadataSchema),
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

export type OpenAiPayslipStructuredOutput = Readonly<z.infer<typeof openAiPayslipStructuredOutputSchema>>;
