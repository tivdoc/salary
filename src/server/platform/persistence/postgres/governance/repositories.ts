import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { ZodError, type ZodType, z } from "zod";
import { canonicalSha256 } from "../../../../../engine/rule-runtime/canonical.ts";
import {
  groundTruthVisualEligibilitySchema,
  trustedGroundTruthActionPayload,
  TRUSTED_GT_SCHEMA,
  type GroundTruthVisualEligibility,
} from "../../../../../engine/extraction-ground-truth/trusted-contracts.ts";
import { validateGroundTruthManifest } from "../../../../../engine/extraction-ground-truth/validation.ts";
import {
  humanDecisionEnvelopeBody,
  humanDecisionEnvelopeSha256,
  humanDecisionPayloadSha256,
  humanDecisionSignatureBytes,
  humanDecisionSignatureSha256,
  humanDecisionSigningBytes,
  payloadWithoutEmbeddedSignature,
  signedHumanDecisionEnvelopeSchema,
  type HumanTrustPurpose,
  type VerifiedHumanDecision,
} from "../../../../../engine/legal-operations/human-trust.ts";
import { legalOperationsSha256 } from "../../../../../engine/legal-operations/canonical.ts";
import {
  parameterAttestationSchema,
  parameterCandidateSchema,
  semanticApprovalSchema,
  type ParameterAttestation,
  type ParameterCandidate,
  type SemanticApproval,
} from "../../../../../engine/legal-operations/contracts.ts";
import {
  keyPossessionChallengeSchema,
  keyPossessionSigningBytes,
  reviewerTrustPolicySchema,
  trustedReviewerSchema,
  trustOrganizationSchema,
  type KeyPossessionChallenge,
  type ReviewerTrustPolicy,
  type TrustedReviewer,
  type TrustOrganization,
} from "../../../trust/reviewer-trust-contracts.ts";
import {
  legalReviewDurableRowSchema,
  legalReviewPacketSchema,
  LegalReviewError,
  type LegalReviewAction,
  type LegalReviewDurableRow,
  type LegalReviewPacket,
} from "../../../../../engine/legal-review/contracts.ts";
import {
  applyLegalReviewAction,
  deriveLegalReviewPacketIdentity,
} from "../../../../../engine/legal-review/workflow.ts";
import {
  validateGoldenCaseSet,
  validateRuleSpecPackage,
  type GoldenCaseSet,
  type RuleSpecPackage,
} from "../../../../../engine/legal-operations/rulespec.ts";
import type { PostgresStatement, PostgresTransactionContext } from "../contracts.ts";
import {
  decodeGovernanceAggregateSnapshot,
  decodeGovernanceMutationReceipt,
  decodeGovernanceWorkClaim,
  decodeHumanDecisionAdmission,
  decodeReviewerVerificationMaterial,
} from "./codecs.ts";
import {
  GovernanceRepositoryError,
  governanceIdSchema,
  governanceVersionSchema,
  governanceTimestampSchema,
  governanceWorkClaimRequestSchema,
  governanceWorkEnqueueSchema,
  governanceWorkReleaseSchema,
  governanceWorkQueueEntrySchema,
  governanceWorkflowKindSchema,
  type GovernanceWorkQueueEntry,
  legalObservationCandidateSchema,
  legalObservationDecisionSchema,
  type GovernanceAggregateSnapshot,
  type GovernanceClaimFence,
  type GovernanceCommandMetadata,
  type GovernanceHumanDecision,
  type GovernanceMutationReceipt,
  type GovernanceWorkClaim,
  type GovernanceWorkClaimRequest,
  type GovernanceWorkRelease,
  type GovernanceWorkflowKind,
  type GroundTruthManifestAppendInput,
  type HumanDecisionAdmissionReceipt,
  type LegalObservationCandidate,
  type LegalObservationDecision,
  type ReviewerVerificationMaterial,
} from "./contracts.ts";
import {
  aggregateReadStatement,
  goldenCaseSetImportStatement,
  groundTruthEligibilityAppendStatement,
  groundTruthManifestAppendStatement,
  humanDecisionAdmitStatement,
  keyChallengeAppendStatement,
  legalObservationDecideStatement,
  legalObservationImportStatement,
  legalReviewActionAppendStatement,
  legalReviewPacketEnqueueStatement,
  legalReviewQueueListStatement,
  parameterAttestationAppendStatement,
  parameterImportStatement,
  reviewerAppendStatement,
  reviewerKeyRegisterStatement,
  reviewerKeyRevokeStatement,
  reviewerVerificationMaterialReadStatement,
  ruleSpecApprovalAppendStatement,
  ruleSpecImportStatement,
  trustOrganizationAppendStatement,
  trustPolicyAppendStatement,
  workClaimStatement,
  workEnqueueStatement,
  workReleaseStatement,
  workQueueListStatement,
} from "./statements.ts";

type UnknownRecord = Readonly<Record<string, unknown>>;

function asRecord(value: object): UnknownRecord {
  return value as UnknownRecord;
}

// Aggregate versions are either version-shaped (a ground-truth manifest at
// revision 1 is admitted as "1") or id-shaped (an observation, parameter or
// rule-spec version). The id schema alone refused "1" — three characters
// minimum — so no manifest under revision 100 could ever be admitted, which
// the first real call of the ground-truth path surfaced.
const aggregateVersionSchema = z.union([governanceVersionSchema, governanceIdSchema]);

function parse<T>(schema: ZodType<T>, value: unknown, operation: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    throw error;
  }
}

function metadata(value: GovernanceCommandMetadata, operation: string): GovernanceCommandMetadata {
  return Object.freeze({
    idempotency_key: parse(governanceIdSchema, value.idempotency_key, operation),
    occurred_at: parse(governanceTimestampSchema, value.occurred_at, operation),
  });
}

function assertPositiveRevision(value: number, operation: string, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
  }
}

function timestampMs(value: string, operation: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
  return parsed;
}

function commandSha256(scope: string, tenantId: string, command: unknown): string {
  return legalOperationsSha256({ scope, tenant_id: tenantId, command });
}

function withoutHash(value: UnknownRecord, hashField: string): UnknownRecord {
  const content: Record<string, unknown> = { ...value };
  delete content[hashField];
  return content;
}

function assertContentHash(value: UnknownRecord, hashField: string, operation: string): void {
  const expected = value[hashField];
  if (typeof expected !== "string" || legalOperationsSha256(withoutHash(value, hashField)) !== expected) {
    throw new GovernanceRepositoryError("GOVERNANCE_HASH_MISMATCH", operation);
  }
}

function assertClaimFence(claim: GovernanceClaimFence, operation: string): GovernanceClaimFence {
  if (!Number.isSafeInteger(claim.fencing_token) || claim.fencing_token < 1) {
    throw new GovernanceRepositoryError("GOVERNANCE_CLAIM_FENCE_INVALID", operation);
  }
  return Object.freeze({
    work_item_id: parse(governanceIdSchema, claim.work_item_id, operation),
    claimant_id: parse(governanceIdSchema, claim.claimant_id, operation),
    fencing_token: claim.fencing_token,
  });
}

async function queryExactlyOne(
  context: PostgresTransactionContext,
  sql: PostgresStatement,
  operation: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const result = await context.client.query(sql);
    if (result.row_count !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
      throw new GovernanceRepositoryError("GOVERNANCE_RECORD_NOT_FOUND", operation);
    }
    return result.rows[0];
  } catch (error) {
    if (error instanceof GovernanceRepositoryError) throw error;
    throw new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", operation, error);
  }
}

function assertReceiptIdentity(
  receipt: GovernanceMutationReceipt,
  expected: Readonly<{
    tenant_id: string;
    workflow_kind?: GovernanceWorkflowKind;
    aggregate_id?: string;
    aggregate_version?: string;
  }>,
  operation: string,
): GovernanceMutationReceipt {
  if (receipt.tenant_id !== expected.tenant_id
      || (expected.workflow_kind !== undefined && receipt.workflow_kind !== expected.workflow_kind)
      || (expected.aggregate_id !== undefined && receipt.aggregate_id !== expected.aggregate_id)
      || (expected.aggregate_version !== undefined && receipt.aggregate_version !== expected.aggregate_version)) {
    throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
  }
  return receipt;
}

function publicKey(pem: string, operation: string) {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("algorithm");
    return key;
  } catch {
    throw new GovernanceRepositoryError("GOVERNANCE_SIGNATURE_INVALID", operation);
  }
}

function publicKeySha256(pem: string, operation: string): string {
  const key = publicKey(pem, operation);
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function verifyEd25519(pem: string, bytes: Uint8Array, signatureBase64: string, operation: string): void {
  let signature: Uint8Array;
  try {
    signature = humanDecisionSignatureBytes(signatureBase64);
  } catch {
    throw new GovernanceRepositoryError("GOVERNANCE_SIGNATURE_INVALID", operation);
  }
  if (!verifySignature(null, bytes, publicKey(pem, operation), signature)) {
    throw new GovernanceRepositoryError("GOVERNANCE_SIGNATURE_INVALID", operation);
  }
}

function same(left: unknown, right: unknown): boolean {
  return legalOperationsSha256(left) === legalOperationsSha256(right);
}

abstract class GovernanceRepositoryBase {
  protected readonly context: PostgresTransactionContext;
  protected readonly tenantId: string;

  constructor(context: PostgresTransactionContext, tenantId: string) {
    if (!context?.client || typeof context.client.query !== "function" || typeof context.transaction_id !== "string") {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", "constructor");
    }
    this.context = context;
    this.tenantId = parse(governanceIdSchema, tenantId, "constructor");
  }

  protected async mutation(
    sql: PostgresStatement,
    expected: Parameters<typeof assertReceiptIdentity>[1],
    operation: string,
  ): Promise<GovernanceMutationReceipt> {
    const receipt = decodeGovernanceMutationReceipt(await queryExactlyOne(this.context, sql, operation));
    return assertReceiptIdentity(receipt, expected, operation);
  }

  async readCurrent(
    workflowKind: GovernanceWorkflowKind,
    aggregateId: string,
    aggregateVersion: string,
  ): Promise<GovernanceAggregateSnapshot> {
    const aggregate_id = parse(governanceIdSchema, aggregateId, "aggregate_read");
    const aggregate_version = parse(aggregateVersionSchema, aggregateVersion, "aggregate_read");
    const snapshot = decodeGovernanceAggregateSnapshot(await queryExactlyOne(this.context, aggregateReadStatement({
      tenant_id: this.tenantId,
      workflow_kind: workflowKind,
      aggregate_id,
      aggregate_version,
    }), "aggregate_read"));
    assertReceiptIdentity(snapshot.receipt, {
      tenant_id: this.tenantId,
      workflow_kind: workflowKind,
      aggregate_id,
      aggregate_version,
    }, "aggregate_read");
    return snapshot;
  }
}

export class PostgresReviewerTrustRepository extends GovernanceRepositoryBase {
  async appendOrganization(
    candidate: unknown,
    actorId: string,
    commandMetadata: GovernanceCommandMetadata,
  ): Promise<GovernanceMutationReceipt> {
    const operation = "trust_organization_append";
    const record = parse(trustOrganizationSchema, candidate, operation);
    assertContentHash(asRecord(record), "organization_record_sha256", operation);
    const actor_id = parse(governanceIdSchema, actorId, operation);
    const meta = metadata(commandMetadata, operation);
    const command = { record, actor_id, occurred_at: meta.occurred_at };
    return this.mutation(trustOrganizationAppendStatement({
      tenant_id: this.tenantId,
      record: asRecord(record),
      actor_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      occurred_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: record.organization_id,
      aggregate_version: record.organization_version }, operation);
  }

  async appendPolicy(
    candidate: unknown,
    actorId: string,
    commandMetadata: GovernanceCommandMetadata,
  ): Promise<GovernanceMutationReceipt> {
    const operation = "trust_policy_append";
    const record = parse(reviewerTrustPolicySchema, candidate, operation);
    assertContentHash(asRecord(record), "policy_sha256", operation);
    const actor_id = parse(governanceIdSchema, actorId, operation);
    const meta = metadata(commandMetadata, operation);
    return this.mutation(trustPolicyAppendStatement({
      tenant_id: this.tenantId,
      record: asRecord(record),
      actor_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, { record, actor_id, occurred_at: meta.occurred_at }),
      occurred_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: record.organization_id,
      aggregate_version: record.policy_version }, operation);
  }

  async appendReviewer(
    candidate: unknown,
    actorId: string,
    commandMetadata: GovernanceCommandMetadata,
  ): Promise<GovernanceMutationReceipt> {
    const operation = "reviewer_append";
    const record = parse(trustedReviewerSchema, candidate, operation);
    assertContentHash(asRecord(record), "reviewer_record_sha256", operation);
    const actor_id = parse(governanceIdSchema, actorId, operation);
    if (actor_id === record.reviewer_id) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    const meta = metadata(commandMetadata, operation);
    return this.mutation(reviewerAppendStatement({
      tenant_id: this.tenantId,
      record: asRecord(record),
      actor_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, { record, actor_id, occurred_at: meta.occurred_at }),
      occurred_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: record.reviewer_id,
      aggregate_version: record.reviewer_identity_version }, operation);
  }

  async appendKeyChallenge(
    candidate: unknown,
    actorId: string,
    commandMetadata: GovernanceCommandMetadata,
  ): Promise<GovernanceMutationReceipt> {
    const operation = "key_challenge_append";
    const record = parse(keyPossessionChallengeSchema, candidate, operation);
    if (publicKeySha256(record.public_key_spki_pem, operation) !== record.public_key_sha256) {
      throw new GovernanceRepositoryError("GOVERNANCE_HASH_MISMATCH", operation);
    }
    const actor_id = parse(governanceIdSchema, actorId, operation);
    const meta = metadata(commandMetadata, operation);
    return this.mutation(keyChallengeAppendStatement({
      tenant_id: this.tenantId,
      record: asRecord(record),
      actor_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, { record, actor_id, occurred_at: meta.occurred_at }),
      occurred_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: record.key_id,
      aggregate_version: record.reviewer_identity_version }, operation);
  }

  async registerProvenKey(input: Readonly<{
    challenge: KeyPossessionChallenge;
    proof_signature_base64: string;
    rotation_authorization_signature_base64?: string;
    prior_public_key_spki_pem?: string;
    registered_at: string;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "reviewer_key_register";
    const challenge = parse(keyPossessionChallengeSchema, input.challenge, operation);
    const registeredAt = parse(governanceTimestampSchema, input.registered_at, operation);
    if (timestampMs(registeredAt, operation) > timestampMs(challenge.challenge_expires_at, operation)) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_UNTRUSTED", operation);
    }
    if (publicKeySha256(challenge.public_key_spki_pem, operation) !== challenge.public_key_sha256) {
      throw new GovernanceRepositoryError("GOVERNANCE_HASH_MISMATCH", operation);
    }
    verifyEd25519(challenge.public_key_spki_pem, keyPossessionSigningBytes(challenge), input.proof_signature_base64, operation);
    let rotationAuthorizationSha256: string | null = null;
    if (challenge.replaces_key_id !== null) {
      if (input.prior_public_key_spki_pem === undefined || input.rotation_authorization_signature_base64 === undefined) {
        throw new GovernanceRepositoryError("GOVERNANCE_SIGNATURE_INVALID", operation);
      }
      verifyEd25519(input.prior_public_key_spki_pem, keyPossessionSigningBytes(challenge),
        input.rotation_authorization_signature_base64, operation);
      rotationAuthorizationSha256 = humanDecisionSignatureSha256(input.rotation_authorization_signature_base64);
    } else if (input.prior_public_key_spki_pem !== undefined || input.rotation_authorization_signature_base64 !== undefined) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    const meta = metadata(input.metadata, operation);
    const proofSignatureSha256 = humanDecisionSignatureSha256(input.proof_signature_base64);
    const command = {
      challenge_id: challenge.challenge_id,
      registered_at: registeredAt,
      proof_signature_sha256: proofSignatureSha256,
      rotation_authorization_signature_sha256: rotationAuthorizationSha256,
    };
    return this.mutation(reviewerKeyRegisterStatement({
      tenant_id: this.tenantId,
      ...command,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: challenge.key_id,
      aggregate_version: challenge.reviewer_identity_version }, operation);
  }

  async revokeKey(input: Readonly<{
    key_id: string;
    effective_at: string;
    reason_code: string;
    actor_id: string;
    recorded_at: string;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "reviewer_key_revoke";
    const command = {
      key_id: parse(governanceIdSchema, input.key_id, operation),
      effective_at: parse(governanceTimestampSchema, input.effective_at, operation),
      reason_code: input.reason_code,
      actor_id: parse(governanceIdSchema, input.actor_id, operation),
      recorded_at: parse(governanceTimestampSchema, input.recorded_at, operation),
    };
    if (!/^[A-Z][A-Z0-9_]{2,99}$/u.test(command.reason_code)
        || timestampMs(command.effective_at, operation) > timestampMs(command.recorded_at, operation)) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const meta = metadata(input.metadata, operation);
    return this.mutation(reviewerKeyRevokeStatement({
      tenant_id: this.tenantId,
      ...command,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
    }), { tenant_id: this.tenantId, workflow_kind: "reviewer_trust", aggregate_id: command.key_id }, operation);
  }

  async readVerificationMaterial(input: Readonly<{
    organization_id: string;
    organization_version: string;
    policy_version: string;
    reviewer_id: string;
    reviewer_identity_version: string;
    key_id: string;
    purpose: HumanTrustPurpose;
    required_reviewer_role: string;
    issued_at: string;
    admitted_at: string;
  }>): Promise<ReviewerVerificationMaterial> {
    const operation = "verification_material_read";
    const query = {
      tenant_id: this.tenantId,
      organization_id: parse(governanceIdSchema, input.organization_id, operation),
      organization_version: parse(governanceIdSchema, input.organization_version, operation),
      policy_version: parse(governanceIdSchema, input.policy_version, operation),
      reviewer_id: parse(governanceIdSchema, input.reviewer_id, operation),
      reviewer_identity_version: parse(governanceIdSchema, input.reviewer_identity_version, operation),
      key_id: parse(governanceIdSchema, input.key_id, operation),
      purpose: input.purpose,
      required_reviewer_role: parse(governanceIdSchema, input.required_reviewer_role, operation),
      issued_at: parse(governanceTimestampSchema, input.issued_at, operation),
      admitted_at: parse(governanceTimestampSchema, input.admitted_at, operation),
    };
    const material = decodeReviewerVerificationMaterial(await queryExactlyOne(
      this.context,
      reviewerVerificationMaterialReadStatement(query),
      operation,
    ));
    if (material.tenant_id !== this.tenantId
        || material.organization_id !== query.organization_id
        || material.organization_version !== query.organization_version
        || material.policy_version !== query.policy_version
        || material.reviewer_id !== query.reviewer_id
        || material.reviewer_identity_version !== query.reviewer_identity_version
        || material.key_id !== query.key_id
        || material.purpose !== query.purpose
        || material.required_reviewer_role !== query.required_reviewer_role) {
      throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
    }
    return material;
  }

  async admitDecision(input: Readonly<{
    workflow_kind: Exclude<GovernanceWorkflowKind, "reviewer_trust">;
    aggregate_id: string;
    aggregate_version: string;
    aggregate_revision: number;
    evidence: GovernanceHumanDecision;
    metadata: GovernanceCommandMetadata;
  }>): Promise<HumanDecisionAdmissionReceipt> {
    const operation = "human_decision_admit";
    assertPositiveRevision(input.aggregate_revision, operation);
    const aggregateId = parse(governanceIdSchema, input.aggregate_id, operation);
    const aggregateVersion = parse(aggregateVersionSchema, input.aggregate_version, operation);
    const meta = metadata(input.metadata, operation);
    const verification = input.evidence.verification;
    const envelope = parse(signedHumanDecisionEnvelopeSchema, verification.envelope, operation);
    const payloadSha256 = humanDecisionPayloadSha256(input.evidence.payload);
    const fieldsMatch = verification.envelope_sha256 === humanDecisionEnvelopeSha256(envelope)
      && verification.signature_sha256 === humanDecisionSignatureSha256(envelope.signature_base64)
      && verification.organization_id === envelope.organization_id
      && verification.organization_version === envelope.organization_version
      && verification.policy_version === envelope.policy_version
      && verification.reviewer_id === envelope.reviewer_id
      && verification.reviewer_identity_version === envelope.reviewer_identity_version
      && verification.reviewer_role === envelope.reviewer_role
      && verification.key_id === envelope.key_id
      && verification.purpose === envelope.purpose
      && envelope.payload_sha256 === payloadSha256
      && envelope.payload_schema_version === input.evidence.expected_payload_schema_version
      && envelope.purpose === input.evidence.expected_purpose
      && envelope.reviewer_role === input.evidence.expected_reviewer_role
      && envelope.reviewer_id === input.evidence.expected_reviewer_id
      && envelope.issued_at === input.evidence.expected_occurred_at
      && verification.signature_sha256 === input.evidence.embedded_signature_sha256;
    if (!fieldsMatch) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    if (!verification.valid_at_signing_time || !verification.currently_trusted
        || timestampMs(meta.occurred_at, operation) > timestampMs(envelope.expires_at, operation)) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_UNTRUSTED", operation);
    }
    const material = await this.readVerificationMaterial({
      organization_id: envelope.organization_id,
      organization_version: envelope.organization_version,
      policy_version: envelope.policy_version,
      reviewer_id: envelope.reviewer_id,
      reviewer_identity_version: envelope.reviewer_identity_version,
      key_id: envelope.key_id,
      purpose: envelope.purpose,
      required_reviewer_role: envelope.reviewer_role,
      issued_at: envelope.issued_at,
      admitted_at: meta.occurred_at,
    });
    if (!material.valid_at_signing_time || !material.currently_trusted
        || !material.reviewer_roles.includes(envelope.reviewer_role)
        || publicKeySha256(material.public_key_spki_pem, operation) !== material.public_key_sha256) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_UNTRUSTED", operation);
    }
    verifyEd25519(material.public_key_spki_pem, humanDecisionSigningBytes(humanDecisionEnvelopeBody(envelope)),
      envelope.signature_base64, operation);
    const command = {
      workflow_kind: input.workflow_kind,
      aggregate_id: aggregateId,
      aggregate_version: aggregateVersion,
      aggregate_revision: input.aggregate_revision,
      payload: input.evidence.payload,
      payload_sha256: payloadSha256,
      verification,
      admitted_at: meta.occurred_at,
    };
    const receipt = decodeHumanDecisionAdmission(await queryExactlyOne(this.context, humanDecisionAdmitStatement({
      tenant_id: this.tenantId,
      ...command,
      verification: asRecord(verification),
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
    }), operation));
    if (receipt.tenant_id !== this.tenantId || receipt.envelope_id !== envelope.envelope_id
        || receipt.aggregate_id !== aggregateId || receipt.aggregate_version !== aggregateVersion
        || receipt.aggregate_revision !== input.aggregate_revision || receipt.envelope_sha256 !== verification.envelope_sha256
        || receipt.signature_sha256 !== verification.signature_sha256 || receipt.reviewer_id !== envelope.reviewer_id
        || receipt.reviewer_role !== envelope.reviewer_role || receipt.key_id !== envelope.key_id
        || receipt.purpose !== envelope.purpose) {
      throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
    }
    return receipt;
  }
}

export class PostgresGovernanceWorkRepository extends GovernanceRepositoryBase {
  async enqueue(candidate: unknown): Promise<GovernanceMutationReceipt> {
    const operation = "work_enqueue";
    const input = parse(governanceWorkEnqueueSchema, candidate, operation);
    const command = { ...input };
    return this.mutation(workEnqueueStatement({
      tenant_id: this.tenantId,
      ...input,
      command_sha256: commandSha256(operation, this.tenantId, command),
    }), { tenant_id: this.tenantId, workflow_kind: input.workflow_kind, aggregate_id: input.aggregate_id,
      aggregate_version: input.aggregate_version }, operation);
  }

  async claim(candidate: GovernanceWorkClaimRequest): Promise<GovernanceWorkClaim | null> {
    const operation = "work_claim";
    const input = parse(governanceWorkClaimRequestSchema, candidate, operation);
    try {
      const result = await this.context.client.query(workClaimStatement({ tenant_id: this.tenantId, ...input }));
      if (result.row_count === 0 && result.rows.length === 0) return null;
      if (result.row_count !== 1 || result.rows.length !== 1 || result.rows[0] === undefined) {
        throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
      }
      const claim = decodeGovernanceWorkClaim(result.rows[0]);
      if (claim.tenant_id !== this.tenantId || claim.workflow_kind !== input.workflow_kind
          || claim.work_kind !== input.work_kind || claim.claimant_id !== input.claimant_id
          || claim.required_role !== input.reviewer_role) {
        throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
      }
      return claim;
    } catch (error) {
      if (error instanceof GovernanceRepositoryError) throw error;
      throw new GovernanceRepositoryError("GOVERNANCE_QUERY_FAILED", operation, error);
    }
  }

  async release(candidate: GovernanceWorkRelease): Promise<GovernanceMutationReceipt> {
    const operation = "work_release";
    const input = parse(governanceWorkReleaseSchema, candidate, operation);
    const command = { ...input };
    return this.mutation(workReleaseStatement({
      tenant_id: this.tenantId,
      ...input,
      command_sha256: commandSha256(operation, this.tenantId, command),
    }), { tenant_id: this.tenantId }, operation);
  }

  /** The queue as a projection: identity, state, claimant and lease, never payload. */
  async listQueue(workflowKind: GovernanceWorkflowKind, limit: number): Promise<readonly GovernanceWorkQueueEntry[]> {
    const operation = "work_queue_list";
    const workflow_kind = parse(governanceWorkflowKindSchema, workflowKind, operation);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const row = await queryExactlyOne(this.context, workQueueListStatement({
      tenant_id: this.tenantId, workflow_kind, limit,
    }), operation);
    const entries = (row as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw new GovernanceRepositoryError("GOVERNANCE_DECODE_FAILED", operation);
    return Object.freeze(entries.map((entry) => {
      try {
        return governanceWorkQueueEntrySchema.parse(entry);
      } catch {
        throw new GovernanceRepositoryError("GOVERNANCE_DECODE_FAILED", operation);
      }
    }));
  }
}

export class PostgresGroundTruthRepository extends GovernanceRepositoryBase {
  readonly #trust: PostgresReviewerTrustRepository;

  constructor(context: PostgresTransactionContext, tenantId: string) {
    super(context, tenantId);
    this.#trust = new PostgresReviewerTrustRepository(context, tenantId);
  }

  async appendVisualEligibility(input: Readonly<{
    decision: GroundTruthVisualEligibility;
    claim: GovernanceClaimFence;
    verification: VerifiedHumanDecision;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "gt_eligibility_append";
    const decision = parse(groundTruthVisualEligibilitySchema, input.decision, operation);
    const claim = assertClaimFence(input.claim, operation);
    if (claim.claimant_id !== decision.reviewer_id) {
      throw new GovernanceRepositoryError("GOVERNANCE_CLAIM_FENCE_INVALID", operation);
    }
    const meta = metadata(input.metadata, operation);
    const payload = payloadWithoutEmbeddedSignature(decision);
    await this.#trust.admitDecision({
      workflow_kind: "ground_truth",
      aggregate_id: decision.eligibility_id,
      aggregate_version: "1",
      aggregate_revision: 1,
      evidence: {
        verification: input.verification,
        payload,
        expected_payload_schema_version: decision.schema_version,
        expected_purpose: "ground_truth_visual_eligibility",
        expected_reviewer_role: decision.reviewer_role,
        expected_reviewer_id: decision.reviewer_id,
        expected_occurred_at: decision.decided_at,
        embedded_signature_sha256: decision.signature_sha256,
      },
      metadata: meta,
    });
    const command = { decision, claim, envelope_id: input.verification.envelope.envelope_id };
    return this.mutation(groundTruthEligibilityAppendStatement({
      tenant_id: this.tenantId,
      decision: asRecord(decision),
      ...claim,
      envelope_id: input.verification.envelope.envelope_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      recorded_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "ground_truth", aggregate_id: decision.eligibility_id,
      aggregate_version: "1" }, operation);
  }

  async appendManifest(input: GroundTruthManifestAppendInput): Promise<GovernanceMutationReceipt> {
    const operation = "gt_manifest_append";
    assertPositiveRevision(input.expected_workflow_revision, operation, true);
    const manifest = validateGroundTruthManifest(input.manifest);
    const prior = input.prior_manifest === null ? null : validateGroundTruthManifest(input.prior_manifest);
    const meta = metadata(input.metadata, operation);
    const signedEvent = input.event_kind !== "disagreement_recorded";
    if (signedEvent !== (input.verification !== null && input.claim !== null)) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    let envelopeId: string | null = null;
    let claim: GovernanceClaimFence | null = null;
    if (signedEvent) {
      const verification = input.verification!;
      claim = assertClaimFence(input.claim!, operation);
      if (claim.claimant_id !== verification.reviewer_id) {
        throw new GovernanceRepositoryError("GOVERNANCE_CLAIM_FENCE_INVALID", operation);
      }
      const action = input.event_kind === "annotation_2_signed" ? "annotation_2"
        : input.event_kind === "adjudication_signed" ? "human_adjudication"
          : input.event_kind === "ground_truth_locked" ? "lock" : "annotation_1";
      const purpose: HumanTrustPurpose = action === "lock" ? "ground_truth_lock"
        : action === "human_adjudication" ? "ground_truth_adjudication" : "ground_truth_annotation";
      const role = action === "lock" ? "human_ground_truth_lock_reviewer"
        : action === "human_adjudication" ? "human_ground_truth_adjudicator" : "human_ground_truth_annotator";
      const expectedReviewer = action === "annotation_1" ? manifest.annotator_1_id
        : action === "annotation_2" ? manifest.annotator_2_id!
          : action === "human_adjudication" ? manifest.adjudicator_id! : verification.reviewer_id;
      if (action === "lock" && [manifest.annotator_1_id, manifest.annotator_2_id, manifest.adjudicator_id]
        .includes(verification.reviewer_id)) {
        throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
      }
      const payload = asRecord(trustedGroundTruthActionPayload(action, prior, manifest));
      await this.#trust.admitDecision({
        workflow_kind: "ground_truth",
        aggregate_id: manifest.manifest_id,
        aggregate_version: String(manifest.revision),
        aggregate_revision: input.expected_workflow_revision + 1,
        evidence: {
          verification,
          payload,
          expected_payload_schema_version: TRUSTED_GT_SCHEMA,
          expected_purpose: purpose,
          expected_reviewer_role: role,
          expected_reviewer_id: expectedReviewer,
          expected_occurred_at: verification.envelope.issued_at,
          embedded_signature_sha256: verification.signature_sha256,
        },
        metadata: meta,
      });
      envelopeId = verification.envelope.envelope_id;
    } else if (manifest.status !== "disagreement" || input.claim !== null || input.verification !== null) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const command = {
      event_kind: input.event_kind,
      manifest_sha256: canonicalSha256(manifest),
      expected_workflow_revision: input.expected_workflow_revision,
      claim,
      envelope_id: envelopeId,
    };
    return this.mutation(groundTruthManifestAppendStatement({
      tenant_id: this.tenantId,
      event_kind: input.event_kind,
      manifest: asRecord(manifest),
      expected_workflow_revision: input.expected_workflow_revision,
      work_item_id: claim?.work_item_id ?? null,
      claimant_id: claim?.claimant_id ?? null,
      fencing_token: claim?.fencing_token ?? null,
      envelope_id: envelopeId,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      recorded_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "ground_truth", aggregate_id: manifest.manifest_id,
      aggregate_version: String(manifest.revision) }, operation);
  }
}

export class PostgresLegalReconciliationRepository extends GovernanceRepositoryBase {
  readonly #trust: PostgresReviewerTrustRepository;

  constructor(context: PostgresTransactionContext, tenantId: string) {
    super(context, tenantId);
    this.#trust = new PostgresReviewerTrustRepository(context, tenantId);
  }

  async importObservation(
    candidateInput: unknown,
    commandMetadata: GovernanceCommandMetadata,
  ): Promise<GovernanceMutationReceipt> {
    const operation = "legal_observation_import";
    const candidate = parse(legalObservationCandidateSchema, candidateInput, operation);
    assertContentHash(asRecord(candidate), "candidate_sha256", operation);
    const meta = metadata(commandMetadata, operation);
    return this.mutation(legalObservationImportStatement({
      tenant_id: this.tenantId,
      candidate: asRecord(candidate),
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, candidate),
      imported_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "legal_reconciliation", aggregate_id: candidate.observation_id,
      aggregate_version: candidate.observation_version }, operation);
  }

  async decideObservation(input: Readonly<{
    candidate: LegalObservationCandidate;
    decision: LegalObservationDecision;
    expected_revision: number;
    claim: GovernanceClaimFence;
    verification: VerifiedHumanDecision;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "legal_observation_decide";
    const candidate = parse(legalObservationCandidateSchema, input.candidate, operation);
    const decision = parse(legalObservationDecisionSchema, input.decision, operation);
    assertContentHash(asRecord(candidate), "candidate_sha256", operation);
    assertPositiveRevision(input.expected_revision, operation);
    const claim = assertClaimFence(input.claim, operation);
    if (decision.observation_id !== candidate.observation_id
        || decision.observation_version !== candidate.observation_version
        || decision.candidate_sha256 !== candidate.candidate_sha256
        || claim.claimant_id !== decision.reviewer_id) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    const meta = metadata(input.metadata, operation);
    const payload = payloadWithoutEmbeddedSignature(decision);
    await this.#trust.admitDecision({
      workflow_kind: "legal_reconciliation",
      aggregate_id: decision.observation_id,
      aggregate_version: decision.observation_version,
      aggregate_revision: input.expected_revision + 1,
      evidence: {
        verification: input.verification,
        payload,
        expected_payload_schema_version: decision.schema_version,
        expected_purpose: "source_review",
        expected_reviewer_role: decision.reviewer_role,
        expected_reviewer_id: decision.reviewer_id,
        expected_occurred_at: decision.decided_at,
        embedded_signature_sha256: decision.signature_sha256,
      },
      metadata: meta,
    });
    const command = { decision, expected_revision: input.expected_revision, claim,
      envelope_id: input.verification.envelope.envelope_id };
    return this.mutation(legalObservationDecideStatement({
      tenant_id: this.tenantId,
      decision: asRecord(decision),
      expected_revision: input.expected_revision,
      ...claim,
      envelope_id: input.verification.envelope.envelope_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      recorded_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "legal_reconciliation", aggregate_id: decision.observation_id,
      aggregate_version: decision.observation_version }, operation);
  }
}

export class PostgresParameterApprovalRepository extends GovernanceRepositoryBase {
  readonly #trust: PostgresReviewerTrustRepository;

  constructor(context: PostgresTransactionContext, tenantId: string) {
    super(context, tenantId);
    this.#trust = new PostgresReviewerTrustRepository(context, tenantId);
  }

  async importCandidate(candidateInput: unknown, commandMetadata: GovernanceCommandMetadata): Promise<GovernanceMutationReceipt> {
    const operation = "parameter_import";
    const candidate = parse(parameterCandidateSchema, candidateInput, operation);
    assertContentHash(asRecord(candidate), "candidate_sha256", operation);
    const meta = metadata(commandMetadata, operation);
    return this.mutation(parameterImportStatement({
      tenant_id: this.tenantId,
      candidate: asRecord(candidate),
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, candidate),
      imported_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "parameter_approval", aggregate_id: candidate.parameter_id,
      aggregate_version: candidate.parameter_version }, operation);
  }

  async appendAttestation(input: Readonly<{
    candidate: ParameterCandidate;
    attestation: ParameterAttestation;
    expected_revision: number;
    claim: GovernanceClaimFence;
    verification: VerifiedHumanDecision;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "parameter_attestation_append";
    const candidate = parse(parameterCandidateSchema, input.candidate, operation);
    const attestation = parse(parameterAttestationSchema, input.attestation, operation);
    assertContentHash(asRecord(candidate), "candidate_sha256", operation);
    assertPositiveRevision(input.expected_revision, operation);
    const claim = assertClaimFence(input.claim, operation);
    const bindingsSha256 = legalOperationsSha256(candidate.bindings);
    const exactBinding = attestation.candidate_id === candidate.parameter_id
      && attestation.candidate_version === candidate.parameter_version
      && attestation.candidate_sha256 === candidate.candidate_sha256
      && attestation.bindings_sha256 === bindingsSha256
      && attestation.unit === candidate.unit
      && attestation.rounding_policy === candidate.rounding_policy
      && same(attestation.value, candidate.value)
      && same(attestation.operative_source_version_ids, candidate.operative_source_version_ids)
      && claim.claimant_id === attestation.reviewer_id;
    if (!exactBinding) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    const meta = metadata(input.metadata, operation);
    const payload = payloadWithoutEmbeddedSignature(attestation);
    await this.#trust.admitDecision({
      workflow_kind: "parameter_approval",
      aggregate_id: candidate.parameter_id,
      aggregate_version: candidate.parameter_version,
      aggregate_revision: input.expected_revision + 1,
      evidence: {
        verification: input.verification,
        payload,
        expected_payload_schema_version: attestation.schema_version,
        expected_purpose: "parameter_attestation",
        expected_reviewer_role: attestation.reviewer_role,
        expected_reviewer_id: attestation.reviewer_id,
        expected_occurred_at: attestation.attested_at,
        embedded_signature_sha256: attestation.signature_sha256,
      },
      metadata: meta,
    });
    const command = { attestation, expected_revision: input.expected_revision, claim,
      envelope_id: input.verification.envelope.envelope_id };
    return this.mutation(parameterAttestationAppendStatement({
      tenant_id: this.tenantId,
      decision: asRecord(attestation),
      expected_revision: input.expected_revision,
      ...claim,
      envelope_id: input.verification.envelope.envelope_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      recorded_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "parameter_approval", aggregate_id: candidate.parameter_id,
      aggregate_version: candidate.parameter_version }, operation);
  }
}

export class PostgresRuleSpecApprovalRepository extends GovernanceRepositoryBase {
  readonly #trust: PostgresReviewerTrustRepository;

  constructor(context: PostgresTransactionContext, tenantId: string) {
    super(context, tenantId);
    this.#trust = new PostgresReviewerTrustRepository(context, tenantId);
  }

  async importGoldenCaseSet(candidate: unknown, commandMetadata: GovernanceCommandMetadata): Promise<GovernanceMutationReceipt> {
    const operation = "golden_case_set_import";
    let golden: GoldenCaseSet;
    try {
      golden = validateGoldenCaseSet(candidate);
    } catch {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const meta = metadata(commandMetadata, operation);
    return this.mutation(goldenCaseSetImportStatement({
      tenant_id: this.tenantId,
      golden_case_set: asRecord(golden),
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, golden),
      imported_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "rulespec_approval", aggregate_id: golden.golden_case_set_id,
      aggregate_version: "1" }, operation);
  }

  async importRuleSpec(candidate: unknown, commandMetadata: GovernanceCommandMetadata): Promise<GovernanceMutationReceipt> {
    const operation = "rulespec_import";
    let rule: RuleSpecPackage;
    try {
      rule = validateRuleSpecPackage(candidate);
    } catch {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const meta = metadata(commandMetadata, operation);
    return this.mutation(ruleSpecImportStatement({
      tenant_id: this.tenantId,
      rule_spec: asRecord(rule),
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, rule),
      imported_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "rulespec_approval", aggregate_id: rule.rule_spec_id,
      aggregate_version: rule.rule_spec_version }, operation);
  }

  async appendApproval(input: Readonly<{
    rule_spec: RuleSpecPackage;
    approval: SemanticApproval;
    expected_revision: number;
    claim: GovernanceClaimFence;
    verification: VerifiedHumanDecision;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "rulespec_approval_append";
    let rule: RuleSpecPackage;
    try {
      rule = validateRuleSpecPackage(input.rule_spec);
    } catch {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const approval = parse(semanticApprovalSchema, input.approval, operation);
    assertPositiveRevision(input.expected_revision, operation);
    const claim = assertClaimFence(input.claim, operation);
    const expectedHash = approval.approval_kind === "rule_semantics" ? rule.content_sha256 : rule.golden_case_set_sha256;
    if (approval.artifact_id !== rule.rule_spec_id || approval.artifact_version !== rule.rule_spec_version
        || approval.artifact_sha256 !== expectedHash || claim.claimant_id !== approval.reviewer_id) {
      throw new GovernanceRepositoryError("GOVERNANCE_HUMAN_DECISION_BINDING_MISMATCH", operation);
    }
    const purpose: HumanTrustPurpose = approval.approval_kind === "rule_semantics"
      ? "rulespec_semantics" : "golden_case_outputs";
    const meta = metadata(input.metadata, operation);
    const payload = payloadWithoutEmbeddedSignature(approval);
    await this.#trust.admitDecision({
      workflow_kind: "rulespec_approval",
      aggregate_id: rule.rule_spec_id,
      aggregate_version: rule.rule_spec_version,
      aggregate_revision: input.expected_revision + 1,
      evidence: {
        verification: input.verification,
        payload,
        expected_payload_schema_version: approval.schema_version,
        expected_purpose: purpose,
        expected_reviewer_role: approval.reviewer_role,
        expected_reviewer_id: approval.reviewer_id,
        expected_occurred_at: approval.decided_at,
        embedded_signature_sha256: approval.signature_sha256,
      },
      metadata: meta,
    });
    const command = { approval, expected_revision: input.expected_revision, claim,
      envelope_id: input.verification.envelope.envelope_id };
    return this.mutation(ruleSpecApprovalAppendStatement({
      tenant_id: this.tenantId,
      decision: asRecord(approval),
      expected_revision: input.expected_revision,
      ...claim,
      envelope_id: input.verification.envelope.envelope_id,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      recorded_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "rulespec_approval", aggregate_id: rule.rule_spec_id,
      aggregate_version: rule.rule_spec_version }, operation);
  }
}

export type {
  GroundTruthVisualEligibility,
  KeyPossessionChallenge,
  ParameterAttestation,
  ParameterCandidate,
  ReviewerTrustPolicy,
  RuleSpecPackage,
  SemanticApproval,
  TrustedReviewer,
  TrustOrganization,
};

/**
 * Canonical durable adapter for the internal legal review workflow.
 *
 * Domain rules are not restated here: the pure workflow decides whether an
 * action is admissible and what state it produces, and this adapter persists
 * that decision under compare-and-swap. There is no memory substitute and no
 * path by which a packet becomes operative.
 */
export class PostgresLegalReviewRepository extends GovernanceRepositoryBase {
  async enqueuePacket(input: Readonly<{
    packet: LegalReviewPacket;
    queue_priority: number;
    blocked_reason_codes: readonly string[];
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "legal_review_packet_enqueue";
    const packet = parse(legalReviewPacketSchema, input.packet, operation);
    if (!Number.isSafeInteger(input.queue_priority) || input.queue_priority < 0 || input.queue_priority > 999) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    if (packet.state !== "pending_review" || packet.revision !== 1) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const identity = deriveLegalReviewPacketIdentity(packet.binding, packet.scope);
    if (identity.packet_id !== packet.packet_id || identity.packet_sha256 !== packet.packet_sha256) {
      throw new GovernanceRepositoryError("GOVERNANCE_HASH_MISMATCH", operation);
    }
    const meta = metadata(input.metadata, operation);
    const command = { packet, queue_priority: input.queue_priority, blocked_reason_codes: input.blocked_reason_codes };
    return this.mutation(legalReviewPacketEnqueueStatement({
      tenant_id: this.tenantId,
      packet: asRecord(packet),
      queue_priority: input.queue_priority,
      blocked_reason_codes: [...input.blocked_reason_codes],
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      enqueued_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "legal_review", aggregate_id: packet.packet_id,
      aggregate_version: packet.packet_sha256 }, operation);
  }

  async appendAction(input: Readonly<{
    packet: LegalReviewPacket;
    action: LegalReviewAction;
    applied_actions?: readonly LegalReviewAction[];
    superseded_by_packet_id?: string | null;
    metadata: GovernanceCommandMetadata;
  }>): Promise<GovernanceMutationReceipt> {
    const operation = "legal_review_action_append";
    const packet = parse(legalReviewPacketSchema, input.packet, operation);
    let transition;
    try {
      transition = applyLegalReviewAction(packet, input.action, input.applied_actions ?? []);
    } catch (error) {
      // Domain refusals stay domain refusals; they never reach SQL.
      if (error instanceof LegalReviewError) throw error;
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    if (!transition.applied) {
      throw new GovernanceRepositoryError("GOVERNANCE_IDEMPOTENT_REPLAY_CONFLICT", operation);
    }
    const supersededBy = transition.packet.state === "superseded"
      ? (input.superseded_by_packet_id ?? null) : null;
    if (transition.packet.state === "superseded" && supersededBy === null) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const meta = metadata(input.metadata, operation);
    const command = { action: input.action, next_state: transition.packet.state, superseded_by: supersededBy };
    return this.mutation(legalReviewActionAppendStatement({
      tenant_id: this.tenantId,
      action: asRecord(input.action as unknown as object),
      next_state: transition.packet.state,
      superseded_by_packet_id: supersededBy,
      idempotency_key: meta.idempotency_key,
      command_sha256: commandSha256(operation, this.tenantId, command),
      occurred_at: meta.occurred_at,
    }), { tenant_id: this.tenantId, workflow_kind: "legal_review", aggregate_id: packet.packet_id,
      aggregate_version: packet.packet_sha256 }, operation);
  }

  async listQueue(limit: number): Promise<readonly LegalReviewDurableRow[]> {
    const operation = "legal_review_queue_list";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new GovernanceRepositoryError("GOVERNANCE_INPUT_INVALID", operation);
    }
    const row = await queryExactlyOne(this.context, legalReviewQueueListStatement({
      tenant_id: this.tenantId, limit,
    }), operation);
    const entries = (row as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) throw new GovernanceRepositoryError("GOVERNANCE_DECODE_FAILED", operation);
    return Object.freeze(entries.map((entry) => {
      try {
        return legalReviewDurableRowSchema.parse(entry);
      } catch {
        throw new GovernanceRepositoryError("GOVERNANCE_DECODE_FAILED", operation);
      }
    }));
  }
}
