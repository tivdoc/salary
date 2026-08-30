import type { ImmutableDocument } from "../domain/documents";
import type { CanonicalFact } from "../facts/contracts";
import type { NormalizedPayslipExtraction } from "../extraction/payslip";
import type {
  AnalysisResultBundle,
  CaseAnalysisCommand,
  DeterministicReportArtifacts,
  LegalCatalogSelection,
  Wave3Topic,
} from "../wave3/contracts";

export const CASE_ANALYSIS_STAGES = [
  "input_snapshot",
  "canonical_facts",
  "rule_inputs",
  "analysis_run",
  "topic_results",
  "report_artifacts",
  "review_pending",
] as const;

export type CaseAnalysisStage = (typeof CASE_ANALYSIS_STAGES)[number];

export type DeclaredFactSnapshot = Readonly<{
  snapshot_id: string;
  snapshot_sha256: string;
  facts: readonly CanonicalFact[];
}>;

export type StoredCaseInputSnapshot = Readonly<{
  document_snapshot_id: string;
  document_snapshot_sha256: string;
  documents: readonly ImmutableDocument[];
  extraction_snapshot_id: string;
  extraction_snapshot_sha256: string;
  extractions: readonly NormalizedPayslipExtraction[];
  declared_fact_snapshot: DeclaredFactSnapshot;
}>;

export interface StoredCaseSnapshotPort {
  loadPinned(command: CaseAnalysisCommand): Promise<StoredCaseInputSnapshot>;
}

export type PinnedAnalysisDependencies = Readonly<{
  extraction_snapshot_sha256: string;
  facts_snapshot_sha256: string;
  catalog_sha256: string;
  source_version_ids: readonly string[];
  parameter_version_ids: readonly string[];
  rule_spec_versions: readonly string[];
  code_version: "case-analysis@0.6.0";
  template_version: string;
}>;

export type PersistedAnalysisStage = Readonly<{
  stage: CaseAnalysisStage;
  payload_sha256: string;
  payload: unknown;
}>;

export type PersistedCaseAnalysisRun = Readonly<{
  analysis_run_id: string;
  idempotency_key: string;
  command_sha256: string;
  command: CaseAnalysisCommand;
  stages: readonly PersistedAnalysisStage[];
  selections: readonly LegalCatalogSelection[];
  dependencies: PinnedAnalysisDependencies | null;
  bundle: AnalysisResultBundle | null;
  report: DeterministicReportArtifacts | null;
  completed: boolean;
}>;

export interface CaseAnalysisRepositoryPort {
  begin(input: Readonly<{
    analysis_run_id: string;
    idempotency_key: string;
    command_sha256: string;
    command: CaseAnalysisCommand;
  }>): Promise<PersistedCaseAnalysisRun>;
  persistStage(input: Readonly<{
    analysis_run_id: string;
    stage: CaseAnalysisStage;
    payload_sha256: string;
    payload: unknown;
  }>): Promise<void>;
  complete(input: Readonly<{
    analysis_run_id: string;
    selections: readonly LegalCatalogSelection[];
    dependencies: PinnedAnalysisDependencies;
    bundle: AnalysisResultBundle;
    report: DeterministicReportArtifacts;
  }>): Promise<PersistedCaseAnalysisRun>;
  getByRunId(analysisRunId: string): Promise<PersistedCaseAnalysisRun | null>;
  getCompletedByIdempotencyKey(idempotencyKey: string): Promise<PersistedCaseAnalysisRun | null>;
  assertPinnedDependenciesAvailable(dependencies: PinnedAnalysisDependencies): Promise<void>;
}

export type CaseAnalysisSafeLog = Readonly<{
  event: "analysis_started" | "analysis_resumed" | "topic_completed" | "analysis_completed" | "replay_completed";
  case_id: string;
  analysis_run_id: string;
  topic: Wave3Topic | null;
  status: string;
  sha256: string;
}>;

export interface CaseAnalysisLogPort {
  write(entry: CaseAnalysisSafeLog): void;
}

export interface ReportRegistrationPort {
  registerReport(input: Readonly<{
    case_id: string;
    report_sha256: string;
    analysis_result_sha256: string;
    export_eligible_after_review: boolean;
  }>): void;
}

export class CaseAnalysisError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CaseAnalysisError";
  }
}
