// L5-2 / D2. Units are derived, never relabelled.
import { describe, expect, it } from "vitest";
import { createRuleSpecPackage, executeRuleSpec, executeRuleSpecAtomic, type RuleSpecDraft, type RuleSpecInputValue } from "./rulespec.ts";
import { dimensionOf, KNOWN_UNIT_IDS, productUnit, quotientUnit, sameUnit, unitIdOf } from "./units.ts";

const SHELL = {
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_version: "1.0.0",
  catalog_boundary: "synthetic_test_only",
  source_version_ids: ["synthetic.source@v0"],
  effective_period: { from: "2040-01-01", to: null },
  sectors: ["synthetic.sector"],
  populations: ["synthetic.population"],
  golden_case_set_sha256: "0".repeat(64),
  resource_policy: { max_steps: 16, max_depth: 8, max_aggregate_items: 8, max_integer_digits: 32 },
} as const;

describe("unit algebra", () => {
  it("is bijective: every known id round-trips through its dimension", () => {
    for (const id of KNOWN_UNIT_IDS) expect(unitIdOf(dimensionOf(id)), id).toBe(id);
  });

  it("derives days_per_month × months = days, and days ÷ days_per_month = months", () => {
    expect(productUnit("days_per_month", "months")).toEqual({ unit: "days" });
    expect(productUnit("months", "days_per_month")).toEqual({ unit: "days" });
    expect(quotientUnit("days", "days_per_month")).toEqual({ unit: "months" });
    expect(quotientUnit("days", "months")).toEqual({ unit: "days_per_month" });
    expect(productUnit("calendar_days_per_year", "count.years")).toEqual({ unit: "calendar_days" });
  });

  it("treats ratio as dimensionless and an unknown id as an opaque symbol", () => {
    expect(productUnit("ratio", "days")).toEqual({ unit: "days" });
    expect(productUnit("ratio", "synthetic.point")).toEqual({ unit: "synthetic.point" });
    expect(quotientUnit("days", "days")).toEqual({ unit: "ratio" });
    expect(productUnit("ratio", "ratio")).toEqual({ unit: "ratio" });
  });

  it("refuses a derived dimension nothing names, and names both operands", () => {
    expect(productUnit("days", "months")).toEqual({ refusal: "RULESPEC_UNIT_DERIVED_UNKNOWN:days*months" });
    expect(productUnit("calendar_days", "days")).toEqual({ refusal: "RULESPEC_UNIT_DERIVED_UNKNOWN:calendar_days*days" });
    expect(quotientUnit("synthetic.point", "days")).toEqual({ refusal: "RULESPEC_UNIT_DERIVED_UNKNOWN:synthetic.point/days" });
  });

  it("never relabels: calendar_days and days are different dimensions", () => {
    expect(sameUnit("calendar_days", "days")).toBe(false);
    expect(sameUnit("days", "days")).toBe(true);
    expect(sameUnit("count.years", "count.years")).toBe(true);
  });
});

/** The sick-pay accrual, as §4(א) states it: a day and a half per full month, capped. */
function accrualDraft(): RuleSpecDraft {
  return {
    ...SHELL,
    rule_spec_id: "synthetic.rulespec.accrual",
    topic: "sick_leave",
    facts: [{ ref_id: "fact.months.employed", value_kind: "rational", unit: "months" }],
    parameters: [
      { ref_id: "parameter.accrual", parameter_id: "synthetic.accrual", parameter_version: "1.0.0", value_kind: "rational", unit: "days_per_month" },
      { ref_id: "parameter.cap", parameter_id: "synthetic.cap", parameter_version: "1.0.0", value_kind: "integer", unit: "days" },
    ],
    nodes: [
      { node_id: "accrued.days", operation: "multiply", left_ref: "fact.months.employed", right_ref: "parameter.accrual" },
      { node_id: "entitlement.days", operation: "min", refs: ["accrued.days", "parameter.cap"] },
    ],
    output_ref: "entitlement.days",
  } as unknown as RuleSpecDraft;
}
const ACCRUAL: readonly RuleSpecInputValue[] = [
  { ref_id: "parameter.accrual", value: { kind: "rational", numerator: "3", denominator: "2", unit: "days_per_month" } },
  { ref_id: "parameter.cap", value: { kind: "integer", value: 90, unit: "days" } },
];
const months = (numerator: string, denominator = "1"): readonly RuleSpecInputValue[] => [
  { ref_id: "fact.months.employed", value: { kind: "rational", numerator, denominator, unit: "months" } },
];

describe("the sick-pay accrual executes under derived units", () => {
  it("1.5 days_per_month × 12 months = 18 days, and min with 90 days holds the unit", () => {
    const rule = createRuleSpecPackage(accrualDraft());
    const execution = executeRuleSpec({ rule, facts: months("12"), parameters: ACCRUAL });
    expect(execution.output).toEqual({ kind: "rational", numerator: "18", denominator: "1", unit: "days" });
    expect(execution.trace.map((step) => step.result)).toEqual([
      { kind: "rational", numerator: "18", denominator: "1", unit: "days" },
      { kind: "rational", numerator: "18", denominator: "1", unit: "days" },
    ]);
  });

  it("caps at 90 days once 60 months have accrued", () => {
    const rule = createRuleSpecPackage(accrualDraft());
    expect(executeRuleSpec({ rule, facts: months("80"), parameters: ACCRUAL }).output).toEqual({ kind: "rational", numerator: "90", denominator: "1", unit: "days" });
    expect(executeRuleSpec({ rule, facts: months("100", "7"), parameters: ACCRUAL }).output).toEqual({ kind: "rational", numerator: "150", denominator: "7", unit: "days" });
  });

  it("refuses at validation when the units cannot be combined, naming both", () => {
    const draft = accrualDraft() as unknown as Record<string, unknown>;
    const parameters = (draft.parameters as Record<string, unknown>[]).map((parameter, index) => index === 1 ? { ...parameter, unit: "calendar_days" } : parameter);
    expect(() => createRuleSpecPackage({ ...draft, parameters } as unknown as RuleSpecDraft)).toThrow("RULESPEC_UNIT_MISMATCH:min:days:calendar_days");
    const facts = [{ ref_id: "fact.months.employed", value_kind: "rational", unit: "days" }];
    expect(() => createRuleSpecPackage({ ...draft, facts } as unknown as RuleSpecDraft)).toThrow("RULESPEC_UNIT_DERIVED_UNKNOWN:days*days_per_month");
  });

  it("is deterministic and refuses an unbound operand fail-closed", () => {
    const rule = createRuleSpecPackage(accrualDraft());
    const first = executeRuleSpec({ rule, facts: months("12"), parameters: ACCRUAL });
    const replay = executeRuleSpec({ rule, facts: months("12"), parameters: [...ACCRUAL].reverse() });
    expect(replay.result_sha256).toBe(first.result_sha256);
    expect(executeRuleSpecAtomic({ rule, facts: months("12"), parameters: ACCRUAL.slice(1) }).error_code).toBe("RULESPEC_INPUT_MISSING");
  });

  it("keeps money out of the algebra: money meets a ratio only through money.scale", () => {
    const draft = {
      ...SHELL, rule_spec_id: "synthetic.rulespec.money.times", topic: "travel",
      facts: [{ ref_id: "fact.days", value_kind: "integer", unit: "days" }],
      parameters: [{ ref_id: "parameter.rate", parameter_id: "synthetic.rate", parameter_version: "1.0.0", value_kind: "money", unit: "currency.zzz" }],
      nodes: [{ node_id: "amount", operation: "multiply", left_ref: "parameter.rate", right_ref: "fact.days" }],
      output_ref: "amount",
    } as unknown as RuleSpecDraft;
    expect(() => createRuleSpecPackage(draft)).toThrow("RULESPEC_MULTIPLY_REQUIRES_COUNTED_VALUES");
  });
});
