import { describe, expect, it } from "vitest";
import { humanDecisionSignatureSha256, type HumanTrustPurpose } from "../legal-operations/human-trust.ts";
import {
  createReviewerTrustPolicy,
  createTrustOrganization,
  createTrustedReviewer,
  InMemoryReviewerTrustStore,
} from "../../server/platform/trust/reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "../../server/platform/trust/test-support.ts";
import { buildSyntheticGroundTruthWorkflow, SYNTHETIC_DOCUMENT_SHA256 } from "./synthetic-fixtures.ts";
import { groundTruthVisualEligibilitySchema, TRUSTED_GT_SCHEMA, TrustedGroundTruthWorkflow, trustedGroundTruthActionPayload } from "./trusted-workflow.ts";

const ROOT = "GT_TRUST_ROOT";
const ADMIN = "GT_TRUST_ADMIN";
const ORG = "GT_TRUST_ORGANIZATION";

function setupTrust() {
  let now = "2040-01-01T00:00:00.000Z";
  const trust = new InMemoryReviewerTrustStore({ root_admin_ids: [ROOT], clock: () => now });
  trust.registerOrganization(createTrustOrganization({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0", valid_from: "2040-01-01T00:00:00.000Z", expires_at: "2041-01-01T00:00:00.000Z", policy_admin_ids: [ADMIN] }), ROOT);
  trust.publishPolicy(createReviewerTrustPolicy({
    schema_version: "tivdoc-reviewer-trust-v0.10.0",
    organization_id: ORG,
    organization_version: "1.0.0",
    policy_version: "1.0.0",
    effective_from: "2040-01-01T00:00:00.000Z",
    expires_at: "2041-01-01T00:00:00.000Z",
    max_envelope_ttl_seconds: 7_200,
    grants: [
      { reviewer_role: "human_ground_truth_eligibility_reviewer", purposes: ["ground_truth_visual_eligibility"] },
      { reviewer_role: "human_ground_truth_annotator", purposes: ["ground_truth_annotation"] },
      { reviewer_role: "human_ground_truth_adjudicator", purposes: ["ground_truth_adjudication"] },
      { reviewer_role: "human_ground_truth_lock_reviewer", purposes: ["ground_truth_lock"] },
    ],
  }), ADMIN);
  const definitions = [
    ["SYNTHETIC_ELIGIBILITY_REVIEWER", "human_ground_truth_eligibility_reviewer"],
    ["SYNTHETIC_ANNOTATOR_A", "human_ground_truth_annotator"],
    ["SYNTHETIC_ANNOTATOR_B", "human_ground_truth_annotator"],
    ["SYNTHETIC_ADJUDICATOR", "human_ground_truth_adjudicator"],
    ["SYNTHETIC_LOCK_REVIEWER", "human_ground_truth_lock_reviewer"],
  ] as const;
  const reviewers = new Map<string, Readonly<{ key_id: string; private_key: ReturnType<typeof generateEd25519TestKey>["private_key"]; role: string }>>();
  definitions.forEach(([reviewerId, role], index) => {
    trust.registerReviewer(createTrustedReviewer({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: ORG, organization_version: "1.0.0", reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", reviewer_roles: [role], valid_from: "2040-01-01T00:00:00.000Z", expires_at: "2041-01-01T00:00:00.000Z", identity_evidence_sha256: String(index + 1).repeat(64) }), ADMIN);
    const key = generateEd25519TestKey();
    const challenge = trust.issueKeyPossessionChallenge({ challenge_id: `GT_CHALLENGE_${index + 1}`, reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", key_id: `GT_KEY_${index + 1}`, public_key_spki_pem: key.public_key_spki_pem, valid_from: "2040-01-01T00:00:00.000Z", expires_at: "2041-01-01T00:00:00.000Z", replaces_key_id: null, actor_id: ADMIN });
    trust.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key) });
    reviewers.set(reviewerId, { key_id: challenge.key_id, private_key: key.private_key, role });
  });
  const signed = (reviewerId: string, purpose: HumanTrustPurpose, payload: unknown, issuedAt: string, envelopeId: string) => {
    now = issuedAt;
    const reviewer = reviewers.get(reviewerId)!;
    return signHumanDecision({ envelope_id: envelopeId, organization_id: ORG, organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", reviewer_role: reviewer.role, key_id: reviewer.key_id, purpose, payload_schema_version: TRUSTED_GT_SCHEMA, payload, issued_at: issuedAt, expires_at: new Date(Date.parse(issuedAt) + 3_600_000).toISOString(), private_key: reviewer.private_key });
  };
  return { trust, signed };
}

describe("trusted Ground Truth workflow", () => {
  it("gates on visual/license/PII review, keeps annotation two blind, and locks only after independent signatures", () => {
    const { trust, signed } = setupTrust();
    const workflow = new TrustedGroundTruthWorkflow(trust);
    const unsignedEligibility = {
      schema_version: TRUSTED_GT_SCHEMA,
      eligibility_id: "ground.truth.eligibility.synthetic.001",
      document_sha256: SYNTHETIC_DOCUMENT_SHA256,
      catalog_boundary: "synthetic_test_only" as const,
      visual_review: "completed_eligible" as const,
      license_gate: "authorized_for_private_evaluation" as const,
      pii_gate: "private_handling_controls_verified" as const,
      decision: "eligible" as const,
      reviewer_id: "SYNTHETIC_ELIGIBILITY_REVIEWER",
      reviewer_role: "human_ground_truth_eligibility_reviewer" as const,
      decided_at: "2040-05-01T08:00:00.000Z",
      reason_code: "SYNTHETIC_VISUAL_REVIEW_COMPLETE",
    };
    const eligibilityEnvelope = signed(unsignedEligibility.reviewer_id, "ground_truth_visual_eligibility", unsignedEligibility, unsignedEligibility.decided_at, "GT_ENVELOPE_ELIGIBILITY_001");
    const eligibility = groundTruthVisualEligibilitySchema.parse({ ...unsignedEligibility, signature_sha256: humanDecisionSignatureSha256(eligibilityEnvelope.signature_base64) });
    workflow.recordVisualEligibility(eligibility, eligibilityEnvelope);

    const fixtures = buildSyntheticGroundTruthWorkflow();
    const firstPayload = trustedGroundTruthActionPayload("annotation_1", null, fixtures.annotation_1);
    const firstEnvelope = signed("SYNTHETIC_ANNOTATOR_A", "ground_truth_annotation", firstPayload, "2040-05-01T10:00:00.000Z", "GT_ENVELOPE_ANNOTATION_1");
    workflow.startAnnotation1(fixtures.annotation_1, firstEnvelope);
    expect(workflow.annotation2Brief(fixtures.annotation_1.manifest_id)).not.toHaveProperty("annotations");
    expect(workflow.annotation2Brief(fixtures.annotation_1.manifest_id)).not.toHaveProperty("values");

    const secondAnnotations = fixtures.annotation_2.annotations.filter((annotation) => annotation.annotation_pass === "annotation_2");
    const secondPayload = workflow.previewAnnotation2(fixtures.annotation_1.manifest_id, secondAnnotations);
    const secondEnvelope = signed("SYNTHETIC_ANNOTATOR_B", "ground_truth_annotation", secondPayload, "2040-05-02T10:00:00.000Z", "GT_ENVELOPE_ANNOTATION_2");
    workflow.addAnnotation2(fixtures.annotation_1.manifest_id, secondAnnotations, secondEnvelope);
    workflow.recordDisagreement(fixtures.annotation_1.manifest_id);

    const adjudications = fixtures.human_adjudication.annotations.filter((annotation) => annotation.annotation_pass === "human_adjudication");
    const adjudicationPayload = workflow.previewAdjudication(fixtures.annotation_1.manifest_id, adjudications);
    const adjudicationEnvelope = signed("SYNTHETIC_ADJUDICATOR", "ground_truth_adjudication", adjudicationPayload, "2040-05-03T10:00:00.000Z", "GT_ENVELOPE_ADJUDICATION");
    workflow.adjudicate(fixtures.annotation_1.manifest_id, adjudications, adjudicationEnvelope);

    const lockPayload = workflow.previewLock(fixtures.annotation_1.manifest_id);
    const wrongLockEnvelope = signed("SYNTHETIC_ADJUDICATOR", "ground_truth_adjudication", lockPayload, "2040-05-03T11:00:00.000Z", "GT_ENVELOPE_LOCK_WRONG_ROLE");
    expect(() => workflow.lock(fixtures.annotation_1.manifest_id, wrongLockEnvelope)).toThrow("HUMAN_TRUST_PURPOSE_MISMATCH");
    const lockEnvelope = signed("SYNTHETIC_LOCK_REVIEWER", "ground_truth_lock", lockPayload, "2040-05-03T11:05:00.000Z", "GT_ENVELOPE_LOCK");
    expect(workflow.lock(fixtures.annotation_1.manifest_id, lockEnvelope).status).toBe("locked_ground_truth");
    expect(workflow.status()).toMatchObject({ locked_count: 1, synthetic_locked_count: 1, real_locked_count: 0 });
    expect(workflow.verifyAuditChain().valid).toBe(true);
    expect(trust.verifyAuditChain().valid).toBe(true);
  });

  it("rejects an eligibility claim when any visual, license, or PII gate is absent", () => {
    expect(() => groundTruthVisualEligibilitySchema.parse({
      schema_version: TRUSTED_GT_SCHEMA,
      eligibility_id: "ground.truth.eligibility.rejected.001",
      document_sha256: SYNTHETIC_DOCUMENT_SHA256,
      catalog_boundary: "real_inactive",
      visual_review: "completed_eligible",
      license_gate: "not_authorized",
      pii_gate: "private_handling_controls_verified",
      decision: "eligible",
      reviewer_id: "SYNTHETIC_ELIGIBILITY_REVIEWER",
      reviewer_role: "human_ground_truth_eligibility_reviewer",
      decided_at: "2040-05-01T08:00:00.000Z",
      reason_code: "LICENSE_NOT_AUTHORIZED",
      signature_sha256: "a".repeat(64),
    })).toThrow("ground_truth_visual_license_pii_gate_mismatch");
  });
});
