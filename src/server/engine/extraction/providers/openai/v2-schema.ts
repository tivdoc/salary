import "server-only";
import { z } from "zod";
import { extractionRegionSchema } from "@/engine/extraction/v2";
import { openAiExtractionWarningSchema, openAiModelConfidenceSchema } from "./schema";

const evidenceSchema = z
  .object({
    page: z.number().int().positive().max(100).nullable(),
    region: extractionRegionSchema.nullable(),
    source_label: z.string().trim().min(1).max(160).nullable(),
  })
  .strict();

export const openAiV2ValueCandidateSchema = z
  .object({
    raw_value: z.string().trim().min(1).max(500),
    confidence: openAiModelConfidenceSchema,
    evidence: evidenceSchema,
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

const genericFieldSchema = z
  .object({
    field: z.enum([
      "salary_period",
      "employment_start_date",
      "vacation_balance",
      "sick_balance",
    ]),
    candidates: z.array(openAiV2ValueCandidateSchema).max(3),
  })
  .strict();

const payrollRowSchema = z
  .object({
    source_label: z.string().trim().min(1).max(160),
    semantic_kind: z.enum([
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
    ]),
    quantity_raw: z.string().trim().min(1).max(120).nullable(),
    rate_raw: z.string().trim().min(1).max(120).nullable(),
    percentage_raw: z.string().trim().min(1).max(120).nullable(),
    amount_raw: z.string().trim().min(1).max(120).nullable(),
    confidence: openAiModelConfidenceSchema,
    evidence: evidenceSchema,
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

const contributionSchema = z
  .object({
    rate_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
    amount_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
  })
  .strict();

const salaryTypeSchema = z
  .object({
    documented_value: z.enum(["monthly", "hourly", "mixed"]).nullable(),
    documented_raw_value: z.string().trim().min(1).max(500).nullable(),
    documented_confidence: openAiModelConfidenceSchema,
    documented_evidence: evidenceSchema,
    inferred_value: z.enum(["monthly", "hourly", "mixed"]).nullable(),
    inferred_confidence: openAiModelConfidenceSchema,
    inference_basis: z.array(z.enum(["hourly_rate", "regular_hours", "payroll_structure"])),
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

export const openAiPayslipV2StructuredOutputSchema = z
  .object({
    detected_document_type: z.enum(["payslip", "unknown"]),
    document_quality: z.enum(["high", "medium", "low"]),
    page_count: z.number().int().positive().max(100),
    rotation_degrees: z.number().min(-360).max(360).nullable(),
    source_resolution_dpi: z.number().int().positive().max(10_000).nullable(),
    salary_type: salaryTypeSchema,
    generic_fields: z.array(genericFieldSchema),
    payroll_rows: z.array(payrollRowSchema).max(200),
    totals: z
      .object({
        visible: z.boolean(),
        gross_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
        deductions_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
        net_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
      })
      .strict(),
    pension: z
      .object({
        visible: z.boolean(),
        base_candidates: z.array(openAiV2ValueCandidateSchema).max(3),
        employee: contributionSchema,
        employer: contributionSchema,
        severance: contributionSchema,
      })
      .strict(),
    earnings_components_complete: z.boolean(),
    warnings: z.array(openAiExtractionWarningSchema),
  })
  .strict();

export type OpenAiPayslipV2StructuredOutput = Readonly<z.infer<typeof openAiPayslipV2StructuredOutputSchema>>;
