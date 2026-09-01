import { canonicalLegalOperationsJson, legalOperationsSha256 } from "../../src/engine/legal-operations/canonical.ts";
import {
  createReviewerTrustPolicy,
  createTrustOrganization,
  createTrustedReviewer,
  InMemoryReviewerTrustStore,
} from "../../src/server/platform/trust/reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "../../src/server/platform/trust/test-support.ts";

const timestamp = "2040-01-01T00:00:00.000Z";
const trust = new InMemoryReviewerTrustStore({ root_admin_ids: ["synthetic.trust.root"], clock: () => timestamp });
trust.registerOrganization(createTrustOrganization({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: "synthetic.trust.organization", organization_version: "1.0.0", valid_from: timestamp, expires_at: "2041-01-01T00:00:00.000Z", policy_admin_ids: ["synthetic.trust.admin"] }), "synthetic.trust.root");
trust.publishPolicy(createReviewerTrustPolicy({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: "synthetic.trust.organization", organization_version: "1.0.0", policy_version: "1.0.0", effective_from: timestamp, expires_at: "2041-01-01T00:00:00.000Z", max_envelope_ttl_seconds: 3_600, grants: [{ reviewer_role: "human_rule_reviewer", purposes: ["rulespec_semantics"] }] }), "synthetic.trust.admin");
trust.registerReviewer(createTrustedReviewer({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: "synthetic.trust.organization", organization_version: "1.0.0", reviewer_id: "synthetic.trust.reviewer", reviewer_identity_version: "1.0.0", reviewer_roles: ["human_rule_reviewer"], valid_from: timestamp, expires_at: "2041-01-01T00:00:00.000Z", identity_evidence_sha256: legalOperationsSha256({ synthetic_test_only: true, evidence: "neutral_identity_fixture" }) }), "synthetic.trust.admin");

const key = generateEd25519TestKey();
const challenge = trust.issueKeyPossessionChallenge({ challenge_id: "synthetic.trust.challenge", reviewer_id: "synthetic.trust.reviewer", reviewer_identity_version: "1.0.0", key_id: "synthetic.trust.key", public_key_spki_pem: key.public_key_spki_pem, valid_from: timestamp, expires_at: "2041-01-01T00:00:00.000Z", replaces_key_id: null, actor_id: "synthetic.trust.admin" });
const registration = trust.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key) });
const payload = { schema_version: "tivdoc-synthetic-human-trust-self-test-v0.10.0", synthetic_test_only: true, decision: "mechanics_verified", legal_effect: false };
const envelope = signHumanDecision({ envelope_id: "synthetic.trust.envelope", organization_id: "synthetic.trust.organization", organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: "synthetic.trust.reviewer", reviewer_identity_version: "1.0.0", reviewer_role: "human_rule_reviewer", key_id: registration.key_id, purpose: "rulespec_semantics", payload_schema_version: payload.schema_version, payload, issued_at: timestamp, expires_at: "2040-01-01T00:30:00.000Z", private_key: key.private_key, nonce: "synthetic-trust-self-test-nonce" });
const verification = trust.verifyForAdmission({ envelope, payload, purpose: "rulespec_semantics", required_reviewer_role: "human_rule_reviewer" });
const audit = trust.verifyAuditChain();
const report = {
  schema_version: "tivdoc-human-trust-self-test-report-v0.10.0",
  synthetic_test_only: true,
  legal_effect: false,
  proof_of_possession_verified: registration.key_id === verification.key_id,
  canonical_envelope_verified: verification.valid_at_signing_time && verification.currently_trusted,
  audit_chain_valid: audit.valid,
  audit_event_count: audit.event_count,
  public_key_sha256: registration.public_key_sha256,
  envelope_sha256: verification.envelope_sha256,
  signature_sha256: verification.signature_sha256,
  real_sources_activated: 0,
  real_parameters_activated: 0,
  real_rules_activated: 0,
  real_ground_truth_locked: 0,
};
process.stdout.write(canonicalLegalOperationsJson({ ...report, report_sha256: legalOperationsSha256(report) }));
