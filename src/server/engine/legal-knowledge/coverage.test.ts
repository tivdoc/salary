import { describe, expect, it } from "vitest";
import { legalCoverageMatrixSchema, loadLegalCoverageMatrix } from "./coverage.ts";

describe("V0.1 declared temporal coverage", () => {
  it("covers all seven required topics without claiming legal limitation or entitlement", async () => {
    const matrix = await loadLegalCoverageMatrix();
    expect(matrix.coverage_window).toMatchObject({ from: "2019-01-01", to: "2026-08-29", timezone: "Asia/Jerusalem" });
    expect(matrix.coverage_window.legal_limitation_or_entitlement_statement).toBe(false);
    expect(new Set(matrix.rows.map((row) => row.topic))).toEqual(new Set([
      "minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave",
    ]));
    expect(matrix.rows.some((row) => row.coverage_status === "gap" || row.coverage_status === "blocked")).toBe(true);
  });

  it("is strict at every object boundary", async () => {
    const matrix = await loadLegalCoverageMatrix();
    expect(() => legalCoverageMatrixSchema.parse({ ...matrix, unknown: true })).toThrow();
    expect(() => legalCoverageMatrixSchema.parse({
      ...matrix,
      rows: [{ ...matrix.rows[0], unknown: true }, ...matrix.rows.slice(1)],
    })).toThrow();
  });
});
