import { describe, expect, it } from "vitest";
import { canonicalLegalOperationsJson, legalOperationsSha256 } from "./canonical.ts";
import {
  blankSourceDecisionTemplateSchema,
  exactRationalSchema,
  lifecycleCommandSchema,
  parameterCandidateSchema,
  reviewPacketSchema,
  signedLifecycleActionSchema,
  sourceReviewAttestationSchema,
} from "./contracts.ts";
import { buildAllReviewPacketBundles, buildOwnerHandoffIndex, buildReviewPacket } from "./review-packets.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "./synthetic-fixtures.ts";

describe("legal operations strict contracts and review packets", () => {
  it("hashes canonical objects independently of key insertion order", () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, a: [3, 2, 1] };
    const right = { a: [3, 2, 1], nested: { a: 1, b: 2 }, z: 1 };
    expect(canonicalLegalOperationsJson(left)).toBe(canonicalLegalOperationsJson(right));
    expect(legalOperationsSha256(left)).toBe(legalOperationsSha256(right));
  });

  it("rejects unknown keys, unsafe money, floats, malformed versions, and inverted intervals", () => {
    const parameter = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0].parameter;
    expect(() => parameterCandidateSchema.parse({ ...parameter, extra: true })).toThrow();
    expect(() => parameterCandidateSchema.parse({ ...parameter, value: { kind: "money", value: { currency: "ZZZ", minor_units: Number.MAX_SAFE_INTEGER + 1 } } })).toThrow();
    expect(() => exactRationalSchema.parse({ kind: "rational", numerator: "1.5", denominator: "1", unit: "ratio" })).toThrow();
    expect(() => parameterCandidateSchema.parse({ ...parameter, parameter_version: "latest" })).toThrow();
    expect(() => parameterCandidateSchema.parse({ ...parameter, effective_from: "2040-02-01", effective_to: "2040-01-01" })).toThrow();
    expect(() => reviewPacketSchema.parse({ ...buildReviewPacket("minimum_wage"), unknown: "denied" })).toThrow();
  });

  it("requires signed and hash-bound explicit lifecycle actions", () => {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
    const action = {
      schema_version: "tivdoc-signed-lifecycle-action-v0.6.0",
      action_id: "syn.action.activate.test",
      idempotency_key: "syn.action.activate.test.key",
      artifact_id: fixture.parameter.parameter_id,
      artifact_version: fixture.parameter.parameter_version,
      artifact_kind: "parameter",
      action: "activate",
      expected_state: "eligible",
      target_state: "active",
      actor_id: "syn.human.activation.test",
      actor_role: "human_activation_approver",
      occurred_at: "2040-01-01T00:00:00.000Z",
      reason: "Synthetic lifecycle contract test.",
      bound_content_sha256: legalOperationsSha256(fixture.parameter),
      bindings: fixture.parameter.bindings,
      signature_sha256: legalOperationsSha256("signature"),
    };
    expect(signedLifecycleActionSchema.parse(action).action).toBe("activate");
    expect(() => signedLifecycleActionSchema.parse({ ...action, signature_sha256: undefined })).toThrow();
    expect(() => signedLifecycleActionSchema.parse({ ...action, target_state: "eligible" })).toThrow();
    expect(() => lifecycleCommandSchema.parse({ ...action, schema_version: "tivdoc-legal-lifecycle-command-v0.6.0" })).toThrow();
  });

  it("builds exactly seven deterministic packet pairs with blockers and blank decisions", () => {
    const first = buildAllReviewPacketBundles();
    const replay = buildAllReviewPacketBundles();
    expect(first).toHaveLength(7);
    expect(first.map((entry) => entry.json)).toEqual(replay.map((entry) => entry.json));
    expect(first.map((entry) => entry.markdown)).toEqual(replay.map((entry) => entry.markdown));
    for (const bundle of first) {
      expect(bundle.packet.usable_for_rules).toBe(false);
      expect(bundle.packet.completeness_status).not.toBe("candidate_complete_unreviewed");
      expect(bundle.packet.sources.every((source) => source.lifecycle_blockers.length > 0)).toBe(true);
      expect(bundle.blank_decision.required_decisions).toHaveLength(5);
      expect(blankSourceDecisionTemplateSchema.parse(bundle.blank_decision)).toEqual(bundle.blank_decision);
    }
    const handoff = buildOwnerHandoffIndex();
    expect(handoff.packet_count).toBe(7);
    expect(handoff.packets.every((packet) => packet.required_signatures.length === 5)).toBe(true);
    expect(handoff.real_catalog_activation_permitted).toBe(false);
  });

  it("produces blank templates that become importable only after five identified signed decisions", () => {
    const packet = buildReviewPacket("travel");
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.topic === "travel")!;
    const sourceVersionIds = packet.sources.map((source) => source.source_version_id);
    const filled = fixture.source_attestations.map((attestation) => sourceReviewAttestationSchema.parse({
      ...attestation,
      packet_id: packet.packet_id,
      packet_sha256: packet.packet_sha256,
      source_version_ids: sourceVersionIds,
      decision_payload: attestation.decision_payload.kind === "authority_precedence" ? { ...attestation.decision_payload, source_roles: sourceVersionIds.map((source_version_id) => ({ source_version_id, authority_role: "role_pending" })) } : attestation.decision_payload,
    }));
    expect(new Set(filled.map((entry) => entry.decision_kind)).size).toBe(5);
    expect(new Set(filled.map((entry) => entry.reviewer_id)).size).toBe(5);
  });
});
