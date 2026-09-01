import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical.ts";
import { compareShadowCandidateToApprovedBaseline } from "../../../engine/shadow/comparison.ts";
import { shadowDecisionPayload } from "../../../engine/shadow/contracts.ts";
import { ShadowReviewerTrustStore } from "../../../engine/shadow/signatures.ts";
import { LocalFileShadowDisagreementQueue } from "./disagreement-queue.ts";
import { buildSyntheticEvaluationSnapshot, buildSyntheticShadowThresholdPolicy } from "./durable-synthetic-fixtures.ts";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("MC-24 / V010-W7.2 signed disagreement queue", () => {
  it.each(["resolved", "rejected"] as const)("persists a cryptographically signed %s decision across restart", async (decisionKind) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-shadow-disagreement-"));
    roots.push(root);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trust = new ShadowReviewerTrustStore();
    trust.register({
      reviewer_id: "reviewer.shadow.001",
      reviewer_key_id: "reviewer-key.shadow.001",
      role: "shadow_disagreement_reviewer",
      algorithm: "ed25519",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      valid_from: "2041-01-01T00:00:00.000Z",
      valid_until: "2043-01-01T00:00:00.000Z",
      revoked_at: null,
    });
    const thresholds = buildSyntheticShadowThresholdPolicy();
    const comparison = compareShadowCandidateToApprovedBaseline({
      comparison_id: `comparison.queue.${decisionKind}`,
      baseline: buildSyntheticEvaluationSnapshot({ snapshot_id: `snapshot.baseline.${decisionKind}` }),
      baseline_approval_receipt_sha256: canonicalSha256({ approval: decisionKind }),
      candidate: buildSyntheticEvaluationSnapshot({ snapshot_id: `snapshot.candidate.${decisionKind}`, changed_topic: "vacation" }),
      thresholds,
    });
    const queue = new LocalFileShadowDisagreementQueue({ root, root_kind: "generated_offline_synthetic_disagreements", trust_store: trust, now: () => "2042-01-01T00:00:00.000Z" });
    const disagreementId = `disagreement.queue.${decisionKind}`;
    await queue.enqueue({ disagreement_id: disagreementId, comparison, threshold_policy: thresholds });
    expect(await queue.pending()).toHaveLength(1);
    const content = {
      schema_version: "tivdoc-shadow-disagreement-decision-v0.10.0" as const,
      disagreement_id: disagreementId,
      disagreement_revision: 2,
      comparison_sha256: comparison.comparison_sha256,
      threshold_policy_sha256: thresholds.policy_sha256,
      decision: decisionKind,
      resolution_code: decisionKind === "resolved" ? "BASELINE_CONFIRMED" as const : "CANDIDATE_REJECTED" as const,
      reviewer_id: "reviewer.shadow.001",
      reviewer_key_id: "reviewer-key.shadow.001",
      signed_at: "2042-01-01T00:01:00.000Z",
      automatic_customer_promotion: false as const,
      automatic_production_promotion: false as const,
    };
    const payload = shadowDecisionPayload(content);
    const signed = { ...content, payload_sha256: payload.payload_sha256, signature_algorithm: "ed25519" as const, signature_base64: sign(null, payload.bytes, privateKey).toString("base64") };
    const decided = await queue.decide(signed);
    expect(decided).toMatchObject({ status: decisionKind, revision: 2, automatic_customer_promotion: false, automatic_production_promotion: false });
    const restarted = new LocalFileShadowDisagreementQueue({ root, root_kind: "generated_offline_synthetic_disagreements", trust_store: trust });
    expect((await restarted.get(disagreementId)).record_sha256).toBe(decided.record_sha256);
    expect(await restarted.pending()).toHaveLength(0);
    await expect(queue.decide({ ...signed, signature_base64: `${signed.signature_base64.slice(0, -2)}AA` })).rejects.toThrow(/SHADOW_DECISION_SIGNATURE_INVALID|SHADOW_DISAGREEMENT_ALREADY_DECIDED/u);
  });
});
