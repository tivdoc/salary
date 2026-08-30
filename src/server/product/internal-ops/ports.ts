import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type {
  AnalysisProjection,
  AuditProjection,
  DocumentProjection,
  ExtractionProjection,
  FactsProjection,
  InternalOpsCaseProjection,
  InternalOpsCommandResult,
  OpsCapability,
  PaymentProjection,
  QueueProjection,
  ReadinessProjection,
  ReportProjection,
  TimelineProjection,
  TrustedInternalOpsCommand,
} from "./contracts.ts";

/** Consumer-owned P2 adapter contract. Authentication must be server verified. */
export interface InternalOpsIdentityPort {
  authenticate(request: Request): Promise<VerifiedActor | null>;
  authorize(actor: VerifiedActor, capability: OpsCapability, caseId: string | null): Promise<boolean>;
}

/**
 * Consumer-owned P1/P2 projection port. Implementations must delegate to the
 * canonical persistence, audit, case-analysis, readiness and report services.
 * P5 intentionally contains no alternate lifecycle or legal truth.
 */
export interface InternalOpsProjectionPort {
  queue(actor: VerifiedActor): Promise<QueueProjection>;
  case(actor: VerifiedActor, caseId: string): Promise<InternalOpsCaseProjection | null>;
  timeline(actor: VerifiedActor, caseId: string): Promise<TimelineProjection | null>;
  payment(actor: VerifiedActor, caseId: string): Promise<PaymentProjection | null>;
  documents(actor: VerifiedActor, caseId: string): Promise<DocumentProjection | null>;
  extraction(actor: VerifiedActor, caseId: string): Promise<ExtractionProjection | null>;
  facts(actor: VerifiedActor, caseId: string): Promise<FactsProjection | null>;
  readiness(actor: VerifiedActor, caseId: string): Promise<ReadinessProjection | null>;
  analysis(actor: VerifiedActor, caseId: string): Promise<AnalysisProjection | null>;
  report(actor: VerifiedActor, caseId: string): Promise<ReportProjection | null>;
  audit(actor: VerifiedActor, caseId: string): Promise<AuditProjection | null>;
}

/** Consumer-owned P1 transaction port; idempotency and revision checks are atomic. */
export interface InternalOpsCommandPort {
  execute(command: TrustedInternalOpsCommand): Promise<InternalOpsCommandResult>;
}

export type InternalOpsPorts = Readonly<{
  identity: InternalOpsIdentityPort;
  projections: InternalOpsProjectionPort;
  commands: InternalOpsCommandPort;
}>;
