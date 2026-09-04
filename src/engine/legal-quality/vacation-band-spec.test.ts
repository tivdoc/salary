// L4-3, completed by L5-3. The vacation entitlement spec, checked against the
// values Pool P registered rather than against numbers written here.
//
// The parameters are supplied the way the run supplies them — 16, 18, 21
// calendar days, an increment of one day per year, a ceiling of 28 — and the
// test's job is that the bands select the right figure, that the rule from the
// eighth year computes the ones the law does not write down, that the ceiling
// holds, and that year zero refuses.
import { describe, expect, it } from "vitest";
import { executeRuleSpec, executeRuleSpecAtomic, type RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import { buildAllScenarioFixtures } from "./scenario-fixtures.ts";
import { SENSITIVITY_SPECS, VACATION_SENIORITY_BAND_SPEC } from "./sensitivity-rulespecs.ts";

const DAYS: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.days.years.1.to.5", value: { kind: "integer", value: 16, unit: "calendar_days" } },
  { ref_id: "parameter.days.year.6", value: { kind: "integer", value: 18, unit: "calendar_days" } },
  { ref_id: "parameter.days.year.7", value: { kind: "integer", value: 21, unit: "calendar_days" } },
  { ref_id: "parameter.increment.per.year", value: { kind: "integer", value: 1, unit: "calendar_days_per_year" } },
  { ref_id: "parameter.days.cap", value: { kind: "integer", value: 28, unit: "calendar_days" } },
];
const year = (value: number): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.seniority.year", value: { kind: "integer", value, unit: "count.years" } },
];

describe("vacation seniority bands and the rule from the eighth year", () => {
  it("selects the entitlement §3(א) states for years one to seven", () => {
    for (const [seniority, days] of [[1, 16], [3, 16], [5, 16], [6, 18], [7, 21]] as const) {
      const execution = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(seniority), parameters: DAYS });
      expect(execution.output, `year ${seniority}`).toEqual({ kind: "integer", value: days, unit: "calendar_days" });
    }
  });

  it("computes 21 + 1 × (years − 7) from the eighth year, and holds the ceiling of 28", () => {
    // BL-21. Years 8 to 14 climb one day at a time; year 15 would be 29 and the
    // ceiling holds; year 16 stays at the ceiling. None of 22–27 is written into
    // the spec: they are produced from three cited figures and a boundary.
    for (const [seniority, days] of [[8, 22], [9, 23], [10, 24], [11, 25], [12, 26], [13, 27], [14, 28], [15, 28], [16, 28], [40, 28]] as const) {
      const execution = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(seniority), parameters: DAYS });
      expect(execution.output, `year ${seniority}`).toEqual({ kind: "integer", value: days, unit: "calendar_days" });
    }
  });

  it("keeps the derived unit honest: calendar_days_per_year × count.years = calendar_days", () => {
    const execution = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(10), parameters: DAYS });
    const step = execution.trace.find((entry) => entry.step_id === "days.added");
    expect(step?.result).toEqual({ kind: "integer", value: 3, unit: "calendar_days" });
    expect(execution.trace.find((entry) => entry.step_id === "boundary.year.7")?.result).toEqual({ kind: "integer", value: 7, unit: "count.years" });
  });

  it("refuses before the first year rather than reaching for the nearest band", () => {
    for (const seniority of [0, -1]) {
      const outcome = executeRuleSpecAtomic({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(seniority), parameters: DAYS });
      expect(outcome.status, `year ${seniority}`).toBe("failed");
      expect(outcome.error_code).toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
    }
  });

  it("refuses fail-closed when any day count or the increment is not supplied", () => {
    for (const drop of [0, 3, 4]) {
      const outcome = executeRuleSpecAtomic({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(9), parameters: DAYS.filter((_entry, index) => index !== drop) });
      expect(outcome.status).toBe("failed");
      expect(outcome.error_code).toBe("RULESPEC_INPUT_MISSING");
    }
  });

  it("is deterministic and independent of parameter order", () => {
    const first = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(12), parameters: DAYS });
    const replay = executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: year(12), parameters: [...DAYS].reverse() });
    expect(replay.result_sha256).toBe(first.result_sha256);
  });

  it("says what it covers, in the spec entry rather than only in a comment", () => {
    const entry = SENSITIVITY_SPECS.find((candidate) => candidate.spec.topic === "vacation");
    expect(entry).toBeDefined();
    expect(entry!.narrower_than_draft).toContain("28");
    expect(entry!.decision_id).toBeNull();
    expect(entry!.spec.catalog_boundary).toBe("real_inactive");
    expect(entry!.bindings.map((binding) => binding.parameter_id)).toEqual([
      "il.vacation.calendar_days_years_1_to_5",
      "il.vacation.calendar_days_year_6",
      "il.vacation.calendar_days_year_7",
      "il.vacation.calendar_days_increment_per_year_from_year_8",
      "il.vacation.calendar_days_years_8_and_above_cap",
    ]);
  });

  it("takes a whole year from its fixtures, and its boundary scenarios sit at 8 and 15", () => {
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
    }
    const edge = fixtures.find((entry) => entry.scenario === "parameter_rounding_boundary")!;
    expect(executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: edge.inputs as never, parameters: DAYS }).output).toEqual({ kind: "integer", value: 28, unit: "calendar_days" });
    const rule = fixtures.find((entry) => entry.scenario === "effective_date_boundary")!;
    expect(executeRuleSpec({ rule: VACATION_SENIORITY_BAND_SPEC, facts: rule.inputs as never, parameters: DAYS }).output).toEqual({ kind: "integer", value: 22, unit: "calendar_days" });
  });
});
