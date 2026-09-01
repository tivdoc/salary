import { z } from "zod";
import { isoTimestampSchema } from "../domain/primitives.ts";
import { bytesSha256, canonicalLegalOperationsJson, frozen, legalOperationsSha256 } from "./canonical.ts";
import { legalOperationsSha256Schema } from "./contracts.ts";

export const HUMAN_TRUST_ENVELOPE_SCHEMA = "tivdoc-human-decision-envelope-v0.10.0" as const;
export const humanTrustIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$/);

export const humanTrustPurposeSchema = z.enum([
  "source_review",
  "parameter_attestation",
  "rulespec_semantics",
  "golden_case_outputs",
  "lifecycle_action",
  "ground_truth_visual_eligibility",
  "ground_truth_annotation",
  "ground_truth_adjudication",
  "ground_truth_lock",
  "evidence_handoff_delivery",
  "evidence_handoff_receipt",
  "evidence_handoff_verification",
]);

const humanDecisionEnvelopeBodyObjectSchema = z.object({
  schema_version: z.literal(HUMAN_TRUST_ENVELOPE_SCHEMA),
  envelope_id: humanTrustIdSchema,
  organization_id: humanTrustIdSchema,
  organization_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  policy_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  reviewer_id: humanTrustIdSchema,
  reviewer_identity_version: z.string().regex(/^[1-9]\d*(?:\.\d+){0,2}$/),
  reviewer_role: humanTrustIdSchema,
  key_id: humanTrustIdSchema,
  purpose: humanTrustPurposeSchema,
  payload_schema_version: z.string().trim().min(1).max(160),
  payload_sha256: legalOperationsSha256Schema,
  issued_at: isoTimestampSchema,
  expires_at: isoTimestampSchema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,160}$/),
  algorithm: z.literal("Ed25519"),
}).strict();

export const humanDecisionEnvelopeBodySchema = humanDecisionEnvelopeBodyObjectSchema.superRefine((body, context) => {
  if (body.expires_at <= body.issued_at) context.addIssue({ code: "custom", message: "human_trust_envelope_expiry_invalid", path: ["expires_at"] });
}).readonly();

export const signedHumanDecisionEnvelopeSchema = humanDecisionEnvelopeBodyObjectSchema.extend({
  signature_base64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256),
}).strict().superRefine((body, context) => {
  if (body.expires_at <= body.issued_at) context.addIssue({ code: "custom", message: "human_trust_envelope_expiry_invalid", path: ["expires_at"] });
}).readonly();

export type HumanTrustPurpose = z.infer<typeof humanTrustPurposeSchema>;
export type HumanDecisionEnvelopeBody = z.infer<typeof humanDecisionEnvelopeBodySchema>;
export type SignedHumanDecisionEnvelope = z.infer<typeof signedHumanDecisionEnvelopeSchema>;

export type VerifiedHumanDecision = Readonly<{
  envelope: SignedHumanDecisionEnvelope;
  envelope_sha256: string;
  signature_sha256: string;
  organization_id: string;
  organization_version: string;
  policy_version: string;
  reviewer_id: string;
  reviewer_identity_version: string;
  reviewer_role: string;
  key_id: string;
  purpose: HumanTrustPurpose;
  valid_at_signing_time: true;
  currently_trusted: boolean;
}>;

export type HumanTrustVerificationRequest = Readonly<{
  envelope: unknown;
  payload: unknown;
  purpose: HumanTrustPurpose;
  required_reviewer_role: string;
  admitted_at?: string;
}>;

export interface HumanTrustVerificationPort {
  verifyForAdmission(input: HumanTrustVerificationRequest): VerifiedHumanDecision;
  verifyHistorically(input: HumanTrustVerificationRequest): VerifiedHumanDecision;
}

export function humanDecisionEnvelopeBody(candidate: unknown): HumanDecisionEnvelopeBody {
  const envelope = signedHumanDecisionEnvelopeSchema.parse(candidate);
  const { signature_base64: omittedSignature, ...body } = envelope;
  void omittedSignature;
  return humanDecisionEnvelopeBodySchema.parse(body);
}

export function humanDecisionSigningBytes(candidate: unknown): Uint8Array {
  return Buffer.from(canonicalLegalOperationsJson(humanDecisionEnvelopeBodySchema.parse(candidate)), "utf8");
}

export function humanDecisionPayloadSha256(payload: unknown): string {
  return legalOperationsSha256(payload);
}

export function humanDecisionSignatureBytes(signatureBase64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) throw new Error("HUMAN_TRUST_SIGNATURE_BASE64_INVALID");
  const bytes = Buffer.from(signatureBase64, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== signatureBase64) throw new Error("HUMAN_TRUST_SIGNATURE_BASE64_INVALID");
  return bytes;
}

export function humanDecisionSignatureSha256(signatureBase64: string): string {
  return bytesSha256(humanDecisionSignatureBytes(signatureBase64));
}

export function humanDecisionEnvelopeSha256(candidate: unknown): string {
  return legalOperationsSha256(signedHumanDecisionEnvelopeSchema.parse(candidate));
}

export function payloadWithoutEmbeddedSignature(candidate: unknown): Readonly<Record<string, unknown>> {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("HUMAN_TRUST_PAYLOAD_OBJECT_REQUIRED");
  const payload = { ...(candidate as Record<string, unknown>) };
  delete payload.signature_sha256;
  delete payload.action_signature_sha256;
  return frozen(payload);
}

export function assertVerifiedHumanBinding(
  verification: VerifiedHumanDecision,
  expected: Readonly<{ reviewer_id: string; reviewer_role: string; purpose: HumanTrustPurpose; occurred_at: string; embedded_signature_sha256: string }>,
): void {
  if (verification.reviewer_id !== expected.reviewer_id) throw new Error("HUMAN_TRUST_REVIEWER_BINDING_MISMATCH");
  if (verification.reviewer_role !== expected.reviewer_role) throw new Error("HUMAN_TRUST_ROLE_BINDING_MISMATCH");
  if (verification.purpose !== expected.purpose) throw new Error("HUMAN_TRUST_PURPOSE_BINDING_MISMATCH");
  if (verification.envelope.issued_at !== expected.occurred_at) throw new Error("HUMAN_TRUST_TIMESTAMP_BINDING_MISMATCH");
  if (verification.signature_sha256 !== expected.embedded_signature_sha256) throw new Error("HUMAN_TRUST_SIGNATURE_HASH_BINDING_MISMATCH");
}
