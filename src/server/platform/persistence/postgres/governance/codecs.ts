import {
  assertEnum,
  rowBoolean,
  rowJson,
  rowNullableSha256,
  rowNullableString,
  rowObject,
  rowSafeInteger,
  rowSha256,
  rowString,
  rowStringArray,
} from "../runtime/codec.ts";
import {
  GovernanceRepositoryError,
  governanceMutationStateSchema,
  governanceWorkflowKindSchema,
  governanceWorkKindSchema,
  type GovernanceAggregateSnapshot,
  type GovernanceMutationReceipt,
  type GovernanceWorkClaim,
  type HumanDecisionAdmissionReceipt,
  type ReviewerVerificationMaterial,
} from "./contracts.ts";
import { humanTrustPurposeSchema } from "../../../../../engine/legal-operations/human-trust.ts";

function decode<T>(operation: string, operationBody: () => T): T {
  try {
    return operationBody();
  } catch (error) {
    if (error instanceof GovernanceRepositoryError) throw error;
    throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", operation);
  }
}

export function decodeGovernanceMutationReceipt(value: unknown): GovernanceMutationReceipt {
  return decode("decode_mutation_receipt", () => {
    const row = rowObject(value);
    const activationAllowed = rowBoolean(row, "activation_allowed");
    if (activationAllowed) throw new GovernanceRepositoryError("GOVERNANCE_ROW_MALFORMED", "decode_mutation_receipt");
    return Object.freeze({
      tenant_id: rowString(row, "tenant_id"),
      workflow_kind: governanceWorkflowKindSchema.parse(rowString(row, "workflow_kind")),
      aggregate_id: rowString(row, "aggregate_id"),
      aggregate_version: rowString(row, "aggregate_version"),
      revision: rowSafeInteger(row, "revision", 1),
      state: governanceMutationStateSchema.parse(rowString(row, "state")),
      content_sha256: rowSha256(row, "content_sha256"),
      audit_event_sha256: rowSha256(row, "audit_event_sha256"),
      idempotent_replay: rowBoolean(row, "idempotent_replay"),
      activation_allowed: false,
    });
  });
}

export function decodeHumanDecisionAdmission(value: unknown): HumanDecisionAdmissionReceipt {
  return decode("decode_human_decision", () => {
    const row = rowObject(value);
    return Object.freeze({
      tenant_id: rowString(row, "tenant_id"),
      envelope_id: rowString(row, "envelope_id"),
      aggregate_id: rowString(row, "aggregate_id"),
      aggregate_version: rowString(row, "aggregate_version"),
      aggregate_revision: rowSafeInteger(row, "aggregate_revision", 1),
      envelope_sha256: rowSha256(row, "envelope_sha256"),
      signature_sha256: rowSha256(row, "signature_sha256"),
      reviewer_id: rowString(row, "reviewer_id"),
      reviewer_role: rowString(row, "reviewer_role"),
      key_id: rowString(row, "key_id"),
      purpose: humanTrustPurposeSchema.parse(rowString(row, "purpose")),
      admitted_at: rowString(row, "admitted_at"),
      idempotent_replay: rowBoolean(row, "idempotent_replay"),
    });
  });
}

export function decodeReviewerVerificationMaterial(value: unknown): ReviewerVerificationMaterial {
  return decode("decode_verification_material", () => {
    const row = rowObject(value);
    return Object.freeze({
      tenant_id: rowString(row, "tenant_id"),
      organization_id: rowString(row, "organization_id"),
      organization_version: rowString(row, "organization_version"),
      policy_version: rowString(row, "policy_version"),
      reviewer_id: rowString(row, "reviewer_id"),
      reviewer_identity_version: rowString(row, "reviewer_identity_version"),
      reviewer_roles: rowStringArray(row, "reviewer_roles"),
      reviewer_record_sha256: rowSha256(row, "reviewer_record_sha256"),
      key_id: rowString(row, "key_id"),
      public_key_spki_pem: rowString(row, "public_key_spki_pem"),
      public_key_sha256: rowSha256(row, "public_key_sha256"),
      purpose: humanTrustPurposeSchema.parse(rowString(row, "purpose")),
      required_reviewer_role: rowString(row, "required_reviewer_role"),
      valid_at_signing_time: rowBoolean(row, "valid_at_signing_time"),
      currently_trusted: rowBoolean(row, "currently_trusted"),
    });
  });
}

export function decodeGovernanceWorkClaim(value: unknown): GovernanceWorkClaim {
  return decode("decode_work_claim", () => {
    const row = rowObject(value);
    return Object.freeze({
      tenant_id: rowString(row, "tenant_id"),
      work_item_id: rowString(row, "work_item_id"),
      workflow_kind: governanceWorkflowKindSchema.parse(rowString(row, "workflow_kind")),
      aggregate_id: rowString(row, "aggregate_id"),
      aggregate_version: rowString(row, "aggregate_version"),
      work_kind: governanceWorkKindSchema.parse(rowString(row, "work_kind")),
      required_role: rowString(row, "required_role"),
      document_sha256: rowNullableSha256(row, "document_sha256"),
      object_version_id: rowNullableString(row, "object_version_id"),
      input_sha256: rowSha256(row, "input_sha256"),
      state: assertEnum(rowString(row, "state"), ["claimed"] as const),
      claimant_id: rowString(row, "claimant_id"),
      fencing_token: rowSafeInteger(row, "fencing_token", 1),
      lease_expires_at: rowString(row, "lease_expires_at"),
    });
  });
}

export function decodeGovernanceAggregateSnapshot(value: unknown): GovernanceAggregateSnapshot {
  return decode("decode_aggregate_snapshot", () => {
    const row = rowObject(value);
    return Object.freeze({
      receipt: decodeGovernanceMutationReceipt(row),
      content: rowJson(row, "content_json"),
    });
  });
}

export function nullableHashFromRow(value: unknown, key: string): string | null {
  return decode("decode_nullable_hash", () => rowNullableSha256(rowObject(value), key));
}
