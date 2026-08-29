import { describe, expect, it } from "vitest";
import type { LegalSource } from "./contracts.ts";
import { syntheticSource } from "./synthetic-fixtures.ts";
import { resolveTemporalSourceSet } from "./temporal-resolver.ts";

function source(overrides: Partial<LegalSource> = {}) {
  return syntheticSource({ status: "needs_review", ...overrides });
}

function query(sources: LegalSource[], overrides: Partial<Parameters<typeof resolveTemporalSourceSet>[0]> = {}) {
  return resolveTemporalSourceSet({ sources, topic: "minimum_wage", targetDate: "2020-01-01", sector: "general", activeOnly: false, ...overrides });
}

describe("version-level fail-closed temporal resolver", () => {
  it("honors the day before, first day, final day, and day after boundaries", () => {
    const bounded = source({ effective_from: "2020-01-01", effective_to: "2020-12-31", effective_period: {
      effective_from: "2020-01-01", effective_to: "2020-12-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(query([bounded], { targetDate: "2019-12-31" }).status).toBe("UNRESOLVED");
    expect(query([bounded], { targetDate: "2020-01-01" }).status).toBe("RESOLVED_CANDIDATE");
    expect(query([bounded], { targetDate: "2020-12-31" }).status).toBe("RESOLVED_CANDIDATE");
    expect(query([bounded], { targetDate: "2021-01-01" }).status).toBe("UNRESOLVED");
  });

  it("does not select a future-published or future-effective version", () => {
    const future = source({ published_at: "2020-06-01", effective_from: "2020-07-01", effective_period: {
      effective_from: "2020-07-01", effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(query([future], { targetDate: "2020-06-15" }).status).toBe("UNRESOLVED");
  });

  it("returns conflict for overlapping versions instead of manifest-order selection", () => {
    const first = source({ source_version: "a" });
    const second = source({ source_version: "b" });
    const result = query([second, first]);
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts).toContain(`overlapping_source_versions:${first.source_id}`);
  });

  it("requires an explicit sector and never guesses unknown", () => {
    expect(query([source()], { sector: null }).reasons).toContain("sector_required");
    expect(query([source()], { sector: "unknown" }).reasons).toContain("sector_required");
  });

  it("does not apply a sector source to another sector", () => {
    const security = source({
      source_id: "IL_SECURITY_ORDER",
      sectors: ["security"],
      authority: { ...source().authority, scope: "sector_specific" },
    });
    expect(query([security], { sector: "cleaning" }).reasons).toContain("sector_not_covered");
  });

  it("retains general and sector sources without letting specificity erase authority", () => {
    const general = source();
    const guidance = source({
      source_id: "IL_SECURITY_GUIDANCE",
      source_type: "official_guidance",
      sectors: ["security"],
      authority: {
        ...source().authority,
        scope: "sector_specific",
        binding_level: "official_guidance",
        operative: false,
        explanatory: true,
        can_independently_support_monetary_rule: false,
      },
    });
    const result = query([guidance, general], { sector: "security" });
    expect(result.status).toBe("RESOLVED_CANDIDATE");
    expect(result.source_set.map((member) => member.source_id)).toEqual([general.source_id, guidance.source_id]);
    expect(result.source_set[1].selection_rationale).toContain("explanatory_source_only");
  });

  it("returns conflict for undocumented overlap between two sector sources", () => {
    const first = source({ source_id: "IL_SECURITY_ORDER_A", sectors: ["security"], authority: { ...source().authority, scope: "sector_specific" } });
    const second = source({ source_id: "IL_SECURITY_ORDER_B", sectors: ["security"], authority: { ...source().authority, scope: "sector_specific" } });
    const result = query([second, first], { sector: "security" });
    expect(result.status).toBe("CONFLICT");
    expect(result.conflicts.some((conflict) => conflict.startsWith("undocumented_sector_overlap:"))).toBe(true);
  });

  it("does not let guidance or a secondary source close an operative gap alone", () => {
    const guidance = source({
      source_id: "IL_GUIDANCE_ONLY",
      source_type: "official_guidance",
      authority: { ...source().authority, binding_level: "official_guidance", operative: false, explanatory: true, can_independently_support_monetary_rule: false },
    });
    const result = query([guidance]);
    expect(result.status).toBe("UNRESOLVED");
    expect(result.reasons).toContain("guidance_or_secondary_cannot_close_gap");
  });

  it("active-only retrieval never falls back to needs-review", () => {
    const result = query([source()], { activeOnly: true });
    expect(result.status).toBe("UNRESOLVED");
    expect(result.source_set).toEqual([]);
    expect(result.reasons).toContain("no_needs_review_fallback");
  });

  it("marks a query outside V0.1 engineering coverage unsupported", () => {
    expect(query([source()], { targetDate: "2018-12-31" }).status).toBe("UNSUPPORTED");
  });

  it("does not keep a temporary order after expiry", () => {
    const temporary = source({ effective_to: "2020-01-31", effective_period: {
      effective_from: "2020-01-01", effective_to: "2020-01-31", retroactive: false, retroactive_basis: null, applicability_basis: "work_date",
    } });
    expect(query([temporary], { targetDate: "2020-02-01" }).status).toBe("UNRESOLVED");
  });
});
