import { describe, expect, it } from "vitest";
import { inspectEffectivePeriods, isEffectiveOn, resolveSourceVersion, temporalSourceState } from "./effective-period.ts";
import { syntheticSource } from "./synthetic-fixtures.ts";

describe("effective-date resolution", () => {
  const v1 = syntheticSource({ source_version: "v1", effective_from: "2020-01-01", effective_to: "2020-12-31", effective_period: {
    effective_from: "2020-01-01", effective_to: "2020-12-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
  } });
  const v2 = syntheticSource({ source_version: "v2", effective_from: "2021-01-01", effective_to: null, effective_period: {
    effective_from: "2021-01-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
  } });

  it("includes both effective boundaries", () => {
    expect(isEffectiveOn(v1, "2020-01-01")).toBe(true);
    expect(isEffectiveOn(v1, "2020-12-31")).toBe(true);
  });

  it("excludes dates outside the period", () => {
    expect(isEffectiveOn(v1, "2019-12-31")).toBe(false);
    expect(isEffectiveOn(v1, "2021-01-01")).toBe(false);
  });

  it("resolves a historical version", () => {
    expect(resolveSourceVersion([v1, v2], v1.source_id, "2020-06-01")).toMatchObject({ status: "resolved", source: { source_version: "v1" } });
  });

  it("resolves the current open-ended version", () => {
    expect(resolveSourceVersion([v1, v2], v1.source_id, "2026-08-29")).toMatchObject({ status: "resolved", source: { source_version: "v2" } });
  });

  it("reports a gap", () => {
    expect(resolveSourceVersion([v1], v1.source_id, "2021-01-01").status).toBe("gap");
  });

  it("reports overlapping versions as ambiguous", () => {
    const overlap = syntheticSource({ source_version: "overlap", effective_from: "2020-06-01", effective_to: "2021-06-01", effective_period: {
      effective_from: "2020-06-01", effective_to: "2021-06-01", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(resolveSourceVersion([v1, overlap], v1.source_id, "2020-07-01").status).toBe("ambiguous_overlap");
    expect(inspectEffectivePeriods([v1, overlap], v1.source_id).overlaps).toEqual([["v1", "overlap"]]);
  });

  it("detects a genuine date gap", () => {
    const late = syntheticSource({ source_version: "late", effective_from: "2021-02-01", effective_to: null, effective_period: {
      effective_from: "2021-02-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(inspectEffectivePeriods([v1, late], v1.source_id).gaps).toEqual([{ after: "v1", before: "late" }]);
  });

  it("does not report a false gap when a longer version spans nested versions", () => {
    const outer = syntheticSource({ source_version: "outer", effective_from: "2020-01-01", effective_to: "2025-12-31", effective_period: {
      effective_from: "2020-01-01", effective_to: "2025-12-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    const inner = syntheticSource({ source_version: "inner", effective_from: "2021-01-01", effective_to: "2021-12-31", effective_period: {
      effective_from: "2021-01-01", effective_to: "2021-12-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    const later = syntheticSource({ source_version: "later", effective_from: "2022-01-01", effective_to: null, effective_period: {
      effective_from: "2022-01-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    const inspection = inspectEffectivePeriods([outer, inner, later], outer.source_id);
    expect(inspection.overlaps).toEqual([["outer", "inner"], ["outer", "later"]]);
    expect(inspection.gaps).toEqual([]);
  });

  it("marks future, expired, superseded, and unresolved states", () => {
    expect(temporalSourceState(v2, "2020-01-01")).toBe("future_effective");
    expect(temporalSourceState(v1, "2021-01-01")).toBe("expired");
    expect(temporalSourceState({ ...v2, status: "superseded" }, "2026-01-01")).toBe("superseded");
    expect(temporalSourceState(syntheticSource({ effective_from: null, effective_period: {
      effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "explanatory_as_of",
    } }), "2026-01-01")).toBe("effective_date_unresolved");
  });
});
