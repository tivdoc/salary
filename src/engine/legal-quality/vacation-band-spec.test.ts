// L4-3. The vacation seniority-band spec, checked against the values Pool P
// actually registered rather than against numbers written here.
//
// The parameters are supplied the way the run supplies them — 16, 18, 21
// calendar days, the figures §3(א) states — and the test's job is that the
// bands select the right one, that the table's edge refuses, and that the spec
// says out loud what it does not cover.
import { describe, expect, it } from "vitest";
import { executeRuleSpec, executeRuleSpecAtomic, type RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import { buildAllScenarioFixtures } from "./scenario-fixtures.ts";
import { SENSITIVITY_SPECS, VACATION_SENIORITY_BAND_SPEC } from "./sensitivity-rulespecs.ts";

const DAYS: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.days.years.1.to.5", value: { kind: "integer", value: 16, unit: "calendar_days" } },
  { ref_id: "parameter.days.year.6", value: { kind: "integer", value: 18, unit: "calendar_days" } },
  { ref_id: "parameter.days.year.7", value: { kind: "integer", value: 21, unit: "calendar_days" } },
];
const year = (value: number): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.seniority.year", value: { kind: "integer", value, unit: "count.years" } },
];

describe("vacation seniority bands", () => {
  it("selects the entitlement §3(א) states for each year it covers", () => {
    for (const [seniority, days] of [[1, 16], [3, 16], [5, 16], [6, 18], [7, 21]] as const) {
      const execution = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(seniority), parameters: DAYS });
      expect(execution.output, `year ${seniority}`).toEqual({ kind: "integer", value: days, unit: "calendar_days" });
    }
  });

  it("refuses at the edge of the table rather than reaching for the nearest band", () => {
    // §3(א)(5)'s one-day-per-year increment to 28 is not in the table, because
    // the intermediate figures are not written anywhere in the law.
    for (const seniority of [0, 8, 20]) {
      const outcome = executeRuleSpecAtomic({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(seniority), parameters: DAYS });
      expect(outcome.status, `year ${seniority}`).toBe("failed");
      expect(outcome.error_code).toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
      expect(outcome.execution).toBeNull();
    }
  });

  it("refuses fail-closed when a band's day count is not supplied", () => {
    const outcome = executeRuleSpecAtomic({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(6), parameters: DAYS.slice(0, 1) });
    expect(outcome.status).toBe("failed");
    expect(outcome.error_code).toBe("RULESPEC_INPUT_MISSING");
  });

  it("says what it does not cover, in the spec entry rather than only in a comment", () => {
    const entry = SENSITIVITY_SPECS.find((candidate) => candidate.spec.topic === "vacation");
    expect(entry).toBeDefined();
    expect(entry!.narrower_than_draft).toContain("28");
    expect(entry!.decision_id).toBeNull();
    expect(entry!.spec.catalog_boundary).toBe("real_inactive");
    expect(entry!.bindings.map((binding) => binding.parameter_id)).toEqual([
      "il.vacation.calendar_days_years_1_to_5",
      "il.vacation.calendar_days_year_6",
      "il.vacation.calendar_days_year_7",
    ]);
  });

  it("takes a whole year from its fixtures, not a multiplier", () => {
    const fixtures = buildAllScenarioFixtures().filter((entry) => entry.topic === "vacation");
    expect(fixtures).toHaveLength(6);
    for (const fixture of fixtures) {
      if (fixture.scenario === "missing_conflicted_facts") {
        expect(fixture.inputs).toEqual([]);
        expect(fixture.omitted_refs).toEqual(["fact.seniority.year"]);
        continue;
      }
      expect(fixture.inputs).toHaveLength(1);
      expect(fixture.inputs[0].ref_id).toBe("fact.seniority.year");
      expect(fixture.inputs[0].value.kind).toBe("integer");
    }
    // The rounding-boundary scenario has no rounding to do here; it carries the
    // edge of the table instead, and must be the one that refuses.
    const edge = fixtures.find((entry) => entry.scenario === "parameter_rounding_boundary")!;
    expect(executeRuleSpecAtomic({ rule: VACATION_SENIORITY_BAND_SPEC, facts: edge.inputs as never, parameters: DAYS }).error_code)
      .toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
  });
});
