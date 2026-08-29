import { z } from "zod";
import {
  confidenceSchema,
  decimalStringSchema,
  domainCodeSchema,
  isoDateSchema,
  moneySchema,
  uuidSchema,
} from "../domain/primitives";
import {
  candidateSourceSchema,
  candidateWarningSchema,
  detectedDocumentTypeSchema,
  documentQualityMetricsSchema,
  extractionMethodSchema,
  extractionOperationSchema,
  extractionProviderSchema,
  extractionStatusSchema,
  sensitiveMetadataCandidateSchema,
} from "./contracts";

export const salaryPeriodSchema = z
  .object({
    year: z.number().int(),
    month: z.number().int(),
    start_date: isoDateSchema,
    end_date: isoDateSchema,
  })
  .strict();

export const normalizedHoursSchema = z
  .object({
    amount: decimalStringSchema,
    unit: z.literal("hours_per_month"),
  })
  .strict();

export const normalizedBalanceSchema = z
  .object({
    amount: decimalStringSchema,
    unit: z.enum(["days", "hours"]),
  })
  .strict();

export const normalizedPercentageSchema = z
  .object({ basis_points: z.number().int().safe() })
  .strict();

const normalizedCommonShape = {
  candidate_id: z.uuid(),
  raw_value: z.string().trim().min(1).max(500),
  confidence: confidenceSchema,
  source: candidateSourceSchema,
  extraction_method: extractionMethodSchema,
  warning_flags: z.array(candidateWarningSchema),
} as const;

function normalizedVariant<TField extends string, TValue extends z.ZodType>(field: TField, value: TValue) {
  return z
    .object({
      ...normalizedCommonShape,
      field: z.literal(field),
      normalized_value: value.nullable(),
    })
    .strict();
}

const moneyFields = [
  "base_monthly_salary",
  "hourly_rate",
  "gross_salary",
  "net_salary",
  "travel_amount",
  "convalescence_amount",
  "pension_employee_contribution",
  "pension_employer_contribution",
  "severance_contribution",
  "pension_base",
] as const;

const hoursFields = ["regular_hours", "overtime_125_hours", "overtime_150_hours"] as const;
const percentageFields = ["pension_employee_rate", "pension_employer_rate", "severance_rate"] as const;

export const normalizedCandidateFieldSchema = z.discriminatedUnion("field", [
  normalizedVariant("document_type", detectedDocumentTypeSchema),
  normalizedVariant("salary_period", salaryPeriodSchema),
  normalizedVariant("employment_start_date", isoDateSchema),
  normalizedVariant("salary_type", z.enum(["monthly", "hourly", "mixed"])),
  ...moneyFields.map((field) => normalizedVariant(field, moneySchema)),
  ...hoursFields.map((field) => normalizedVariant(field, normalizedHoursSchema)),
  ...percentageFields.map((field) => normalizedVariant(field, normalizedPercentageSchema)),
  normalizedVariant("vacation_balance", normalizedBalanceSchema),
  normalizedVariant("sick_balance", normalizedBalanceSchema),
]);

export const normalizedAdditionalComponentSchema = z
  .object({
    component_id: uuidSchema,
    source_label: z.string().trim().min(1).max(160),
    normalized_label: domainCodeSchema.nullable(),
    quantity_raw: z.string().nullable(),
    rate_raw: z.string().nullable(),
    amount_raw: z.string().nullable(),
    confidence: confidenceSchema,
    source: candidateSourceSchema,
    extraction_method: extractionMethodSchema,
    warning_flags: z.array(candidateWarningSchema),
    quantity: decimalStringSchema.nullable(),
    rate: moneySchema.nullable(),
    amount: moneySchema.nullable(),
    normalization_warnings: z.array(domainCodeSchema),
  })
  .strict();

export const normalizedPayslipExtractionSchema = z
  .object({
    extraction_id: z.uuid(),
    document_id: z.uuid(),
    status: extractionStatusSchema,
    detected_document_type: detectedDocumentTypeSchema,
    document_quality_confidence: confidenceSchema,
    quality_metrics: documentQualityMetricsSchema,
    fields: z.array(normalizedCandidateFieldSchema),
    additional_components: z.array(normalizedAdditionalComponentSchema),
    sensitive_metadata: z.array(sensitiveMetadataCandidateSchema),
    earnings_components_complete: z.boolean(),
    warnings: z.array(domainCodeSchema),
    provider: extractionProviderSchema,
    operation: extractionOperationSchema,
    extracted_at: z.iso.datetime({ offset: true }),
    error_code: domainCodeSchema.nullable(),
  })
  .strict();

export type SalaryPeriod = Readonly<z.infer<typeof salaryPeriodSchema>>;
export type NormalizedCandidateField = Readonly<z.infer<typeof normalizedCandidateFieldSchema>>;
export type NormalizedPayslipExtraction = Readonly<z.infer<typeof normalizedPayslipExtractionSchema>>;
