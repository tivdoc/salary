import { z } from "zod";
import { domainCodeSchema, uuidSchema } from "../domain/primitives.ts";
import { payslipFieldKeySchema } from "./contracts.ts";
import { normalizedPayslipExtractionSchema, type NormalizedCandidateField, type NormalizedPayslipExtraction } from "./payslip.ts";

export const gate0StatusSchema = z.enum(["valid", "suspicious", "invalid", "requires_confirmation"]);
export const validationSeveritySchema = z.enum(["warning", "error", "confirmation"]);

export const gate0IssueSchema = z
  .object({
    code: domainCodeSchema,
    severity: validationSeveritySchema,
    field_candidate_ids: z.array(uuidSchema),
    field_keys: z.array(payslipFieldKeySchema).default([]),
    message: z.string().trim().min(1).max(500),
  })
  .strict();

export const fieldAssessmentSchema = z
  .object({
    candidate_id: uuidSchema,
    field: payslipFieldKeySchema,
    status: gate0StatusSchema,
    issue_codes: z.array(domainCodeSchema),
  })
  .strict();

export const gate0ValidationSchema = z
  .object({
    status: gate0StatusSchema,
    field_assessments: z.array(fieldAssessmentSchema),
    issues: z.array(gate0IssueSchema),
  })
  .strict();

export type Gate0Validation = Readonly<z.infer<typeof gate0ValidationSchema>>;
export type Gate0CriticalContext = Readonly<{
  required_fields?: readonly z.infer<typeof payslipFieldKeySchema>[];
  hourly_analysis_implied?: boolean;
  pension_section_visible?: boolean;
  totals_section_visible?: boolean;
}>;

type MutableAssessment = {
  candidate_id: string;
  field: z.infer<typeof payslipFieldKeySchema>;
  status: z.infer<typeof gate0StatusSchema>;
  issue_codes: string[];
};

const statusRank = { valid: 0, suspicious: 1, requires_confirmation: 2, invalid: 3 } as const;
const moneyFields = new Set([
  "base_monthly_salary",
  "hourly_rate",
  "gross_salary",
  "total_deductions",
  "net_salary",
  "travel_amount",
  "convalescence_amount",
  "pension_employee_contribution",
  "pension_employer_contribution",
  "severance_contribution",
  "pension_base",
]);
const hoursFields = new Set(["regular_hours", "overtime_125_hours", "overtime_150_hours"]);
const percentageFields = new Set(["pension_employee_rate", "pension_employer_rate", "severance_rate"]);

function worsen(assessment: MutableAssessment, status: MutableAssessment["status"], code: string) {
  if (statusRank[status] > statusRank[assessment.status]) assessment.status = status;
  if (!assessment.issue_codes.includes(code)) assessment.issue_codes.push(code);
}

function decimalFraction(value: string) {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const denominator = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(`${match[1]}${match[2]}${fraction}`);
  return { numerator, denominator };
}

function absolute(value: bigint) {
  return value < BigInt(0) ? -value : value;
}

function firstField(extraction: NormalizedPayslipExtraction, field: string) {
  return extraction.fields.find((candidate) => candidate.field === field && candidate.normalized_value !== null);
}

function moneyMinorUnits(field: NormalizedCandidateField | undefined) {
  if (!field || !moneyFields.has(field.field) || field.normalized_value === null) return null;
  return (field.normalized_value as { minor_units: number }).minor_units;
}

function hoursAmount(field: NormalizedCandidateField | undefined) {
  if (!field || !hoursFields.has(field.field) || field.normalized_value === null) return null;
  return (field.normalized_value as { amount: string }).amount;
}

function percentageBasisPoints(field: NormalizedCandidateField | undefined) {
  if (!field || !percentageFields.has(field.field) || field.normalized_value === null) return null;
  return (field.normalized_value as { basis_points: number }).basis_points;
}

function scaledDifferenceIsLarge(actualScaled: bigint, expectedScaled: bigint, denominator: bigint, percent: number) {
  const difference = absolute(actualScaled - expectedScaled);
  const exceedsAbsoluteTolerance = difference > BigInt(100) * denominator;
  const exceedsPercentTolerance = difference * BigInt(100) > absolute(expectedScaled) * BigInt(percent);
  return exceedsAbsoluteTolerance && exceedsPercentTolerance;
}

function nearPowerOfTenScale(actualScaled: bigint, expectedScaled: bigint) {
  if (actualScaled === BigInt(0) || expectedScaled === BigInt(0)) return false;
  return [10, 100].some((factor) => {
    const scaledExpected = expectedScaled * BigInt(factor);
    const scaledActual = actualScaled * BigInt(factor);
    return (
      absolute(actualScaled - scaledExpected) * BigInt(10) <= absolute(scaledExpected) ||
      absolute(scaledActual - expectedScaled) * BigInt(10) <= absolute(expectedScaled)
    );
  });
}

export function validatePayslipGate0(
  input: NormalizedPayslipExtraction,
  options: {
    reference_year?: number;
    critical_context?: Gate0CriticalContext;
  } = {},
): Gate0Validation {
  const extraction = normalizedPayslipExtractionSchema.parse(input);
  const referenceYear = options.reference_year ?? new Date().getUTCFullYear();
  const assessments = new Map<string, MutableAssessment>(
    extraction.fields.map((field) => [
      field.candidate_id,
      { candidate_id: field.candidate_id, field: field.field, status: "valid", issue_codes: [] },
    ]),
  );
  const issues: z.infer<typeof gate0IssueSchema>[] = [];
  let globalStatus: MutableAssessment["status"] = "valid";

  const addIssue = (
    code: string,
    status: MutableAssessment["status"],
    severity: z.infer<typeof validationSeveritySchema>,
    fields: readonly NormalizedCandidateField[],
    message: string,
  ) => {
    const ids = fields.map((field) => field.candidate_id);
    issues.push({ code, severity, field_candidate_ids: ids, field_keys: [...new Set(fields.map((field) => field.field))], message });
    for (const id of ids) {
      const assessment = assessments.get(id);
      if (assessment) worsen(assessment, status, code);
    }
  };

  const addContextIssue = (
    code: string,
    status: MutableAssessment["status"],
    severity: z.infer<typeof validationSeveritySchema>,
    fieldKeys: readonly z.infer<typeof payslipFieldKeySchema>[],
    message: string,
  ) => {
    issues.push({ code, severity, field_candidate_ids: [], field_keys: [...new Set(fieldKeys)], message });
    if (statusRank[status] > statusRank[globalStatus]) globalStatus = status;
  };

  if (extraction.status === "failed") {
    globalStatus = "invalid";
    issues.push({
      code: "extraction_failed",
      severity: "error",
      field_candidate_ids: [],
      field_keys: [],
      message: "The extraction provider did not produce candidate fields.",
    });
  } else if (extraction.document_quality_confidence < 0.65) {
    globalStatus = "requires_confirmation";
    issues.push({
      code: "low_document_quality",
      severity: "confirmation",
      field_candidate_ids: [],
      field_keys: [],
      message: "Document quality is too low for automatic confirmation.",
    });
  } else if (extraction.document_quality_confidence < 0.9) {
    globalStatus = "suspicious";
    issues.push({
      code: "moderate_document_quality",
      severity: "warning",
      field_candidate_ids: [],
      field_keys: [],
      message: "Document quality is below the automatic-confirmation threshold.",
    });
  }

  for (const field of extraction.fields) {
    if (field.normalized_value === null) {
      addIssue("normalization_failed", "invalid", "error", [field], "A field could not be normalized deterministically.");
      continue;
    }
    if (field.confidence < 0.65) {
      addIssue("low_field_confidence", "requires_confirmation", "confirmation", [field], "A low-confidence field requires confirmation.");
    } else if (field.confidence < 0.9) {
      addIssue("moderate_field_confidence", "suspicious", "warning", [field], "A field is below the automatic-confirmation threshold.");
    }
    if (field.warning_flags.includes("ocr_ambiguous") || field.warning_flags.includes("possible_scale_error")) {
      addIssue("ocr_value_ambiguous", "requires_confirmation", "confirmation", [field], "OCR evidence indicates an ambiguous value or scale.");
    }

    if (field.field === "salary_period") {
      const period = field.normalized_value as { month: number; year: number };
      if (period.month < 1 || period.month > 12 || period.year < 1990 || period.year > referenceYear + 1) {
        addIssue("invalid_salary_period", "invalid", "error", [field], "The salary period is outside the supported range.");
      }
    } else if (moneyFields.has(field.field)) {
      const minorUnits = (field.normalized_value as { minor_units: number }).minor_units;
      if (minorUnits < 0) {
        addIssue("negative_money_value", "invalid", "error", [field], "A non-negative payslip amount was extracted as negative.");
      } else if (minorUnits > 100_000_000) {
        addIssue("impossible_money_magnitude", "invalid", "error", [field], "A payslip amount has an implausible magnitude.");
      } else if (minorUnits > 20_000_000) {
        addIssue("suspicious_money_magnitude", "suspicious", "warning", [field], "A payslip amount has an unusually large magnitude.");
      }
    } else if (hoursFields.has(field.field)) {
      const decimal = decimalFraction((field.normalized_value as { amount: string }).amount);
      if (!decimal) continue;
      if (decimal.numerator < BigInt(0)) {
        addIssue("negative_hours", "invalid", "error", [field], "Worked hours cannot be negative.");
      } else if (decimal.numerator > BigInt(744) * decimal.denominator) {
        addIssue("impossible_hours", "invalid", "error", [field], "Monthly hours exceed the number of hours in a 31-day month.");
      } else if (decimal.numerator > BigInt(350) * decimal.denominator) {
        addIssue("suspicious_hours", "suspicious", "warning", [field], "Monthly hours are unusually high.");
      }
    } else if (percentageFields.has(field.field)) {
      const basisPoints = (field.normalized_value as { basis_points: number }).basis_points;
      if (basisPoints < 0 || basisPoints > 10_000) {
        addIssue("invalid_percentage", "invalid", "error", [field], "A contribution percentage is outside zero to one hundred percent.");
      }
    }
  }

  for (const fieldName of new Set(extraction.fields.map((field) => field.field))) {
    const duplicates = extraction.fields.filter((field) => field.field === fieldName && field.normalized_value !== null);
    if (duplicates.length < 2) continue;
    const values = new Set(duplicates.map((field) => JSON.stringify(field.normalized_value)));
    if (values.size > 1) {
      addIssue("conflicting_candidates", "requires_confirmation", "confirmation", duplicates, "Multiple extracted candidates disagree for the same field.");
    } else {
      addIssue("duplicate_candidate", "suspicious", "warning", duplicates, "The same field was extracted more than once.");
    }
  }

  const mappedComponents = new Map<string, typeof extraction.additional_components>();
  for (const component of extraction.additional_components) {
    if (component.normalized_label === null) continue;
    const group = mappedComponents.get(component.normalized_label) ?? [];
    mappedComponents.set(component.normalized_label, [...group, component]);
  }
  for (const components of mappedComponents.values()) {
    if (components.length < 2) continue;
    if (statusRank.suspicious > statusRank[globalStatus]) globalStatus = "suspicious";
    issues.push({
      code: "duplicate_mapped_component",
      severity: "warning",
      field_candidate_ids: components.map((component) => component.component_id),
      field_keys: [],
      message: "The same normalized additional component was mapped more than once.",
    });
  }

  const hourlyRateField = firstField(extraction, "hourly_rate");
  const regularHoursField = firstField(extraction, "regular_hours");
  const baseSalaryField = firstField(extraction, "base_monthly_salary");
  const hourlyRate = moneyMinorUnits(hourlyRateField);
  const regularHours = hoursAmount(regularHoursField);
  const baseSalary = moneyMinorUnits(baseSalaryField);
  if (hourlyRate !== null && regularHours !== null && baseSalary !== null && hourlyRateField && regularHoursField && baseSalaryField) {
    const hours = decimalFraction(regularHours);
    if (hours) {
      const expectedScaled = BigInt(hourlyRate) * hours.numerator;
      const actualScaled = BigInt(baseSalary) * hours.denominator;
      if (nearPowerOfTenScale(actualScaled, expectedScaled)) {
        addIssue("ocr_scale_mismatch", "requires_confirmation", "confirmation", [hourlyRateField, regularHoursField, baseSalaryField], "Related salary fields differ by an apparent factor of ten.");
      } else if (scaledDifferenceIsLarge(actualScaled, expectedScaled, hours.denominator, 5)) {
        addIssue("hourly_salary_mismatch", "suspicious", "warning", [hourlyRateField, regularHoursField, baseSalaryField], "Hourly rate and regular hours do not reconcile with the parsed base component.");
      }
    }
  }

  for (const side of ["employee", "employer"] as const) {
    const baseField = firstField(extraction, "pension_base");
    const rateField = firstField(extraction, `pension_${side}_rate`);
    const contributionField = firstField(extraction, `pension_${side}_contribution`);
    const base = moneyMinorUnits(baseField);
    const rate = percentageBasisPoints(rateField);
    const contribution = moneyMinorUnits(contributionField);
    if (base !== null && rate !== null && contribution !== null && baseField && rateField && contributionField) {
      const expectedScaled = BigInt(base) * BigInt(rate);
      const actualScaled = BigInt(contribution) * BigInt(10_000);
      if (scaledDifferenceIsLarge(actualScaled, expectedScaled, BigInt(10_000), 3)) {
        addIssue("pension_contribution_mismatch", "suspicious", "warning", [baseField, rateField, contributionField], "A pension contribution does not reconcile with its parsed base and percentage.");
      }
    }
  }

  const severanceBaseField = firstField(extraction, "pension_base");
  const severanceRateField = firstField(extraction, "severance_rate");
  const severanceAmountField = firstField(extraction, "severance_contribution");
  const severanceBase = moneyMinorUnits(severanceBaseField);
  const severanceRate = percentageBasisPoints(severanceRateField);
  const severanceAmount = moneyMinorUnits(severanceAmountField);
  if (
    severanceBase !== null && severanceRate !== null && severanceAmount !== null &&
    severanceBaseField && severanceRateField && severanceAmountField
  ) {
    const expectedScaled = BigInt(severanceBase) * BigInt(severanceRate);
    const actualScaled = BigInt(severanceAmount) * BigInt(10_000);
    if (scaledDifferenceIsLarge(actualScaled, expectedScaled, BigInt(10_000), 3)) {
      addIssue(
        "severance_contribution_mismatch",
        "suspicious",
        "warning",
        [severanceBaseField, severanceRateField, severanceAmountField],
        "The severance contribution does not reconcile with its parsed base and percentage.",
      );
    }
  }

  const grossField = firstField(extraction, "gross_salary");
  const deductionsField = firstField(extraction, "total_deductions");
  const netField = firstField(extraction, "net_salary");
  const grossTotal = moneyMinorUnits(grossField);
  const deductionsTotal = moneyMinorUnits(deductionsField);
  const netTotal = moneyMinorUnits(netField);
  if (
    grossTotal !== null && deductionsTotal !== null && netTotal !== null &&
    grossField && deductionsField && netField
  ) {
    const expectedNet = grossTotal - deductionsTotal;
    if (scaledDifferenceIsLarge(BigInt(netTotal), BigInt(expectedNet), BigInt(1), 2)) {
      addIssue(
        "payslip_totals_mismatch",
        "requires_confirmation",
        "confirmation",
        [grossField, deductionsField, netField],
        "Gross, deductions, and net totals do not reconcile technically.",
      );
    }
  }

  if (extraction.earnings_components_complete) {
    const gross = moneyMinorUnits(grossField);
    const knownComponentFields = ["base_monthly_salary", "travel_amount", "convalescence_amount"]
      .map((field) => firstField(extraction, field))
      .filter((field): field is NormalizedCandidateField => field !== undefined);
    const componentAmounts = knownComponentFields.map(moneyMinorUnits).filter((value): value is number => value !== null);
    const additionalAmounts = extraction.additional_components.map((component) => component.amount?.minor_units ?? 0);
    if (gross !== null && grossField && componentAmounts.length > 0) {
      const componentSum = [...componentAmounts, ...additionalAmounts].reduce((sum, value) => sum + value, 0);
      if (nearPowerOfTenScale(BigInt(gross), BigInt(componentSum))) {
        addIssue("ocr_scale_mismatch", "requires_confirmation", "confirmation", [grossField, ...knownComponentFields], "Gross salary and parsed components differ by an apparent factor of ten.");
      } else if (scaledDifferenceIsLarge(BigInt(gross), BigInt(componentSum), BigInt(1), 3)) {
        addIssue("gross_component_mismatch", "suspicious", "warning", [grossField, ...knownComponentFields], "Gross salary does not reconcile with the complete parsed component set.");
      }
    }
  }

  const requiredFields = new Set(options.critical_context?.required_fields ?? []);
  if (options.critical_context?.hourly_analysis_implied) {
    requiredFields.add("hourly_rate");
    requiredFields.add("regular_hours");
  }
  if (options.critical_context?.pension_section_visible) requiredFields.add("pension_base");
  if (options.critical_context?.totals_section_visible) {
    requiredFields.add("gross_salary");
    requiredFields.add("total_deductions");
    requiredFields.add("net_salary");
  }
  for (const field of requiredFields) {
    if (firstField(extraction, field)) continue;
    addContextIssue(
      "critical_field_missing",
      "requires_confirmation",
      "confirmation",
      [field],
      `A contextually critical field is missing: ${field}.`,
    );
  }

  if (options.critical_context?.pension_section_visible) {
    const pensionRelationships = [
      ["pension_employee_rate", "pension_employee_contribution"],
      ["pension_employer_rate", "pension_employer_contribution"],
      ["severance_rate", "severance_contribution"],
    ] as const;
    for (const [rateField, amountField] of pensionRelationships) {
      const ratePresent = firstField(extraction, rateField) !== undefined;
      const amountPresent = firstField(extraction, amountField) !== undefined;
      if (ratePresent === amountPresent) continue;
      addContextIssue(
        "pension_relationship_incomplete",
        "requires_confirmation",
        "confirmation",
        [rateField, amountField, "pension_base"],
        "A visible pension row is missing its base, rate, or amount relationship.",
      );
    }
  }

  const fieldAssessments = [...assessments.values()];
  const status = fieldAssessments.reduce<MutableAssessment["status"]>(
    (current, assessment) => (statusRank[assessment.status] > statusRank[current] ? assessment.status : current),
    globalStatus,
  );
  return gate0ValidationSchema.parse({ status, field_assessments: fieldAssessments, issues });
}
