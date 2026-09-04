import { describe, expect, it } from "vitest";
import { legalSourceSchema } from "../contracts.ts";
import { syntheticChunk, syntheticSource } from "../synthetic-fixtures.ts";
import { retrieveLegalKnowledgeForReview } from "../../../server/engine/legal-knowledge/review-retrieval.ts";
import { resolveTemporalSourceSet } from "../temporal-resolver.ts";
import { selectCanonicalInstrumentPages } from "./canonical-corpus.ts";
import { loadCanonicalRoleInventory, loadWorkingTimeCandidateGraph } from "../../../server/engine/legal-knowledge/wave21-canonical-corpus/canonical-inventory.ts";

const id = "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025";
function source() {
  return legalSourceSchema.parse({ ...syntheticSource({ source_id: id, source_version: "discovery-v0.3.1", status: "needs_review", topics: ["convalescence"] }), source_type: "statute" });
}

describe("canonical corpus boundary v0.4.1", () => {
  it("segments the exact instrument and trims both mixed boundary pages", () => {
    const pages = Array.from({ length: 40 }, (_, index) => ({ page: index + 1, text: `outside-page-${index + 1}` }));
    pages[15].text = "before-on-page-16\nChapter 7\ninstrument-start";
    pages[24].text = "instrument-end\nChapter 8\nafter-on-page-25";
    const selected = selectCanonicalInstrumentPages(source(), pages);
    expect(selected.pages).toHaveLength(10);
    expect(selected.pages[0]).toEqual({ page: 16, text: "Chapter 7\ninstrument-start" });
    expect(selected.pages[9]).toEqual({ page: 25, text: "instrument-end" });
    expect(selected.reason).toBe("gazette_3384_chapter_7_section_24");
  });

  it("makes pre-instrument, Chapter 8, and post-instrument text unreachable on the canonical search path", () => {
    const s = source();
    const chunk = (chunkId: string, page: number, text: string) => ({ ...syntheticChunk(s), chunk_id: chunkId, page_from: page, page_to: page, text });
    const result = retrieveLegalKnowledgeForReview([s], [
      chunk("before", 15, "DISTINCTIVE_PRE_INSTRUMENT"),
      chunk("instrument", 24, "DISTINCTIVE_INSTRUMENT"),
      chunk("mixed-after", 25, "Chapter 8 DISTINCTIVE_MIXED_PAGE_AFTER"),
      chunk("after", 26, "DISTINCTIVE_POST_INSTRUMENT"),
    ], { topic: "convalescence", targetDate: "2025-01-01", sector: "general", keywords: ["distinctive"], limit: 20 });
    expect(result.results.map((entry) => entry.chunk.chunk_id)).toEqual(["instrument"]);
  });

  it.each([
    ["IL_CONVALESCENCE_EXTENSION_ORDER_2023", "gazette amendment container"],
    ["IL_GENERAL_OVERTIME_PERMIT_2018", "permit attachment container"],
  ])("fails closed for %s until an instrument selector is reviewed (%s)", (sourceId) => {
    const result = selectCanonicalInstrumentPages({ source_id: sourceId }, [{ page: 1, text: "synthetic multi-instrument container" }]);
    expect(result).toMatchObject({ pages: [], reason: "instrument_selector_pending_human_review" });
  });

  it("keeps research, implementation and permit roles out of canonical operative resolution", () => {
    const inventory = loadCanonicalRoleInventory();
    // 17 pre-existing + Addendum 5/6 Pool D discovery: D-2, D-4, D-7, D-1b +
    // Addendum 7 A7-5: D-5's second half, D-16.
    expect(inventory.source_count).toBe(24);
    const byId = new Map(inventory.rows.map((row) => [row.source_version_id.split("@")[0], row]));
    expect(byId.get("IL_CONVALESCENCE_KNESSET_RESEARCH_2025")?.role).toBe("secondary_explanatory");
    expect(byId.get("IL_MIN_WAGE_OFFICIAL_RATES")?.role).toBe("official_implementation_or_corroboration");
    expect(byId.get("IL_GENERAL_OVERTIME_PERMIT_2018")?.role).toBe("role_pending_human_legal_review");
    // D-2 and D-1b are official-implementation corroboration only, same as
    // their respective HTML counterparts, never independently operative.
    expect(byId.get("IL_AVERAGE_WAGE_OFFICIAL_RATES")?.role).toBe("official_implementation_or_corroboration");
    expect(byId.get("IL_MIN_WAGE_OFFICIAL_RATES_HISTORY_XLSX")?.role).toBe("official_implementation_or_corroboration");
    // D-4 and D-7 are primary-binding operative instruments capable of
    // independently supporting a monetary rule (the law text and the
    // regulation text, respectively).
    expect(byId.get("IL_SEFER_HACHUKIM_3072_2023")?.role).toBe("binding_operative_instrument_version");
    expect(byId.get("IL_SEFER_HACHUKIM_3072_2023")?.eligible_to_independently_support_monetary_parameter).toBe(true);
    expect(byId.get("IL_MIN_WAGE_YOUTH_APPRENTICES_REGULATIONS_1987")?.role).toBe("binding_operative_instrument_version");
    expect(byId.get("IL_MIN_WAGE_YOUTH_APPRENTICES_REGULATIONS_1987")?.eligible_to_independently_support_monetary_parameter).toBe(true);
    expect([...byId.values()].filter((row) => !row.eligible_for_operative_resolution).every((row) => !row.eligible_to_independently_support_monetary_parameter)).toBe(true);
  });

  it("constructs the exact 20-publication unverified candidate graph", () => {
    const graph = loadWorkingTimeCandidateGraph();
    expect(graph.node_count).toBe(20);
    expect(new Set(graph.nodes.map((node) => node.node_id)).size).toBe(20);
    expect(graph.nodes.every((node) => /^[a-f0-9]{64}$/u.test(node.node_sha256) && node.official_artifact_sha256 === null && node.commencement_date === null)).toBe(true);
    expect(graph.edges).toHaveLength(19);
    expect(graph.edges.every((edge) => edge.verification_state === "unverified" && /^[a-f0-9]{64}$/u.test(edge.edge_evidence_sha256))).toBe(true);
    expect(graph.safeguards).toMatchObject({ current_text_asserted: false, automatic_consolidation_performed: false, commencement_inferred: false });
  });

  it("excludes a secondary-only source before it can become an operative temporal candidate", () => {
    const secondary = legalSourceSchema.parse({ ...syntheticSource({ source_id: "SYN_SECONDARY", topics: ["minimum_wage"] }), source_type: "secondary_reference", authority: { ...syntheticSource().authority, binding_level: "secondary_explanatory", operative: false, explanatory: true, can_independently_support_monetary_rule: false } });
    const result = resolveTemporalSourceSet({ sources: [secondary], topic: "minimum_wage", targetDate: "2025-01-01", sector: "general", activeOnly: false });
    expect(result.status).toBe("UNRESOLVED_MISSING_BASE_INSTRUMENT");
    expect(result.unverified_candidates).toEqual([]);
    expect(result.excluded_source_roles).toEqual([{ source_version_id: `${secondary.source_id}@${secondary.source_version}`, role: "secondary_explanatory" }]);
  });
});
