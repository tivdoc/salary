import { describe, expect, it } from "vitest";
import {
  classifyConvalescencePayment,
  HAVRAA_RATE_TABLE,
  havraaBranchGuard,
  havraaRateFor,
  havraaYearOf,
  havraaYearPaidFor,
  RATE_NOT_PUBLISHED,
  retroactiveTag,
} from "./convalescence-rate-table.ts";
import { REGISTERED_DRAFT_PARAMETERS } from "./rulespec-drafts.ts";
import { SENSITIVITY_SPECS } from "./sensitivity-rulespecs.ts";

describe("L11-4 / D3.4: the convalescence rate is bitemporal — a convalescence year, and the day it became known", () => {
  it("carries the 2026 row: 451.50 valid 1.7.2025–30.6.2026, known 18.8.2026, retroactive, bound to the havraa_year branch's version", () => {
    expect(HAVRAA_RATE_TABLE).toEqual([expect.objectContaining({
      havraa_year: 2026, rate_minor_units: 45_150, valid_from: "2025-07-01", valid_to: "2026-06-30", known_at: "2026-08-18", retroactive: true,
      parameter_version_id: "il.convalescence.daily_rate@2026.3.0",
    })]);
    const registration = REGISTERED_DRAFT_PARAMETERS.find((entry) => entry.parameter_id === "il.convalescence.daily_rate")!;
    expect(registration.versions).toContain("2026.3.0");
    expect(registration.branches).toContainEqual(["havraa_year", "2026.3.0"]);
    const spec = SENSITIVITY_SPECS.find((entry) => entry.decision_id?.endsWith("convalescence_2026_rate_period"))!;
    expect(spec.branches).toContainEqual(["havraa_year", "2026.3.0"]);
    expect(spec.unbound_branches ?? []).toEqual([]);
  });

  it("names a convalescence year for the year it ends in", () => {
    expect(havraaYearOf("2025-07-01")).toBe(2026);
    expect(havraaYearOf("2026-06-30")).toBe(2026);
    expect(havraaYearOf("2026-07-01")).toBe(2027);
    expect(havraaYearPaidFor("2026-06-01")).toBe(2026);
    expect(havraaYearPaidFor("2027-01-01")).toBe(2027);
  });

  it("any period from 1.7.2026 has no rate: unknown, refused rate_not_published — never 418 or 451.50 by default", () => {
    const lookup = havraaRateFor(havraaYearOf("2026-07-01"));
    expect(lookup).toMatchObject({ status: "unknown", havraa_year: 2027, refusal: RATE_NOT_PUBLISHED });
    expect(havraaBranchGuard({ branch: "havraa_year", period: { start: "2027-01-01", end: "2027-01-31" } })).toBe(RATE_NOT_PUBLISHED);
    expect(havraaBranchGuard({ branch: "havraa_year", period: { start: "2026-06-01", end: "2026-06-30" } })).toBeNull();
    expect(havraaBranchGuard({ branch: "calendar_year_2026", period: { start: "2027-01-01", end: "2027-01-31" } })).toBeNull();
    expect(classifyConvalescencePayment({ paid_per_day_minor_units: 41_800, payment_period_start: "2027-02-01" })).toMatchObject({ status: "refused", refusal: RATE_NOT_PUBLISHED });
  });

  it("a payslip of June, July or August 2026 that paid 418 a day is 33.50 a day short, tagged as the retroactive update of 18.8.2026", () => {
    for (const month of ["2026-06-01", "2026-07-01", "2026-08-01"]) {
      expect(classifyConvalescencePayment({ paid_per_day_minor_units: 41_800, payment_period_start: month })).toEqual({
        status: "computed", havraa_year: 2026, rate_minor_units: 45_150, paid_per_day_minor_units: 41_800,
        delta_per_day_minor_units: 3_350, tag: "retroactive_update_2026-08-18", parameter_version_id: "il.convalescence.daily_rate@2026.3.0",
      });
    }
    // Paid after the publication at the old rate: an ordinary shortfall, no retroactive tag.
    expect(classifyConvalescencePayment({ paid_per_day_minor_units: 41_800, payment_period_start: "2026-09-01" })).toMatchObject({ delta_per_day_minor_units: 3_350, tag: null });
    expect(retroactiveTag("2026-08-18", HAVRAA_RATE_TABLE[0])).toBeNull();
    expect(retroactiveTag("2026-08-17", HAVRAA_RATE_TABLE[0])).toBe("retroactive_update_2026-08-18");
  });

  it("years before the table's first row are outside it, named as such, not read as 418", () => {
    expect(havraaRateFor(2025)).toMatchObject({ status: "outside_table", refusal: "rate_not_in_table" });
  });
});
