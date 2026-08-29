import { describe, expect, it } from "vitest";
import type { LegalSource } from "./contracts.ts";
import { retrieveLegalKnowledge } from "./retrieval.ts";
import { syntheticChunk, syntheticSource } from "./synthetic-fixtures.ts";

function activeSource(overrides: Partial<LegalSource> = {}) {
  return syntheticSource({
    status: "active",
    content_sha256: "a".repeat(64),
    retrieved_at: "2026-08-29T00:00:00Z",
    verification: {
      status: "content_verified",
      method: "synthetic",
      verified_by: ["reviewer-a"],
      verified_at: "2026-08-29T00:00:00Z",
      notes: [],
    },
    ...overrides,
  });
}

function query(overrides: Partial<Parameters<typeof retrieveLegalKnowledge>[2]> = {}) {
  return {
    topic: "minimum_wage" as const,
    targetDate: "2026-08-29",
    sector: "general" as const,
    activeOnly: true,
    keywords: ["minimum", "wage"],
    limit: 10,
    ...overrides,
  };
}

describe("deterministic legal retrieval", () => {
  it("returns a current active source with a citation reference", () => {
    const source = activeSource();
    const result = retrieveLegalKnowledge([source], [syntheticChunk(source)], query());
    expect(result.results[0]).toMatchObject({
      source: { source_id: source.source_id },
      effectiveDateMatch: true,
      citationReference: { source_id: source.source_id },
      requiresReview: false,
    });
  });

  it("resolves a historical query to the historical source", () => {
    const old = activeSource({ source_version: "old", effective_from: "2020-01-01", effective_to: "2020-12-31", effective_period: {
      effective_from: "2020-01-01", effective_to: "2020-12-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    const current = activeSource({ source_version: "current", effective_from: "2021-01-01", effective_to: null, effective_period: {
      effective_from: "2021-01-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    const result = retrieveLegalKnowledge([old, current], [syntheticChunk(old), syntheticChunk(current)], query({ targetDate: "2020-06-01" }));
    expect(result.results.map((entry) => entry.source.source_version)).toEqual(["old"]);
  });

  it("excludes a future-effective source", () => {
    const future = activeSource({ effective_from: "2030-01-01", effective_period: {
      effective_from: "2030-01-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(retrieveLegalKnowledge([future], [syntheticChunk(future)], query()).results).toEqual([]);
  });

  it("excludes a superseded source from active-only retrieval", () => {
    const source = syntheticSource({ status: "superseded" });
    expect(retrieveLegalKnowledge([source], [syntheticChunk(source)], query()).results).toEqual([]);
  });

  it("excludes draft, rejected, and needs-review sources from active-only retrieval", () => {
    for (const status of ["draft", "rejected", "needs_review"] as const) {
      const source = syntheticSource({ status });
      expect(retrieveLegalKnowledge([source], [syntheticChunk(source)], query()).results).toEqual([]);
    }
  });

  it("prefers a sector-specific operative source and retains the general baseline", () => {
    const general = activeSource();
    const security = activeSource({
      source_id: "IL_SYNTHETIC_SECURITY_ORDER",
      sectors: ["security"],
      authority: { ...activeSource().authority, scope: "sector_specific" },
    });
    const result = retrieveLegalKnowledge(
      [general, security],
      [syntheticChunk(general), syntheticChunk(security)],
      query({ sector: "security" }),
    );
    expect(result.results.map((entry) => entry.source.source_id)).toEqual([security.source_id, general.source_id]);
  });

  it("returns the general baseline when the requested sector is missing", () => {
    const general = activeSource();
    const result = retrieveLegalKnowledge([general], [syntheticChunk(general)], query({ sector: "cleaning" }));
    expect(result.results[0].reasons).toContain("general_baseline");
  });

  it("does not hide overlapping active versions", () => {
    const first = activeSource({ source_version: "a" });
    const second = activeSource({ source_version: "b" });
    const result = retrieveLegalKnowledge([first, second], [syntheticChunk(first), syntheticChunk(second)], query());
    expect(result.conflicts).toContain(`overlapping_source_versions:${first.source_id}`);
  });

  it("marks a secondary-only inspection result as requiring review", () => {
    const secondary = syntheticSource({
      source_id: "IL_SYNTHETIC_SECONDARY",
      source_type: "secondary_reference",
      status: "verified",
      authority: {
        kind: "secondary_professional_source",
        issuing_body: "Synthetic publisher",
        binding_level: "secondary_explanatory",
        court_level: null,
        scope: "general",
        operative: false,
        explanatory: true,
        contains_numeric_rate: true,
        can_independently_support_monetary_rule: false,
      },
    });
    const result = retrieveLegalKnowledge([secondary], [syntheticChunk(secondary)], query({ activeOnly: false }));
    expect(result.results[0].requiresReview).toBe(true);
    expect(result.incomplete).toBe(true);
  });

  it("filters by source type, language, and minimum authority", () => {
    const source = activeSource();
    expect(retrieveLegalKnowledge([source], [syntheticChunk(source)], query({ sourceTypes: ["regulation"] })).results).toEqual([]);
    expect(retrieveLegalKnowledge([source], [syntheticChunk(source)], query({ language: "en" })).results).toEqual([]);
    expect(retrieveLegalKnowledge([source], [syntheticChunk(source)], query({ minimumBindingLevel: "primary_binding" })).results).toHaveLength(1);
  });
});
