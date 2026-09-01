import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type {
  ClarificationFactState,
  ClarificationOrigin,
  ConsentRevision,
  CustomerClarificationTask,
  CustomerReportProjection,
  DeclaredFactCandidate,
  LegalInputRequirement,
  PortalCaseProjection,
  PortalCaseRecord,
  PrivacyRequestKind,
  PrivacyRequestRevision,
  ReportAccessGrant,
  StoredReportEdition,
  UploadSession,
  VerifiedProductEvidence,
} from "./contracts.ts";

export type Awaitable<T> = T | PromiseLike<T>;

export type PortalAnswerInput = Readonly<{
  case_id: string;
  task_id: string;
  question_version: number;
  value: unknown;
  explicit_confirmation: true;
  consent_version: string;
  terms_version: string;
  idempotency_key: string;
  expected_revision?: number;
}>;

export type PortalPrivacyInput = Readonly<{
  case_id: string;
  request_kind: PrivacyRequestKind;
  idempotency_key: string;
  expected_revision?: number;
}>;

export type PortalConsentInput = Readonly<{
  case_id: string;
  consent_version: string;
  terms_version: string;
  granted: boolean;
  idempotency_key: string;
}>;

export type PortalUploadInput = Readonly<{
  case_id: string;
  document_id: string;
  expected_sha256: string;
  expected_length: number;
  detected_mime: string;
  expires_at: string;
  idempotency_key: string;
}>;

export type ReportDownload = Readonly<{
  bytes: Uint8Array;
  artifact_sha256: string;
  object_version_id: string;
  content_type: "application/pdf";
  filename: string;
}>;

/**
 * Stable route-facing portal contract. Durable mutations must bind the required
 * expected revision, owner/tenant scope, idempotency result and audit append in
 * one transaction. Synchronous hermetic services remain structurally valid.
 */
export interface CustomerPortalApplicationPort {
  getCaseProjection(actor: VerifiedActor, caseId: string): Awaitable<PortalCaseProjection>;
  listReports(actor: VerifiedActor, caseId: string): Awaitable<readonly CustomerReportProjection[]>;
  answerClarification(
    actor: VerifiedActor,
    input: PortalAnswerInput & Readonly<{ expected_revision: number }>,
  ): Awaitable<Readonly<{ candidate: DeclaredFactCandidate; idempotent_replay: boolean }>>;
  createPrivacyRequest(
    actor: VerifiedActor,
    input: PortalPrivacyInput & Readonly<{ expected_revision: number }>,
  ): Awaitable<Readonly<{ request: PrivacyRequestRevision; idempotent_replay: boolean }>>;
  createReportAccessGrant(
    actor: VerifiedActor,
    caseId: string,
    reportId: string,
    expectedRevision: number,
  ): Awaitable<ReportAccessGrant>;
  downloadReport(actor: VerifiedActor, grant: ReportAccessGrant): Awaitable<ReportDownload>;
}

/**
 * Policy repository used by the existing synchronous service. Seed/history
 * helpers intentionally remain outside this product contract.
 */
export interface CustomerPortalRepositoryPort {
  case(caseId: string): PortalCaseRecord | null;
  tasksForCase(caseId: string): readonly CustomerClarificationTask[];
  reportsForCase(caseId: string): readonly StoredReportEdition[];
  evidenceForCase(caseId: string): readonly VerifiedProductEvidence[];
  createClarifications(
    caseId: string,
    facts: readonly ClarificationFactState[],
    requirements: readonly LegalInputRequirement[],
    originOverride?: ClarificationOrigin | null,
  ): readonly CustomerClarificationTask[];
  recordAnswer(input: PortalAnswerInput & Readonly<{ actor_id: string }>): Readonly<{
    candidate: DeclaredFactCandidate;
    idempotent_replay: boolean;
  }>;
  recordConsent(input: PortalConsentInput & Readonly<{ actor_id: string }>): Readonly<{
    consent: ConsentRevision;
    idempotent_replay: boolean;
  }>;
  createPrivacyRequest(input: PortalPrivacyInput & Readonly<{ actor_id: string }>): Readonly<{
    request: PrivacyRequestRevision;
    idempotent_replay: boolean;
  }>;
  reserveUpload(input: PortalUploadInput & Readonly<{ actor_id: string }>): Readonly<{
    session: UploadSession;
    idempotent_replay: boolean;
  }>;
  acceptInvite(input: Readonly<{ token: string; audience: string }>): Readonly<{
    case_id: string;
    owner_actor_id: string;
    accepted_at: string;
  }>;
  createReportGrant(input: Readonly<{
    actor_id: string;
    case_id: string;
    report: StoredReportEdition;
    expires_at: string;
  }>): ReportAccessGrant;
  reportGrant(grantId: string): ReportAccessGrant | null;
  readArtifact(objectVersionId: string): Uint8Array | null;
}
