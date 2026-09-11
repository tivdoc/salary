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

// Keep the original r5 contract available for replay/audit. R6 adds a valid
// location for separately printed observations; no old value is rewritten.
export const openAiPayslipV2R5StructuredOutputSchema = z
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

export const OPENAI_PAYSLIP_V2_OBSERVATION_SCHEMA_VERSION='payslip-v2-header-observations-v1' as const;
export const openAiPayslipV2R6StructuredOutputSchema=openAiPayslipV2R5StructuredOutputSchema.extend({
 generic_fields:z.array(genericFieldSchema.extend({field:z.enum([
  'salary_period','employment_start_date','vacation_balance','sick_balance','regular_hours','hourly_rate',
 ])}).strict()),
}).strict();

// R7 changes transcription instructions, not the structured source vocabulary.
export const openAiPayslipV2StructuredOutputSchema=openAiPayslipV2R6StructuredOutputSchema;

// R8 adds source-scope evidence without changing any R5/R6/R7 parser or bytes.
export const openAiV2SourceScopeSchema=z.object({
 period_kind:z.enum(['current','cumulative','retroactive','unknown']),
 fund_kind:z.enum(['pension','study','severance','combined','unknown']),
 column_label:z.string().trim().min(1).max(160).nullable(),
}).strict();
const evidenceR8=evidenceSchema.extend({source_scope:openAiV2SourceScopeSchema}).strict();
const candidateR8=openAiV2ValueCandidateSchema.extend({evidence:evidenceR8}).strict();
const contributionR8=z.object({rate_candidates:z.array(candidateR8).max(8),amount_candidates:z.array(candidateR8).max(8)}).strict();
export const openAiPayslipV2R8StructuredOutputSchema=openAiPayslipV2R6StructuredOutputSchema.extend({
 schema_version:z.literal('payslip-v2-source-scope-r8'),
 salary_type:salaryTypeSchema.extend({documented_evidence:evidenceR8}).strict(),
 generic_fields:z.array(z.object({field:z.enum(['salary_period','employment_start_date','vacation_balance','sick_balance','regular_hours','hourly_rate']),candidates:z.array(candidateR8).max(8)}).strict()),
 payroll_rows:z.array(payrollRowSchema.extend({evidence:evidenceR8}).strict()).max(200),
 totals:z.object({visible:z.boolean(),gross_candidates:z.array(candidateR8).max(8),deductions_candidates:z.array(candidateR8).max(8),net_candidates:z.array(candidateR8).max(8)}).strict(),
 pension:z.object({visible:z.boolean(),base_candidates:z.array(candidateR8).max(8),employee:contributionR8,employer:contributionR8,severance:contributionR8}).strict(),
}).strict();
export const openAiPayslipV2AcceptedOutputSchema=z.union([openAiPayslipV2R8StructuredOutputSchema,openAiPayslipV2StructuredOutputSchema]);
export type OpenAiPayslipV2StructuredOutput = Readonly<z.infer<typeof openAiPayslipV2StructuredOutputSchema>>;
export type OpenAiPayslipV2AcceptedOutput = Readonly<z.infer<typeof openAiPayslipV2AcceptedOutputSchema>>;
