import { describe, expect, it } from "vitest";

import { legalOperationsSha256 } from "../../../engine/legal-operations/canonical.ts";
import { GOVERNANCE_SCHEMA_VERSION } from "../../platform/persistence/postgres/governance/contracts.ts";
import {
  LegalReviewBacklogError,
  LEGAL_REVIEW_BACKLOG_SCHEMA,
  projectObservationToBacklogEntry,
  projectStagedObservationsToReviewBacklog,
} from "./staging-projection.ts";

function candidate(overrides: Record<string, unknown> = {}) {
  const base = {
    schema_version: GOVERNANCE_SCHEMA_VERSION,
    observation_id: "ACQOBS:WAVE1:00000000000000000000000000000001",
    observation_version: "1",
    observation_kind: "source_bytes",
    source_candidate_id: null,
    instrument_candidate_id: null,
    observed_url: "https://www.gov.il/synthetic-observation",
    artifact_version_id: "ARTIFACT:v1",
    byte_object_id: "BYTES:v1",
    bytes_sha256: "a".repeat(64),
    topic: "minimum_wage",
    candidate_valid_from: "2020-01-01",
    candidate_valid_to: null,
    knowledge_time: null,
    sectors: ["general"],
    populations: [],
    geographies: [],
    provenance: { collection: "hours_publications", retrieved_by: "wave1" },
    contradiction_refs: [],
    gap_refs: [],
    alias_refs: [],
    duplicate_refs: [],
    overlap_refs: [],
    legal_effect: "unreviewed",
    activation_allowed: false,
    ...overrides,
  };
  return { ...base, candidate_sha256: legalOperationsSha256(base).slice(0, 64) };
}

describe("V0.10.3 staged observation to review backlog projection", () => {
  it("projects a fully evidenced observation as reviewable and preserves its hashes", () => {
    const entry = projectObservationToBacklogEntry(candidate());
    expect(entry.schema_version).toBe(LEGAL_REVIEW_BACKLOG_SCHEMA);
    expect(entry.disposition).toBe("reviewable");
    expect(entry.blocked_reason_codes).toEqual([]);
    expect(entry.bytes_sha256).toBe("a".repeat(64));
    expect(entry.artifact_version_id).toBe("ARTIFACT:v1");
    expect(entry.provenance).toEqual({ collection: "hours_publications", retrieved_by: "wave1" });
    expect(entry.provenance_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("blocks rather than substitutes when the official artifact bytes are absent", () => {
    const entry = projectObservationToBacklogEntry(candidate({ bytes_sha256: null, byte_object_id: null }));
    expect(entry.disposition).toBe("blocked");
    expect(entry.blocked_reason_codes).toContain("OFFICIAL_ARTIFACT_BYTES_MISSING");
    expect(entry.bytes_sha256).toBeNull();
  });

  it("records every missing precondition instead of only the first", () => {
    const entry = projectObservationToBacklogEntry(candidate({
      bytes_sha256: null, byte_object_id: null, artifact_version_id: null,
      topic: null, candidate_valid_from: null, candidate_valid_to: null,
    }));
    expect(entry.disposition).toBe("blocked");
    expect([...entry.blocked_reason_codes].sort()).toEqual([
      "ARTIFACT_VERSION_MISSING",
      "EFFECTIVE_PERIOD_UNRESOLVED",
      "OFFICIAL_ARTIFACT_BYTES_MISSING",
      "TOPIC_UNRESOLVED",
    ]);
  });

  it("never infers a topic or an effective period for a blocked entry", () => {
    const entry = projectObservationToBacklogEntry(candidate({
      topic: null, candidate_valid_from: null, candidate_valid_to: null,
    }));
    expect(entry.topic).toBeNull();
    expect(entry.candidate_valid_from).toBeNull();
    expect(entry.candidate_valid_to).toBeNull();
  });

  it("refuses a candidate that claims activation is allowed", () => {
    expect(() => projectObservationToBacklogEntry(candidate({ activation_allowed: true })))
      .toThrow(LegalReviewBacklogError);
  });

  it("refuses a malformed candidate rather than projecting a partial entry", () => {
    expect(() => projectObservationToBacklogEntry({ observation_id: "only-an-id" }))
      .toThrow(/LEGAL_REVIEW_BACKLOG_CANDIDATE_INVALID/u);
  });

  it("projects a set deterministically and idempotently with activation held off", () => {
    const first = candidate();
    const second = candidate({ observation_id: "ACQOBS:WAVE1:00000000000000000000000000000002" });
    const backlog = projectStagedObservationsToReviewBacklog([second, first, first]);
    expect(backlog.counts).toEqual({ total: 2, reviewable: 2, blocked: 0 });
    expect(backlog.activation_allowed).toBe(false);
    expect(backlog.entries.map((entry) => entry.observation_id)).toEqual([
      "ACQOBS:WAVE1:00000000000000000000000000000001",
      "ACQOBS:WAVE1:00000000000000000000000000000002",
    ]);
    expect(projectStagedObservationsToReviewBacklog([first, second])).toEqual(backlog);
  });

  it("treats the same observation version arriving with different bytes as a conflict", () => {
    const original = candidate();
    const divergent = candidate({ bytes_sha256: "b".repeat(64) });
    expect(() => projectStagedObservationsToReviewBacklog([original, divergent]))
      .toThrow(/LEGAL_REVIEW_BACKLOG_CONFLICT/u);
  });

  it("counts reviewable and blocked entries separately across a mixed set", () => {
    const backlog = projectStagedObservationsToReviewBacklog([
      candidate(),
      candidate({ observation_id: "ACQOBS:WAVE1:00000000000000000000000000000003", bytes_sha256: null, byte_object_id: null }),
      candidate({ observation_id: "ACQOBS:WAVE1:00000000000000000000000000000004", topic: null }),
    ]);
    expect(backlog.counts).toEqual({ total: 3, reviewable: 1, blocked: 2 });
  });

  it("returns an empty backlog for an empty staged set without inventing entries", () => {
    const backlog = projectStagedObservationsToReviewBacklog([]);
    expect(backlog.entries).toEqual([]);
    expect(backlog.counts).toEqual({ total: 0, reviewable: 0, blocked: 0 });
  });
});
