import { describe, expect, it } from "vitest";
import { CORPUS_LIFECYCLE, corpusLifecycleReconciliation } from "./lifecycle.ts";
import { reconcileStableTransitions, type HistoricalChunkTransition } from "./transitions.ts";

describe("orthogonal corpus lifecycle V0.5.0", () => {
  it("reconciles all 17 sources and the L5 arithmetic: 274 extracted, 194 resolved through selections", () => {
    const report = corpusLifecycleReconciliation();
    expect(report.passed).toBe(true);
    expect(report.totals).toMatchObject({ source_count: 17, technical_parsed_sources: 16, technical_failed_sources: 1, parsed_but_instrument_quarantined_sources: 0, extracted_chunks: 274, instrument_resolved_chunks: 194, quarantined_chunk_cardinality: 80, retrievable_review_chunks: 194, canonical_binding_candidate_chunks: 78, explanatory_or_corroborative_chunks: 116, reviewed_sources: 0, active_sources: 0, operative_sources: 0 });
    expect(CORPUS_LIFECYCLE.every((entry) => entry.operative === false && entry.human_review_status === "needs_review" && entry.activation_status === "inactive")).toBe(true);
    expect(CORPUS_LIFECYCLE.find((entry) => entry.source_version_id.includes("OVERTIME_PERMIT"))?.technical_parse_status).toBe("parsed");
    expect(CORPUS_LIFECYCLE.find((entry) => entry.source_version_id.includes("CONVALESCENCE_EXTENSION_ORDER_2023"))?.technical_parse_status).toBe("parsed");
    expect(CORPUS_LIFECYCLE.find((entry) => entry.source_version_id.includes("PENSION_INCREASE"))?.technical_parse_status).toBe("failed");
  });

  it("preserves and validates every stable transition ID", () => {
    const fixture: HistoricalChunkTransition[] = Array.from({ length: 72 }, (_, index) => ({
      delta_id: `CHUNK_TRANSITION_${String(index + 1).padStart(3, "0")}`,
      source_transition: index < 54 ? "convalescence_2025" : index < 66 ? "overtime_permit_2018" : "convalescence_order_2023",
      reason: index === 53 ? "boundary_three_to_two_cardinality_delta" : "historical_reason",
      before_chunk_ids: [`SYNTHETIC_CHUNK_${String(index + 1).padStart(3, "0")}`],
      after_chunk_ids: [],
      cardinality_delta: -1,
    }));
    const ledger = reconcileStableTransitions(fixture);
    expect(ledger.totals).toEqual({ record_count: 72, cardinality_delta: -72, corrected_reason_count: 4 });
    expect(() => reconcileStableTransitions(fixture.slice(1))).toThrow("stable_transition_id_mismatch");
  });
});
