// L6-6 / D4 (P-29). The 1988 order's seniority bands, looked up by a whole
// year of service. Values are the registered draft parameters' as executor
// inputs; nothing here reads a source.
import { describe, expect, it } from "vitest";
import { executeRuleSpecAtomic } from "../legal-operations/rulespec.ts";
import { CONVALESCENCE_DAYS_SPEC } from "./sensitivity-rulespecs.ts";

const days = (value: number) => ({ kind: "integer" as const, value, unit: "days" });
const PARAMETERS = [
  { ref_id: "parameter.days.year.1", value: days(5) },
  { ref_id: "parameter.days.years.2.to.3", value: days(6) },
  { ref_id: "parameter.days.years.4.to.10", value: days(7) },
  { ref_id: "parameter.days.years.11.to.15", value: days(8) },
  { ref_id: "parameter.days.years.16.to.19", value: days(9) },
  { ref_id: "parameter.days.years.20.and.above", value: days(10) },
];

function run(years: number) {
  return executeRuleSpecAtomic({
    rule: CONVALESCENCE_DAYS_SPEC,
    facts: [{ ref_id: "fact.years.employed", value: { kind: "integer", value: years, unit: "count.years" } }],
    parameters: PARAMETERS,
  } as never);
}

describe("convalescence days by seniority (1988 order §4(א))", () => {
  it("looks up the band the completed years fall in", () => {
    const expected: Array<[number, number]> = [[1, 5], [2, 6], [3, 6], [4, 7], [10, 7], [11, 8], [15, 8], [16, 9], [19, 9], [20, 10], [35, 10]];
    for (const [years, expectedDays] of expected) {
      const result = run(years);
      expect(result.error_code, `years ${years}`).toBeNull();
      expect((result.execution?.output as { value: bigint | number }).value.toString(), `years ${years}`).toBe(String(expectedDays));
    }
  });

  it("refuses year 0 at the table's edge rather than inventing a row", () => {
    expect(run(0).error_code).toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
  });
});
