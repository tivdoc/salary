import { z } from "zod";
import { domainCodeSchema, uuidSchema } from "../domain/primitives";
import {
  extractionResultSchema,
  payslipFieldKeySchema,
  type PayslipFieldKey,
  type RawCandidateField,
} from "./contracts";
import {
  assessExtractionConfidence,
  criticalFieldThresholds,
  extractionConfidenceAssessmentSchema,
} from "./confidence-policy";
import { normalizePayslipExtraction } from "./normalization";
import { normalizedPayslipExtractionSchema, type NormalizedCandidateField } from "./payslip";
import {
  gate0ValidationSchema,
  validatePayslipGate0,
  type Gate0CriticalContext,
  type Gate0Validation,
} from "./validation";
import {
  extractionRegionSchema,
  payslipExtractionPassSchema,
  type ExtractionRegion,
  type PayslipExtractionPass,
} from "./v2";

export const PAYSLIP_EXTRACTION_V21_VERSION = "2.1";
export const PAYSLIP_V21_RESOLUTION_POLICY_VERSION = "payslip-v2.1-non-degrading-resolution-1";
export const RECOVERY_PROMOTION_MIN_CONFIDENCE = 0.9;

export const expectedInformationGainSchema = z.enum([
  "none",
  "missing_critical_field",
  "unreadable_critical_field",
  "low_confidence_critical_field",
  "structural_ambiguity",
]);
export type ExpectedInformationGain = z.infer<typeof expectedInformationGainSchema>;

export const targetedRecoveryPlanV21Schema = z
  .object({
    fields: z.array(payslipFieldKeySchema).min(1).max(4),
    regions: z.array(extractionRegionSchema).length(1),
    reason_codes: z.array(domainCodeSchema).min(1),
    expected_information_gain: expectedInformationGainSchema.exclude(["none"]),
  })
  .strict();
export type TargetedRecoveryPlanV21 = Readonly<z.infer<typeof targetedRecoveryPlanV21Schema>>;

export const recoveryDecisionSchema = z
  .object({
    requested: z.boolean(),
    skipped: z.boolean(),
    fields_requested: z.array(payslipFieldKeySchema).max(4),
    regions: z.array(extractionRegionSchema).max(1),
    reason_codes: z.array(domainCodeSchema).min(1),
    expected_information_gain: expectedInformationGainSchema,
  })
  .strict()
  .refine((decision) => decision.requested !== decision.skipped, {
    message: "Recovery must be either requested or skipped",
  });
export type RecoveryDecision = Readonly<z.infer<typeof recoveryDecisionSchema>>;

export const factResolutionStateSchema = z.enum([
  "confirmed",
  "candidate",
  "missing",
  "suspicious",
  "conflicted",
  "requires_confirmation",
  "recovered",
  "invalid",
]);
export type FactResolutionState = z.infer<typeof factResolutionStateSchema>;

export const fieldResolutionV21Schema = z
  .object({
    field: payslipFieldKeySchema,
    status: factResolutionStateSchema,
    first_pass_status: factResolutionStateSchema,
    first_pass_candidate_ids: z.array(uuidSchema),
    recovery_candidate_ids: z.array(uuidSchema),
    selected_candidate_id: uuidSchema.nullable(),
    reason_codes: z.array(domainCodeSchema),
  })
  .strict();
export type FieldResolutionV21 = Readonly<z.infer<typeof fieldResolutionV21Schema>>;

export const payslipExtractionV21ResultSchema = z
  .object({
    extractor_version: z.literal(PAYSLIP_EXTRACTION_V21_VERSION),
    resolution_policy_version: z.literal(PAYSLIP_V21_RESOLUTION_POLICY_VERSION),
    first_pass: payslipExtractionPassSchema,
    recovery_passes: z.array(payslipExtractionPassSchema).max(1),
    recovery_decision: recoveryDecisionSchema,
    resolutions: z.array(fieldResolutionV21Schema),
    historical_validation: gate0ValidationSchema,
    current_validation: gate0ValidationSchema,
    resolved_historical_issue_codes: z.array(domainCodeSchema),
    final_extraction: normalizedPayslipExtractionSchema,
    final_validation: gate0ValidationSchema,
    final_confidence_assessment: extractionConfidenceAssessmentSchema,
  })
  .strict();
export type PayslipExtractionV21Result = Readonly<z.infer<typeof payslipExtractionV21ResultSchema>>;

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

const regionPriority: readonly ExtractionRegion[] = ["pension", "totals", "earnings", "header"];
const gainPriority: Readonly<Record<ExpectedInformationGain, number>> = {
  none: 0,
  structural_ambiguity: 1,
  low_confidence_critical_field: 2,
  unreadable_critical_field: 3,
  missing_critical_field: 4,
};
const lowEvidenceCodes = new Set(["low_field_confidence", "ocr_value_ambiguous"]);
const unreadableWarningCodes = new Set(["unreadable_value", "ocr_ambiguous", "possible_scale_error", "ambiguous_value"]);
const deterministicallyResolvableHistoricalCodes = new Set([
  "critical_field_missing",
  "pension_relationship_incomplete",
]);
const promotionRejectCodes = new Set([
  "conflicting_candidates",
  "gross_component_mismatch",
  "hourly_salary_mismatch",
  "impossible_money_magnitude",
  "negative_money_value",
  "ocr_scale_mismatch",
  "payslip_totals_mismatch",
  "pension_contribution_mismatch",
  "pension_relationship_incomplete",
  "severance_contribution_mismatch",
  "suspicious_money_magnitude",
]);
const statusRank: Readonly<Record<Gate0Validation["status"], number>> = {
  valid: 0,
  suspicious: 1,
  requires_confirmation: 2,
  invalid: 3,
};

function uniqueFields(fields: readonly PayslipFieldKey[]) {
  return [...new Set(fields)].sort(
    (left, right) => payslipFieldKeySchema.options.indexOf(left) - payslipFieldKeySchema.options.indexOf(right),
  );
}

type RecoverySignal = {
  field: PayslipFieldKey;
  gain: Exclude<ExpectedInformationGain, "none">;
  reasons: Set<string>;
};

function addSignal(
  signals: Map<PayslipFieldKey, RecoverySignal>,
  field: PayslipFieldKey,
  gain: Exclude<ExpectedInformationGain, "none">,
  reason: string,
) {
  if (!(field in criticalFieldThresholds)) return;
  const current = signals.get(field);
  if (!current || gainPriority[gain] > gainPriority[current.gain]) {
    signals.set(field, { field, gain, reasons: new Set([...(current?.reasons ?? []), reason]) });
  } else {
    current.reasons.add(reason);
  }
}

export function selectTargetedRecoveryV21(passInput: PayslipExtractionPass): TargetedRecoveryPlanV21 | null {
  const pass = payslipExtractionPassSchema.parse(passInput);
  const signals = new Map<PayslipFieldKey, RecoverySignal>();

  for (const issue of pass.validation.issues) {
    if (issue.code === "critical_field_missing") {
      for (const field of issue.field_keys) addSignal(signals, field, "missing_critical_field", issue.code);
      continue;
    }
    if (issue.code === "conflicting_candidates") {
      for (const field of issue.field_keys) addSignal(signals, field, "structural_ambiguity", issue.code);
      continue;
    }
    if (issue.code === "normalization_failed") {
      for (const field of issue.field_keys) addSignal(signals, field, "unreadable_critical_field", issue.code);
    }
  }

  for (const assessment of pass.validation.field_assessments) {
    if (assessment.status === "valid" || assessment.status === "suspicious") continue;
    const candidate = pass.normalized_extraction.fields.find((item) => item.candidate_id === assessment.candidate_id);
    if (!candidate) continue;
    if (assessment.issue_codes.some((code) => lowEvidenceCodes.has(code))) {
      addSignal(signals, candidate.field, "low_confidence_critical_field", "low_confidence_or_ambiguous_critical_field");
    }
    if (candidate.warning_flags.some((code) => unreadableWarningCodes.has(code))) {
      addSignal(signals, candidate.field, "unreadable_critical_field", "unreadable_critical_field");
    }
  }

  const byRegion = new Map<ExtractionRegion, RecoverySignal[]>();
  for (const signal of signals.values()) {
    const region = recoveryRegionByField[signal.field];
    if (!region) continue;
    byRegion.set(region, [...(byRegion.get(region) ?? []), signal]);
  }
  if (byRegion.size === 0) return null;

  const rankedRegions = [...byRegion.entries()].sort(([leftRegion, left], [rightRegion, right]) => {
    const leftPriority = Math.max(...left.map((signal) => gainPriority[signal.gain]));
    const rightPriority = Math.max(...right.map((signal) => gainPriority[signal.gain]));
    if (leftPriority !== rightPriority) return rightPriority - leftPriority;
    if (left.length !== right.length) return right.length - left.length;
    return regionPriority.indexOf(leftRegion) - regionPriority.indexOf(rightRegion);
  });
  const [region, selectedSignals] = rankedRegions[0];
  const topGain = [...selectedSignals].sort((left, right) => gainPriority[right.gain] - gainPriority[left.gain])[0].gain;
  const fields = uniqueFields(selectedSignals.map((signal) => signal.field)).slice(0, 4);
  const reasonCodes = [...new Set(selectedSignals.flatMap((signal) => [...signal.reasons]))].sort();
  return targetedRecoveryPlanV21Schema.parse({
    fields,
    regions: [region],
    reason_codes: reasonCodes,
    expected_information_gain: topGain,
  });
}

export function recoveryDecisionForV21(plan: TargetedRecoveryPlanV21 | null): RecoveryDecision {
  return recoveryDecisionSchema.parse(plan
    ? {
        requested: true,
        skipped: false,
        fields_requested: plan.fields,
        regions: plan.regions,
        reason_codes: plan.reason_codes,
        expected_information_gain: plan.expected_information_gain,
      }
    : {
        requested: false,
        skipped: true,
        fields_requested: [],
        regions: [],
        reason_codes: ["recovery_skipped_no_material_gain"],
        expected_information_gain: "none",
      });
}

function assessmentFor(validation: Gate0Validation, candidateId: string) {
  return validation.field_assessments.find((assessment) => assessment.candidate_id === candidateId);
}

function candidatesFor(pass: PayslipExtractionPass, field: PayslipFieldKey) {
  return pass.normalized_extraction.fields.filter(
    (candidate) => candidate.field === field && candidate.normalized_value !== null,
  );
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

function rawCandidate(normalized: NormalizedCandidateField, candidates: ReadonlyMap<string, RawCandidateField>) {
  const raw = candidates.get(normalized.candidate_id);
  if (!raw) throw new TypeError(`Raw candidate is missing for ${normalized.candidate_id}`);
  return raw;
}

function firstPassStatus(pass: PayslipExtractionPass, candidates: readonly NormalizedCandidateField[]): FactResolutionState {
  if (candidates.length === 0) return "missing";
  if (groupedValues(candidates).size > 1) return "conflicted";
  const candidate = highestConfidence(candidates);
  const assessment = assessmentFor(pass.validation, candidate.candidate_id);
  if (assessment?.status === "invalid") return "invalid";
  if (assessment?.status === "requires_confirmation") return "requires_confirmation";
  if (assessment?.status === "suspicious") return "suspicious";
  const threshold = criticalFieldThresholds[candidate.field as keyof typeof criticalFieldThresholds] ?? 0.9;
  return candidate.confidence >= threshold ? "confirmed" : "candidate";
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

function buildFinalRaw(input: {
  firstPass: PayslipExtractionPass;
  passes: readonly PayslipExtractionPass[];
  fields: readonly RawCandidateField[];
  extractionId: string;
}) {
  const lastPass = input.passes.at(-1) ?? input.firstPass;
  const allPassesFailed = input.passes.every((pass) => pass.raw_extraction.status === "failed");
  return extractionResultSchema.parse({
    ...input.firstPass.raw_extraction,
    extraction_id: input.extractionId,
    status: allPassesFailed ? "failed" : input.fields.length > 1 ? "completed" : "partial",
    fields: input.fields,
    additional_components: input.firstPass.raw_extraction.additional_components,
    sensitive_metadata: input.firstPass.raw_extraction.sensitive_metadata,
    warnings: [...new Set(input.passes.flatMap((pass) => pass.raw_extraction.warnings))],
    provider: {
      provider_id: input.firstPass.raw_extraction.provider.provider_id,
      extractor_version: PAYSLIP_EXTRACTION_V21_VERSION,
      model_version: input.firstPass.model,
    },
    operation: aggregateOperation(input.passes),
    extracted_at: lastPass.raw_extraction.extracted_at,
    error_code: allPassesFailed ? (lastPass.raw_extraction.error_code ?? "extraction_failed") : null,
  });
}

function promotionThreshold(field: PayslipFieldKey) {
  return Math.max(
    RECOVERY_PROMOTION_MIN_CONFIDENCE,
    criticalFieldThresholds[field as keyof typeof criticalFieldThresholds] ?? RECOVERY_PROMOTION_MIN_CONFIDENCE,
  );
}

function issueStatus(severity: Gate0Validation["issues"][number]["severity"]): Gate0Validation["status"] {
  if (severity === "error") return "invalid";
  return severity === "confirmation" ? "requires_confirmation" : "suspicious";
}

function withResolutionConflicts(
  validation: Gate0Validation,
  resolutions: readonly FieldResolutionV21[],
): Gate0Validation {
  const conflicts = resolutions.filter((resolution) => resolution.status === "conflicted");
  if (conflicts.length === 0) return validation;
  const conflictIds = new Set(conflicts.flatMap((resolution) => resolution.first_pass_candidate_ids));
  const fieldAssessments = validation.field_assessments.map((assessment) => conflictIds.has(assessment.candidate_id)
    ? {
        ...assessment,
        status: "requires_confirmation" as const,
        issue_codes: [...new Set([...assessment.issue_codes, "recovery_conflict"])],
      }
    : assessment);
  const issues = [
    ...validation.issues,
    ...conflicts.map((resolution) => ({
      code: "recovery_conflict",
      severity: "confirmation" as const,
      field_candidate_ids: [...resolution.first_pass_candidate_ids, ...resolution.recovery_candidate_ids],
      field_keys: [resolution.field],
      message: "Recovery disagreed with an existing first-pass observation; neither observation is confirmed.",
    })),
  ];
  const status = statusRank[validation.status] > statusRank.requires_confirmation
    ? validation.status
    : "requires_confirmation";
  return gate0ValidationSchema.parse({ status, field_assessments: fieldAssessments, issues });
}

function mergeStickyValidation(input: {
  historical: Gate0Validation;
  current: Gate0Validation;
  recoveredFields: ReadonlySet<PayslipFieldKey>;
}) {
  const currentCodes = new Set(input.current.issues.map((issue) => issue.code));
  const resolvedHistorical = new Set<string>();
  for (const issue of input.historical.issues) {
    if (!deterministicallyResolvableHistoricalCodes.has(issue.code) || currentCodes.has(issue.code)) continue;
    if (issue.field_keys.some((field) => input.recoveredFields.has(field))) resolvedHistorical.add(issue.code);
  }
  const stickyIssues = input.historical.issues.filter((issue) => !resolvedHistorical.has(issue.code));
  const issueKeys = new Set(input.current.issues.map((issue) => JSON.stringify([
    issue.code,
    issue.field_candidate_ids,
    issue.field_keys,
  ])));
  const mergedIssues = [...input.current.issues];
  for (const issue of stickyIssues) {
    const key = JSON.stringify([issue.code, issue.field_candidate_ids, issue.field_keys]);
    if (!issueKeys.has(key)) mergedIssues.push(issue);
  }
  const historicalAssessment = new Map(input.historical.field_assessments.map((item) => [item.candidate_id, item]));
  const fieldAssessments = input.current.field_assessments.map((current) => {
    const historical = historicalAssessment.get(current.candidate_id);
    if (!historical) return current;
    const unresolvedCodes = historical.issue_codes.filter((code) => !resolvedHistorical.has(code));
    if (unresolvedCodes.length === 0) return current;
    return {
      ...current,
      status: statusRank[historical.status] > statusRank[current.status] ? historical.status : current.status,
      issue_codes: [...new Set([...current.issue_codes, ...unresolvedCodes])],
    };
  });
  const issueDerivedStatus = mergedIssues.reduce<Gate0Validation["status"]>((status, issue) => {
    const next = issueStatus(issue.severity);
    return statusRank[next] > statusRank[status] ? next : status;
  }, input.current.status);
  const status = fieldAssessments.reduce<Gate0Validation["status"]>(
    (current, assessment) => statusRank[assessment.status] > statusRank[current] ? assessment.status : current,
    issueDerivedStatus,
  );
  return {
    validation: gate0ValidationSchema.parse({ status, field_assessments: fieldAssessments, issues: mergedIssues }),
    resolvedHistoricalIssueCodes: [...resolvedHistorical].sort(),
  };
}

export function resolvePayslipExtractionPassesV21(input: {
  first_pass: PayslipExtractionPass;
  recovery_passes: readonly PayslipExtractionPass[];
  recovery_decision: RecoveryDecision;
  final_extraction_id: string;
  critical_context: Gate0CriticalContext;
  reference_year?: number;
}): PayslipExtractionV21Result {
  const firstPass = payslipExtractionPassSchema.parse(input.first_pass);
  const recoveryPasses = input.recovery_passes.map((pass) => payslipExtractionPassSchema.parse(pass));
  if (recoveryPasses.length > 1) throw new TypeError("V2.1 allows at most one recovery pass");
  const decision = recoveryDecisionSchema.parse(input.recovery_decision);
  if (decision.requested !== (recoveryPasses.length === 1)) {
    throw new TypeError("Recovery decision and executed recovery passes disagree");
  }
  const passes = [firstPass, ...recoveryPasses];
  const rawCandidates = rawByCandidateId(passes);
  const targetedFields = new Set(decision.fields_requested);
  const allFields = uniqueFields([
    ...firstPass.normalized_extraction.fields.map((field) => field.field),
    ...recoveryPasses.flatMap((pass) => pass.normalized_extraction.fields.map((field) => field.field)),
    ...decision.fields_requested,
  ]);
  const baseFields = firstPass.normalized_extraction.fields
    .filter((candidate) => candidate.normalized_value !== null)
    .map((candidate) => rawCandidate(candidate, rawCandidates));
  const resolutionDrafts = new Map<PayslipFieldKey, FieldResolutionV21>();
  const promotionCandidates = new Map<PayslipFieldKey, NormalizedCandidateField>();

  for (const field of allFields) {
    const firstCandidates = candidatesFor(firstPass, field);
    const recoveryCandidates = recoveryPasses.flatMap((pass) => candidatesFor(pass, field));
    const firstIds = firstCandidates.map((candidate) => candidate.candidate_id);
    const recoveryIds = recoveryCandidates.map((candidate) => candidate.candidate_id);
    const initialStatus = firstPassStatus(firstPass, firstCandidates);
    const firstGroups = groupedValues(firstCandidates);
    const recoveryGroups = groupedValues(recoveryCandidates);
    const firstCandidate = highestConfidence(firstCandidates);
    const recoveryCandidate = highestConfidence(recoveryCandidates);

    if (firstGroups.size > 1) {
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "conflicted",
        first_pass_status: "conflicted",
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: ["first_pass_conflict_preserved"],
      }));
      continue;
    }

    if (firstCandidate) {
      let status = initialStatus;
      let selectedCandidateId: string | null = firstCandidate.candidate_id;
      const reasonCodes = [targetedFields.has(field) ? "first_pass_preserved_during_recovery" : "first_pass_preserved"];
      if (recoveryGroups.size > 1) {
        status = "conflicted";
        selectedCandidateId = null;
        reasonCodes.push("recovery_within_pass_conflict");
      } else if (!recoveryCandidate) {
        if (targetedFields.has(field)) reasonCodes.push("recovery_missing_first_pass_preserved");
      } else if (JSON.stringify(firstCandidate.normalized_value) === JSON.stringify(recoveryCandidate.normalized_value)) {
        reasonCodes.push("correlated_recovery_agreement_preserved");
      } else {
        status = "conflicted";
        selectedCandidateId = null;
        reasonCodes.push("cross_pass_disagreement");
      }
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status,
        first_pass_status: initialStatus,
        first_pass_candidate_ids: firstIds,
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: selectedCandidateId,
        reason_codes: reasonCodes,
      }));
      continue;
    }

    if (!targetedFields.has(field) || !recoveryCandidate) {
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "missing",
        first_pass_status: "missing",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: [targetedFields.has(field) ? "recovery_missing" : "field_missing"],
      }));
      continue;
    }
    if (recoveryGroups.size > 1) {
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "conflicted",
        first_pass_status: "missing",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: ["recovery_within_pass_conflict"],
      }));
      continue;
    }

    const recoveryPass = recoveryPasses.find((pass) => pass.requested_fields.includes(field));
    const expectedRegion = recoveryRegionByField[field];
    const recoveryAssessment = recoveryPass
      ? assessmentFor(recoveryPass.validation, recoveryCandidate.candidate_id)
      : undefined;
    const preconditionsMet = recoveryPass !== undefined &&
      expectedRegion !== undefined &&
      recoveryPass.selected_regions.includes(expectedRegion) &&
      recoveryCandidate.confidence >= promotionThreshold(field) &&
      recoveryAssessment?.status === "valid";
    if (preconditionsMet) {
      promotionCandidates.set(field, recoveryCandidate);
    } else {
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "requires_confirmation",
        first_pass_status: "missing",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: recoveryIds,
        selected_candidate_id: null,
        reason_codes: ["recovery_candidate_not_promotable"],
      }));
    }
  }

  const provisionalFields = [
    ...baseFields,
    ...[...promotionCandidates.values()].map((candidate) => rawCandidate(candidate, rawCandidates)),
  ];
  const provisionalRaw = buildFinalRaw({
    firstPass,
    passes,
    fields: provisionalFields,
    extractionId: input.final_extraction_id,
  });
  const provisionalExtraction = normalizePayslipExtraction(provisionalRaw);
  const provisionalValidation = validatePayslipGate0(provisionalExtraction, {
    reference_year: input.reference_year,
    critical_context: input.critical_context,
  });
  const recoveredFields = new Set<PayslipFieldKey>();
  for (const [field, candidate] of promotionCandidates) {
    const assessment = assessmentFor(provisionalValidation, candidate.candidate_id);
    const deterministicContradiction = provisionalValidation.issues.some(
      (issue) => issue.field_keys.includes(field) && promotionRejectCodes.has(issue.code),
    );
    if (assessment?.status === "valid" && !deterministicContradiction) {
      recoveredFields.add(field);
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "recovered",
        first_pass_status: "missing",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: [candidate.candidate_id],
        selected_candidate_id: candidate.candidate_id,
        reason_codes: ["first_pass_missing", "recovery_candidate_promoted_with_deterministic_validation"],
      }));
    } else {
      resolutionDrafts.set(field, fieldResolutionV21Schema.parse({
        field,
        status: "requires_confirmation",
        first_pass_status: "missing",
        first_pass_candidate_ids: [],
        recovery_candidate_ids: [candidate.candidate_id],
        selected_candidate_id: null,
        reason_codes: ["recovery_candidate_rejected_by_deterministic_validation"],
      }));
    }
  }

  const finalFields = [
    ...baseFields,
    ...[...promotionCandidates.entries()]
      .filter(([field]) => recoveredFields.has(field))
      .map(([, candidate]) => rawCandidate(candidate, rawCandidates)),
  ];
  const finalRaw = buildFinalRaw({
    firstPass,
    passes,
    fields: finalFields,
    extractionId: input.final_extraction_id,
  });
  const finalExtraction = normalizePayslipExtraction(finalRaw);
  const resolutions = uniqueFields([...resolutionDrafts.keys()]).map((field) => resolutionDrafts.get(field)!);
  const deterministicValidation = validatePayslipGate0(finalExtraction, {
    reference_year: input.reference_year,
    critical_context: input.critical_context,
  });
  const currentValidation = withResolutionConflicts(deterministicValidation, resolutions);
  const sticky = mergeStickyValidation({
    historical: firstPass.validation,
    current: currentValidation,
    recoveredFields,
  });

  return payslipExtractionV21ResultSchema.parse({
    extractor_version: PAYSLIP_EXTRACTION_V21_VERSION,
    resolution_policy_version: PAYSLIP_V21_RESOLUTION_POLICY_VERSION,
    first_pass: firstPass,
    recovery_passes: recoveryPasses,
    recovery_decision: decision,
    resolutions,
    historical_validation: firstPass.validation,
    current_validation: currentValidation,
    resolved_historical_issue_codes: sticky.resolvedHistoricalIssueCodes,
    final_extraction: finalExtraction,
    final_validation: sticky.validation,
    final_confidence_assessment: assessExtractionConfidence(finalExtraction, sticky.validation),
  });
}
