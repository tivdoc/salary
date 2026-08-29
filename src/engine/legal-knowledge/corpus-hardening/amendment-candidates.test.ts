import { describe, expect, it } from "vitest";
import { buildUnverifiedAmendmentCandidateGraph } from "./amendment-candidates.ts";

const base = {
  amendment_number: null,
  catalog_directness: null,
  publication_series: "Synthetic Gazette",
  publication_issue: "1",
  publication_page: "1",
  official_detail_url: "https://example.gov.il/detail",
  official_artifact_url: "https://example.gov.il/artifact.pdf",
  discovery_evidence: "synthetic_catalog_row",
};

describe("unverified amendment candidate graph", () => {
  it("maps every publication once without creating consolidated text or effectivity", () => {
    const graph = buildUnverifiedAmendmentCandidateGraph([
      { ...base, publication_ordinal: 1, publication_identity: "SYN:AMENDMENT:1", publication_kind: "direct_amendment_publication", title: "Synthetic amendment", publication_date: "2020-01-01" },
      { ...base, publication_ordinal: 2, publication_identity: "SYN:ORIGINAL", publication_kind: "original_promulgation", title: "Synthetic original", publication_date: "2010-01-01" },
      { ...base, publication_ordinal: 3, publication_identity: "SYN:CORRECTION", publication_kind: "error_correction_publication", title: "Synthetic correction", publication_date: "2010-02-01" },
    ]);
    expect(graph).toMatchObject({ node_count: 3, edge_count: 2, original_publication_identity: "SYN:ORIGINAL" });
    expect(graph.safeguards).toEqual({ current_text_asserted: false, automatic_consolidation_performed: false, commencement_inferred: false, applicability_determined: false, every_inventory_entry_mapped_once: true });
    expect(graph.edges.map((edge) => edge.candidate_relation)).toEqual(["amends", "corrects"]);
    expect(graph.edges.every((edge) => edge.verification_state === "unverified" && edge.commencement_date === null)).toBe(true);
  });
});
