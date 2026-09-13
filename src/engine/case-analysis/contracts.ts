import type {DocumentReviewInput} from "../document-review/contracts.ts";
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {aiReleaseRuntimeInputSchema,type AiReleaseRuntimeInput} from '../ai-release-runtime/contracts.ts';
import {runAiReleaseRuntime,replayAiReleaseRuntime,type AiReleaseRuntimeResult} from '../ai-release-runtime/runtime.ts';
import {ownerEngineeringRuntimeInputSchema,runOwnerEngineeringRuntime,replayOwnerEngineeringRuntime,type OwnerEngineeringRuntimeInput,type OwnerEngineeringRuntimeResult} from '../ai-release-runtime/owner-engineering.ts';
import type { ImmutableDocument } from "../domain/documents.ts";
import type { CanonicalFact } from "../facts/contracts.ts";
import type { NormalizedPayslipExtraction } from "../extraction/payslip.ts";
import type {
  AnalysisResultBundle,
  CaseAnalysisCommand,
  DeterministicReportArtifacts,
  LegalCatalogSelection,
  Wave3Topic,
} from "../wave3/contracts.ts";

export const CASE_ANALYSIS_DOCUMENT_REVIEW_CODE_VERSION='case-analysis@0.6.7' as const;
export const CASE_ANALYSIS_AI_RELEASE_CODE_VERSION='case-analysis@0.6.8' as const;
export const CASE_ANALYSIS_OWNER_ENGINEERING_CODE_VERSION='case-analysis@0.6.9' as const;
export const CASE_ANALYSIS_CODE_VERSION = "case-analysis@0.6.5" as const;
export const CASE_ANALYSIS_IDENTIFIED_READING_CODE_VERSION = 'case-analysis@0.6.6' as const;

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
  /** Verified server source head; distinct from the engine case revision. */
  source_journal?:Readonly<{case_id:string;input_revision:number;input_sha256:string}>;
  /** Server journal routing hint; never a customer supplied answer receipt. */
  has_document_review_answers?: boolean;
  document_snapshot_id: string;
  document_snapshot_sha256: string;
  documents: readonly ImmutableDocument[];
  extraction_snapshot_id: string;
  extraction_snapshot_sha256: string;
  extractions: readonly NormalizedPayslipExtraction[];
  /** Independently typed evidence; never counted as payroll extraction. The
   * ordinary document-review input pins these records in its command hash. */
  non_payslip_evidence?: readonly import('../extraction/document-evidence/snapshot.ts').SavedNonPayslipEvidence[];
  document_source_transcriptions?: readonly import('../extraction/document-evidence/source-transcription.ts').DocumentEvidenceSourceReading[];
  declared_fact_snapshot: DeclaredFactSnapshot;
  /** Optional source-reviewed inputs, separately pinned in the command. */
  document_review_input?: DocumentReviewInput;
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
  code_version: "case-analysis@0.6.0" | "case-analysis@0.6.1" | "case-analysis@0.6.2" | "case-analysis@0.6.3" | "case-analysis@0.6.4" | typeof CASE_ANALYSIS_CODE_VERSION | typeof CASE_ANALYSIS_IDENTIFIED_READING_CODE_VERSION | typeof CASE_ANALYSIS_DOCUMENT_REVIEW_CODE_VERSION | typeof CASE_ANALYSIS_AI_RELEASE_CODE_VERSION | typeof CASE_ANALYSIS_OWNER_ENGINEERING_CODE_VERSION;
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

/** Internal persisted replay envelope. The assessment input is not a public
 * report payload. Only result carries the qualified, non-debt presentation. */
export type CaseAnalysisAiRelease=Readonly<{
  schema_version:'case-analysis-ai-release-v1';
  binding:CaseAnalysisAiReleaseBinding;
  input:AiReleaseRuntimeInput;
  result:AiReleaseRuntimeResult;
  sha256:string;
}>;
export const caseAnalysisAiReleaseBindingSchema=z.object({engine_case_revision:z.number().int().nonnegative(),
  source_journal:z.object({case_id:z.string().min(1),input_revision:z.number().int().positive(),input_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()}).strict();
export type CaseAnalysisAiReleaseBinding=z.infer<typeof caseAnalysisAiReleaseBindingSchema>;
const aiReleaseEnvelopeSchema=z.object({schema_version:z.literal('case-analysis-ai-release-v1'),
  binding:caseAnalysisAiReleaseBindingSchema,input:aiReleaseRuntimeInputSchema,result:z.unknown(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export function createCaseAnalysisAiRelease(input:AiReleaseRuntimeInput,binding:CaseAnalysisAiReleaseBinding):CaseAnalysisAiRelease{
  const parsed=aiReleaseRuntimeInputSchema.parse(input),result=runAiReleaseRuntime(parsed);
  const body={schema_version:'case-analysis-ai-release-v1' as const,binding:caseAnalysisAiReleaseBindingSchema.parse(binding),input:parsed,result};
  return deepFreeze({...body,sha256:canonicalSha256(body)});
}
/** Reconstructs actual source-dependent rules and calculations at the saved
 * evaluation instant. Live publication must separately check current expiry,
 * revocation and server-owned policy/source pins. */
export function replayCaseAnalysisAiRelease(value:unknown):CaseAnalysisAiRelease{
  const parsed=aiReleaseEnvelopeSchema.parse(value),{sha256,...body}=parsed;
  if(canonicalSha256(body)!==sha256)throw new CaseAnalysisError('AI_RELEASE_ENVELOPE_HASH_MISMATCH');
  return deepFreeze({...parsed,result:replayAiReleaseRuntime(parsed.result,parsed.input)});
}
export type CaseAnalysisAiReleaseScope=Readonly<{
  case_id:string;analysis_run_id:string;case_revision:number;facts_snapshot_sha256:string;
  period:Readonly<{start_date:string;end_date:string}>;
  document_review?:import('../document-review/contracts.ts').DocumentReviewResult;
}>;
export function assertCaseAnalysisAiReleaseScope(envelope:CaseAnalysisAiRelease,scope:CaseAnalysisAiReleaseScope){
  const {input,result,binding}=envelope,current=input.assessment_input.current.scope;
  if(input.analysis_run_id!==scope.analysis_run_id||result.analysis_run_id!==scope.analysis_run_id
    ||result.case_id!==scope.case_id||current.case_id!==scope.case_id||binding.engine_case_revision!==scope.case_revision
    ||binding.source_journal.case_id!==scope.case_id||current.input_revision!==binding.source_journal.input_revision
    ||current.input_sha256!==binding.source_journal.input_sha256
    ||current.facts_sha256!==scope.facts_snapshot_sha256||current.period.from!==scope.period.start_date
    ||current.period.to!==scope.period.end_date||!scope.document_review
    ||canonicalSha256(result.review)!==canonicalSha256(scope.document_review))throw new CaseAnalysisError('AI_RELEASE_BUNDLE_SCOPE_MISMATCH');
}

export type CaseAnalysisOwnerEngineering=Readonly<{schema_version:'case-analysis-owner-engineering-v1';
 binding:CaseAnalysisAiReleaseBinding;input:OwnerEngineeringRuntimeInput;result:OwnerEngineeringRuntimeResult;sha256:string}>;
const ownerEngineeringEnvelopeSchema=z.object({schema_version:z.literal('case-analysis-owner-engineering-v1'),
 binding:caseAnalysisAiReleaseBindingSchema,input:ownerEngineeringRuntimeInputSchema,result:z.unknown(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export function createCaseAnalysisOwnerEngineering(input:OwnerEngineeringRuntimeInput,binding:CaseAnalysisAiReleaseBinding):CaseAnalysisOwnerEngineering{
 const parsed=ownerEngineeringRuntimeInputSchema.parse(input),result=runOwnerEngineeringRuntime(parsed);
 const body={schema_version:'case-analysis-owner-engineering-v1' as const,binding:caseAnalysisAiReleaseBindingSchema.parse(binding),input:parsed,result};
 return deepFreeze({...body,sha256:canonicalSha256(body)});
}
export function replayCaseAnalysisOwnerEngineering(value:unknown):CaseAnalysisOwnerEngineering{
 const parsed=ownerEngineeringEnvelopeSchema.parse(value),{sha256,...body}=parsed;
 if(canonicalSha256(body)!==sha256)throw new CaseAnalysisError('OWNER_ENGINEERING_ENVELOPE_HASH_MISMATCH');
 return deepFreeze({...parsed,result:replayOwnerEngineeringRuntime(parsed.result,parsed.input)});
}
export function assertCaseAnalysisOwnerEngineeringScope(envelope:CaseAnalysisOwnerEngineering,scope:CaseAnalysisAiReleaseScope){
 const {input,result,binding}=envelope,current=input.assessment_input.current.scope;
 if(input.analysis_run_id!==scope.analysis_run_id||result.analysis_run_id!==scope.analysis_run_id
  ||result.case_id!==scope.case_id||current.case_id!==scope.case_id||binding.engine_case_revision!==scope.case_revision
  ||binding.source_journal.case_id!==scope.case_id||current.input_revision!==binding.source_journal.input_revision
  ||current.input_sha256!==binding.source_journal.input_sha256||current.facts_sha256!==scope.facts_snapshot_sha256
  ||current.period.from!==scope.period.start_date||current.period.to!==scope.period.end_date||!scope.document_review
  ||canonicalSha256(result.review)!==canonicalSha256(scope.document_review))throw new CaseAnalysisError('OWNER_ENGINEERING_BUNDLE_SCOPE_MISMATCH');
}
