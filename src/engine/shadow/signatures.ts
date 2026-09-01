import { createPublicKey, verify } from "node:crypto";
import {
  shadowDecisionPayload,
  signedShadowDisagreementDecisionSchema,
  type SignedShadowDisagreementDecision,
} from "./contracts.ts";

export type ShadowReviewerTrustRecord = Readonly<{
  reviewer_id: string;
  reviewer_key_id: string;
  role: "shadow_disagreement_reviewer";
  algorithm: "ed25519";
  public_key_pem: string;
  valid_from: string;
  valid_until: string;
  revoked_at: string | null;
}>;

export class ShadowReviewerTrustStore {
  readonly #records = new Map<string, ShadowReviewerTrustRecord>();

  register(input: ShadowReviewerTrustRecord) {
    if (!/^[a-z][a-z0-9:._-]{2,159}$/u.test(input.reviewer_id)
      || !/^[a-z][a-z0-9:._-]{2,159}$/u.test(input.reviewer_key_id)
      || input.role !== "shadow_disagreement_reviewer"
      || input.algorithm !== "ed25519"
      || !Number.isFinite(Date.parse(input.valid_from))
      || !Number.isFinite(Date.parse(input.valid_until))
      || Date.parse(input.valid_until) <= Date.parse(input.valid_from)) throw new Error("SHADOW_REVIEWER_TRUST_RECORD_INVALID");
    const key = createPublicKey(input.public_key_pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("SHADOW_REVIEWER_KEY_ALGORITHM_INVALID");
    const existing = this.#records.get(input.reviewer_key_id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(input)) throw new Error("SHADOW_REVIEWER_KEY_IMMUTABLE");
    const record = Object.freeze({ ...input });
    this.#records.set(input.reviewer_key_id, record);
    return record;
  }

  verifyDecision(input: unknown): SignedShadowDisagreementDecision {
    const decision = signedShadowDisagreementDecisionSchema.parse(input);
    const trust = this.#records.get(decision.reviewer_key_id);
    if (!trust || trust.reviewer_id !== decision.reviewer_id || trust.revoked_at !== null) throw new Error("SHADOW_DECISION_REVIEWER_NOT_TRUSTED");
    const signedAt = Date.parse(decision.signed_at);
    if (signedAt < Date.parse(trust.valid_from) || signedAt > Date.parse(trust.valid_until)) throw new Error("SHADOW_DECISION_SIGNATURE_TIME_INVALID");
    const { payload_sha256, signature_algorithm, signature_base64, ...content } = decision;
    void signature_algorithm;
    const payload = shadowDecisionPayload(content);
    if (payload.payload_sha256 !== payload_sha256) throw new Error("SHADOW_DECISION_PAYLOAD_HASH_MISMATCH");
    const signature = Buffer.from(signature_base64, "base64");
    if (!verify(null, payload.bytes, createPublicKey(trust.public_key_pem), signature)) throw new Error("SHADOW_DECISION_SIGNATURE_INVALID");
    return Object.freeze({ ...decision });
  }
}
