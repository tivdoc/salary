import { canonicalFactSchema, type CanonicalFact } from "../facts/contracts";
import type { ImmutableDocument } from "../domain/documents";
import type { NormalizedCandidateField, NormalizedPayslipExtraction } from "../extraction/payslip";
import { canonicalSha256 } from "../rule-runtime/canonical";
import type { CaseAnalysisCommand, Wave3Topic } from "../wave3/contracts";
import type { StoredCaseInputSnapshot } from "./contracts";

const TOPIC_FACT_PATH: Readonly<Record<Wave3Topic, CanonicalFact["path"]>> = Object.freeze({
  minimum_wage: "compensation.base_monthly_salary",
  working_time: "work.regular_hours",
  pension: "pension.base_salary",
  travel: "travel.reimbursement",
  convalescence: "convalescence.payment",
  vacation: "leave.vacation_balance",
  sick_leave: "leave.sick_balance",
});

function uuid(seed: string) {
  const hash = canonicalSha256(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function source(documentId: string, page = 1) {
  return { document_id: documentId, page };
}

function field(documentId: string, periodIndex: number, name: NormalizedCandidateField["field"]): NormalizedCandidateField {
  const common = {
    candidate_id: uuid(`candidate:${documentId}:${name}`),
    raw_value: `synthetic-${name}-${periodIndex}`,
    confidence: 1,
    source: source(documentId),
    extraction_method: "fixture" as const,
    warning_flags: [],
  };
  switch (name) {
    case "document_type": return { ...common, field: name, normalized_value: "payslip" };
    case "salary_period": return {
      ...common, field: name,
      normalized_value: {
        year: 2025, month: periodIndex,
        start_date: `2025-${String(periodIndex).padStart(2, "0")}-01`,
        end_date: `2025-${String(periodIndex).padStart(2, "0")}-${periodIndex === 2 ? "28" : "30"}`,
      },
    };
    case "salary_type": return { ...common, field: name, normalized_value: "monthly" };
    case "regular_hours": return { ...common, field: name, normalized_value: { amount: "1", unit: "hours_per_month" } };
    case "vacation_balance":
    case "sick_balance": return { ...common, field: name, normalized_value: { amount: "1", unit: "days" } };
    case "base_monthly_salary":
    case "gross_salary": return { ...common, field: name, normalized_value: { currency: "XTS", minor_units: 100_000 } };
    case "net_salary": return { ...common, field: name, normalized_value: { currency: "XTS", minor_units: 90_000 } };
    case "pension_base": return { ...common, field: name, normalized_value: { currency: "XTS", minor_units: 10_000 } };
    case "travel_amount":
    case "convalescence_amount": return { ...common, field: name, normalized_value: { currency: "XTS", minor_units: 1 } };
    default: throw new TypeError(`unsupported_synthetic_field:${name}`);
  }
}

function document(caseId: string, periodIndex: number): ImmutableDocument {
  const documentId = uuid(`synthetic-document:${caseId}:${periodIndex}`);
  return {
    document_id: documentId,
    case_id: caseId,
    document_type: "payslip",
    original_filename: `neutral-synthetic-period-${periodIndex}.json`,
    mime_type: "application/json",
    size_bytes: 1,
    content_sha256: canonicalSha256(`neutral-synthetic-document-bytes:${periodIndex}`),
    storage_path: `cases/${caseId}/documents/${documentId}/original.json`,
    document_period: {
      start_date: `2025-${String(periodIndex).padStart(2, "0")}-01`,
      end_date: `2025-${String(periodIndex).padStart(2, "0")}-${periodIndex === 2 ? "28" : "30"}`,
    },
    supersedes_document_id: null,
    created_at: "2025-04-01T00:00:00.000Z",
  };
}

function extraction(documentId: string, periodIndex: number): NormalizedPayslipExtraction {
  const fieldNames: readonly NormalizedCandidateField["field"][] = [
    "document_type", "salary_period", "salary_type", "base_monthly_salary", "gross_salary", "net_salary",
    "regular_hours", "pension_base", "travel_amount", "convalescence_amount", "vacation_balance", "sick_balance",
  ];
  return {
    extraction_id: uuid(`synthetic-extraction:${documentId}`),
    document_id: documentId,
    status: "completed",
    detected_document_type: "payslip",
    document_quality_confidence: 1,
    quality_metrics: { page_count: 1, text_coverage: 1, rotation_degrees: 0, source_resolution_dpi: null },
    fields: fieldNames.map((name) => field(documentId, periodIndex, name)),
    additional_components: [],
    sensitive_metadata: [],
    earnings_components_complete: true,
    warnings: [],
    provider: { provider_id: "fixture.snapshot", extractor_version: "1.0.0", model_version: null },
    operation: { duration_ms: 0, provider_response_id: null, token_usage: null },
    extracted_at: "2025-04-01T00:00:00.000Z",
    error_code: null,
  };
}

function declaredOverride(caseId: string, topic: Wave3Topic, kind: "missing" | "conflict"): CanonicalFact {
  const path = TOPIC_FACT_PATH[topic];
  return canonicalFactSchema.parse({
    fact_id: uuid(`declared-override:${caseId}:${topic}:${kind}`),
    case_id: caseId,
    path,
    value: null,
    status: kind === "missing" ? "missing" : "conflicted",
    provenance: [{
      source_type: "declared",
      source_reference: { kind: "questionnaire_response", response_id: uuid(`response:${caseId}:${topic}:${kind}`) },
    }],
    confidence: 1,
    conflicting_fact_ids: kind === "conflict"
      ? [uuid(`conflict-a:${caseId}:${topic}`), uuid(`conflict-b:${caseId}:${topic}`)]
      : [],
    resolution: null,
    created_at: "2025-04-01T00:00:00.000Z",
  });
}

export type SyntheticFixtureOptions = Readonly<{
  fixture_id: string;
  mode?: "real" | "synthetic_test";
  missing_topic?: Wave3Topic;
  conflict_topic?: Wave3Topic;
  idempotency_key?: string;
}>;

export function buildSyntheticCaseFixture(options: SyntheticFixtureOptions): Readonly<{
  command: CaseAnalysisCommand;
  stored: StoredCaseInputSnapshot;
}> {
  const caseId = uuid(`synthetic-case:${options.fixture_id}`);
  const documents = [1, 2, 3].map((index) => document(caseId, index));
  const extractions = documents.map((entry, index) => extraction(entry.document_id, index + 1));
  const declaredFacts = [
    ...(options.missing_topic ? [declaredOverride(caseId, options.missing_topic, "missing")] : []),
    ...(options.conflict_topic ? [declaredOverride(caseId, options.conflict_topic, "conflict")] : []),
  ];
  const documentHash = canonicalSha256(documents);
  const extractionHash = canonicalSha256(extractions);
  const declaredHash = canonicalSha256(declaredFacts);
  const stored: StoredCaseInputSnapshot = {
    document_snapshot_id: `document-snapshot:${options.fixture_id}`,
    document_snapshot_sha256: documentHash,
    documents,
    extraction_snapshot_id: `extraction-snapshot:${options.fixture_id}`,
    extraction_snapshot_sha256: extractionHash,
    extractions,
    declared_fact_snapshot: {
      snapshot_id: `declared-facts:${options.fixture_id}`,
      snapshot_sha256: declaredHash,
      facts: declaredFacts,
    },
  };
  const command: CaseAnalysisCommand = {
    case_id: caseId,
    case_revision: 1,
    document_snapshot_id: stored.document_snapshot_id,
    document_snapshot_sha256: documentHash,
    extraction_snapshot_id: stored.extraction_snapshot_id,
    extraction_snapshot_sha256: extractionHash,
    declared_fact_snapshot_id: stored.declared_fact_snapshot.snapshot_id,
    declared_fact_snapshot_sha256: declaredHash,
    period: { start_date: "2025-01-01", end_date: "2025-03-31" },
    as_of: "2025-04-01",
    requested_topics: ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"],
    sector: "synthetic_sector",
    population: "synthetic_population",
    mode: options.mode ?? "synthetic_test",
    idempotency_key: options.idempotency_key ?? `idempotency:${options.fixture_id}`,
  };
  return Object.freeze({ command: Object.freeze(command), stored: Object.freeze(stored) });
}

export const COMPLETE_THREE_PERIOD_FIXTURE = buildSyntheticCaseFixture({ fixture_id: "complete-three-period" });
export const PARTIAL_THREE_PERIOD_FIXTURE = buildSyntheticCaseFixture({ fixture_id: "partial-three-period", missing_topic: "travel", conflict_topic: "vacation" });
