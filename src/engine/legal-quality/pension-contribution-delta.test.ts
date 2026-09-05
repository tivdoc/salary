import { describe, expect, it } from "vitest";
import { contributionDelta } from "./pension-contribution-delta.ts";

// The 2016 order's rates from 1.1.2017: 6% employee, 6.5% employer, 6% severance.
const RATES_2017 = [
  { share: "employee", rate: { numerator: "6", denominator: "100" } },
  { share: "employer", rate: { numerator: "13", denominator: "200" } },
  { share: "severance", rate: { numerator: "6", denominator: "100" } },
];

describe("L11-5 / D3.7: a cap difference becomes a contribution difference at the rates, shown apart from the base", () => {
  it("203.00 of cap at 18.5% is 37.56 of contributions, not 203", () => {
    const result = contributionDelta({ base_delta_minor_units: "20300", shares: RATES_2017 });
    expect(result.rate_sum).toEqual({ numerator: "37", denominator: "200" });
    expect(result.contribution_delta_minor_units).toBe("3756");
    expect(result.base_delta_minor_units).toBe("20300");
    expect(result.components.map((entry) => [entry.share, entry.delta_minor_units])).toEqual([["employee", "1218"], ["employer", "1320"], ["severance", "1218"]]);
  });

  it("rounds half-up once at the end, exactly, and keeps the sign", () => {
    expect(contributionDelta({ base_delta_minor_units: "1", shares: RATES_2017 }).contribution_delta_minor_units).toBe("0");
    expect(contributionDelta({ base_delta_minor_units: "3", shares: RATES_2017 }).contribution_delta_minor_units).toBe("1");
    expect(contributionDelta({ base_delta_minor_units: "-20300", shares: RATES_2017 }).contribution_delta_minor_units).toBe("-3756");
  });

  it("knows no percentage of its own: the rates are inputs and a missing rate is a refusal", () => {
    expect(() => contributionDelta({ base_delta_minor_units: "20300", shares: [] })).toThrow("CONTRIBUTION_DELTA_NO_SHARES");
    expect(() => contributionDelta({ base_delta_minor_units: "20300", shares: [{ share: "employee", rate: { numerator: "6", denominator: "0" } }] })).toThrow(/CONTRIBUTION_DELTA_RATE_INVALID/u);
    expect(() => contributionDelta({ base_delta_minor_units: "203.00", shares: RATES_2017 })).toThrow("CONTRIBUTION_DELTA_BASE_INVALID");
  });
});
