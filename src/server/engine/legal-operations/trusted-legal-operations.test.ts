import { describe, expect, it } from "vitest";
import { legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { humanDecisionSignatureSha256, payloadWithoutEmbeddedSignature, type HumanTrustPurpose } from "../../../engine/legal-operations/human-trust.ts";
import { parameterAttestationSchema, parameterCandidateSchema, semanticApprovalSchema, signedLifecycleActionSchema, type LifecycleCommand } from "../../../engine/legal-operations/contracts.ts";
import { createGoldenCaseSet, createRuleSpecPackage, type RuleSpecPackage } from "../../../engine/legal-operations/rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "../../../engine/legal-operations/synthetic-fixtures.ts";
import {
  createReviewerTrustPolicy,
  createTrustOrganization,
  createTrustedReviewer,
  InMemoryReviewerTrustStore,
} from "../../platform/trust/reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "../../platform/trust/test-support.ts";
import { LegalOperationsApplicationService } from "./service.ts";

const NOW = "2026-06-01T10:00:00.000Z";
const EXPIRES = "2026-06-01T11:00:00.000Z";
const ORG = "trust.organization.legal.test";
const ADMIN = "trust.admin.legal.test";
const ROOT = "trust.root.legal.test";

function trustedReviewers(definitions: readonly Readonly<{ reviewer_id: string; reviewer_role: string; purpose: HumanTrustPurpose }>[]) {
  const trust = new InMemoryReviewerTrustStore({ root_admin_ids: [ROOT], clock: () => NOW });
  trust.registerOrganization(createTrustOrganization({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0", valid_from: "2026-01-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z", policy_admin_ids: [ADMIN] }), ROOT);
  const grants = [...new Set(definitions.map((definition) => definition.reviewer_role))].map((reviewerRole) => ({ reviewer_role: reviewerRole, purposes: [...new Set(definitions.filter((definition) => definition.reviewer_role === reviewerRole).map((definition) => definition.purpose))] }));
  trust.publishPolicy(createReviewerTrustPolicy({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0", effective_from: "2026-01-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z", max_envelope_ttl_seconds: 7_200, grants }), ADMIN);
  const reviewers = definitions.map((definition, index) => {
    const ordinal = index + 1;
    trust.registerReviewer(createTrustedReviewer({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0", reviewer_id: definition.reviewer_id, reviewer_identity_version: "1.0.0", reviewer_roles: [definition.reviewer_role], valid_from: "2026-01-01T00:00:00.000Z", expires_at: "2027-01-01T00:00:00.000Z", identity_evidence_sha256: ordinal.toString(16).repeat(64) }), ADMIN);
    const key = generateEd25519TestKey();
    const challenge = trust.issueKeyPossessionChallenge({ challenge_id: `trust.challenge.legal.${ordinal}`, reviewer_id: definition.reviewer_id, reviewer_identity_version: "1.0.0", key_id: `trust.key.legal.${ordinal}`, public_key_spki_pem: key.public_key_spki_pem, valid_from: NOW, expires_at: "2027-01-01T00:00:00.000Z", replaces_key_id: null, actor_id: ADMIN });
    trust.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key) });
    return { ...definition, key_id: challenge.key_id, private_key: key.private_key };
  });
  return { trust, reviewers };
}

function lifecycle(parameter: ReturnType<typeof parameterCandidateSchema.parse>, expected: string, target: string): LifecycleCommand {
  return {
    schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
    command_id: `trust.command.${target}`,
    idempotency_key: `trust.command.key.${target}`,
    artifact_id: parameter.parameter_id,
    artifact_version: parameter.parameter_version,
    artifact_kind: "parameter",
    expected_state: expected,
    target_state: target,
    actor_id: "trust.system.governance",
    actor_role: "human_authority_reviewer",
    occurred_at: NOW,
    reason: "Mechanical state transition after cryptographically admitted attestations.",
    bound_content_sha256: legalOperationsSha256(parameter),
    bindings: parameter.bindings,
    action_signature_sha256: null,
  };
}

function ruleLifecycle(rule: RuleSpecPackage, bindings: LifecycleCommand["bindings"], expected: string, target: string): LifecycleCommand {
  return {
    schema_version: "tivdoc-legal-lifecycle-command-v0.6.0",
    command_id: `trust.rule.command.${target}`,
    idempotency_key: `trust.rule.command.key.${target}`,
    artifact_id: rule.rule_spec_id,
    artifact_version: rule.rule_spec_version,
    artifact_kind: "rule_package",
    expected_state: expected,
    target_state: target,
    actor_id: "trust.system.governance",
    actor_role: "human_authority_reviewer",
    occurred_at: NOW,
    reason: "Mechanical RuleSpec transition after cryptographically admitted approvals.",
    bound_content_sha256: legalOperationsSha256(rule),
    bindings,
    action_signature_sha256: null,
  };
}

describe("trusted legal operations admission", () => {
  it("requires exact cryptographic envelopes for dual parameter attestations and remains inactive", () => {
    const { trust, reviewers } = trustedReviewers([
      { reviewer_id: "trust.reviewer.parameter.1", reviewer_role: "human_parameter_reviewer", purpose: "parameter_attestation" },
      { reviewer_id: "trust.reviewer.parameter.2", reviewer_role: "human_parameter_reviewer", purpose: "parameter_attestation" },
    ]);
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const seed = { ...fixture.parameter, parameter_id: "parameter.real.inactive.test", parameter_version: "1.0.0" } as Record<string, unknown>;
    delete seed.candidate_sha256;
    const parameter = parameterCandidateSchema.parse({ ...seed, candidate_sha256: legalOperationsSha256(seed) });
    const service = new LegalOperationsApplicationService({ trust });
    service.importArtifact({ artifact_id: parameter.parameter_id, artifact_version: parameter.parameter_version, artifact_kind: "parameter", content: parameter, content_sha256: legalOperationsSha256(parameter), bindings: parameter.bindings, idempotency_key: "trust.parameter.import.001", imported_at: NOW });
    service.transition(lifecycle(parameter, "candidate", "structurally_valid"));
    service.transition(lifecycle(parameter, "structurally_valid", "awaiting_attestations"));
    expect(() => service.importParameterAttestation(parameter.parameter_id, parameter.parameter_version, fixture.parameter_attestations[0])).toThrow("HUMAN_TRUST_ENVELOPE_REQUIRED");

    reviewers.forEach((reviewer, index) => {
      const unsigned = {
        ...fixture.parameter_attestations[index],
        attestation_id: `trust.parameter.attestation.${index + 1}`,
        candidate_id: parameter.parameter_id,
        candidate_version: parameter.parameter_version,
        candidate_sha256: parameter.candidate_sha256,
        reviewer_id: reviewer.reviewer_id,
        value: parameter.value,
        unit: parameter.unit,
        rounding_policy: parameter.rounding_policy,
        operative_source_version_ids: parameter.operative_source_version_ids,
        bindings_sha256: legalOperationsSha256(parameter.bindings),
        attested_at: NOW,
      };
      const envelope = signHumanDecision({ envelope_id: `trust.envelope.parameter.${index + 1}`, organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: reviewer.reviewer_id, reviewer_identity_version: "1.0.0", reviewer_role: "human_parameter_reviewer", key_id: reviewer.key_id, purpose: "parameter_attestation", payload_schema_version: "tivdoc-parameter-attestation-v0.6.0", payload: payloadWithoutEmbeddedSignature(unsigned), issued_at: NOW, expires_at: EXPIRES, private_key: reviewer.private_key, nonce: `canonical-parameter-nonce-${index + 1}` });
      const payload = parameterAttestationSchema.parse({ ...unsigned, signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64) });
      service.importTrustedParameterAttestation({ artifact_id: parameter.parameter_id, artifact_version: parameter.parameter_version, payload, envelope });
    });

    service.transition(lifecycle(parameter, "awaiting_attestations", "approved"));
    expect(service.status(parameter.parameter_id, parameter.parameter_version)).toMatchObject({ state: "approved", missing_gates: ["explicit_activation"] });
    expect(service.trustedDecisionHistory(parameter.parameter_id, parameter.parameter_version)).toHaveLength(2);
    expect(() => service.transition(lifecycle(parameter, "approved", "eligible"))).toThrow("TRUSTED_SIGNED_LIFECYCLE_ACTION_REQUIRED");
    expect(service.status(parameter.parameter_id, parameter.parameter_version).state).toBe("approved");
    expect(trust.verifyAuditChain().valid).toBe(true);
  });

  it("admits separate signed RuleSpec and golden approvals but blocks unsigned eligibility", () => {
    const { trust, reviewers } = trustedReviewers([
      { reviewer_id: "trust.reviewer.rule.1", reviewer_role: "human_rule_reviewer", purpose: "rulespec_semantics" },
      { reviewer_id: "trust.reviewer.golden.1", reviewer_role: "human_golden_case_reviewer", purpose: "golden_case_outputs" },
      { reviewer_id: "trust.reviewer.lifecycle.1", reviewer_role: "human_rule_reviewer", purpose: "lifecycle_action" },
    ]);
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const { content_sha256: omittedGoldenSha256, ...goldenSeed } = fixture.golden_cases;
    const { content_sha256: omittedRuleSha256, ...ruleSeed } = fixture.rule;
    void omittedGoldenSha256;
    void omittedRuleSha256;
    const golden = createGoldenCaseSet({ ...goldenSeed, golden_case_set_id: "golden.real.inactive.test", rule_spec_id: "rule.real.inactive.test" });
    const rule = createRuleSpecPackage({ ...ruleSeed, rule_spec_id: "rule.real.inactive.test", catalog_boundary: "real_inactive", golden_case_set_sha256: golden.content_sha256 });
    const bindings = { ...fixture.parameter.bindings, rule_spec_sha256: rule.content_sha256, golden_cases_sha256: golden.content_sha256 };
    const service = new LegalOperationsApplicationService({ trust });
    service.importArtifact({ artifact_id: rule.rule_spec_id, artifact_version: rule.rule_spec_version, artifact_kind: "rule_package", content: rule, content_sha256: legalOperationsSha256(rule), bindings, idempotency_key: "trust.rule.import.001", imported_at: NOW });
    service.importGoldenCaseSet(golden, "trust.golden.import.001");
    service.transition(ruleLifecycle(rule, bindings, "candidate", "structurally_valid"));
    service.transition(ruleLifecycle(rule, bindings, "structurally_valid", "awaiting_attestations"));
    expect(() => service.importRuleOrGoldenApproval(rule.rule_spec_id, rule.rule_spec_version, fixture.semantic_approvals[0])).toThrow("HUMAN_TRUST_ENVELOPE_REQUIRED");
    reviewers.slice(0, 2).forEach((reviewer, index) => {
      const approvalKind = index === 0 ? "rule_semantics" as const : "golden_case_outputs" as const;
      const unsigned = {
        ...fixture.semantic_approvals[index],
        approval_id: `trust.${approvalKind}.approval.001`,
        artifact_id: rule.rule_spec_id,
        artifact_version: rule.rule_spec_version,
        artifact_sha256: approvalKind === "rule_semantics" ? rule.content_sha256 : golden.content_sha256,
        approval_kind: approvalKind,
        reviewer_id: reviewer.reviewer_id,
        reviewer_role: reviewer.reviewer_role,
        decided_at: NOW,
      };
      const envelope = signHumanDecision({ envelope_id: `trust.envelope.${approvalKind}.001`, organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: reviewer.reviewer_id, reviewer_identity_version: "1.0.0", reviewer_role: reviewer.reviewer_role, key_id: reviewer.key_id, purpose: reviewer.purpose, payload_schema_version: "tivdoc-legal-semantic-approval-v0.6.0", payload: payloadWithoutEmbeddedSignature(unsigned), issued_at: NOW, expires_at: EXPIRES, private_key: reviewer.private_key, nonce: `canonical-${approvalKind}-nonce` });
      const payload = semanticApprovalSchema.parse({ ...unsigned, signature_sha256: humanDecisionSignatureSha256(envelope.signature_base64) });
      service.importTrustedRuleOrGoldenApproval({ artifact_id: rule.rule_spec_id, artifact_version: rule.rule_spec_version, payload, envelope });
    });
    service.transition(ruleLifecycle(rule, bindings, "awaiting_attestations", "approved"));
    expect(service.status(rule.rule_spec_id, rule.rule_spec_version)).toMatchObject({ state: "approved", missing_gates: ["explicit_activation"] });
    expect(() => service.transition(ruleLifecycle(rule, bindings, "approved", "eligible"))).toThrow("TRUSTED_SIGNED_LIFECYCLE_ACTION_REQUIRED");
    expect(service.status(rule.rule_spec_id, rule.rule_spec_version).state).toBe("approved");
    const lifecycleReviewer = reviewers[2]!;
    const unsignedAction = {
      schema_version: "tivdoc-signed-lifecycle-action-v0.6.0" as const,
      action_id: "trust.rule.action.propose.001",
      idempotency_key: "trust.rule.action.key.propose.001",
      artifact_id: rule.rule_spec_id,
      artifact_version: rule.rule_spec_version,
      artifact_kind: "rule_package" as const,
      action: "propose_activation" as const,
      expected_state: "approved" as const,
      target_state: "eligible" as const,
      actor_id: lifecycleReviewer.reviewer_id,
      actor_role: "human_rule_reviewer" as const,
      occurred_at: NOW,
      reason: "Cryptographically signed eligibility proposal without activation.",
      bound_content_sha256: legalOperationsSha256(rule),
      bindings,
    };
    const lifecycleEnvelope = signHumanDecision({ envelope_id: "trust.envelope.lifecycle.propose.001", organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: lifecycleReviewer.reviewer_id, reviewer_identity_version: "1.0.0", reviewer_role: lifecycleReviewer.reviewer_role, key_id: lifecycleReviewer.key_id, purpose: "lifecycle_action", payload_schema_version: unsignedAction.schema_version, payload: unsignedAction, issued_at: NOW, expires_at: EXPIRES, private_key: lifecycleReviewer.private_key, nonce: "canonical-lifecycle-propose-nonce" });
    const action = signedLifecycleActionSchema.parse({ ...unsignedAction, signature_sha256: humanDecisionSignatureSha256(lifecycleEnvelope.signature_base64) });
    service.applyTrustedLifecycleAction({ payload: action, envelope: lifecycleEnvelope });
    expect(service.status(rule.rule_spec_id, rule.rule_spec_version)).toMatchObject({ state: "eligible", missing_gates: ["explicit_activation"] });
  });
});
