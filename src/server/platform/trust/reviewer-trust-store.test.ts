import { describe, expect, it } from "vitest";
import {
  createReviewerTrustPolicy,
  createTrustOrganization,
  createTrustedReviewer,
  InMemoryReviewerTrustStore,
} from "./reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "./test-support.ts";

const ROOT = "trust.root.001";
const ADMIN = "trust.admin.001";
const ORG = "trust.organization.test";
const REVIEWER = "trust.reviewer.rule.001";

function setup() {
  let now = "2026-01-01T00:00:00.000Z";
  const store = new InMemoryReviewerTrustStore({ root_admin_ids: [ROOT], clock: () => now, random_bytes: (length) => new Uint8Array(length).fill(7) });
  store.registerOrganization(createTrustOrganization({
    schema_version: "tivdoc-reviewer-trust-v0.10.0",
    organization_id: ORG,
    organization_version: "1.0.0",
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
    policy_admin_ids: [ADMIN],
  }), ROOT);
  store.publishPolicy(createReviewerTrustPolicy({
    schema_version: "tivdoc-reviewer-trust-v0.10.0",
    organization_id: ORG,
    organization_version: "1.0.0",
    policy_version: "1.0.0",
    effective_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
    max_envelope_ttl_seconds: 86_400,
    grants: [
      { reviewer_role: "human_rule_reviewer", purposes: ["rulespec_semantics"] },
      { reviewer_role: "human_parameter_reviewer", purposes: ["parameter_attestation"] },
    ],
  }), ADMIN);
  const reviewer = createTrustedReviewer({
    schema_version: "tivdoc-reviewer-trust-v0.10.0",
    organization_id: ORG,
    organization_version: "1.0.0",
    reviewer_id: REVIEWER,
    reviewer_identity_version: "1.0.0",
    reviewer_roles: ["human_rule_reviewer"],
    valid_from: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
    identity_evidence_sha256: "a".repeat(64),
  });
  store.registerReviewer(reviewer, ADMIN);
  return { store, setNow: (value: string) => { now = value; } };
}

function registerKey(store: InMemoryReviewerTrustStore, keyId: string, replacesKeyId: string | null, key: ReturnType<typeof generateEd25519TestKey>, prior?: ReturnType<typeof generateEd25519TestKey>) {
  const challenge = store.issueKeyPossessionChallenge({
    challenge_id: `trust.challenge.${keyId}`,
    reviewer_id: REVIEWER,
    reviewer_identity_version: "1.0.0",
    key_id: keyId,
    public_key_spki_pem: key.public_key_spki_pem,
    valid_from: replacesKeyId === null ? "2026-01-01T00:00:00.000Z" : "2026-01-03T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
    replaces_key_id: replacesKeyId,
    actor_id: replacesKeyId === null ? ADMIN : REVIEWER,
  });
  store.registerProvenKey({
    challenge,
    proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key),
    rotation_authorization_signature_base64: prior ? signKeyPossessionChallenge(challenge, prior.private_key) : undefined,
  });
  return challenge;
}

describe("cryptographic reviewer trust store", () => {
  it("requires generated-key proof-of-possession and admits only exact signed canonical payloads", () => {
    const { store, setNow } = setup();
    const key = generateEd25519TestKey();
    const attacker = generateEd25519TestKey();
    const challenge = store.issueKeyPossessionChallenge({
      challenge_id: "trust.challenge.key.001",
      reviewer_id: REVIEWER,
      reviewer_identity_version: "1.0.0",
      key_id: "trust.key.001",
      public_key_spki_pem: key.public_key_spki_pem,
      valid_from: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
      replaces_key_id: null,
      actor_id: ADMIN,
    });
    expect(() => store.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, attacker.private_key) })).toThrow("TRUST_KEY_PROOF_OF_POSSESSION_INVALID");
    store.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key) });
    setNow("2026-01-02T00:05:00.000Z");
    const payload = { schema_version: "test-rule-decision-v1", artifact_id: "rule.test.001", decision: "approved" };
    const envelope = signHumanDecision({
      envelope_id: "trust.envelope.rule.001",
      organization_id: ORG,
      organization_version: "1.0.0",
      policy_version: "1.0.0",
      reviewer_id: REVIEWER,
      reviewer_identity_version: "1.0.0",
      reviewer_role: "human_rule_reviewer",
      key_id: "trust.key.001",
      purpose: "rulespec_semantics",
      payload_schema_version: payload.schema_version,
      payload,
      issued_at: "2026-01-02T00:00:00.000Z",
      expires_at: "2026-01-03T00:00:00.000Z",
      private_key: key.private_key,
      nonce: "canonical-nonce-00000001",
    });
    expect(store.verifyForAdmission({ envelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toMatchObject({ reviewer_id: REVIEWER, currently_trusted: true, valid_at_signing_time: true });
    expect(() => store.verifyForAdmission({ envelope, payload: { ...payload, decision: "rejected" }, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toThrow("HUMAN_TRUST_PAYLOAD_HASH_MISMATCH");
    expect(() => store.verifyForAdmission({ envelope, payload, purpose: "parameter_attestation", required_reviewer_role: "human_parameter_reviewer" })).toThrow("HUMAN_TRUST_PURPOSE_MISMATCH");
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
  });

  it("supports authorized rotation and historical verification while failing current admission closed", () => {
    const { store, setNow } = setup();
    const first = generateEd25519TestKey();
    registerKey(store, "trust.key.rotation.001", null, first);
    const payload = { schema_version: "test-rule-decision-v1", artifact_id: "rule.test.rotation", decision: "approved" };
    const oldEnvelope = signHumanDecision({
      envelope_id: "trust.envelope.rotation.old",
      organization_id: ORG,
      organization_version: "1.0.0",
      policy_version: "1.0.0",
      reviewer_id: REVIEWER,
      reviewer_identity_version: "1.0.0",
      reviewer_role: "human_rule_reviewer",
      key_id: "trust.key.rotation.001",
      purpose: "rulespec_semantics",
      payload_schema_version: payload.schema_version,
      payload,
      issued_at: "2026-01-02T00:00:00.000Z",
      expires_at: "2026-01-03T00:00:00.000Z",
      private_key: first.private_key,
      nonce: "canonical-nonce-rotation-old",
    });
    setNow("2026-01-02T12:00:00.000Z");
    expect(store.verifyForAdmission({ envelope: oldEnvelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" }).currently_trusted).toBe(true);
    setNow("2026-01-03T00:00:00.000Z");
    const second = generateEd25519TestKey();
    registerKey(store, "trust.key.rotation.002", "trust.key.rotation.001", second, first);
    setNow("2026-01-03T01:00:00.000Z");
    expect(() => store.verifyForAdmission({ envelope: oldEnvelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toThrow("HUMAN_TRUST_NOT_CURRENTLY_ADMISSIBLE");
    expect(store.verifyHistorically({ envelope: oldEnvelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toMatchObject({ valid_at_signing_time: true, currently_trusted: false });
    expect(store.verifyAuditChain().valid).toBe(true);
  });

  it("records revocation without rewriting prior verification history and forbids self-registration", () => {
    const { store, setNow } = setup();
    const self = createTrustedReviewer({
      schema_version: "tivdoc-reviewer-trust-v0.10.0",
      organization_id: ORG,
      organization_version: "1.0.0",
      reviewer_id: ADMIN,
      reviewer_identity_version: "1.0.0",
      reviewer_roles: ["human_parameter_reviewer"],
      valid_from: "2026-01-01T00:00:00.000Z",
      expires_at: "2027-01-01T00:00:00.000Z",
      identity_evidence_sha256: "b".repeat(64),
    });
    expect(() => store.registerReviewer(self, ADMIN)).toThrow("TRUST_REVIEWER_SELF_REGISTRATION_FORBIDDEN");
    const key = generateEd25519TestKey();
    registerKey(store, "trust.key.revoke.001", null, key);
    const payload = { schema_version: "test-rule-decision-v1", artifact_id: "rule.test.revoke", decision: "approved" };
    const envelope = signHumanDecision({
      envelope_id: "trust.envelope.revoke.001",
      organization_id: ORG,
      organization_version: "1.0.0",
      policy_version: "1.0.0",
      reviewer_id: REVIEWER,
      reviewer_identity_version: "1.0.0",
      reviewer_role: "human_rule_reviewer",
      key_id: "trust.key.revoke.001",
      purpose: "rulespec_semantics",
      payload_schema_version: payload.schema_version,
      payload,
      issued_at: "2026-01-02T00:00:00.000Z",
      expires_at: "2026-01-03T00:00:00.000Z",
      private_key: key.private_key,
      nonce: "canonical-nonce-revocation-01",
    });
    setNow("2026-01-02T00:05:00.000Z");
    store.verifyForAdmission({ envelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" });
    store.revokeKey({ key_id: "trust.key.revoke.001", effective_at: "2026-01-02T00:10:00.000Z", reason_code: "KEY_COMPROMISE_REPORTED", actor_id: ADMIN });
    setNow("2026-01-02T00:15:00.000Z");
    expect(() => store.verifyForAdmission({ envelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toThrow("HUMAN_TRUST_NOT_CURRENTLY_ADMISSIBLE");
    expect(store.verifyHistorically({ envelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" })).toMatchObject({ valid_at_signing_time: true, currently_trusted: false });
    expect(store.verifyAuditChain()).toMatchObject({ valid: true });
  });
});
