import { z } from "zod";
import { confidenceSchema, domainCodeSchema, uuidSchema } from "../domain/primitives.ts";
import {
  extractionResultSchema,
  payslipFieldKeySchema,
  type ExtractionResult,
  type PayslipFieldKey,
  type RawCandidateField,
} from "./contracts.ts";
import {
  assessExtractionConfidence,
  criticalFieldThresholds,
  extractionConfidenceAssessmentSchema,
} from "./confidence-policy.ts";
import { normalizePayslipExtraction } from "./normalization.ts";
import { normalizedPayslipExtractionSchema, type NormalizedCandidateField } from "./payslip.ts";
import {
  gate0ValidationSchema,
  validatePayslipGate0,
  type Gate0CriticalContext,
  type Gate0Validation,
} from "./validation.ts";

export const PAYSLIP_EXTRACTION_V2_VERSION = "2.0";
export const PAYSLIP_V2_RESOLUTION_POLICY_VERSION = "payslip-v2-resolution-1";

export const extractionRegionSchema = z.enum(["header", "earnings", "totals", "pension"]);
export type ExtractionRegion = z.infer<typeof extractionRegionSchema>;

const salaryTypeValueSchema = z.enum(["monthly", "hourly", "mixed"]);
export const salaryTypeAssessmentSchema = z
  .object({
    documented: z
      .object({
        value: salaryTypeValueSchema,
        raw_value: z.string().trim().min(1).max(500),
        confidence: confidenceSchema,
        candidate_id: uuidSchema,
      })
      .strict()
      .nullable(),
    inferred: z
      .object({
        value: salaryTypeValueSchema,
        confidence: confidenceSchema,
        basis: z
          .array(z.enum(["hourly_rate", "regular_hours", "payroll_structure"]))
          .min(1)
          .refine((items) => new Set(items).size === items.length, "Inference basis values must be unique"),
        warning_flags: z.array(domainCodeSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type SalaryTypeAssessment = Readonly<z.infer<typeof salaryTypeAssessmentSchema>>;

export const payslipExtractionPassSchema = z
  .object({
    pass_id: uuidSchema,
    kind: z.enum(["first_pass", "targeted_recovery"]),
    requested_fields: z.array(payslipFieldKeySchema),
    selected_regions: z.array(extractionRegionSchema).max(4),
    prompt_version: domainCodeSchema,
    model: z.string().trim().min(1).max(200),
    raw_extraction: extractionResultSchema,
    normalized_extraction: normalizedPayslipExtractionSchema,
    validation: gate0ValidationSchema,
    confidence_assessment: extractionConfidenceAssessmentSchema,
    salary_type_assessment: salaryTypeAssessmentSchema,
    pension_section_visible: z.boolean(),
    totals_section_visible: z.boolean(),
  })
  .strict();

export type PayslipExtractionPass = Readonly<z.infer<typeof payslipExtractionPassSchema>>;

export const targetedRecoveryPlanSchema = z
  .object({
    fields: z.array(payslipFieldKeySchema).min(1),
    regions: z.array(extractionRegionSchema).min(1).max(4),
    reason_codes: z.array(domainCodeSchema).min(1),
  })
  .strict();

export type TargetedRecoveryPlan = Readonly<z.infer<typeof targetedRecoveryPlanSchema>>;

export const fieldResolutionSchema = z
  .object({
    field: payslipFieldKeySchema,
    status: z.enum([
      "first_pass",
      "promoted_recovery",
      "cross_pass_agreement",
      "conflicted",
      "missing",
      "invalid",
    ]),
    first_pass_candidate_ids: z.array(uuidSchema),
    recovery_candidate_ids: z.array(uuidSchema),
    selected_candidate_id: uuidSchema.nullable(),
    reason_codes: z.array(domainCodeSchema),
  })
  .strict();

export type FieldResolution = Readonly<z.infer<typeof fieldResolutionSchema>>;

export const payslipExtractionV2ResultSchema = z
  .object({
    extractor_version: z.literal(PAYSLIP_EXTRACTION_V2_VERSION),
    resolution_policy_version: z.literal(PAYSLIP_V2_RESOLUTION_POLICY_VERSION),
    first_pass: payslipExtractionPassSchema,
    recovery_passes: z.array(payslipExtractionPassSchema),
    resolutions: z.array(fieldResolutionSchema),
    final_extraction: normalizedPayslipExtractionSchema,
    final_validation: gate0ValidationSchema,
    final_confidence_assessment: extractionConfidenceAssessmentSchema,
  })
  .strict();

export type PayslipExtractionV2Result = Readonly<z.infer<typeof payslipExtractionV2ResultSchema>>;

const recoveryRegionByField: Readonly<Partial<Record<PayslipFieldKey, ExtractionRegion>>> = {
  salary_period: "header",
  employment_start_date: "header",
  salary_type: "header",
  base_monthly_salary: "earnings",
  hourly_rate: "earnings",
  regular_hours: "earnings",
  overtime_125_hours: "earnings",
  overtime_150_hours: "earnings",
  travel_amount: "earnings",
  convalescence_amount: "earnings",
  gross_salary: "totals",
  total_deductions: "totals",
  net_salary: "totals",
  pension_base: "pension",
  pension_employee_rate: "pension",
  pension_employee_contribution: "pension",
  pension_employer_rate: "pension",
  pension_employer_contribution: "pension",
  severance_rate: "pension",
  severance_contribution: "pension",
};

const regionPriority: readonly ExtractionRegion[] = ["totals", "pension", "earnings", "header"];

function uniqueFields(fields: readonly PayslipFieldKey[]) {
  return [...new Set(fields)].sort((left, right) => payslipFieldKeySchema.options.indexOf(left) - payslipFieldKeySchema.options.indexOf(right));
}

export function selectTargetedRecovery(passInput: PayslipExtractionPass): TargetedRecoveryPlan | null {
  const pass = payslipExtractionPassSchema.parse(passInput);
  const fields: PayslipFieldKey[] = [];
  const reasons = new Set<string>();
  for (const decision of pass.confidence_assessment.decisions) {
    if (!decision.applicable || decision.status !== "needs_confirmation") continue;
    fields.push(decision.field);
    for (const reason of decision.reason_codes) reasons.add(reason);
  }
  for (const issue of pass.validation.issues) {
    if (issue.severity === "warning" && issue.code !== "conflicting_candidates") continue;
    for (const field of issue.field_keys) {
      if (field in criticalFieldThresholds) fields.push(field);
    }
    if (issue.field_keys.length > 0) reasons.add(issue.code);
  }
  if (pass.salary_type_assessment.documented === null && pass.salary_type_assessment.inferred !== null) {
    fields.push("salary_type");
    reasons.add("salary_type_inferred_not_documented");
  }
  const selectedFields = uniqueFields(fields);
  if (selectedFields.length === 0) return null;
  const presentRegions = new Set(selectedFields.map((field) => recoveryRegionByField[field]).filter(Boolean));
  const regions = regionPriority.filter((region) => presentRegions.has(region));
  return targetedRecoveryPlanSchema.parse({
    fields: selectedFields,
    regions,
    reason_codes: [...reasons].sort(),
  });
}

function assessmentFor(validation: Gate0Validation, candidateId: string) {
  return validation.field_assessments.find((assessment) => assessment.candidate_id === candidateId);
}

function usableCandidates(pass: PayslipExtractionPass, field: PayslipFieldKey) {
  return pass.normalized_extraction.fields
    .filter((candidate) => candidate.field === field && candidate.normalized_value !== null)
    .filter((candidate) => assessmentFor(pass.validation, candidate.candidate_id)?.status !== "invalid");
}

function groupedValues(candidates: readonly NormalizedCandidateField[]) {
  const groups = new Map<string, NormalizedCandidateField[]>();
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate.normalized_value);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  return groups;
}

function highestConfidence(candidates: readonly NormalizedCandidateField[]) {
  return [...candidates].sort((left, right) => right.confidence - left.confidence)[0];
}

function rawByCandidateId(passes: readonly PayslipExtractionPass[]) {
  return new Map(
    passes.flatMap((pass) => pass.raw_extraction.fields.map((candidate) => [candidate.candidate_id, candidate] as const)),
  );
}

function rawCandidate(
  normalized: NormalizedCandidateField,
  candidates: ReadonlyMap<string, RawCandidateField>,
  confidenceBoost = 0,
): RawCandidateField {
  const raw = candidates.get(normalized.candidate_id);
  if (!raw) throw new TypeError(`Raw candidate is missing for ${normalized.candidate_id}`);
  return {
    ...raw,
    confidence: Math.min(0.99, raw.confidence + confidenceBoost),
    warning_flags: confidenceBoost > 0
      ? [...new Set([...raw.warning_flags, "cross_pass_agreement"])]
      : raw.warning_flags,
  };
}

function aggregateOperation(passes: readonly PayslipExtractionPass[]) {
  const usages = passes.map((pass) => pass.raw_extraction.operation.token_usage);
  return {
    duration_ms: passes.reduce((total, pass) => total + pass.raw_extraction.operation.duration_ms, 0),
    provider_response_id: null,
    token_usage: usages.every((usage) => usage !== null)
      ? {
          input_tokens: usages.reduce((total, usage) => total + (usage?.input_tokens ?? 0), 0),
          output_tokens: usages.reduce((total, usage) => total + (usage?.output_tokens ?? 0), 0),
          total_tokens: usages.reduce((total, usage) => total + (usage?.total_tokens ?? 0), 0),
        }
      : null,
  };
}

export function buildPassEvaluation(input: {
  pass_id: string;
  kind: "first_pass" | "targeted_recovery";
  requested_fields: readonly PayslipFieldKey[];
  selected_regions: readonly ExtractionRegion[];
  prompt_version: string;
  model: string;
  raw_extraction: ExtractionResult;
  salary_type_assessment: SalaryTypeAssessment;
  pension_section_visible: boolean;
  totals_section_visible: boolean;
  critical_context: Gate0CriticalContext;
  reference_year?: number;
}): PayslipExtractionPass {
  const raw = extractionResultSchema.parse(input.raw_extraction);
  const normalized = normalizePayslipExtraction(raw);
  const validation = validatePayslipGate0(normalized, {
    reference_year: input.reference_year,
    critical_context: input.critical_context,
  });
  return payslipExtractionPassSchema.parse({
    pass_id: input.pass_id,
    kind: input.kind,
    requested_fields: uniqueFields(input.requested_fields),
    selected_regions: input.selected_regions,
    prompt_version: input.prompt_version,
    model: input.model,
    raw_extraction: raw,
    normalized_extraction: normalized,
    validation,
    confidence_assessment: assessExtractionConfidence(normalized, validation),
    salary_type_assessment: input.salary_type_assessment,
    pension_section_visible: input.pension_section_visible,
    totals_section_visible: input.totals_section_visible,
  });
}

export function resolvePayslipExtractionPasses(input: {
  first_pass: PayslipExtractionPass;
  recovery_passes: readonly PayslipExtractionPass[];
  final_extraction_id: string;
  critical_context: Gate0CriticalContext;
  reference_year?: number;
}): PayslipExtractionV2Result {
  const firstPass = payslipExtractionPassSchema.parse(input.first_pass);
  const recoveryPasses = input.recovery_passes.map((pass) => payslipExtractionPassSchema.parse(pass));
  const passes = [firstPass, ...recoveryPasses];
  const rawCandidates = rawByCandidateId(passes);
  const finalFields: RawCandidateField[] = [];
  const resolutions: FieldResolution[] = [];
  const targetedFields = new Set(recoveryPasses.flatMap((pass) => pass.requested_fields));
  const allFields = uniqueFields([
    ...passes.flatMap((pass) => pass.normalized_extraction.fields.map((field) => field.field)),
    ...targetedFields,
  ]);

  for (const field of allFields) {
    const firstCandidates = usableCandidates(firstPass, field);
    const recoveryCandidates = recoveryPasses.flatMap((pass) => usableCandidates(pass, field));
    const firstIds = firstCandidates.map((candidate) => candidate.candidate_id);
    const recoveryIds = recoveryCandidates.map((candidate) => candidate.candidate_id);

    if (!targetedFields.has(field)) {
      for (const candidate of firstCandidates) finalFields.push(rawCandidate(candidate, rawCandidates));
      resolutions.push({
        field,
        status: firstCandidates.length > 0 ? "first_pass" : "missing",
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: [],
        selected_candidate_id: highestConfidence(firstCandidates)?.candidate_id ?? null,
        reason_codes: firstCandidates.length > 0 ? [] : ["field_missing"],
      });
      continue;
    }

    const firstGroups = groupedValues(firstCandidates);
    const recoveryGroups = groupedValues(recoveryCandidates);
    if (firstGroups.size > 1 || recoveryGroups.size > 1) {
      for (const candidate of [...firstCandidates, ...recoveryCandidates]) {
        finalFields.push(rawCandidate(candidate, rawCandidates));
      }
      resolutions.push({
        field,
        status: "conflicted",
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: ["within_pass_conflict"],
      });
      continue;
    }

    const firstCandidate = highestConfidence(firstCandidates);
    const recoveryCandidate = highestConfidence(recoveryCandidates);
    if (!recoveryCandidate) {
      resolutions.push({
        field,
        status: firstCandidate && assessmentFor(firstPass.validation, firstCandidate.candidate_id)?.status === "invalid"
          ? "invalid"
          : "missing",
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: ["recovery_missing"],
      });
      continue;
    }
    if (!firstCandidate) {
      finalFields.push(rawCandidate(recoveryCandidate, rawCandidates));
      resolutions.push({
        field,
        status: "promoted_recovery",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: recoveryCandidate.candidate_id,
        reason_codes: ["first_pass_missing", "recovery_candidate_promoted"],
      });
      continue;
    }
    if (JSON.stringify(firstCandidate.normalized_value) === JSON.stringify(recoveryCandidate.normalized_value)) {
      const selected = recoveryCandidate.confidence >= firstCandidate.confidence ? recoveryCandidate : firstCandidate;
      finalFields.push(rawCandidate(selected, rawCandidates, 0.03));
      resolutions.push({
        field,
        status: "cross_pass_agreement",
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: selected.candidate_id,
        reason_codes: ["independent_pass_agreement"],
      });
      continue;
    }
    finalFields.push(rawCandidate(firstCandidate, rawCandidates));
    finalFields.push(rawCandidate(recoveryCandidate, rawCandidates));
    resolutions.push({
      field,
      status: "conflicted",
      first_pass_candidate_ids: firstIds,
      recovery_candidate_ids: recoveryIds,
      selected_candidate_id: null,
      reason_codes: ["cross_pass_disagreement"],
    });
  }

  const lastPass = passes.at(-1) ?? firstPass;
  const allPassesFailed = passes.every((pass) => pass.raw_extraction.status === "failed");
  const finalRaw = extractionResultSchema.parse({
    ...firstPass.raw_extraction,
    extraction_id: input.final_extraction_id,
    status: allPassesFailed ? "failed" : finalFields.length > 1 ? "completed" : "partial",
    fields: finalFields,
    additional_components: firstPass.raw_extraction.additional_components,
    warnings: [...new Set(passes.flatMap((pass) => pass.raw_extraction.warnings))],
    provider: {
      provider_id: firstPass.raw_extraction.provider.provider_id,
      extractor_version: PAYSLIP_EXTRACTION_V2_VERSION,
      model_version: firstPass.model,
    },
    operation: aggregateOperation(passes),
    extracted_at: lastPass.raw_extraction.extracted_at,
    error_code: allPassesFailed ? (lastPass.raw_extraction.error_code ?? "extraction_failed") : null,
  });
  const finalExtraction = normalizePayslipExtraction(finalRaw);
  const finalValidation = validatePayslipGate0(finalExtraction, {
    reference_year: input.reference_year,
    critical_context: input.critical_context,
  });
  return payslipExtractionV2ResultSchema.parse({
    extractor_version: PAYSLIP_EXTRACTION_V2_VERSION,
    resolution_policy_version: PAYSLIP_V2_RESOLUTION_POLICY_VERSION,
    first_pass: firstPass,
    recovery_passes: recoveryPasses,
    resolutions,
    final_extraction: finalExtraction,
    final_validation: finalValidation,
    final_confidence_assessment: assessExtractionConfidence(finalExtraction, finalValidation),
  });
}
