// L7-2 / D2. Every transformation, versioned, deterministic, and refusing
// what it cannot honestly produce. Values here are synthetic seeds; nothing
// is read from a document.
import { describe, expect, it } from "vitest";
import { createCanonicalRuleInputSnapshot } from "./snapshot.ts";
import { prepareRuleInputs } from "./preparation.ts";
import { registerRuleInputMappingRegistry, type RuleInputMapping } from "./mapping-registry.ts";
import { TRANSFORMATIONS, findTransformation, transformationAccepts } from "./transformations.ts";
import {
  SYNTHETIC_PREPARED_AT,
  buildSyntheticPayslipMonth,
  periodFact,
  type SyntheticFactSeed,
} from "../shadow/synthetic-payslip-month.ts";

const PERIOD = periodFact("t", "2026-07-01", "2026-07-31");

function mapping(input: Partial<RuleInputMapping> & Pick<RuleInputMapping, "fact_path" | "expected_output"> & { transformation_id: string }): RuleInputMapping {
  return {
    input_id: input.input_id ?? "input.under.test",
    runtime_fact_path: input.runtime_fact_path ?? "synthetic.input.under.test",
    fact_path: input.fact_path,
    minimum_confidence: input.minimum_confidence ?? 0.5,
    max_age_seconds: input.max_age_seconds ?? 31_536_000,
    expected_output: input.expected_output,
    transformation: { transformation_id: input.transformation_id, transformation_version: "1.0.0" },
  };
}

function prepare(facts: readonly SyntheticFactSeed[], mappings: readonly RuleInputMapping[]) {
  const snapshot = buildSyntheticPayslipMonth({ seed: "transformations", facts: [PERIOD, ...facts] });
  return prepareRuleInputs(
    createCanonicalRuleInputSnapshot(snapshot),
    registerRuleInputMappingRegistry({ registry_id: "test.transformations", registry_version: "1.0.0", mappings: [...mappings] }),
    SYNTHETIC_PREPARED_AT,
  );
}

function value(facts: readonly SyntheticFactSeed[], entry: RuleInputMapping) {
  const prepared = prepare(facts, [entry]);
  return { status: prepared.result.status, codes: prepared.result.rejection_codes, value: prepared.result.values[0]?.value ?? null };
}

describe("the transformation registry", () => {
  it("names every transformation once, by id and version", () => {
    const keys = TRANSFORMATIONS.map((entry) => `${entry.transformation_id}@${entry.transformation_version}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([
      "canonical.hours.amount@1.0.0",
      "canonical.hours.count.as.multiplier@1.0.0",
      "canonical.hours.per.day.integer@1.0.0",
      "canonical.money.identity@1.0.0",
      "canonical.pension.employee.contribution@1.0.0",
      "canonical.pension.employer.contribution@1.0.0",
      "canonical.seniority.whole.years@1.0.0",
      "canonical.seniority.whole.months@1.0.0",
      "canonical.workdays.per.week@1.0.0",
      "canonical.workdays.count.as.multiplier@1.0.0",
      "canonical.absence.day.index@1.0.0",
      "canonical.leave.days.integer@1.0.0",
    ]);
  });

  it("an unknown version is unsupported, not silently the nearest one", () => {
    const entry = { ...mapping({ fact_path: "work.regular_hours", expected_output: { kind: "decimal", unit: "hours_per_month" }, transformation_id: "canonical.hours.amount" }), transformation: { transformation_id: "canonical.hours.amount", transformation_version: "1.1.0" } };
    expect(findTransformation(entry)).toBeNull();
    expect(transformationAccepts(entry)).toBe(false);
    const prepared = prepare([{ path: "work.regular_hours", value: { amount: "182", unit: "hours_per_month" } }], [entry]);
    expect(prepared.result.rejection_codes).toEqual(["transformation.unsupported"]);
  });

  it("a transformation that does not accept the fact path is a mismatch, not a guess", () => {
    expect(transformationAccepts(mapping({ fact_path: "compensation.hourly_rate", expected_output: { kind: "rational", unit: "ratio" }, transformation_id: "canonical.hours.count.as.multiplier" }))).toBe(false);
  });
});

describe("hours", () => {
  it("hours.amount keeps the fact's own unit and refuses another", () => {
    const fact: SyntheticFactSeed = { path: "work.regular_hours", value: { amount: "182.5", unit: "hours_per_month" } };
    expect(value([fact], mapping({ fact_path: "work.regular_hours", expected_output: { kind: "decimal", unit: "hours_per_month" }, transformation_id: "canonical.hours.amount" })).value).toEqual({ kind: "decimal", value: "182.5", unit: "hours_per_month" });
    expect(value([fact], mapping({ fact_path: "work.regular_hours", expected_output: { kind: "decimal", unit: "hours_per_week" }, transformation_id: "canonical.hours.amount" })).codes).toEqual(["transformation.failed"]);
  });

  it("hours worked in the month become the multiplier the hourly floor is scaled by", () => {
    const entry = mapping({ fact_path: "work.regular_hours", expected_output: { kind: "rational", unit: "ratio" }, transformation_id: "canonical.hours.count.as.multiplier" });
    expect(value([{ path: "work.regular_hours", value: { amount: "186", unit: "hours_per_month" } }], entry).value).toEqual({ kind: "decimal", value: "186", unit: "ratio" });
    expect(value([{ path: "work.regular_hours", value: { amount: "42", unit: "hours_per_week" } }], entry).codes).toEqual(["transformation.failed"]);
  });

  it("hours in a day are whole hours; a fractional hour refuses rather than rounds", () => {
    const entry = mapping({ fact_path: "work.overtime_hours", expected_output: { kind: "integer", unit: "hours" }, transformation_id: "canonical.hours.per.day.integer" });
    expect(value([{ path: "work.overtime_hours", value: { amount: "3", unit: "hours_per_day" } }], entry).value).toEqual({ kind: "integer", value: 3 });
    expect(value([{ path: "work.overtime_hours", value: { amount: "3.0", unit: "hours_per_day" } }], entry).value).toEqual({ kind: "integer", value: 3 });
    expect(value([{ path: "work.overtime_hours", value: { amount: "3.5", unit: "hours_per_day" } }], entry).codes).toEqual(["transformation.failed"]);
    expect(value([{ path: "work.overtime_hours", value: { amount: "3", unit: "hours_per_month" } }], entry).codes).toEqual(["transformation.failed"]);
  });
});

describe("money", () => {
  it("identity passes money through and checks the currency", () => {
    const fact: SyntheticFactSeed = { path: "compensation.hourly_rate", value: { currency: "ILS", minor_units: 3_500 } };
    expect(value([fact], mapping({ fact_path: "compensation.hourly_rate", expected_output: { kind: "money", currency: "ILS" }, transformation_id: "canonical.money.identity" })).value).toEqual({ kind: "money", value: { currency: "ILS", minor_units: 3_500 } });
    expect(value([fact], mapping({ fact_path: "compensation.hourly_rate", expected_output: { kind: "money", currency: "USD" }, transformation_id: "canonical.money.identity" })).codes).toEqual(["transformation.failed"]);
  });

  it("a pension contribution side is its amount; a rate-only side has nothing to compare and fails", () => {
    const period = { start_date: "2026-07-01", end_date: "2026-07-31" };
    const employee = mapping({ fact_path: "pension.contributions", expected_output: { kind: "money", currency: "ILS" }, transformation_id: "canonical.pension.employee.contribution" });
    const employer = mapping({ fact_path: "pension.contributions", expected_output: { kind: "money", currency: "ILS" }, transformation_id: "canonical.pension.employer.contribution" });
    const both: SyntheticFactSeed = { path: "pension.contributions", value: { employee: { amount: { currency: "ILS", minor_units: 60_000 }, rate_basis_points: 600 }, employer: { amount: { currency: "ILS", minor_units: 65_000 }, rate_basis_points: 650 }, period } };
    expect(value([both], employee).value).toEqual({ kind: "money", value: { currency: "ILS", minor_units: 60_000 } });
    expect(value([both], employer).value).toEqual({ kind: "money", value: { currency: "ILS", minor_units: 65_000 } });
    const rateOnly: SyntheticFactSeed = { path: "pension.contributions", value: { employee: { amount: null, rate_basis_points: 600 }, employer: null, period } };
    expect(value([rateOnly], employee).codes).toEqual(["transformation.failed"]);
    expect(value([rateOnly], employer).codes).toEqual(["transformation.failed"]);
  });
});

describe("seniority from the start date and the period end", () => {
  const years = mapping({ fact_path: "employment.start_date", expected_output: { kind: "integer", unit: "count.years" }, transformation_id: "canonical.seniority.whole.years" });
  const months = mapping({ fact_path: "employment.start_date", expected_output: { kind: "rational", unit: "months" }, transformation_id: "canonical.seniority.whole.months" });

  it("counts completed years at the period end, by the calendar, no clock", () => {
    const cases: Array<[string, number]> = [["2023-07-31", 3], ["2023-08-01", 2], ["2026-07-31", 0], ["2016-01-15", 10], ["2019-07-01", 7]];
    for (const [start, expected] of cases) {
      expect(value([{ path: "employment.start_date", value: start }], years).value, start).toEqual({ kind: "integer", value: expected });
    }
  });

  it("counts completed months the same way", () => {
    expect(value([{ path: "employment.start_date", value: "2025-07-31" }], months).value).toEqual({ kind: "decimal", value: "12", unit: "months" });
    expect(value([{ path: "employment.start_date", value: "2026-02-15" }], months).value).toEqual({ kind: "decimal", value: "5", unit: "months" });
  });

  it("a start after the period end fails; a missing or unconfirmed period fails too", () => {
    expect(value([{ path: "employment.start_date", value: "2026-09-01" }], years).codes).toEqual(["transformation.failed"]);
    const noPeriod = prepareRuleInputs(
      createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "no-period", facts: [{ path: "employment.start_date", value: "2020-01-01" }] })),
      registerRuleInputMappingRegistry({ registry_id: "test.transformations", registry_version: "1.0.0", mappings: [years] }),
      SYNTHETIC_PREPARED_AT,
    );
    expect(noPeriod.result.rejection_codes).toEqual(["transformation.failed"]);
    const unconfirmedPeriod = prepareRuleInputs(
      createCanonicalRuleInputSnapshot(buildSyntheticPayslipMonth({ seed: "unconfirmed-period", facts: [{ ...PERIOD, status: "candidate" }, { path: "employment.start_date", value: "2020-01-01" }] })),
      registerRuleInputMappingRegistry({ registry_id: "test.transformations", registry_version: "1.0.0", mappings: [years] }),
      SYNTHETIC_PREPARED_AT,
    );
    expect(unconfirmedPeriod.result.rejection_codes).toEqual(["transformation.failed"]);
  });
});

describe("days", () => {
  it("the weekly pattern's length is the workdays per week", () => {
    const entry = mapping({ fact_path: "work.workdays", expected_output: { kind: "integer", unit: "days_per_week" }, transformation_id: "canonical.workdays.per.week" });
    expect(value([{ path: "work.workdays", value: { days: ["sunday", "monday", "tuesday", "wednesday", "thursday"] } }], entry).value).toEqual({ kind: "integer", value: 5 });
  });

  it("workdays in the month become the multiplier the daily cap is scaled by", () => {
    const entry = mapping({ fact_path: "work.workdays_in_month", expected_output: { kind: "rational", unit: "ratio" }, transformation_id: "canonical.workdays.count.as.multiplier" });
    expect(value([{ path: "work.workdays_in_month", value: { days: 22 } }], entry).value).toEqual({ kind: "decimal", value: "22", unit: "ratio" });
  });

  it("an absence's last day index is its inclusive length; an open-ended absence fails", () => {
    const entry = mapping({ fact_path: "leave.sick_absence", expected_output: { kind: "integer", unit: "days" }, transformation_id: "canonical.absence.day.index" });
    expect(value([{ path: "leave.sick_absence", value: { start_date: "2026-07-06", end_date: "2026-07-10" } }], entry).value).toEqual({ kind: "integer", value: 5 });
    expect(value([{ path: "leave.sick_absence", value: { start_date: "2026-07-06", end_date: "2026-07-06" } }], entry).value).toEqual({ kind: "integer", value: 1 });
    expect(value([{ path: "leave.sick_absence", value: { start_date: "2026-07-06", end_date: null } }], entry).codes).toEqual(["transformation.failed"]);
  });

  it("a leave balance in whole days binds; hours or a fraction of a day refuse", () => {
    const entry = mapping({ fact_path: "leave.vacation_days_paid", expected_output: { kind: "integer", unit: "days" }, transformation_id: "canonical.leave.days.integer" });
    expect(value([{ path: "leave.vacation_days_paid", value: { amount: "4", unit: "days" } }], entry).value).toEqual({ kind: "integer", value: 4 });
    expect(value([{ path: "leave.vacation_days_paid", value: { amount: "4.5", unit: "days" } }], entry).codes).toEqual(["transformation.failed"]);
    expect(value([{ path: "leave.vacation_days_paid", value: { amount: "32", unit: "hours" } }], entry).codes).toEqual(["transformation.failed"]);
  });
});
