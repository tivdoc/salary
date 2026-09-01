import { z } from "zod";
import { isoTimestampSchema } from "../../../engine/domain/primitives.ts";
import { humanTrustIdSchema, humanTrustPurposeSchema } from "../../../engine/legal-operations/human-trust.ts";
import { canonicalLegalOperationsJson } from "../../../engine/legal-operations/canonical.ts";
import { legalOperationsSha256Schema } from "../../../engine/legal-operations/contracts.ts";

export const REVIEWER_TRUST_SCHEMA_VERSION = "tivdoc-reviewer-trust-v0.10.0" as const;
export const KEY_REGISTRATION_CHALLENGE_SCHEMA = "tivdoc-key-possession-challenge-v0.10.0" as const;

const version = z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/);

export const trustOrganizationSchema = z.object({
  schema_version: z.literal(REVIEWER_TRUST_SCHEMA_VERSION),
  organization_id: humanTrustIdSchema,
  organization_version: version,
  valid_from: isoTimestampSchema,
  expires_at: isoTimestampSchema.nullable(),
  policy_admin_ids: z.array(humanTrustIdSchema).min(1).max(32).readonly(),
  organization_record_sha256: legalOperationsSha256Schema,
}).strict().superRefine((record, context) => {
  if (record.expires_at !== null && record.expires_at <= record.valid_from) context.addIssue({ code: "custom", message: "trust_organization_expiry_invalid" });
  if (new Set(record.policy_admin_ids).size !== record.policy_admin_ids.length) context.addIssue({ code: "custom", message: "trust_organization_duplicate_admin" });
}).readonly();

export const reviewerTrustPolicySchema = z.object({
  schema_version: z.literal(REVIEWER_TRUST_SCHEMA_VERSION),
  organization_id: humanTrustIdSchema,
  organization_version: version,
  policy_version: version,
  effective_from: isoTimestampSchema,
  expires_at: isoTimestampSchema.nullable(),
  max_envelope_ttl_seconds: z.number().int().min(60).max(604_800),
  grants: z.array(z.object({
    reviewer_role: humanTrustIdSchema,
    purposes: z.array(humanTrustPurposeSchema).min(1).readonly(),
  }).strict()).min(1).max(64).readonly(),
  policy_sha256: legalOperationsSha256Schema,
}).strict().superRefine((policy, context) => {
  if (policy.expires_at !== null && policy.expires_at <= policy.effective_from) context.addIssue({ code: "custom", message: "trust_policy_expiry_invalid" });
  if (new Set(policy.grants.map((grant) => grant.reviewer_role)).size !== policy.grants.length) context.addIssue({ code: "custom", message: "trust_policy_duplicate_role" });
  for (const [index, grant] of policy.grants.entries()) if (new Set(grant.purposes).size !== grant.purposes.length) context.addIssue({ code: "custom", message: "trust_policy_duplicate_purpose", path: ["grants", index] });
}).readonly();

export const trustedReviewerSchema = z.object({
  schema_version: z.literal(REVIEWER_TRUST_SCHEMA_VERSION),
  organization_id: humanTrustIdSchema,
  organization_version: version,
  reviewer_id: humanTrustIdSchema,
  reviewer_identity_version: version,
  reviewer_roles: z.array(humanTrustIdSchema).min(1).max(32).readonly(),
  valid_from: isoTimestampSchema,
  expires_at: isoTimestampSchema,
  identity_evidence_sha256: legalOperationsSha256Schema,
  reviewer_record_sha256: legalOperationsSha256Schema,
}).strict().superRefine((reviewer, context) => {
  if (reviewer.expires_at <= reviewer.valid_from) context.addIssue({ code: "custom", message: "trusted_reviewer_expiry_invalid" });
  if (new Set(reviewer.reviewer_roles).size !== reviewer.reviewer_roles.length) context.addIssue({ code: "custom", message: "trusted_reviewer_duplicate_role" });
}).readonly();

export const keyPossessionChallengeSchema = z.object({
  schema_version: z.literal(KEY_REGISTRATION_CHALLENGE_SCHEMA),
  challenge_id: humanTrustIdSchema,
  organization_id: humanTrustIdSchema,
  organization_version: version,
  reviewer_id: humanTrustIdSchema,
  reviewer_identity_version: version,
  key_id: humanTrustIdSchema,
  public_key_spki_pem: z.string().min(80).max(4_000),
  public_key_sha256: legalOperationsSha256Schema,
  valid_from: isoTimestampSchema,
  expires_at: isoTimestampSchema,
  replaces_key_id: humanTrustIdSchema.nullable(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,160}$/),
  issued_at: isoTimestampSchema,
  challenge_expires_at: isoTimestampSchema,
}).strict().superRefine((challenge, context) => {
  if (challenge.expires_at <= challenge.valid_from) context.addIssue({ code: "custom", message: "trusted_key_expiry_invalid" });
  if (challenge.challenge_expires_at <= challenge.issued_at) context.addIssue({ code: "custom", message: "key_challenge_expiry_invalid" });
}).readonly();

export type TrustOrganization = z.infer<typeof trustOrganizationSchema>;
export type ReviewerTrustPolicy = z.infer<typeof reviewerTrustPolicySchema>;
export type TrustedReviewer = z.infer<typeof trustedReviewerSchema>;
export type KeyPossessionChallenge = z.infer<typeof keyPossessionChallengeSchema>;

export function keyPossessionSigningBytes(challenge: unknown): Uint8Array {
  return Buffer.from(canonicalLegalOperationsJson(keyPossessionChallengeSchema.parse(challenge)), "utf8");
}
