import { z } from "zod";
import { confidenceSchema, domainCodeSchema } from "../domain/primitives";
import { payslipFieldKeySchema, type PayslipFieldKey } from "./contracts";
import { normalizedPayslipExtractionSchema, type NormalizedPayslipExtraction } from "./payslip";
import { gate0ValidationSchema, type Gate0Validation } from "./validation";

export const criticalFieldThresholds = {
  salary_period: 0.9,
  salary_type: 0.85,
  gross_salary: 0.9,
  total_deductions: 0.9,
  net_salary: 0.9,
  hourly_rate: 0.9,
  regular_hours: 0.85,
  pension_base: 0.92,
  pension_employee_contribution: 0.9,
  pension_employer_contribution: 0.9,
  severance_contribution: 0.9,
  overtime_125_hours: 0.85,
  overtime_150_hours: 0.85,
} as const satisfies Partial<Record<PayslipFieldKey, number>>;

export const criticalFieldDecisionSchema = z
  .object({
    field: payslipFieldKeySchema,
    applicable: z.boolean(),
    status: z.enum(["reliable", "needs_confirmation", "not_applicable"]),
    effective_confidence: confidenceSchema,
    threshold: confidenceSchema,
    candidate_ids: z.array(z.uuid()),
    reason_codes: z.array(domainCodeSchema),
  })
  .strict();

export const extractionConfidenceAssessmentSchema = z
  .object({ decisions: z.array(criticalFieldDecisionSchema) })
  .strict();

export type CriticalFieldDecision = Readonly<z.infer<typeof criticalFieldDecisionSchema>>;

function normalizedKey(value: unknown) {
  return JSON.stringify(value);
}

function applicableCriticalFields(extraction: NormalizedPayslipExtraction) {
  const result = new Set<PayslipFieldKey>(["salary_period", "gross_salary", "net_salary"]);
  const presentFields = new Set(extraction.fields.map((candidate) => candidate.field));
  if (presentFields.has("salary_type")) result.add("salary_type");
  const salaryTypes = extraction.fields
    .filter((candidate) => candidate.field === "salary_type")
    .map((candidate) => candidate.normalized_value);
  if (salaryTypes.some((value) => value === "hourly" || value === "mixed")) {
    result.add("hourly_rate");
    result.add("regular_hours");
  }

  if (presentFields.has("total_deductions")) result.add("total_deductions");
  const pensionSignals: PayslipFieldKey[] = [
    "pension_base",
    "pension_employee_contribution",
    "pension_employer_contribution",
    "severance_contribution",
    "pension_employee_rate",
    "pension_employer_rate",
    "severance_rate",
  ];
  if (pensionSignals.some((field) => presentFields.has(field))) {
    result.add("pension_base");
    if (presentFields.has("pension_employee_contribution") || presentFields.has("pension_employee_rate")) {
      result.add("pension_employee_contribution");
    }
    if (presentFields.has("pension_employer_contribution") || presentFields.has("pension_employer_rate")) {
      result.add("pension_employer_contribution");
    }
    if (presentFields.has("severance_contribution") || presentFields.has("severance_rate")) {
      result.add("severance_contribution");
    }
  }

  if (presentFields.has("overtime_125_hours")) result.add("overtime_125_hours");
  if (presentFields.has("overtime_150_hours")) result.add("overtime_150_hours");
  return result;
}

export function assessExtractionConfidence(
  extractionInput: NormalizedPayslipExtraction,
  validationInput: Gate0Validation,
) {
  const extraction = normalizedPayslipExtractionSchema.parse(extractionInput);
  const validation = gate0ValidationSchema.parse(validationInput);
  const applicable = applicableCriticalFields(extraction);
  const assessmentByCandidate = new Map(
    validation.field_assessments.map((assessment) => [assessment.candidate_id, assessment]),
  );

  const decisions = Object.entries(criticalFieldThresholds).map(([fieldName, threshold]) => {
    const field = fieldName as keyof typeof criticalFieldThresholds;
    if (!applicable.has(field)) {
      return {
        field,
        applicable: false,
        status: "not_applicable" as const,
        effective_confidence: 0,
        threshold,
        candidate_ids: [],
        reason_codes: [],
      };
    }

    const candidates = extraction.fields.filter(
      (candidate) => candidate.field === field && candidate.normalized_value !== null,
    );
    const candidateIds = candidates.map((candidate) => candidate.candidate_id);
    const reasons = new Set<string>();
    if (candidates.length === 0) reasons.add("critical_field_missing");

    const distinctValues = new Set(candidates.map((candidate) => normalizedKey(candidate.normalized_value)));
    if (distinctValues.size > 1) reasons.add("critical_field_conflict");
    if (candidates.some((candidate) => candidate.warning_flags.length > 0)) reasons.add("candidate_warning_present");

    let effectiveConfidence = candidates.length === 0
      ? 0
      : Math.min(
          extraction.document_quality_confidence,
          Math.max(...candidates.map((candidate) => candidate.confidence)),
        );
    for (const candidate of candidates) {
      const gateAssessment = assessmentByCandidate.get(candidate.candidate_id);
      if (!gateAssessment || gateAssessment.status === "valid") continue;
      reasons.add("gate0_requires_review");
      effectiveConfidence = Math.min(
        effectiveConfidence,
        gateAssessment.status === "invalid" ? 0.2 : gateAssessment.status === "requires_confirmation" ? 0.5 : 0.75,
      );
    }
    if (effectiveConfidence < threshold) reasons.add("below_field_threshold");

    return {
      field,
      applicable: true,
      status: reasons.size === 0 ? "reliable" as const : "needs_confirmation" as const,
      effective_confidence: effectiveConfidence,
      threshold,
      candidate_ids: candidateIds,
      reason_codes: [...reasons],
    };
  });

  return extractionConfidenceAssessmentSchema.parse({ decisions });
}
