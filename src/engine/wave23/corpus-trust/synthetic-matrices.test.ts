import { describe, expect, it } from "vitest";
import { multiInstrumentMatrix } from "./multi-instrument.ts";
import { syntheticTemporalMatrix } from "./synthetic-temporal-matrix.ts";

describe("legally neutral synthetic coverage", () => {
  it("covers temporal, sector, population, amendment and knowledge-time boundaries", () => {
    const matrix = syntheticTemporalMatrix();
    expect(matrix.passed).toBe(true);
    expect(matrix.totals).toEqual({ case_count: 17, passed_count: 17 });
    expect(new Set(matrix.cases.map((entry) => entry.case_id)).size).toBe(17);
  });

  it("selects exactly one instrument without leakage and quarantines ambiguity", () => {
    const matrix = multiInstrumentMatrix();
    expect(matrix.passed).toBe(true);
    expect(matrix.totals).toEqual({ case_count: 5, passed_count: 5, positive_complete_chunk_count: 3, neighbor_leakage_count: 0 });
    expect(matrix.cases[4].actual).toMatchObject({ technical_parse_status: "parsed", permit_identity_authority_status: "needs_human_review", status: "QUARANTINED" });
  });
});
