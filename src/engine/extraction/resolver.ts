import { z } from "zod";
import { immutableDocumentSchema } from "../domain/documents.ts";
import { isoTimestampSchema, uuidSchema, versionSchema } from "../domain/primitives.ts";
import { canonicalFactSchema, type CanonicalFact, type EvidenceReference } from "../facts/contracts.ts";
import { employmentSnapshotSchema } from "../facts/snapshot.ts";
import { factPathSchema, type FactPath } from "../facts/fact-paths.ts";
import { normalizedPayslipExtractionSchema, type NormalizedCandidateField, type NormalizedPayslipExtraction } from "./payslip.ts";
import { gate0ValidationSchema, validatePayslipGate0, type Gate0Validation } from "./validation.ts";
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {CustomerDocumentReading} from './customer-reading.ts';
import {materializeValidatedPayslipReadings} from './reading-resolution.ts';

// Opt-in analysis policy. Its absence preserves the old serialized snapshots;
// it is never supplied by OCR and does not change an extraction checkpoint.
export const IDENTIFIED_AGREEING_CANDIDATES_POLICY='identified-agreeing-candidates-v1' as const;
const identifiedReadingIssueCodes=['low_field_confidence','moderate_field_confidence','ocr_value_ambiguous','recovery_reading_confirmation_required'] as const;

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

function documentaryEvidence(field: NormalizedCandidateField,reading?:CustomerDocumentReading): EvidenceReference {
  const locator = {
    page: field.source.page,
    ...(field.source.text_fragment ? { text_span: field.source.text_fragment } : {}),
    ...(field.source.bounding_box ? { bounding_box: field.source.bounding_box } : {}),
  };
  return {
    source_type: "documented",
    source_reference: { kind: "document", document_id: field.source.document_id, locator },
    read_by: "machine",
    verified: reading!==undefined,
    ...(reading?{customer_confirmation:reading}:{}),
  };
}

function documentEvidence(documentId: string): EvidenceReference {
  return {
    source_type: "documented",
    source_reference: { kind: "document", document_id: documentId },
    read_by: "machine",
    verified: false,
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
  if (worst === "suspicious" || documentQuality < 0.95 || fields.some((field) => field.confidence < 0.95)) {
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
  readings:ReadonlyMap<string,CustomerDocumentReading>,
  observedFields:readonly NormalizedCandidateField[],
  readingPolicy?:typeof IDENTIFIED_AGREEING_CANDIDATES_POLICY,
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
  // Cell confirmation resolves only uncertainty in reading. Reconciliation,
  // impossible values and cross-source conflicts retain their original gates.
  // Only the explicit new policy can discharge equal duplicates, after every
  // observed candidate has its own identified source reading.
  const singleField=Object.entries(fieldToPath).find(([,mapped])=>mapped===path)?.[0];
  const observed=singleField?observedFields.filter(field=>field.field===singleField):[];
  const newGroup=readingPolicy===IDENTIFIED_AGREEING_CANDIDATES_POLICY&&singleField!==undefined&&observed.length>1;
  const groupComplete=!newGroup||(observed.length===fields.length&&new Set(observed.map(f=>f.candidate_id)).size===observed.length
    &&observed.every(f=>f.normalized_value!==null&&fieldAssessment(validation,f.candidate_id)?.status!=='invalid'));
  const identified=fields.map(field=>readings.get(field.candidate_id));
  const agreeingIdentifiedGroup=newGroup&&groupComplete&&validation.status!=='invalid'
    &&new Set(fields.map(f=>canonicalSha256(f.normalized_value))).size===1
    &&identified.every((r):r is CustomerDocumentReading=>r!==undefined)
    &&new Set(identified.map(r=>r.request_id)).size===fields.length&&new Set(identified.map(r=>r.target_sha256)).size===fields.length;
  const confirmed=groupComplete&&fields.every(field=>readings.has(field.candidate_id)&&
    fieldAssessment(validation,field.candidate_id)?.issue_codes.every(code=>identifiedReadingIssueCodes.some(allowed=>allowed===code)
      ||agreeingIdentifiedGroup&&code==='duplicate_candidate'));
  return canonicalFactSchema.parse({
    fact_id: factId,
    case_id: context.case_id,
    path,
    value: disposition.status === "conflicted" ? null : value,
    status: confirmed?'confirmed':!groupComplete&&disposition.status==='confirmed'?'needs_confirmation':disposition.status,
    provenance: fields.map(field=>documentaryEvidence(field,readings.get(field.candidate_id))),
    // This is the source grade of an explicit customer reading, not an increase
    // to the saved model's confidence (which remains in the original checkpoint).
    confidence: confirmed?1:Math.min(documentQuality, ...fields.map((field) => field.confidence)),
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
  reading_policy?:typeof IDENTIFIED_AGREEING_CANDIDATES_POLICY;
}) {
  const document = immutableDocumentSchema.parse(input.document);
  let extraction = normalizedPayslipExtractionSchema.parse(input.extraction);
  let validation = gate0ValidationSchema.parse(input.validation);
  const context = snapshotResolutionContextSchema.parse(input.context);
  if(input.reading_policy!==undefined&&input.reading_policy!==IDENTIFIED_AGREEING_CANDIDATES_POLICY)throw new TypeError('DOCUMENT_READING_POLICY_UNSUPPORTED');
  if (document.case_id !== context.case_id || document.document_id !== extraction.document_id) {
    throw new TypeError("Snapshot resolution inputs must reference one case and document");
  }
  const materialized=materializeValidatedPayslipReadings({document,extraction,case_id:context.case_id,requireDistinctTargets:input.reading_policy===IDENTIFIED_AGREEING_CANDIDATES_POLICY});
  const readings=materialized.readings;
  if(materialized.hasCorrections){
    const options={reference_year:Number(context.created_at.slice(0,4)),component_duplicate_policy:validation.component_duplicate_policy};
    const originalDefault=validatePayslipGate0(extraction,options),supplied=validation;
    extraction=materialized.extraction;
    validation=validatePayslipGate0(extraction,options);
    // Recompute arithmetic affected by the changed cell, but preserve caller
    // gates/critical context that default Gate0 does not know how to recreate.
    for(const assessment of supplied.field_assessments){
      const oldCodes=originalDefault.field_assessments.find(a=>a.candidate_id===assessment.candidate_id)?.issue_codes??[];
      const extra=assessment.issue_codes.filter(code=>!oldCodes.includes(code));
      const current=validation.field_assessments.find(a=>a.candidate_id===assessment.candidate_id);
      if(current&&extra.length){
        current.issue_codes=[...new Set([...current.issue_codes,...extra])];
        if(assessmentRank[assessment.status]>assessmentRank[current.status])current.status=assessment.status;
        if(assessmentRank[assessment.status]>assessmentRank[validation.status])validation.status=assessment.status;
      }
    }
    validation.issues.push(...supplied.issues.filter(issue=>!originalDefault.issues.some(old=>canonicalSha256(old)===canonicalSha256(issue))));
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
      makeFact(path, value, candidates, document.document_id, validation, extraction.document_quality_confidence, context,readings,extraction.fields,input.reading_policy),
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
      readings,
      extraction.fields,input.reading_policy,
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
      readings,
      extraction.fields,input.reading_policy,
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
      readings,
      extraction.fields,input.reading_policy,
    ),
  );

  for (const path of resolvedPayslipFactPaths) {
    if (!facts.has(path)) {
      facts.set(
        path,
        makeFact(path, null, [], document.document_id, validation, extraction.document_quality_confidence, context,readings,extraction.fields,input.reading_policy),
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
