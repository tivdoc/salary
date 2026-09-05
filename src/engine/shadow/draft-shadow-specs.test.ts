// L7-2 / D2. The seven draft topics execute on a synthetic payslip month
// through the canonical fact model, the mapping registries and preparation —
// and refuse, per rejection code, when a fact is not what the slot needs.
import { describe, expect, it } from "vitest";
import { executeRuleSpecAtomic, type RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import { registerRuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import { prepareRuleInputs, ruleInputRejectionCodeSchema } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import {
  CONVALESCENCE_PAY_SHADOW_SPEC,
  DRAFT_SHADOW_SPECS,
  DRAFT_SHADOW_TOPICS,
  PENSION_CONTRIBUTION_SHADOW_SPEC,
  PENSION_WAGE_CAP_SHADOW_SPEC,
  boundInputSlots,
  type DraftShadowSpec,
} from "./draft-shadow-specs.ts";
import { transformationAccepts } from "../rule-input/transformations.ts";
import { bridgePreparedInputs, decimalToRational } from "./prepared-input-bridge.ts";
import {
  SYNTHETIC_PREPARED_AT,
  buildSyntheticPayslipMonth,
  periodFact,
  type SyntheticFactSeed,
} from "./synthetic-payslip-month.ts";

const ratio = (numerator: string, denominator = "1") => ({ kind: "rational" as const, numerator, denominator, unit: "ratio" });
const money = (minorUnits: number) => ({ kind: "money" as const, currency: "ILS", minor_units: minorUnits });
const integer = (value: number, unit: string) => ({ kind: "integer" as const, value, unit });

/** Draft parameter values as executor inputs — the figures the P line registered, synthetic here. */
const PARAMETER_VALUES: Readonly<Record<string, RuleSpecInputValue["value"]>> = Object.freeze({
  "parameter.hourly.floor": money(3_468),
  "parameter.wage.cap": money(1_378_800),
  "parameter.employee.share": ratio("6", "100"),
  "parameter.employer.share": ratio("13", "200"),
  "parameter.severance.share": ratio("3", "50"),
  "parameter.daily.cap": money(2_260),
  "parameter.days.years.1.to.5": integer(16, "calendar_days"),
  "parameter.days.year.6": integer(18, "calendar_days"),
  "parameter.days.year.7": integer(21, "calendar_days"),
  "parameter.increment.per.year": integer(1, "calendar_days_per_year"),
  "parameter.days.cap": integer(28, "calendar_days"),
  "parameter.accrual.per.month": { kind: "rational", numerator: "3", denominator: "2", unit: "days_per_month" },
  "parameter.accrual.cap": integer(90, "days"),
  "parameter.rate.days.2.to.3": ratio("1", "2"),
  "parameter.daily.wage": money(28_895),
  "parameter.daily.rate": money(45_150),
  "parameter.rate.first": ratio("5", "4"),
  "parameter.rate.second": ratio("3", "2"),
  "parameter.rate.rest": ratio("3", "2"),
  "parameter.daily.threshold": integer(8, "hours"),
  "parameter.daily.threshold.five.day": { kind: "rational", numerator: "43", denominator: "5", unit: "hours" },
  "parameter.short.day.threshold": { kind: "rational", numerator: "38", denominator: "5", unit: "hours" },
  "parameter.daily.threshold.statute": integer(8, "hours"),
  "parameter.days.year.1": integer(5, "days"),
  "parameter.days.years.2.to.3": integer(6, "days"),
  "parameter.days.years.4.to.10": integer(7, "days"),
  "parameter.days.years.11.to.15": integer(8, "days"),
  "parameter.days.years.16.to.19": integer(9, "days"),
  "parameter.days.years.20.and.above": integer(10, "days"),
});

const PERIOD = periodFact("month", "2026-07-01", "2026-07-31");

/** One synthetic payslip month that carries every fact the twelve specs read. */
const MONTH_FACTS: readonly SyntheticFactSeed[] = [
  PERIOD,
  { path: "employment.start_date", value: "2023-03-01", source_type: "declared" },
  { path: "work.regular_hours", value: { amount: "182", unit: "hours_per_month" }, source_type: "documented" },
  { path: "work.overtime_hours", value: { amount: "4", unit: "hours_per_day" }, source_type: "documented" },
  { path: "work.workdays", value: { days: ["sunday", "monday", "tuesday", "wednesday", "thursday"] }, source_type: "documented" },
  { path: "work.hours_worked_day", value: { amount: "12", unit: "hours_per_day" }, source_type: "documented" },
  { path: "work.rest_day_overtime_hours", value: { amount: "3", unit: "hours_per_day" }, source_type: "declared" },
  { path: "work.workdays_in_month", value: { days: 22 }, source_type: "derived" },
  { path: "compensation.hourly_rate", value: { currency: "ILS", minor_units: 4_000 }, source_type: "documented" },
  { path: "pension.base_salary", value: { currency: "ILS", minor_units: 1_500_000 }, source_type: "documented" },
  { path: "leave.sick_absence", value: { start_date: "2026-07-06", end_date: "2026-07-08" }, source_type: "declared" },
];

function parametersFor(entry: DraftShadowSpec): RuleSpecInputValue[] {
  return entry.spec.parameters.map((declaration) => {
    const value = PARAMETER_VALUES[declaration.ref_id];
    if (!value) throw new Error(`test parameter missing: ${declaration.ref_id}`);
    return { ref_id: declaration.ref_id, value };
  });
}

function runShadow(entry: DraftShadowSpec, facts: readonly SyntheticFactSeed[] = MONTH_FACTS, preparedAt = SYNTHETIC_PREPARED_AT) {
  const snapshot = createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "shadow-month", facts }));
  const prepared = prepareRuleInputs(snapshot, entry.input_mappings, preparedAt);
  const inputs = bridgePreparedInputs(prepared, entry.input_mappings);
  const outcome = prepared.result.status === "ready"
    ? executeRuleSpecAtomic({ rule: entry.spec, facts: inputs, parameters: parametersFor(entry) } as never)
    : null;
  return { prepared, inputs, outcome };
}

function outputOf(outcome: ReturnType<typeof executeRuleSpecAtomic> | null): unknown {
  if (!outcome || !outcome.execution) return null;
  return outcome.execution.output;
}

describe("the draft shadow set", () => {
  it("covers the seven topics with fifteen specs (L11-4 retired the multiplicative rest-day reading; L12-2 added the derived five-day norm), three of them shadow forms and two under the pension decision alone", () => {
    expect(DRAFT_SHADOW_TOPICS).toEqual(["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"]);
    expect(DRAFT_SHADOW_SPECS).toHaveLength(15);
    expect(DRAFT_SHADOW_SPECS.filter((entry) => entry.shadow_form_of !== null).map((entry) => entry.shadow_id)).toEqual([
      "pension.wage.cap.on.wage",
      "pension.employee.contribution.on.wage",
      "convalescence.pay.by.seniority",
    ]);
    expect(new Set(DRAFT_SHADOW_SPECS.map((entry) => entry.shadow_id)).size).toBe(15);
    expect(DRAFT_SHADOW_SPECS.some((entry) => entry.shadow_id === "working.time.rest.day.overtime.multiplicative")).toBe(false);
    // L8-3 / D4: the employer and severance specs run under the precedence decision, both branches, no sensitivity counterpart.
    for (const shadowId of ["pension.employer.contribution.on.wage", "pension.severance.contribution.on.wage"]) {
      const entry = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === shadowId)!;
      expect(entry.shadow_form_of).toBeNull();
      expect(entry.decision_id).toBe("legal.reference.il.decision.pension_2011_2016_precedence");
      expect(entry.branches).toEqual([["order_2011_2014_row", "2014.2.0"], ["order_2016_2017_rates", "2017.1.0"]]);
      expect(entry.bindings.filter((binding) => binding.parameter_version === null).map((binding) => binding.parameter_id))
        .toEqual([shadowId.includes("employer") ? "il.pension.employer_contribution_rate" : "il.pension.severance_contribution_rate"]);
    }
  });

  it("binds every input slot of every spec through a registry mapping — no slot is typed", () => {
    const slots = boundInputSlots();
    const declared = DRAFT_SHADOW_SPECS.reduce((sum, entry) => sum + entry.spec.facts.length, 0);
    expect(slots).toHaveLength(declared);
    // L11-4 / D3.3: the retired multiplicative reading declared two of the nineteen; L12-2 / D2 declares three more.
    expect(slots).toHaveLength(20);
    for (const entry of DRAFT_SHADOW_SPECS) {
      expect(entry.input_mappings.registry.mappings.map((mapping) => mapping.input_id).sort()).toEqual(entry.spec.facts.map((fact) => fact.ref_id).sort());
      expect(entry.input_mappings.registry.registry_version).toBe("2.0.0");
      expect(entry.input_mappings.registry.registry_id).toBe(`legal.draft.shadow.${entry.shadow_id}`);
    }
  });

  it("each mapping's expected output is the spec slot's own kind and unit, and its transformation accepts the slot", () => {
    for (const slot of boundInputSlots()) {
      expect(transformationAccepts(slot.mapping), slot.ref_id).toBe(true);
      const entry = DRAFT_SHADOW_SPECS.find((candidate) => candidate.shadow_id === slot.shadow_id)!;
      const declaration = entry.spec.facts.find((fact) => fact.ref_id === slot.ref_id)!;
      if (slot.mapping.expected_output.kind === "money") expect(declaration.value_kind).toBe("money");
      else {
        expect(slot.mapping.expected_output.kind).toBe(declaration.value_kind);
        expect(slot.mapping.expected_output.unit).toBe(declaration.unit);
      }
    }
  });

  it("executes all fifteen specs on one synthetic month, through preparation and the bridge", () => {
    const outputs = new Map<string, unknown>();
    for (const entry of DRAFT_SHADOW_SPECS) {
      const { prepared, outcome } = runShadow(entry);
      expect(prepared.result.status, entry.shadow_id).toBe("ready");
      expect(outcome?.error_code, entry.shadow_id).toBeNull();
      outputs.set(entry.shadow_id, outputOf(outcome));
    }
    // 182 hours at the 34.68 floor.
    expect(outputs.get("minimum.wage.hourly.entitlement")).toEqual(money(631_176));
    // 4 overtime hours on 40.00: 2 × 1.25 + 2 × 1.5 = 5.5 hours.
    expect(outputs.get("working.time.overtime.pay")).toEqual(money(22_000));
    // 12 hours worked over the derived 8.6-hour threshold on a five-day week: 3.4 hours, 2 × 1.25 + 1.4 × 1.5 = 4.6 hours at 40.00.
    expect(outputs.get("working.time.overtime.five.day.norm")).toEqual(money(18_400));
    // 12 hours worked over an 8-hour threshold: the same 4 overtime hours, derived.
    expect(outputs.get("working.time.overtime.from.hours.worked")).toEqual(money(22_000));
    // A 15,000 wage capped at 13,788; 6% of it.
    expect(outputs.get("pension.wage.cap.on.wage")).toEqual(money(1_378_800));
    expect(outputs.get("pension.employee.contribution.on.wage")).toEqual(money(82_728));
    // L8-3 / D4: 6.5% and 6% of the same capped wage.
    expect(outputs.get("pension.employer.contribution.on.wage")).toEqual(money(89_622));
    expect(outputs.get("pension.severance.contribution.on.wage")).toEqual(money(82_728));
    // 22 workdays at the 22.60 cap.
    expect(outputs.get("travel.daily.cap.entitlement")).toEqual(money(49_720));
    // Started 2023-03-01, period ends 2026-07-31: 3 completed years → 6 days → 6 × 451.50.
    expect(outputs.get("convalescence.days.by.seniority")).toEqual(integer(6, "days"));
    expect(outputs.get("convalescence.pay.by.seniority")).toEqual(money(270_900));
    expect(outputs.get("vacation.seniority.band.entitlement")).toEqual(integer(16, "calendar_days"));
    // 40 completed months × 1.5 = 60 days, under the 90 cap.
    expect(outputs.get("sick.pay.accrual")).toEqual({ kind: "rational", numerator: "60", denominator: "1", unit: "days" });
    // Absence 6–8 July: day index 3 → half the daily wage.
    expect(outputs.get("sick.pay.daily.rate")).toEqual(money(14_448));
  });

  it("the shadow forms compute what their sensitivity specs compute, on a wage instead of a multiplier", () => {
    const capped = executeRuleSpecAtomic({
      rule: PENSION_WAGE_CAP_SHADOW_SPEC,
      facts: [{ ref_id: "fact.pensionable.wage", value: money(1_000_000) }],
      parameters: [{ ref_id: "parameter.wage.cap", value: money(1_378_800) }],
    } as never);
    expect(outputOf(capped)).toEqual(money(1_000_000));
    const contribution = executeRuleSpecAtomic({
      rule: PENSION_CONTRIBUTION_SHADOW_SPEC,
      facts: [{ ref_id: "fact.pensionable.wage", value: money(1_000_000) }],
      parameters: [{ ref_id: "parameter.wage.cap", value: money(1_378_800) }, { ref_id: "parameter.employee.share", value: ratio("6", "100") }],
    } as never);
    expect(outputOf(contribution)).toEqual(money(60_000));
    const yearZero = executeRuleSpecAtomic({
      rule: CONVALESCENCE_PAY_SHADOW_SPEC,
      facts: [{ ref_id: "fact.years.employed", value: integer(0, "count.years") }],
      parameters: DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "convalescence.pay.by.seniority")!.spec.parameters.map((declaration) => ({ ref_id: declaration.ref_id, value: PARAMETER_VALUES[declaration.ref_id] })),
    } as never);
    expect(yearZero.error_code).toBe("RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE");
  });
});

describe("the refusal path — one proof per rejection code", () => {
  const overtime = DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "working.time.overtime.pay")!;
  const vacation = DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "vacation.seniority.band.entitlement")!;
  const without = (path: string) => MONTH_FACTS.filter((fact) => fact.path !== path);
  const replace = (fact: SyntheticFactSeed) => [...without(fact.path), fact];

  const proofs: Array<[string, () => ReturnType<typeof runShadow>]> = [
    ["fact.missing", () => runShadow(overtime, without("work.overtime_hours"))],
    ["fact.conflicted", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: null, status: "conflicted" }))],
    ["fact.unconfirmed", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: { amount: "4", unit: "hours_per_day" }, status: "needs_confirmation" }))],
    ["fact.rejected", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: { amount: "4", unit: "hours_per_day" }, status: "rejected" }))],
    ["fact.stale", () => runShadow(overtime, MONTH_FACTS, "2028-01-01T00:00:00.000Z")],
    ["fact.timestamp_after_preparation", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: { amount: "4", unit: "hours_per_day" }, created_at: "2026-08-02T00:00:00.000Z" }))],
    ["fact.below_confidence_threshold", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: { amount: "4", unit: "hours_per_day" }, confidence: 0.5 }))],
    ["transformation.failed", () => runShadow(overtime, replace({ path: "work.overtime_hours", value: { amount: "4.25", unit: "hours_per_day" } }))],
  ];

  for (const [code, run] of proofs) {
    it(`${code}: no value, no execution`, () => {
      const { prepared, inputs, outcome } = run();
      expect(prepared.result.status).toBe("rejected");
      expect(prepared.result.rejection_codes).toContain(code);
      expect(prepared.result.values).toEqual([]);
      expect(inputs).toEqual([]);
      expect(outcome).toBeNull();
    });
  }

  it("transformation.unsupported: a registry naming a transformation that does not exist", () => {
    const mapping = vacation.input_mappings.registry.mappings[0];
    const registry = registerRuleInputMappingRegistry({
      registry_id: "test.unsupported",
      registry_version: "1.0.0",
      mappings: [{ ...mapping, transformation: { transformation_id: "canonical.seniority.whole.years", transformation_version: "9.0.0" } }],
    });
    const prepared = prepareRuleInputs(createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "m", facts: MONTH_FACTS })), registry, SYNTHETIC_PREPARED_AT);
    expect(prepared.result.rejection_codes).toEqual(["transformation.unsupported"]);
  });

  it("every rejection code the contract names has a proof above", () => {
    const proven = new Set([...proofs.map(([code]) => code), "transformation.unsupported"]);
    expect([...proven].sort()).toEqual([...ruleInputRejectionCodeSchema.options].sort());
  });

  it("a conflicted fact is a refusal — the binder never picks a side", () => {
    const { prepared } = runShadow(overtime, replace({ path: "work.overtime_hours", value: null, status: "conflicted" }));
    const rejection = prepared.rejections.find((entry) => entry.code === "fact.conflicted")!;
    expect(rejection.observed_status).toBe("conflicted");
    expect(prepared.result.values).toEqual([]);
    const snapshot = buildSyntheticPayslipMonth({ seed: "shadow-month", facts: replace({ path: "work.overtime_hours", value: null, status: "conflicted" }) });
    const conflicted = snapshot.facts.find((fact) => fact.path === "work.overtime_hours")!;
    expect(conflicted.resolution).toBeNull();
    expect(conflicted.conflicting_fact_ids).toHaveLength(2);
  });
});

describe("the bridge", () => {
  it("writes a decimal as the exact fraction it is", () => {
    expect(decimalToRational("182")).toEqual({ numerator: "182", denominator: "1" });
    expect(decimalToRational("2.50")).toEqual({ numerator: "5", denominator: "2" });
    expect(decimalToRational("0.125")).toEqual({ numerator: "1", denominator: "8" });
    expect(decimalToRational("-0.5")).toEqual({ numerator: "-1", denominator: "2" });
    expect(decimalToRational("0.0")).toEqual({ numerator: "0", denominator: "1" });
    expect(() => decimalToRational("1e3")).toThrow("SHADOW_BRIDGE_DECIMAL_MALFORMED");
  });

  it("yields nothing for a preparation that is not ready", () => {
    const overtime = DRAFT_SHADOW_SPECS.find((entry) => entry.shadow_id === "working.time.overtime.pay")!;
    const { prepared } = runShadow(overtime, MONTH_FACTS.filter((fact) => fact.path !== "compensation.hourly_rate"));
    expect(bridgePreparedInputs(prepared, overtime.input_mappings)).toEqual([]);
  });
});
