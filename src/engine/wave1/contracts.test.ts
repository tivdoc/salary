import { describe, expect, it } from "vitest";
import {
  legalEvidenceRefSchema,
  ruleExecutionResultSchema,
  ruleInputSnapshotSchema,
  topicReadinessResultSchema,
} from "./contracts.ts";

const hash = "a".repeat(64);

describe("frozen Wave 1 shared contracts", () => {
  it("keeps RuleInputSnapshot as a hash-only placeholder", () => {
    expect(ruleInputSnapshotSchema.parse({ snapshot_id: "snap:1", snapshot_version: "v0.3.1", snapshot_sha256: hash })).toEqual({
      snapshot_id: "snap:1",
      snapshot_version: "v0.3.1",
      snapshot_sha256: hash,
    });
    expect(() => ruleInputSnapshotSchema.parse({ snapshot_id: "snap:1", snapshot_version: "v0.3.1", snapshot_sha256: hash, facts: [] })).toThrow();
  });

  it("keeps evidence lifecycle dimensions explicit", () => {
    expect(legalEvidenceRefSchema.parse({
      source_id: "SYNTHETIC_SOURCE",
      source_version_id: "SYNTHETIC_SOURCE@v1",
      artifact_sha256: hash,
      parsed_version_id: null,
      citation_id: null,
      review_state: "needs_review",
      activation_state: "inactive",
    }).activation_state).toBe("inactive");
  });

  it("fails topic readiness closed", () => {
    expect(() => topicReadinessResultSchema.parse({
      topic: "synthetic_topic",
      valid_on: "2026-08-29",
      known_at: "2026-08-29T20:00:00Z",
      sector: "synthetic_sector",
      population: "synthetic_population",
      status: "ready",
      missing_gates: ["review_missing"],
      evidence_refs: [],
      usable_for_rules: false,
    })).toThrow();
  });

  it("does not permit partial successful results", () => {
    expect(() => ruleExecutionResultSchema.parse({
      request_id: "request:1",
      rule_id: "synthetic_rule",
      rule_version: "v1",
      status: "succeeded",
      trace_id: null,
      output_hash: null,
      rejection_codes: [],
      completed_at: "2026-08-29T20:00:00Z",
    })).toThrow();
  });
});
