// L5-2 / L5-4. The two sick-pay specs, checked against the values Pool P holds.
import { describe, expect, it } from "vitest";
import { executeRuleSpec, executeRuleSpecAtomic, type RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import { buildAllScenarioFixtures } from "./scenario-fixtures.ts";
import { SENSITIVITY_SPECS, SICK_PAY_ACCRUAL_SPEC, SICK_PAY_DAILY_RATE_SPEC } from "./sensitivity-rulespecs.ts";

const ACCRUAL: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.accrual.per.month", value: { kind: "rational", numerator: "3", denominator: "2", unit: "days_per_month" } },
  { ref_id: "parameter.accrual.cap", value: { kind: "integer", value: 90, unit: "days" } },
];
const RATE: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.rate.days.2.to.3", value: { kind: "rational", numerator: "1", denominator: "2", unit: "ratio" } },
  { ref_id: "parameter.daily.wage", value: { kind: "money", currency: "ILS", minor_units: 29740 } },
];
const months = (numerator: string, denominator = "1"): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.months.employed", value: { kind: "rational", numerator, denominator, unit: "months" } },
];
const day = (index: number): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.absence.day.index", value: { kind: "integer", value: index, unit: "days" } },
];

describe("sick-pay accrual, §4(א)", () => {
  it("accrues a day and a half per month and holds the ceiling of ninety", () => {
    for (const [count, numerator, denominator] of [["12", "18", "1"], ["6", "9", "1"], ["60", "90", "1"], ["80", "90", "1"], ["100/7", "150", "7"]] as const) {
      const [n, d] = count.includes("/") ? count.split("/") : [count, "1"];
      const execution = executeRuleSpec({ rule: SICK_PAY_ACCRUAL_SPEC, facts: months(n, d), parameters: ACCRUAL });
      expect(execution.output, `${count} months`).toEqual({ kind: "rational", numerator, denominator, unit: "days" });
    }
  });

  it("refuses fail-closed without either parameter", () => {
    expect(executeRuleSpecAtomic({ rule: SICK_PAY_ACCRUAL_SPEC, facts: months("12"), parameters: ACCRUAL.slice(0, 1) }).error_code).toBe("RULESPEC_INPUT_MISSING");
  });
});

describe("sick-pay rate on day n, §2(א) with §5(א)", () => {
  it("pays half on days two and three and the full daily wage from day four", () => {
    for (const [index, minor] of [[2, 14870], [3, 14870], [4, 29740], [5, 29740], [30, 29740]] as const) {
      const execution = executeRuleSpec({ rule: SICK_PAY_DAILY_RATE_SPEC, facts: day(index), parameters: RATE });
      expect(execution.output, `day ${index}`).toEqual({ kind: "money", currency: "ILS", minor_units: minor });
    }
  });

  it("refuses day one — stated by omission, no exclusion clause, no zero by inference", () => {
    const outcome = executeRuleSpecAtomic({ rule: SICK_PAY_DAILY_RATE_SPEC, facts: day(1), parameters: RATE });
    expect(outcome.status).toBe("failed");
    expect(outcome.error_code).toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
    expect(outcome.execution).toBeNull();
  });

  it("carries the full rate as the identity constant, and the half rate as a bound parameter", () => {
    const full = SICK_PAY_DAILY_RATE_SPEC.nodes.find((node) => node.node_id === "rate.full");
    expect(full).toMatchObject({ operation: "constant.rational", value: "1", unit: "ratio" });
    const entry = SENSITIVITY_SPECS.find((candidate) => candidate.spec.rule_spec_id === SICK_PAY_DAILY_RATE_SPEC.rule_spec_id);
    expect(entry?.bindings.map((binding) => binding.parameter_id)).toEqual(["il.sick_pay.rate_days_2_to_3", "il.minimum_wage.daily_5day"]);
    expect(entry?.narrower_than_draft).toContain("omission");
  });

  it("takes both facts from the fixtures, and each spec takes only the fact it declares", () => {
    const fixtures = buildAllScenarioFixtures().filter((entry) => entry.topic === "sick_leave");
    for (const fixture of fixtures.filter((entry) => entry.scenario !== "missing_conflicted_facts")) {
      expect(fixture.inputs.map((input) => input.ref_id).sort()).toEqual(["fact.absence.day.index", "fact.months.employed"]);
      const declared = new Set(SICK_PAY_DAILY_RATE_SPEC.facts.map((fact) => fact.ref_id));
      const facts = fixture.inputs.filter((input) => declared.has(input.ref_id));
      expect(executeRuleSpec({ rule: SICK_PAY_DAILY_RATE_SPEC, facts: facts as never, parameters: RATE }).output.kind).toBe("money");
    }
  });
});
