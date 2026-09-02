import { describe, expect, it } from "vitest";

import { WAVE3_TOPICS } from "../wave3/contracts.ts";
import {
  buildLegalHandoffManifest,
  buildLegalTopicReadiness,
  LEGAL_HANDOFF_MANIFEST_SCHEMA,
  LEGAL_TOPIC_GATES,
  LEGAL_TOPIC_READINESS_SCHEMA,
} from "./topic-readiness.ts";

function packet(overrides: Record<string, unknown> = {}) {
  return {
    packet_id: "LRP:a", packet_sha256: "a".repeat(64), raw_artifact_sha256: "b".repeat(64),
    source_version_id: "IL_SYNTHETIC_LAW@v1", state: "pending_review",
    ...overrides,
  } as never;
}

describe("V0.10.5 legal topic readiness", () => {
  it("reports every topic blocked on every gate with no evidence", () => {
    const readiness = buildLegalTopicReadiness();
    expect(readiness.schema_version).toBe(LEGAL_TOPIC_READINESS_SCHEMA);
    expect(readiness.topics).toHaveLength(WAVE3_TOPICS.length);
    expect(readiness.topic_denominator).toBe(WAVE3_TOPICS.length);
    expect(readiness.ready_topics).toBe(0);
    expect(readiness.activation_allowed).toBe(false);
    for (const topic of readiness.topics) {
      expect(topic.ready).toBe(false);
      expect(topic.blocked_gates).toEqual([...LEGAL_TOPIC_GATES]);
      expect(topic.cleared_gates).toEqual([]);
    }
  });

  it("clears only the gates that durable evidence actually supports", () => {
    const readiness = buildLegalTopicReadiness([{
      topic: WAVE3_TOPICS[0], approved_packets: 1, packets_with_known_period: 1,
      packets_with_declared_scope: 0, dual_attested_parameters: 0,
      approved_not_activated_rulespecs: 0, locked_ground_truth_cases: 0,
    }]);
    const row = readiness.topics.find((entry) => entry.topic === WAVE3_TOPICS[0]);
    expect(row?.cleared_gates).toEqual(["source_review", "effective_period"]);
    expect(row?.blocked_gates).toContain("ground_truth");
    expect(row?.blocked_gates).toContain("parameter_attestation");
  });

  it("never reports a topic ready even when every gate clears", () => {
    const readiness = buildLegalTopicReadiness(WAVE3_TOPICS.map((topic) => ({
      topic, approved_packets: 9, packets_with_known_period: 9, packets_with_declared_scope: 9,
      dual_attested_parameters: 9, approved_not_activated_rulespecs: 9, locked_ground_truth_cases: 9,
    })));
    expect(readiness.ready_topics).toBe(0);
    for (const topic of readiness.topics) {
      expect(topic.ready).toBe(false);
      expect(topic.blocked_gates).toEqual([]);
      expect(topic.cleared_gates).toEqual([...LEGAL_TOPIC_GATES]);
    }
  });

  it("is deterministic and ordered by topic", () => {
    const first = buildLegalTopicReadiness();
    const second = buildLegalTopicReadiness();
    expect(first).toEqual(second);
    const topics = first.topics.map((entry) => entry.topic);
    expect(topics).toEqual([...topics].sort());
  });
});

describe("V0.10.5 human handoff manifest", () => {
  it("binds packets to evidence hashes and templates without claiming delivery", () => {
    const manifest = buildLegalHandoffManifest({
      generated_for: "internal-review",
      packets: [packet()],
      template_ids: ["GT:template:001"],
    });
    expect(manifest.schema_version).toBe(LEGAL_HANDOFF_MANIFEST_SCHEMA);
    expect(manifest.delivered).toBe(false);
    expect(manifest.activation_allowed).toBe(false);
    expect(manifest.packets[0]?.raw_artifact_sha256).toBe("b".repeat(64));
    expect(manifest.template_ids).toEqual(["GT:template:001"]);
    expect(manifest.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("counts open and terminal packets separately", () => {
    const manifest = buildLegalHandoffManifest({
      generated_for: "internal-review",
      packets: [
        packet({ packet_id: "LRP:a", state: "pending_review" }),
        packet({ packet_id: "LRP:b", state: "in_review" }),
        packet({ packet_id: "LRP:c", state: "approved" }),
        packet({ packet_id: "LRP:d", state: "superseded" }),
      ],
      template_ids: [],
    });
    expect(manifest.open_packet_count).toBe(2);
    expect(manifest.terminal_packet_count).toBe(2);
  });

  it("is deterministic under reordering and deduplicates template ids", () => {
    const packets = [packet({ packet_id: "LRP:b" }), packet({ packet_id: "LRP:a" })];
    const first = buildLegalHandoffManifest({
      generated_for: "internal-review", packets, template_ids: ["t2", "t1", "t1"],
    });
    const second = buildLegalHandoffManifest({
      generated_for: "internal-review", packets: [...packets].reverse(), template_ids: ["t1", "t2"],
    });
    expect(first.manifest_sha256).toBe(second.manifest_sha256);
    expect(first.template_ids).toEqual(["t1", "t2"]);
    expect(first.packets.map((entry) => entry.packet_id)).toEqual(["LRP:a", "LRP:b"]);
  });

  it("changes its hash when any bound evidence changes", () => {
    const base = buildLegalHandoffManifest({
      generated_for: "internal-review", packets: [packet()], template_ids: ["t1"],
    });
    const altered = buildLegalHandoffManifest({
      generated_for: "internal-review",
      packets: [packet({ raw_artifact_sha256: "c".repeat(64) })],
      template_ids: ["t1"],
    });
    expect(altered.manifest_sha256).not.toBe(base.manifest_sha256);
  });

  it("produces an empty manifest without inventing a packet or template", () => {
    const manifest = buildLegalHandoffManifest({
      generated_for: "internal-review", packets: [], template_ids: [],
    });
    expect(manifest.packets).toEqual([]);
    expect(manifest.template_ids).toEqual([]);
    expect(manifest.open_packet_count).toBe(0);
    expect(manifest.terminal_packet_count).toBe(0);
  });
});
