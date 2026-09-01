import { describe, expect, it } from "vitest";
import type { ImmutableDocument } from "../domain/documents.ts";
import type { CanonicalFact } from "../facts/contracts.ts";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { registerRuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import {
  buildMultiDocumentIntake,
  multiDocumentIntakeCanonicalBytes,
  type RuleInputScopeRequirement,
} from "./multi-document-intake.ts";
import type { ExtractionResult } from "./contracts.ts";

const CASE_ID = id(1);
const ANALYSIS_ID = id(2);

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function document(
  number: number,
  documentType: string,
  startDate: string,
  endDate = startDate,
  options: Readonly<{ sha?: string; supersedes?: string | null }> = {},
): ImmutableDocument {
  const documentId = id(number);
  return {
    document_id: documentId,
    case_id: CASE_ID,
    document_type: documentType,
    original_filename: `synthetic-${number}.pdf`,
    mime_type: "application/pdf",
    size_bytes: 128,
    content_sha256: options.sha ?? number.toString(16).padStart(64, "0"),
    storage_path: `cases/${CASE_ID}/documents/${documentId}/original.pdf`,
    document_period: { start_date: startDate, end_date: endDate },
    supersedes_document_id: options.supersedes ?? null,
    created_at: "2031-01-01T00:00:00.000Z",
  };
}

function extraction(
  number: number,
  source: ImmutableDocument,
  status: "completed" | "partial" | "failed" = "completed",
  sensitive: readonly Readonly<{ kind: "employee_name" | "employer_name" | "national_id"; value: string }>[] = [],
): ExtractionResult {
  return {
    extraction_id: id(100 + number),
    document_id: source.document_id,
    status,
    detected_document_type: source.document_type === "payslip" ? "payslip" : "unknown",
    document_quality_confidence: status === "failed" ? 0 : 0.9,
    quality_metrics: { page_count: 1, text_coverage: 0.9, rotation_degrees: 0, source_resolution_dpi: 300 },
    fields: [],
    additional_components: [],
    sensitive_metadata: sensitive.map((entry, index) => ({
      metadata_id: id(500 + number * 10 + index),
      kind: entry.kind,
      raw_value: entry.value,
      confidence: 0.99,
      source: { document_id: source.document_id, page: 1 },
      extraction_method: "fixture",
    })),
    earnings_components_complete: status === "completed",
    warnings: status === "partial" ? ["synthetic.partial"] : [],
    provider: { provider_id: "synthetic.fixture", extractor_version: "1.0.0", model_version: null },
    operation: { duration_ms: 1, provider_response_id: null, token_usage: null },
    extracted_at: "2031-01-02T00:00:00.000Z",
    error_code: status === "failed" ? "synthetic.failure" : null,
  };
}

function documented(documentId: string) {
  return [{
    source_type: "documented" as const,
    source_reference: { kind: "document" as const, document_id: documentId, locator: { page: 1 } },
  }];
}

function factBase<TPath extends CanonicalFact["path"]>(number: number, path: TPath, documentId: string) {
  return {
    fact_id: id(800 + number),
    case_id: CASE_ID,
    path,
    provenance: documented(documentId),
    confidence: 0.95,
    conflicting_fact_ids: [],
    resolution: null,
    created_at: "2031-01-03T00:00:00.000Z",
  };
}

function scenario() {
  const payslips: ImmutableDocument[] = [];
  let number = 10;
  for (const month of ["01", "02", "03", "04", "05", "07", "08", "09", "10", "11", "12"]) {
    payslips.push(document(number, "payslip", `2030-${month}-01`, `2030-${month}-28`));
    number += 1;
  }
  const originalFebruary = payslips[1]!;
  const correctedFebruary = document(30, "payslip", "2030-02-01", "2030-02-28", { supersedes: originalFebruary.document_id });
  const duplicateJanuary = document(31, "payslip", "2030-01-01", "2030-01-28", { sha: payslips[0]!.content_sha256 });
  const agreement = document(32, "employment_agreement", "2030-01-01", "2030-01-31");
  const attendance = document(33, "attendance", "2030-03-01", "2030-03-31");
  const pension = document(34, "pension_deposit", "2030-03-01", "2030-03-31");
  const travel = document(35, "travel", "2030-05-01", "2030-05-31");
  const leave = document(36, "leave_absence", "2030-09-01", "2030-09-30");
  const termination = document(37, "termination", "2030-12-01", "2030-12-31");
  const documents = [...payslips, correctedFebruary, duplicateJanuary, agreement, attendance, pension, travel, leave, termination];
  const extractions = documents.map((entry, index) => extraction(
    index + 1,
    entry,
    entry.document_id === travel.document_id ? "partial" : "completed",
    entry.document_id === agreement.document_id
      ? [{ kind: "employer_name", value: "SYNTHETIC EMPLOYER A" }]
      : entry.document_id === payslips[0]!.document_id
        ? [{ kind: "employer_name", value: "SYNTHETIC EMPLOYER B" }]
        : [],
  ));
  const conflictOne = id(990);
  const conflictTwo = id(991);
  const pensionConflictOne = id(992);
  const pensionConflictTwo = id(993);
  const facts: CanonicalFact[] = [
    {
      ...factBase(1, "work.regular_hours", attendance.document_id),
      status: "conflicted",
      value: null,
      conflicting_fact_ids: [conflictOne, conflictTwo],
    },
    {
      ...factBase(2, "pension.contributions", pension.document_id),
      status: "conflicted",
      value: null,
      conflicting_fact_ids: [pensionConflictOne, pensionConflictTwo],
    },
    {
      ...factBase(3, "travel.reimbursement", travel.document_id),
      status: "missing",
      value: null,
    },
    {
      ...factBase(4, "employment.end_date", termination.document_id),
      status: "confirmed",
      value: "2031-01-15",
    },
  ];
  const factSnapshot: EmploymentSnapshot = {
    snapshot_id: id(700),
    case_id: CASE_ID,
    analysis_run_id: ANALYSIS_ID,
    schema_version: "1.0.0",
    facts,
    created_at: "2031-01-03T00:00:00.000Z",
  };
  const registry = registerRuleInputMappingRegistry({
    registry_id: "multi.document.registry",
    registry_version: "1.0.0",
    mappings: [
      mapping("input.regular_hours", "work.regular_hours", "hours_per_month"),
      mapping("input.pension", "pension.contributions", "pension_contribution"),
      mapping("input.travel", "travel.reimbursement", "money_minor_units"),
      mapping("input.end_date", "employment.end_date", "iso_date"),
    ],
  });
  const scopes: RuleInputScopeRequirement[] = [
    {
      scope_id: "employment.full_period",
      topic: "synthetic.employment",
      period: { start_date: "2030-01-01", end_date: "2030-12-31" },
      input_ids: ["input.travel", "input.regular_hours", "input.pension", "input.end_date"],
    },
  ];
  return { documents, extractions, fact_snapshot: factSnapshot, mapping_registry: registry, scopes, prepared_at: "2031-01-04T00:00:00.000Z" };
}

function mapping(inputId: string, factPath: CanonicalFact["path"], unit: string) {
  return {
    input_id: inputId,
    runtime_fact_path: `synthetic.${inputId}`,
    fact_path: factPath,
    minimum_confidence: 0.8,
    max_age_seconds: 31_536_000,
    expected_output: { kind: "decimal" as const, unit },
    transformation: { transformation_id: "synthetic.identity", transformation_version: "1.0.0" },
  };
}

describe("multi-document intake", () => {
  it("builds a factual twelve-month projection and keeps all synthetic disagreement visible", () => {
    const fixture = scenario();
    const result = buildMultiDocumentIntake({ case_id: CASE_ID, ...fixture });
    const codes = result.technical_issues.map((entry) => entry.code);

    expect(result.timeline.map((entry) => entry.period_key)).toEqual([
      "2030-01", "2030-02", "2030-03", "2030-04", "2030-05", "2030-06", "2030-07",
      "2030-08", "2030-09", "2030-10", "2030-11", "2030-12",
    ]);
    expect(codes).toContain("period.missing_month");
    expect(codes).toContain("document.duplicate_content");
    expect(codes).toContain("document.corrected");
    expect(codes).toContain("employer.mismatch");
    expect(codes).toContain("fact.conflicted");
    expect(codes).toContain("termination.period_mismatch");
    expect(result.clarification_fact_states.map((entry) => [entry.fact_path, entry.status])).toEqual([
      ["pension.contributions", "conflicted"],
      ["travel.reimbursement", "missing"],
      ["work.regular_hours", "conflicted"],
    ]);
    expect(result.rule_input_views[0]!.coverage.map((entry) => [entry.fact_path, entry.state])).toEqual([
      ["employment.end_date", "covered"],
      ["pension.contributions", "conflicted"],
      ["work.regular_hours", "conflicted"],
      ["travel.reimbursement", "unreadable"],
    ]);
    expect(multiDocumentIntakeCanonicalBytes(result)).not.toMatch(/entitlement|legal conclusion/i);
  });

  it("is deterministic across input order and never serializes identity values", () => {
    const fixture = scenario();
    const first = buildMultiDocumentIntake({ case_id: CASE_ID, ...fixture });
    const second = buildMultiDocumentIntake({
      case_id: CASE_ID,
      ...fixture,
      documents: [...fixture.documents].reverse(),
      extractions: [...fixture.extractions].reverse(),
      fact_snapshot: { ...fixture.fact_snapshot, facts: [...fixture.fact_snapshot.facts].reverse() },
      scopes: fixture.scopes.map((scope) => ({ ...scope, input_ids: [...scope.input_ids].reverse() })),
    } as unknown as Parameters<typeof buildMultiDocumentIntake>[0]);

    expect(second.result_sha256).toBe(first.result_sha256);
    expect(multiDocumentIntakeCanonicalBytes(second)).toBe(multiDocumentIntakeCanonicalBytes(first));
    expect(multiDocumentIntakeCanonicalBytes(first)).not.toContain("SYNTHETIC EMPLOYER A");
    expect(multiDocumentIntakeCanonicalBytes(first)).not.toContain("SYNTHETIC EMPLOYER B");
  });

  it("retains prior technical warnings during non-degrading recovery", () => {
    const fixture = scenario();
    const first = buildMultiDocumentIntake({ case_id: CASE_ID, ...fixture });
    const recovered = buildMultiDocumentIntake({
      case_id: CASE_ID,
      ...fixture,
      prior_warning_codes: first.retained_warning_codes,
    });

    expect(recovered.retained_warning_codes).toEqual(first.retained_warning_codes);
    expect(recovered.rule_input_views[0]!.blocker_codes).toContain("rule_input.conflicted");
    expect(recovered.rule_input_views[0]!.snapshot.snapshot_sha256).toBe(first.rule_input_views[0]!.snapshot.snapshot_sha256);
  });

  it("fails closed for cross-case documents and undeclared RuleInput mappings", () => {
    const fixture = scenario();
    expect(() => buildMultiDocumentIntake({
      case_id: CASE_ID,
      ...fixture,
      documents: [{
        ...fixture.documents[0]!,
        case_id: id(999),
        storage_path: `cases/${id(999)}/documents/${fixture.documents[0]!.document_id}/original.pdf`,
      }],
      extractions: [],
    })).toThrow("multi_document_case_boundary_violation");

    expect(() => buildMultiDocumentIntake({
      case_id: CASE_ID,
      ...fixture,
      scopes: [{ ...fixture.scopes[0]!, input_ids: ["input.not_registered"] }],
    })).toThrow("multi_document_mapping_missing:input.not_registered");
  });
});
