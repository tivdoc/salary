import { z } from "zod";
import type { GroundTruthManifest } from "../../../../../engine/wave2/contracts.ts";
import type {
  HumanTrustPurpose,
  VerifiedHumanDecision,
} from "../../../../../engine/legal-operations/human-trust.ts";

export const GOVERNANCE_SCHEMA_VERSION = "tivdoc-durable-governance-v0.10.1" as const;

export const governanceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/u);
export const governanceVersionSchema = z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/u);
export const governanceSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const governanceTimestampSchema = z.iso.datetime({ offset: true });

export const governanceWorkflowKindSchema = z.enum([
  "reviewer_trust",
  "ground_truth",
  "legal_reconciliation",
  "parameter_approval",
  "rulespec_approval",
  "legal_review",
]);

export const governanceWorkKindSchema = z.enum([
  "ground_truth_visual_eligibility",
  "ground_truth_annotation",
  "ground_truth_adjudication",
  "ground_truth_lock",
  "legal_observation_reconciliation",
  "parameter_attestation",
  "rulespec_semantics",
  "golden_case_outputs",
]);

export const governanceMutationStateSchema = z.enum([
  "registered",
  "organization_registered",
  "policy_published",
  "reviewer_registered",
  "key_challenge_issued",
  "key_registered",
  "key_rotated",
  "key_revoked",
  "decision_admitted",
  "pending",
  "claimed",
  "released",
  "eligible_for_private_ground_truth_work",
  "rejected_for_private_ground_truth_work",
  "annotation_1",
  "annotation_2",
  "disagreement",
  "human_adjudication",
  "locked_ground_truth",
  "reconciliation_candidate_inactive",
  "reconciliation_rejected",
  "reconciliation_needs_more_evidence",
  "reconciliation_superseded",
  "reconciliation_reviewed_inactive",
  "candidate_inactive",
  "awaiting_second_attestation",
  "dual_attested_inactive",
  "awaiting_complementary_approval",
  "dual_approved_inactive",
  "pending_review",
  "in_review",
  "changes_requested",
  "approved",
  "rejected",
  "superseded",
]);

export const legalObservationCandidateSchema = z.object({
  schema_version: z.literal(GOVERNANCE_SCHEMA_VERSION),
  observation_id: governanceIdSchema,
  observation_version: governanceVersionSchema,
  observation_kind: z.enum([
    "catalog_listing",
    "source_bytes",
    "source_metadata",
    "citation_candidate",
    "temporal_candidate",
    "scope_candidate",
  ]),
  source_candidate_id: governanceIdSchema.nullable(),
  instrument_candidate_id: governanceIdSchema.nullable(),
  observed_url: z.url().max(2_048),
  artifact_version_id: governanceIdSchema.nullable(),
  byte_object_id: governanceIdSchema.nullable(),
  bytes_sha256: governanceSha256Schema.nullable(),
  topic: governanceIdSchema.nullable(),
  candidate_valid_from: z.iso.date().nullable(),
  candidate_valid_to: z.iso.date().nullable(),
  // Historical acquisition evidence did not always retain a trustworthy
  // observation timestamp.  Absence stays explicit instead of being filled
  // with an import time that would change the meaning of the source record.
  knowledge_time: governanceTimestampSchema.nullable(),
  sectors: z.array(governanceIdSchema).max(64).readonly(),
  populations: z.array(governanceIdSchema).max(64).readonly(),
  geographies: z.array(governanceIdSchema).max(64).readonly(),
  provenance: z.record(z.string(), z.unknown()),
  contradiction_refs: z.array(governanceIdSchema).max(128).readonly(),
  gap_refs: z.array(governanceIdSchema).max(128).readonly(),
  alias_refs: z.array(governanceIdSchema).max(128).readonly(),
  duplicate_refs: z.array(governanceIdSchema).max(128).readonly(),
  overlap_refs: z.array(governanceIdSchema).max(128).readonly(),
  legal_effect: z.literal("unreviewed"),
  activation_allowed: z.literal(false),
  candidate_sha256: governanceSha256Schema,
}).strict().superRefine((value, context) => {
  if (value.candidate_valid_from !== null && value.candidate_valid_to !== null
      && value.candidate_valid_to < value.candidate_valid_from) {
    context.addIssue({ code: "custom", message: "legal_observation_interval_inverted" });
  }
  if ((value.byte_object_id === null) !== (value.bytes_sha256 === null)) {
    context.addIssue({ code: "custom", message: "legal_observation_byte_binding_incomplete" });
  }
}).readonly();

export const legalObservationDecisionSchema = z.object({
  schema_version: z.literal(GOVERNANCE_SCHEMA_VERSION),
  decision_id: governanceIdSchema,
  observation_id: governanceIdSchema,
  observation_version: governanceVersionSchema,
  candidate_sha256: governanceSha256Schema,
  disposition: z.enum(["accepted", "rejected", "needs_more_evidence", "superseded"]),
  reviewer_id: governanceIdSchema,
  reviewer_role: z.literal("human_source_reviewer"),
  decided_at: governanceTimestampSchema,
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/u),
  legal_effect: z.literal("reconciliation_candidate_only"),
  activation_allowed: z.literal(false),
  signature_sha256: governanceSha256Schema,
}).strict().readonly();

export const governanceWorkEnqueueSchema = z.object({
  work_item_id: governanceIdSchema,
  workflow_kind: governanceWorkflowKindSchema,
  aggregate_id: governanceIdSchema,
  aggregate_version: governanceVersionSchema,
  work_kind: governanceWorkKindSchema,
  required_role: governanceIdSchema,
  document_sha256: governanceSha256Schema.nullable(),
  object_version_id: governanceIdSchema.nullable(),
  input_sha256: governanceSha256Schema,
  payload: z.record(z.string(), z.unknown()),
  idempotency_key: governanceIdSchema,
  created_at: governanceTimestampSchema,
}).strict().superRefine((value, context) => {
  const groundTruth = value.workflow_kind === "ground_truth";
  if (groundTruth && (value.document_sha256 === null || value.object_version_id === null)) {
    context.addIssue({ code: "custom", message: "ground_truth_work_requires_exact_byte_version" });
  }
}).readonly();

export const governanceWorkClaimRequestSchema = z.object({
  workflow_kind: governanceWorkflowKindSchema,
  work_kind: governanceWorkKindSchema,
  claimant_id: governanceIdSchema,
  reviewer_role: governanceIdSchema,
  now: governanceTimestampSchema,
  lease_seconds: z.number().int().min(30).max(86_400),
}).strict().readonly();

export const governanceWorkReleaseSchema = z.object({
  work_item_id: governanceIdSchema,
  claimant_id: governanceIdSchema,
  fencing_token: z.number().int().positive(),
  next_state: z.enum(["pending", "released"]),
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/u),
  occurred_at: governanceTimestampSchema,
  idempotency_key: governanceIdSchema,
}).strict().readonly();

export type GovernanceWorkflowKind = z.infer<typeof governanceWorkflowKindSchema>;
export type GovernanceWorkKind = z.infer<typeof governanceWorkKindSchema>;
export type GovernanceMutationState = z.infer<typeof governanceMutationStateSchema>;
export type LegalObservationCandidate = z.infer<typeof legalObservationCandidateSchema>;
export type LegalObservationDecision = z.infer<typeof legalObservationDecisionSchema>;
export type GovernanceWorkEnqueue = z.infer<typeof governanceWorkEnqueueSchema>;
export type GovernanceWorkClaimRequest = z.infer<typeof governanceWorkClaimRequestSchema>;
export type GovernanceWorkRelease = z.infer<typeof governanceWorkReleaseSchema>;

export type GovernanceCommandMetadata = Readonly<{
  idempotency_key: string;
  occurred_at: string;
}>;

export type GovernanceClaimFence = Readonly<{
  work_item_id: string;
  claimant_id: string;
  fencing_token: number;
}>;

export type GovernanceMutationReceipt = Readonly<{
  tenant_id: string;
  workflow_kind: GovernanceWorkflowKind;
  aggregate_id: string;
  aggregate_version: string;
  revision: number;
  state: GovernanceMutationState;
  content_sha256: string;
  audit_event_sha256: string;
  idempotent_replay: boolean;
  activation_allowed: false;
}>;

export type HumanDecisionAdmissionReceipt = Readonly<{
  tenant_id: string;
  envelope_id: string;
  aggregate_id: string;
  aggregate_version: string;
  aggregate_revision: number;
  envelope_sha256: string;
  signature_sha256: string;
  reviewer_id: string;
  reviewer_role: string;
  key_id: string;
  purpose: HumanTrustPurpose;
  admitted_at: string;
  idempotent_replay: boolean;
}>;

export type ReviewerVerificationMaterial = Readonly<{
  tenant_id: string;
  organization_id: string;
  organization_version: string;
  policy_version: string;
  reviewer_id: string;
  reviewer_identity_version: string;
  reviewer_roles: readonly string[];
  reviewer_record_sha256: string;
  key_id: string;
  public_key_spki_pem: string;
  public_key_sha256: string;
  purpose: HumanTrustPurpose;
  required_reviewer_role: string;
  valid_at_signing_time: boolean;
  currently_trusted: boolean;
}>;

export type GovernanceWorkClaim = Readonly<{
  tenant_id: string;
  work_item_id: string;
  workflow_kind: GovernanceWorkflowKind;
  aggregate_id: string;
  aggregate_version: string;
  work_kind: GovernanceWorkKind;
  required_role: string;
  document_sha256: string | null;
  object_version_id: string | null;
  input_sha256: string;
  state: "claimed";
  claimant_id: string;
  fencing_token: number;
  lease_expires_at: string;
}>;

export type GovernanceAggregateSnapshot = Readonly<{
  receipt: GovernanceMutationReceipt;
  content: unknown;
}>;

export type GovernanceHumanDecision = Readonly<{
  verification: VerifiedHumanDecision;
  payload: Readonly<Record<string, unknown>>;
  expected_payload_schema_version: string;
  expected_purpose: HumanTrustPurpose;
  expected_reviewer_role: string;
  expected_reviewer_id: string;
  expected_occurred_at: string;
  embedded_signature_sha256: string;
}>;

export type GroundTruthManifestAppendInput = Readonly<{
  event_kind:
    | "annotation_1_signed"
    | "annotation_2_signed"
    | "disagreement_recorded"
    | "adjudication_signed"
    | "ground_truth_locked"
    | "correction_started";
  prior_manifest: GroundTruthManifest | null;
  manifest: GroundTruthManifest;
  expected_workflow_revision: number;
  claim: GovernanceClaimFence | null;
  verification: VerifiedHumanDecision | null;
  metadata: GovernanceCommandMetadata;
}>;

export type GovernanceRepositoryErrorCode =
  | "GOVERNANCE_INPUT_INVALID"
  | "GOVERNANCE_HASH_MISMATCH"
  | "GOVERNANCE_HUMAN_DECISION_UNTRUSTED"
  | "GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH"
  | "GOVERNANCE_SIGNATURE_INVALID"
  | "GOVERNANCE_CLAIM_FENCE_INVALID"
  | "GOVERNANCE_ROW_MALFORMED"
  | "GOVERNANCE_RECORD_NOT_FOUND"
  | "GOVERNANCE_QUERY_FAILED"
  | "GOVERNANCE_DECODE_FAILED"
  | "GOVERNANCE_IDEMPOTENT_REPLAY_CONFLICT";

/** Driver and database details do not cross the governance boundary. */
export class GovernanceRepositoryError extends Error {
  readonly code: GovernanceRepositoryErrorCode;
  readonly operation: string;

  constructor(code: GovernanceRepositoryErrorCode, operation: string) {
    super(`${code}:${operation}`);
    this.name = "GovernanceRepositoryError";
    this.code = code;
    this.operation = operation;
  }
}
