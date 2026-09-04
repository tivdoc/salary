// L6-3 / L6-4. The §16(א) tiers over a day's overtime hours, and the two
// readings of overtime on the weekly rest. Values are the registered draft
// parameters' (5/4, 3/2, 3/2) as executor inputs; nothing here reads a source.
import { describe, expect, it } from "vitest";
import { executeRuleSpecAtomic } from "../legal-operations/rulespec.ts";
import {
  REST_DAY_OVERTIME_ADDITIVE_SPEC,
  REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC,
  SENSITIVITY_SPECS,
  WORKING_TIME_OVERTIME_SPEC,
} from "./sensitivity-rulespecs.ts";

const ratio = (numerator: string, denominator: string) => ({ kind: "rational" as const, numerator, denominator, unit: "ratio" });
const wage = (minorUnits: number) => ({ kind: "money" as const, currency: "ILS", minor_units: minorUnits });
const hours = (value: number) => ({ kind: "integer" as const, value, unit: "hours" });

const PARAMETERS = [
  { ref_id: "parameter.rate.first", value: ratio("5", "4") },
  { ref_id: "parameter.rate.second", value: ratio("3", "2") },
  { ref_id: "parameter.rate.rest", value: ratio("3", "2") },
];

function money(result: ReturnType<typeof executeRuleSpecAtomic>): string {
  if (result.error_code !== null) throw new Error(result.error_code);
  const output = result.execution?.output as { kind: string; minor_units: bigint | number } | undefined;
  expect(output?.kind).toBe("money");
  return String(output?.minor_units);
}

describe("working time: overtime pay by the §16(א) tiers", () => {
  it("prices the first two hours at the first tier and the rest at the second", () => {
    const run = (overtime: number, wageMinor: number) => money(executeRuleSpecAtomic({
      rule: WORKING_TIME_OVERTIME_SPEC,
      facts: [{ ref_id: "fact.overtime.hours.day", value: hours(overtime) }, { ref_id: "fact.regular.hourly.wage", value: wage(wageMinor) }],
      parameters: PARAMETERS.slice(0, 2),
    } as never));
    // 30.00 an hour: 2 × 37.50 + 2 × 45.00 = 165.00
    expect(run(4, 3_000)).toBe("16500");
    expect(run(2, 3_000)).toBe("7500");
    expect(run(1, 3_000)).toBe("3750");
    expect(run(0, 3_000)).toBe("0");
    // 33.33 × 1¼ = 41.6625 → 41.66 half-up on the cumulative sum
    expect(run(1, 3_333)).toBe("4166");
  });

  it("refuses without the wage or without the hours, by name", () => {
    const missing = executeRuleSpecAtomic({ rule: WORKING_TIME_OVERTIME_SPEC, facts: [{ ref_id: "fact.overtime.hours.day", value: hours(2) }], parameters: PARAMETERS.slice(0, 2) } as never);
    expect(missing.error_code).toBe("RULESPEC_INPUT_MISSING");
  });
});

describe("overtime on the weekly rest: one decision, two computations (D2)", () => {
  const run = (spec: typeof REST_DAY_OVERTIME_ADDITIVE_SPEC, restOvertime: number, wageMinor: number) => money(executeRuleSpecAtomic({
    rule: spec,
    facts: [{ ref_id: "fact.rest.day.overtime.hours.day", value: hours(restOvertime) }, { ref_id: "fact.regular.hourly.wage", value: wage(wageMinor) }],
    parameters: PARAMETERS,
  } as never));

  it("additive: 1½ + ¼ = 1¾ for the first two hours, 1½ + ½ = 2 after them", () => {
    // 30.00: 2 × 52.50 + 1 × 60.00 = 165.00
    expect(run(REST_DAY_OVERTIME_ADDITIVE_SPEC, 3, 3_000)).toBe("16500");
    expect(run(REST_DAY_OVERTIME_ADDITIVE_SPEC, 1, 3_000)).toBe("5250");
  });

  it("multiplicative: 1½ × 1¼ = 1⅞ for the first two hours, 1½ × 1½ = 2¼ after them", () => {
    // 30.00: 2 × 56.25 + 1 × 67.50 = 180.00
    expect(run(REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC, 3, 3_000)).toBe("18000");
    expect(run(REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC, 1, 3_000)).toBe("5625");
  });

  it("no figure 175 or 200 is authored: the branches derive their rates from the three parameters", () => {
    for (const spec of [REST_DAY_OVERTIME_ADDITIVE_SPEC, REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC]) {
      const constants = spec.nodes.filter((node) => node.operation === "constant.rational" || node.operation === "constant.integer");
      expect(constants.map((node) => (node as { value: string | number }).value)).toEqual(spec === REST_DAY_OVERTIME_ADDITIVE_SPEC ? ["1"] : []);
      expect(JSON.stringify(spec)).not.toMatch(/175|200|1\.75|\b7\/4\b|\b9\/4\b|15\/8/u);
    }
    const entries = SENSITIVITY_SPECS.filter((entry) => entry.composition_branch !== undefined);
    expect(entries.map((entry) => [entry.decision_id, entry.composition_branch])).toEqual([
      ["legal.reference.il.decision.rest_day_overtime_composition", "additive"],
      ["legal.reference.il.decision.rest_day_overtime_composition", "multiplicative"],
    ]);
  });
});
