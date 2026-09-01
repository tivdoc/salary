import { describe, expect, it } from "vitest";
import type { HumanTrustPurpose } from "./human-trust.ts";
import { EVIDENCE_HANDOFF_SCHEMA, ExternalEvidenceHandoffLedger } from "./evidence-handoff.ts";
import {
  createReviewerTrustPolicy,
  createTrustOrganization,
  createTrustedReviewer,
  InMemoryReviewerTrustStore,
} from "../../server/platform/trust/reviewer-trust-store.ts";
import { generateEd25519TestKey, signHumanDecision, signKeyPossessionChallenge } from "../../server/platform/trust/test-support.ts";

function setup() {
  let now = "2026-07-01T00:00:00.000Z";
  const root = "evidence.trust.root";
  const admin = "evidence.trust.admin";
  const organization = "evidence.trust.organization";
  const trust = new InMemoryReviewerTrustStore({ root_admin_ids: [root], clock: () => now });
  trust.registerOrganization(createTrustOrganization({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: organization, organization_version: "1.0.0", valid_from: "2026-07-01T00:00:00.000Z", expires_at: "2027-07-01T00:00:00.000Z", policy_admin_ids: [admin] }), root);
  trust.publishPolicy(createReviewerTrustPolicy({
    schema_version: "tivdoc-reviewer-trust-v0.10.0",
    organization_id: organization,
    organization_version: "1.0.0",
    policy_version: "1.0.0",
    effective_from: "2026-07-01T00:00:00.000Z",
    expires_at: "2027-07-01T00:00:00.000Z",
    max_envelope_ttl_seconds: 7_200,
    grants: [
      { reviewer_role: "human_evidence_custodian", purposes: ["evidence_handoff_delivery"] },
      { reviewer_role: "human_external_evidence_auditor", purposes: ["evidence_handoff_receipt", "evidence_handoff_verification"] },
    ],
  }), admin);
  const definitions = [
    ["evidence.custodian.001", "human_evidence_custodian"],
    ["evidence.auditor.001", "human_external_evidence_auditor"],
  ] as const;
  const reviewers = new Map<string, Readonly<{ role: string; key_id: string; private_key: ReturnType<typeof generateEd25519TestKey>["private_key"] }>>();
  definitions.forEach(([reviewerId, role], index) => {
    trust.registerReviewer(createTrustedReviewer({ schema_version: "tivdoc-reviewer-trust-v0.10.0", organization_id: organization, organization_version: "1.0.0", reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", reviewer_roles: [role], valid_from: "2026-07-01T00:00:00.000Z", expires_at: "2027-07-01T00:00:00.000Z", identity_evidence_sha256: String(index + 3).repeat(64) }), admin);
    const key = generateEd25519TestKey();
    const challenge = trust.issueKeyPossessionChallenge({ challenge_id: `evidence.challenge.${index + 1}`, reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", key_id: `evidence.key.${index + 1}`, public_key_spki_pem: key.public_key_spki_pem, valid_from: "2026-07-01T00:00:00.000Z", expires_at: "2027-07-01T00:00:00.000Z", replaces_key_id: null, actor_id: admin });
    trust.registerProvenKey({ challenge, proof_signature_base64: signKeyPossessionChallenge(challenge, key.private_key) });
    reviewers.set(reviewerId, { role, key_id: challenge.key_id, private_key: key.private_key });
  });
  const sign = (reviewerId: string, purpose: HumanTrustPurpose, payload: unknown, occurredAt: string, envelopeId: string) => {
    now = occurredAt;
    const reviewer = reviewers.get(reviewerId)!;
    return signHumanDecision({ envelope_id: envelopeId, organization_id: organization, organization_version: "1.0.0", policy_version: "1.0.0", reviewer_id: reviewerId, reviewer_identity_version: "1.0.0", reviewer_role: reviewer.role, key_id: reviewer.key_id, purpose, payload_schema_version: EVIDENCE_HANDOFF_SCHEMA, payload, issued_at: occurredAt, expires_at: new Date(Date.parse(occurredAt) + 3_600_000).toISOString(), private_key: reviewer.private_key });
  };
  return { trust, sign };
}

const originalFiles = [
  { file_id: "evidence.file.001", bytes: new TextEncoder().encode("first exact local evidence bytes") },
  { file_id: "evidence.file.002", bytes: new TextEncoder().encode("second exact local evidence bytes") },
] as const;

describe("external evidence handoff", () => {
  it("requires actual bytes and signed custody/auditor transitions through verification", () => {
    const { trust, sign } = setup();
    const ledger = new ExternalEvidenceHandoffLedger(trust);
    expect(() => ledger.prepare({ handoff_id: "evidence.handoff.empty", package_version: "1.0.0", files: [], prepared_at: "2026-07-02T00:00:00.000Z", reason_code: "PACKAGE_PREPARED" })).toThrow("EVIDENCE_HANDOFF_ACTUAL_BYTES_REQUIRED");
    const prepared = ledger.prepare({ handoff_id: "evidence.handoff.001", package_version: "1.0.0", files: originalFiles, prepared_at: "2026-07-02T00:00:00.000Z", reason_code: "PACKAGE_PREPARED" });
    expect(prepared.manifest.files.every((file) => file.byte_length > 0 && /^[a-f0-9]{64}$/.test(file.bytes_sha256))).toBe(true);

    const delivery = { delivery_reference_sha256: "a".repeat(64), delivered_at: "2026-07-02T01:00:00.000Z", reason_code: "PACKAGE_DELIVERED" };
    const deliveryPayload = ledger.previewDelivery(prepared.manifest.handoff_id, delivery);
    ledger.deliver(prepared.manifest.handoff_id, { ...delivery, envelope: sign("evidence.custodian.001", "evidence_handoff_delivery", deliveryPayload, delivery.delivered_at, "evidence.envelope.delivery.001") });

    const receipt = { files: originalFiles, receipt_reference_sha256: "b".repeat(64), received_at: "2026-07-02T02:00:00.000Z", reason_code: "PACKAGE_RECEIVED" };
    const receiptPreview = ledger.previewReceipt(prepared.manifest.handoff_id, receipt);
    expect(receiptPreview.exact_bytes).toBe(true);
    ledger.receive(prepared.manifest.handoff_id, { ...receipt, envelope: sign("evidence.auditor.001", "evidence_handoff_receipt", receiptPreview.payload, receipt.received_at, "evidence.envelope.receipt.001") });

    const verification = { verification_reference_sha256: "c".repeat(64), verified_at: "2026-07-02T03:00:00.000Z", reason_code: "PACKAGE_BYTES_VERIFIED" };
    const verificationPreview = ledger.previewVerification(prepared.manifest.handoff_id, verification);
    expect(verificationPreview.exact_bytes).toBe(true);
    expect(ledger.verify(prepared.manifest.handoff_id, { ...verification, envelope: sign("evidence.auditor.001", "evidence_handoff_verification", verificationPreview.payload, verification.verified_at, "evidence.envelope.verify.001") })).toMatchObject({ state: "verified", file_count: 2 });
    expect(ledger.verifyAuditChain().valid).toBe(true);
    expect(trust.verifyAuditChain().valid).toBe(true);
  });

  it("records a signed rejection when received bytes do not match the prepared manifest", () => {
    const trustSetup = setup();
    const ledger = new ExternalEvidenceHandoffLedger(trustSetup.trust);
    const prepared = ledger.prepare({ handoff_id: "evidence.handoff.002", package_version: "1.0.0", files: originalFiles, prepared_at: "2026-07-02T00:00:00.000Z", reason_code: "PACKAGE_PREPARED" });
    const delivery = { delivery_reference_sha256: "d".repeat(64), delivered_at: "2026-07-02T01:00:00.000Z", reason_code: "PACKAGE_DELIVERED" };
    const deliveryPayload = ledger.previewDelivery(prepared.manifest.handoff_id, delivery);
    ledger.deliver(prepared.manifest.handoff_id, { ...delivery, envelope: trustSetup.sign("evidence.custodian.001", "evidence_handoff_delivery", deliveryPayload, delivery.delivered_at, "evidence.envelope.delivery.002") });
    const mismatched = [{ file_id: "evidence.file.001", bytes: new TextEncoder().encode("mutated bytes") }, originalFiles[1]];
    const receipt = { files: mismatched, receipt_reference_sha256: "e".repeat(64), received_at: "2026-07-02T02:00:00.000Z", reason_code: "PACKAGE_BYTES_MISMATCH" };
    const preview = ledger.previewReceipt(prepared.manifest.handoff_id, receipt);
    expect(preview.exact_bytes).toBe(false);
    expect(ledger.receive(prepared.manifest.handoff_id, { ...receipt, envelope: trustSetup.sign("evidence.auditor.001", "evidence_handoff_receipt", preview.payload, receipt.received_at, "evidence.envelope.receipt.002") })).toMatchObject({ state: "rejected" });
    expect(() => ledger.previewVerification(prepared.manifest.handoff_id, { verification_reference_sha256: "f".repeat(64), verified_at: "2026-07-02T03:00:00.000Z", reason_code: "PACKAGE_VERIFY" })).toThrow("EVIDENCE_HANDOFF_VERIFICATION_REQUIRES_RECEIVED_BYTES");
  });
});
