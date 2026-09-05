import { z } from "zod";
import { immutableDocumentSchema } from "../domain/documents.ts";
import { isoTimestampSchema, uuidSchema, versionSchema } from "../domain/primitives.ts";
import { canonicalFactSchema, type CanonicalFact, type EvidenceReference } from "../facts/contracts.ts";
import { employmentSnapshotSchema } from "../facts/snapshot.ts";
import { factPathSchema, type FactPath } from "../facts/fact-paths.ts";
import { normalizedPayslipExtractionSchema, type NormalizedCandidateField, type NormalizedPayslipExtraction } from "./payslip.ts";
import { gate0ValidationSchema, type Gate0Validation } from "./validation.ts";

export const snapshotResolutionContextSchema = z
  .object({
    snapshot_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    schema_version: versionSchema,
    created_at: isoTimestampSchema,
    fact_ids: z.partialRecord(factPathSchema, uuidSchema),
  })
  .strict();

export type SnapshotResolutionContext = z.infer<typeof snapshotResolutionContextSchema>;

export const resolvedPayslipFactPaths = [
  "documents.period",
  "employment.start_date",
  "compensation.salary_type",
  "compensation.base_monthly_salary",
  "compensation.hourly_rate",
  "compensation.gross_salary",
  "compensation.net_salary",
  "work.regular_hours",
  "work.overtime_125_hours",
  "work.overtime_150_hours",
  "work.overtime_hours",
  "pension.base_salary",
  "pension.contributions",
  "pension.severance_contribution",
  "travel.reimbursement",
  "convalescence.payment",
  "leave.vacation_balance",
  "leave.sick_balance",
] as const satisfies readonly FactPath[];

const fieldToPath = {
  salary_period: "documents.period",
  employment_start_date: "employment.start_date",
  salary_type: "compensation.salary_type",
  base_monthly_salary: "compensation.base_monthly_salary",
  hourly_rate: "compensation.hourly_rate",
  gross_salary: "compensation.gross_salary",
  net_salary: "compensation.net_salary",
  regular_hours: "work.regular_hours",
  overtime_125_hours: "work.overtime_125_hours",
  overtime_150_hours: "work.overtime_150_hours",
  pension_base: "pension.base_salary",
  travel_amount: "travel.reimbursement",
  convalescence_amount: "convalescence.payment",
  vacation_balance: "leave.vacation_balance",
  sick_balance: "leave.sick_balance",
} as const;

const assessmentRank = { valid: 0, suspicious: 1, requires_confirmation: 2, invalid: 3 } as const;

function documentaryEvidence(field: NormalizedCandidateField): EvidenceReference {
  const locator = {
    page: field.source.page,
    ...(field.source.text_fragment ? { text_span: field.source.text_fragment } : {}),
    ...(field.source.bounding_box ? { bounding_box: field.source.bounding_box } : {}),
  };
  return {
    source_type: "documented",
    source_reference: { kind: "document", document_id: field.source.document_id, locator },
    // The extractor read it; no person has. The execution grade keeps it off `verified`.
    reading: "machine",
  };
}

function documentEvidence(documentId: string): EvidenceReference {
  return {
    source_type: "documented",
    source_reference: { kind: "document", document_id: documentId },
    reading: "machine",
  };
}

function addDecimals(values: readonly string[]) {
  const maximumScale = values.reduce((scale, value) => Math.max(scale, value.split(".")[1]?.length ?? 0), 0);
  const multiplier = BigInt(10) ** BigInt(maximumScale);
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    const sign = whole.startsWith("-") ? BigInt(-1) : BigInt(1);
    const absoluteWhole = whole.replace("-", "");
    const scaled = BigInt(absoluteWhole) * multiplier + BigInt(fraction.padEnd(maximumScale, "0") || "0");
    return sum + sign * scaled;
  }, BigInt(0));
  const negative = total < BigInt(0);
  const absoluteTotal = negative ? -total : total;
  const whole = absoluteTotal / multiplier;
  const fraction = (absoluteTotal % multiplier).toString().padStart(maximumScale, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function fieldAssessment(validation: Gate0Validation, candidateId: string) {
  return validation.field_assessments.find((assessment) => assessment.candidate_id === candidateId);
}

function selectFields(extraction: NormalizedPayslipExtraction, validation: Gate0Validation, names: readonly string[]) {
  return extraction.fields
    .filter((field) => names.includes(field.field) && field.normalized_value !== null)
    .filter((field) => fieldAssessment(validation, field.candidate_id)?.status !== "invalid")
    .sort((left, right) => right.confidence - left.confidence);
}

function factStatus(fields: readonly NormalizedCandidateField[], validation: Gate0Validation, documentQuality: number) {
  const assessments = fields
    .map((field) => fieldAssessment(validation, field.candidate_id))
    .filter((assessment): assessment is NonNullable<typeof assessment> => assessment !== undefined);
  const conflictIds = assessments
    .filter((assessment) => assessment.issue_codes.includes("conflicting_candidates"))
    .map((assessment) => assessment.candidate_id);
  if (conflictIds.length >= 2) return { status: "conflicted" as const, conflictIds };
  const worst = assessments.reduce<keyof typeof assessmentRank>(
    (current, assessment) => (assessmentRank[assessment.status] > assessmentRank[current] ? assessment.status : current),
    "valid",
  );
  if (worst === "requires_confirmation" || documentQuality < 0.65) {
    return { status: "needs_confirmation" as const, conflictIds: [] };
  }
  if (worst === "suspicious" || documentQuality < 0.9 || fields.some((field) => field.confidence < 0.9)) {
    return { status: "candidate" as const, conflictIds: [] };
  }
  return { status: "confirmed" as const, conflictIds: [] };
}

function makeFact(
  path: FactPath,
  value: unknown,
  fields: readonly NormalizedCandidateField[],
  documentId: string,
  validation: Gate0Validation,
  documentQuality: number,
  context: SnapshotResolutionContext,
): CanonicalFact {
  const factId = context.fact_ids[path];
  if (!factId) throw new TypeError(`A deterministic fact ID is required for ${path}`);
  if (fields.length === 0 || value === null) {
    return canonicalFactSchema.parse({
      fact_id: factId,
      case_id: context.case_id,
      path,
      value: null,
      status: "missing",
      provenance: [documentEvidence(documentId)],
      confidence: documentQuality,
      conflicting_fact_ids: [],
      resolution: null,
      created_at: context.created_at,
    });
  }
  const disposition = factStatus(fields, validation, documentQuality);
  return canonicalFactSchema.parse({
    fact_id: factId,
    case_id: context.case_id,
    path,
    value: disposition.status === "conflicted" ? null : value,
    status: disposition.status,
    provenance: fields.map(documentaryEvidence),
    confidence: Math.min(documentQuality, ...fields.map((field) => field.confidence)),
    conflicting_fact_ids: disposition.conflictIds,
    resolution: null,
    created_at: context.created_at,
  });
}

export function resolvePayslipSnapshot(input: {
  document: unknown;
  extraction: NormalizedPayslipExtraction;
  validation: Gate0Validation;
  context: SnapshotResolutionContext;
}) {
  const document = immutableDocumentSchema.parse(input.document);
  const extraction = normalizedPayslipExtractionSchema.parse(input.extraction);
  const validation = gate0ValidationSchema.parse(input.validation);
  const context = snapshotResolutionContextSchema.parse(input.context);
  if (document.case_id !== context.case_id || document.document_id !== extraction.document_id) {
    throw new TypeError("Snapshot resolution inputs must reference one case and document");
  }

  const facts = new Map<FactPath, CanonicalFact>();
  for (const [field, path] of Object.entries(fieldToPath)) {
    const candidates = selectFields(extraction, validation, [field]);
    const selected = candidates[0];
    let value: unknown = selected?.normalized_value ?? null;
    if (path === "documents.period" && selected?.field === "salary_period" && selected.normalized_value) {
      value = {
        document_id: document.document_id,
        period: {
          start_date: selected.normalized_value.start_date,
          end_date: selected.normalized_value.end_date,
        },
      };
    }
    facts.set(
      path,
      makeFact(path, value, candidates, document.document_id, validation, extraction.document_quality_confidence, context),
    );
  }

  const overtimeFields = selectFields(extraction, validation, ["overtime_125_hours", "overtime_150_hours"]);
  const overtimeAmounts = overtimeFields.map((field) => (field.normalized_value as { amount: string }).amount);
  facts.set(
    "work.overtime_hours",
    makeFact(
      "work.overtime_hours",
      overtimeAmounts.length > 0 ? { amount: addDecimals(overtimeAmounts), unit: "hours_per_month" } : null,
      overtimeFields,
      document.document_id,
      validation,
      extraction.document_quality_confidence,
      context,
    ),
  );

  const periodField = selectFields(extraction, validation, ["salary_period"])[0];
  const period = periodField?.field === "salary_period" && periodField.normalized_value
    ? { start_date: periodField.normalized_value.start_date, end_date: periodField.normalized_value.end_date }
    : null;
  const pensionFields = selectFields(extraction, validation, [
    "pension_employee_contribution",
    "pension_employer_contribution",
    "pension_employee_rate",
    "pension_employer_rate",
  ]);
  const findPension = (name: string) => pensionFields.find((field) => field.field === name);
  const employeeAmount = findPension("pension_employee_contribution")?.normalized_value as { currency: string; minor_units: number } | null | undefined;
  const employerAmount = findPension("pension_employer_contribution")?.normalized_value as { currency: string; minor_units: number } | null | undefined;
  const employeeRate = findPension("pension_employee_rate")?.normalized_value as { basis_points: number } | null | undefined;
  const employerRate = findPension("pension_employer_rate")?.normalized_value as { basis_points: number } | null | undefined;
  const pensionValue = period && pensionFields.length > 0
    ? {
        employee: employeeAmount || employeeRate
          ? { amount: employeeAmount ?? null, rate_basis_points: employeeRate?.basis_points ?? null }
          : null,
        employer: employerAmount || employerRate
          ? { amount: employerAmount ?? null, rate_basis_points: employerRate?.basis_points ?? null }
          : null,
        period,
      }
    : null;
  facts.set(
    "pension.contributions",
    makeFact(
      "pension.contributions",
      pensionValue,
      pensionFields,
      document.document_id,
      validation,
      extraction.document_quality_confidence,
      context,
    ),
  );

  const severanceFields = selectFields(extraction, validation, ["severance_contribution", "severance_rate"]);
  const severanceAmount = severanceFields.find((field) => field.field === "severance_contribution")?.normalized_value as { currency: string; minor_units: number } | null | undefined;
  const severanceRate = severanceFields.find((field) => field.field === "severance_rate")?.normalized_value as { basis_points: number } | null | undefined;
  facts.set(
    "pension.severance_contribution",
    makeFact(
      "pension.severance_contribution",
      severanceAmount || severanceRate
        ? { amount: severanceAmount ?? null, rate_basis_points: severanceRate?.basis_points ?? null }
        : null,
      severanceFields,
      document.document_id,
      validation,
      extraction.document_quality_confidence,
      context,
    ),
  );

  for (const path of resolvedPayslipFactPaths) {
    if (!facts.has(path)) {
      facts.set(
        path,
        makeFact(path, null, [], document.document_id, validation, extraction.document_quality_confidence, context),
      );
    }
  }

  return employmentSnapshotSchema.parse({
    snapshot_id: context.snapshot_id,
    case_id: context.case_id,
    analysis_run_id: context.analysis_run_id,
    schema_version: context.schema_version,
    facts: resolvedPayslipFactPaths.map((path) => facts.get(path)),
    created_at: context.created_at,
  });
}
