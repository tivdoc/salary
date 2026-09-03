import type { CaseAnalysisPort, CaseOperationsPort, ReportBuilderPort } from "../wave3/contracts.ts";

/**
 * V0.7 freezes platform and product adapter ports around canonical Wave 3
 * services. These types do not replace domain Facts, Money, legal readiness,
 * RuleSpec, AnalysisRun, Finding, report, review, or audit truth models.
 */
export const V07_FEATURE_FLAGS = [
  "TIVDOC_INTERNAL_OPS_UI_ENABLED",
  "TIVDOC_INTERNAL_OPS_API_ENABLED",
  "TIVDOC_SYNTHETIC_OPS_ENABLED",
  "TIVDOC_PUBLIC_FIXTURE_OPS_ENABLED",
  "TIVDOC_MANUAL_REPORT_EXPORT_ENABLED",
  "TIVDOC_CUSTOMER_PORTAL_ENABLED",
  "TIVDOC_OFFLINE_SHADOW_ENABLED",
  "TIVDOC_CUSTOMER_PROCESSING_ENABLED",
  "TIVDOC_CUSTOMER_SHADOW_ENABLED",
  "TIVDOC_PRODUCTION_DELIVERY_ENABLED",
] as const;

export type V07FeatureFlag = (typeof V07_FEATURE_FLAGS)[number];

export interface ServerFeatureFlagPort {
  isEnabled(flag: V07FeatureFlag): boolean;
  projectForActor(flags: readonly V07FeatureFlag[], actor: VerifiedActor): Readonly<Record<V07FeatureFlag, boolean>>;
}

export const V07_ROLES = [
  "anonymous",
  "customer_owner",
  "intake_operator",
  "extraction_reviewer",
  "fact_reviewer",
  "legal_reviewer",
  "parameter_verifier",
  "report_approver",
  "auditor",
  "scoped_background_worker",
  "break_glass_admin",
] as const;

export type V07Role = (typeof V07_ROLES)[number];

export type VerifiedActor = Readonly<{
  actor_id: string;
  role: V07Role;
  tenant_id: string | null;
  assigned_case_ids: readonly string[];
  verified_server_side: true;
  break_glass_reason: string | null;
  break_glass_expires_at: string | null;
}>;

export type CommandEnvelope<T> = Readonly<{
  command_id: string;
  idempotency_key: string;
  expected_revision: number;
  actor: VerifiedActor;
  reason: string;
  payload: T;
}>;

export interface AtomicPlatformTransactionPort {
  execute<T>(command: CommandEnvelope<unknown>, mutation: () => Promise<T>): Promise<T>;
}

export type ObjectRetentionClass = "temporary" | "case_record" | "legal_record" | "report_record" | "audit_record";

export type ObjectWriteReservation = Readonly<{
  reservation_id: string;
  opaque_key: string;
  expected_sha256: string;
  expected_length: number;
  detected_mime: string;
  retention_class: ObjectRetentionClass;
}>;

export interface ObjectStoragePort {
  reserve(input: CommandEnvelope<Omit<ObjectWriteReservation, "reservation_id" | "opaque_key">>): Promise<ObjectWriteReservation>;
  stage(reservation: ObjectWriteReservation, bytes: AsyncIterable<Uint8Array>): Promise<Readonly<{ staged_sha256: string; staged_length: number }>>;
  finalize(reservation: ObjectWriteReservation): Promise<Readonly<{ object_version_id: string; object_sha256: string }>>;
  quarantine(objectVersionId: string, command: CommandEnvelope<Readonly<{ cause_code: string }>>): Promise<void>;
}

export type AuditEventInput = Readonly<{
  actor_id: string;
  action: string;
  resource_id: string;
  resource_revision: number;
  resource_sha256: string;
  reason: string;
  occurred_at: string;
}>;

export interface AuditEventPort {
  append(event: AuditEventInput): Promise<Readonly<{ sequence: number; previous_sha256: string | null; event_sha256: string }>>;
  verify(): Promise<Readonly<{ valid: boolean; event_count: number; tail_sha256: string | null }>>;
}

export interface AuditAnchorPort {
  anchor(input: Readonly<{ event_count: number; tail_sha256: string; anchored_at: string }>): Promise<Readonly<{ receipt_sha256: string }>>;
}

export interface ProductServicePorts {
  caseOperations: CaseOperationsPort;
  caseAnalysis: CaseAnalysisPort;
  reports: ReportBuilderPort;
  flags: ServerFeatureFlagPort;
  audit: AuditEventPort;
}

export type CapabilityLevel = "implemented" | "locally_verified" | "dynamically_verified" | "externally_verified" | "human_approved";

export type CapabilityReceipt = Readonly<{
  capability_id: string;
  levels: Readonly<Record<CapabilityLevel, boolean>>;
  evidence_paths: readonly string[];
  blocker_codes: readonly string[];
}>;
