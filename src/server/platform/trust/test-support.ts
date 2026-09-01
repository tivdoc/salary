import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import {
  HUMAN_TRUST_ENVELOPE_SCHEMA,
  humanDecisionEnvelopeBodySchema,
  humanDecisionPayloadSha256,
  humanDecisionSigningBytes,
  signedHumanDecisionEnvelopeSchema,
  type HumanTrustPurpose,
  type SignedHumanDecisionEnvelope,
} from "../../../engine/legal-operations/human-trust.ts";
import { frozen } from "../../../engine/legal-operations/canonical.ts";
import { keyPossessionSigningBytes, type KeyPossessionChallenge } from "./reviewer-trust-store.ts";

export type GeneratedEd25519TestKey = Readonly<{
  public_key_spki_pem: string;
  private_key: KeyObject;
}>;

export function generateEd25519TestKey(): GeneratedEd25519TestKey {
  const pair = generateKeyPairSync("ed25519");
  return Object.freeze({
    public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key: pair.privateKey,
  });
}

export function signKeyPossessionChallenge(challenge: KeyPossessionChallenge, privateKey: KeyObject): string {
  return sign(null, keyPossessionSigningBytes(challenge), privateKey).toString("base64");
}

export function signHumanDecision(input: Readonly<{
  envelope_id: string;
  organization_id: string;
  organization_version: string;
  policy_version: string;
  reviewer_id: string;
  reviewer_identity_version: string;
  reviewer_role: string;
  key_id: string;
  purpose: HumanTrustPurpose;
  payload_schema_version: string;
  payload: unknown;
  issued_at: string;
  expires_at: string;
  private_key: KeyObject;
  nonce?: string;
}>): SignedHumanDecisionEnvelope {
  const body = humanDecisionEnvelopeBodySchema.parse({
    schema_version: HUMAN_TRUST_ENVELOPE_SCHEMA,
    envelope_id: input.envelope_id,
    organization_id: input.organization_id,
    organization_version: input.organization_version,
    policy_version: input.policy_version,
    reviewer_id: input.reviewer_id,
    reviewer_identity_version: input.reviewer_identity_version,
    reviewer_role: input.reviewer_role,
    key_id: input.key_id,
    purpose: input.purpose,
    payload_schema_version: input.payload_schema_version,
    payload_sha256: humanDecisionPayloadSha256(input.payload),
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    nonce: input.nonce ?? randomBytes(18).toString("base64url"),
    algorithm: "Ed25519",
  });
  return frozen(signedHumanDecisionEnvelopeSchema.parse({
    ...body,
    signature_base64: sign(null, humanDecisionSigningBytes(body), input.private_key).toString("base64"),
  }));
}
