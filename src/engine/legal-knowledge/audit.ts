import { createHash } from "node:crypto";
import { legalReviewEventSchema, type LegalReviewEvent } from "./contracts.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function legalReviewEventHash(event: LegalReviewEvent) {
  return createHash("sha256").update(stableJson(legalReviewEventSchema.parse(event))).digest("hex");
}

export function appendLegalReviewEvent(events: readonly LegalReviewEvent[], input: LegalReviewEvent) {
  const event = legalReviewEventSchema.parse(input);
  if (events.some((existing) => existing.event_id === event.event_id)) throw new Error("duplicate_review_event_id");
  return [...events, event] as const;
}

export function validateDualReviewEvents(events: readonly LegalReviewEvent[]) {
  const reviews = events.filter((event) => event.event_type === "reviewed");
  const issues: string[] = [];
  if (reviews.length < 2) issues.push("dual_review_requires_two_events");
  if (new Set(reviews.map((event) => event.actor_id)).size < 2) issues.push("dual_review_requires_distinct_actors");
  if (new Set(reviews.map((event) => event.artifact_sha256)).size > 1) issues.push("dual_review_artifact_hash_mismatch");
  if (new Set(reviews.map((event) => stableJson(event.effective_period))).size > 1) issues.push("dual_review_effective_interval_mismatch");
  return { passed: issues.length === 0, issues };
}
