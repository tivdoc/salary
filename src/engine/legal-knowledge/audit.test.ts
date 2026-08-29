import { describe, expect, it } from "vitest";
import { appendLegalReviewEvent, legalReviewEventHash, validateDualReviewEvents } from "./audit.ts";
import { legalReviewEventSchema } from "./contracts.ts";
import { syntheticSource } from "./synthetic-fixtures.ts";

function event(actorId = "reviewer-a", artifactSha256 = "a".repeat(64)) {
  const source = syntheticSource();
  return legalReviewEventSchema.parse({
    event_id: `review:${actorId}`,
    event_type: "reviewed",
    source_id: source.source_id,
    source_version_id: `${source.source_id}@${source.source_version}`,
    artifact_sha256: artifactSha256,
    normalized_text_sha256: "b".repeat(64),
    effective_period: source.effective_period,
    actor_id: actorId,
    actor_type: "human",
    occurred_at: "2026-08-29T00:00:00Z",
    decision: "review_complete",
    reason: "Synthetic human review fixture",
  });
}

describe("append-only legal review audit", () => {
  it("rejects unknown contract properties at runtime", () => {
    expect(() => legalReviewEventSchema.parse({ ...event(), unknown: true })).toThrow();
  });

  it("does not attribute human review to a system actor", () => {
    expect(() => legalReviewEventSchema.parse({ ...event(), actor_type: "system" })).toThrow("human_review_event_requires_human_actor");
  });

  it("rejects duplicate event identifiers and hashes events deterministically", () => {
    const first = event();
    expect(() => appendLegalReviewEvent([first], first)).toThrow("duplicate_review_event_id");
    expect(legalReviewEventHash(first)).toBe(legalReviewEventHash(first));
  });

  it("requires distinct actors reviewing the same hash and interval", () => {
    expect(validateDualReviewEvents([event("reviewer-a"), event("reviewer-b")]).passed).toBe(true);
    expect(validateDualReviewEvents([event("reviewer-a"), { ...event("reviewer-b"), artifact_sha256: "c".repeat(64) }]).issues)
      .toContain("dual_review_artifact_hash_mismatch");
  });
});
