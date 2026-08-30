import type { CalculationTrace } from "../calculations/contracts";
import type { Money } from "../domain/primitives";
import type { CanonicalFact } from "../facts/contracts";
import type { LegalReadinessDecision } from "../legal-knowledge/canonical-readiness/evaluate-legal-readiness";
import type { RuleInputSnapshot } from "../wave2/contracts";

/**
 * Wave 3 freezes application ports around the existing canonical domain types.
 * These records are boundary messages, not replacement Fact, Money, readiness,
 * calculation, Finding, AnalysisRun, report-truth, or approval models.
 */
export const WAVE3_TOPICS = [
  "minimum_wage",
  "working_time",
  "pension",
  "travel",
  "convalescence",
  "vacation",
  "sick_leave",
] as const;

export type Wave3Topic = (typeof WAVE3_TOPICS)[number];
export type CaseLifecycleState =
  | "awaiting_payment"
  | "awaiting_documents"
  | "awaiting_extraction_review"
  | "awaiting_fact_resolution"
  | "ready_for_legal_evaluation"
  | "awaiting_legal_review"
  | "awaiting_report_approval"
  | "report_ready"
  | "release_hold"
  | "delivered"
  | "cancelled";

export interface DeterministicClockPort {
  now(): string;
}

export interface DeterministicIdPort {
  derive(namespace: string, canonicalInputHash: string): string;
}

export interface CanonicalHashPort {
  hashCanonical(value: unknown): string;
  hashBytes(value: Uint8Array): string;
}

export type PaymentEvidenceSnapshot = Readonly<{
  evidence_id: string;
  evidence_revision: string;
  evidence_sha256: string;
  case_reference: string;
  customer_reference: string;
  amount: Money;
  status: "settled" | "pending" | "failed" | "cancelled" | "refunded" | "chargeback";
  duplicate_of_evidence_id: string | null;
}>;

export interface PaymentEvidencePort {
  loadVerifiedEvidence(caseId: string): Promise<readonly PaymentEvidenceSnapshot[]>;
}

export type CaseTransitionCommand = Readonly<{
  case_id: string;
  expected_revision: number;
  target_state: CaseLifecycleState;
  actor_id: string;
  actor_role: string;
  reason: string;
  idempotency_key: string;
}>;

export type CaseOperationsResult = Readonly<{
  case_id: string;
  revision: number;
  state: CaseLifecycleState;
  command_sha256: string;
  audit_event_sha256: string;
  idempotent_replay: boolean;
}>;

export interface CaseOperationsPort {
  transition(command: CaseTransitionCommand): Promise<CaseOperationsResult>;
  reconcilePayment(caseId: string, expectedAmount: Money, expectedCustomerReference: string): Promise<CaseOperationsResult>;
  get(caseId: string): Promise<CaseOperationsResult | null>;
}

export type LegalArtifactEnvelope = Readonly<{
  artifact_id: string;
  artifact_kind: "source_decision" | "parameter_attestation" | "rulespec_approval" | "golden_case_approval";
  schema_version: string;
  payload_sha256: string;
  canonical_payload: unknown;
}>;

export interface LegalArtifactReviewPort {
  importArtifact(artifact: LegalArtifactEnvelope): Promise<Readonly<{ artifact_id: string; revision: number; state: string; receipt_sha256: string }>>;
  status(artifactId: string): Promise<Readonly<{ state: string; missing_gates: readonly string[] }> | null>;
}

export type LegalCatalogSelection = Readonly<{
  catalog_id: string;
  catalog_version: string;
  catalog_sha256: string;
  mode: "real" | "synthetic_test";
  topic: Wave3Topic;
  source_version_ids: readonly string[];
  parameter_version_ids: readonly string[];
  rule_spec_id: string | null;
  rule_spec_version: string | null;
  readiness: LegalReadinessDecision;
}>;

export interface LegalRuleCatalogPort {
  resolve(input: Readonly<{ topic: Wave3Topic; target_date: string; as_of: string; sector: string; population: string; mode: "real" | "synthetic_test" }>): Promise<LegalCatalogSelection>;
}

export type RuleSpecExecutionResult = Readonly<{
  topic: Wave3Topic;
  rule_spec_id: string;
  rule_spec_version: string;
  amount: Money | null;
  trace: CalculationTrace;
  result_sha256: string;
}>;

export interface RuleSpecExecutorPort {
  execute(input: Readonly<{ selection: LegalCatalogSelection; rule_input: RuleInputSnapshot; execution_id: string; calculated_at: string }>): Promise<RuleSpecExecutionResult>;
}

export type TopicAnalysisResult = Readonly<{
  topic: Wave3Topic;
  status: "calculated" | "not_applicable" | "blocked_missing_facts" | "blocked_conflict" | "blocked_legal_readiness" | "error";
  blockers: readonly string[];
  rule_input_sha256: string | null;
  amount: Money | null;
  trace: CalculationTrace | null;
  legal_readiness: LegalReadinessDecision | null;
}>;

export type AnalysisResultBundle = Readonly<{
  schema_version: "tivdoc-analysis-result-bundle-v0.6.0";
  analysis_run_id: string;
  case_id: string;
  case_revision: number;
  period: Readonly<{ start_date: string; end_date: string }>;
  as_of: string;
  document_snapshot_sha256: string;
  extraction_snapshot_sha256: string;
  declared_fact_snapshot_sha256: string;
  facts_snapshot_sha256: string;
  facts: readonly CanonicalFact[];
  rule_inputs: readonly RuleInputSnapshot[];
  catalog_sha256: string;
  topic_results: readonly TopicAnalysisResult[];
  known_subtotal: Money | null;
  coverage_complete: boolean;
  result_sha256: string;
}>;

export type CaseAnalysisCommand = Readonly<{
  case_id: string;
  case_revision: number;
  document_snapshot_id: string;
  document_snapshot_sha256: string;
  extraction_snapshot_id: string;
  extraction_snapshot_sha256: string;
  declared_fact_snapshot_id: string;
  declared_fact_snapshot_sha256: string;
  period: Readonly<{ start_date: string; end_date: string }>;
  as_of: string;
  requested_topics: readonly Wave3Topic[];
  sector: string;
  population: string;
  mode: "real" | "synthetic_test";
  idempotency_key: string;
}>;

export interface CaseAnalysisPort {
  runCaseAnalysis(command: CaseAnalysisCommand): Promise<AnalysisResultBundle>;
  replay(analysisRunId: string): Promise<AnalysisResultBundle>;
}

export type DeterministicReportArtifacts = Readonly<{
  report_id: string;
  report_revision: number;
  analysis_result_sha256: string;
  json: Uint8Array;
  html: Uint8Array;
  pdf: Uint8Array;
  manifest: Uint8Array;
  json_sha256: string;
  html_sha256: string;
  pdf_sha256: string;
  manifest_sha256: string;
  report_sha256: string;
}>;

export interface ReportBuilderPort {
  build(bundle: AnalysisResultBundle): Promise<DeterministicReportArtifacts>;
}

export type CaseReviewDecision = Readonly<{
  task_id: string;
  task_kind: "extraction_review" | "fact_conflict" | "legal_evaluation" | "report_approval";
  reviewer_id: string;
  reviewer_role: string;
  decision: "approved" | "rejected" | "changes_requested";
  input_sha256: string;
  output_sha256: string;
  decided_at: string;
  reason: string;
  schema_version: string;
}>;

export interface CaseReviewPort {
  decide(decision: CaseReviewDecision): Promise<Readonly<{ task_id: string; revision: number; receipt_sha256: string }>>;
  isReportExportEligible(caseId: string, reportSha256: string): Promise<boolean>;
}
