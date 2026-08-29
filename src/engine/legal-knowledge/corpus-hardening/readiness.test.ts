import { describe, expect, it } from "vitest";
import { legalSourceSchema } from "../contracts.ts";
import { WAVE2_REAL_CORPUS_TOPICS, evaluateStrictRealCorpusReadiness } from "./readiness.ts";

function source(topic: typeof WAVE2_REAL_CORPUS_TOPICS[number]) {
  return legalSourceSchema.parse({
    source_id: `SYN_${topic.toUpperCase()}`,
    source_version: "fixture-v1",
    source_type: "statute",
    authority: { kind: "israeli_legislature", issuing_body: "Synthetic authority", binding_level: "primary_binding", court_level: null, scope: "general", operative: true, explanatory: false, contains_numeric_rate: false, can_independently_support_monetary_rule: true },
    jurisdiction: "IL",
    title: "Synthetic readiness source",
    canonical_url: `https://example.gov.il/${topic}`,
    publication_reference: null,
    published_at: null,
    effective_from: null,
    effective_to: null,
    retrieved_at: null,
    language: "he",
    topics: [topic],
    sectors: ["general"],
    status: "needs_review",
    content_sha256: null,
    artifact_format: "pdf",
    supersedes_source_version: null,
    notes: [],
    verification: { status: "unverified", method: "synthetic", verified_by: [], verified_at: null, notes: [] },
    effective_period: { effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "requires_historical_version_review" },
    discovery: { method: "official_registry", found_at: "2026-08-30", included_reason: "Synthetic readiness test." },
  });
}

describe("strict real-corpus topic readiness", () => {
  it("reports all seven topics non-ready with explicit eight-gate diagnostics", () => {
    const sources = WAVE2_REAL_CORPUS_TOPICS.map(source);
    const readiness = evaluateStrictRealCorpusReadiness({ sources, buildRecords: [], citationRecords: [] });
    expect(readiness).toMatchObject({ status: "LEGAL_SOURCE_CORPUS_INCOMPLETE", strict_gate_passed: false, strict_exit_code: 2, topic_count: 7, ready_topic_count: 0 });
    for (const report of readiness.reports) {
      expect(report.status).toBe("not_ready");
      expect(Object.keys(report.gates).sort()).toEqual(["activation", "citation", "effective_interval", "parse", "population", "review", "sector", "source_role"]);
      expect(report.missing_gates).toEqual(["activation", "citation", "effective_interval", "parse", "population", "review", "sector"]);
    }
  });
});
