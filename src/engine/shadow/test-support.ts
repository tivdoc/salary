// Test support only. The registered draft parameter values as executor
// inputs, keyed by spec ref id — the figures the P line holds as drafts,
// written here so unit tests can execute specs without a database. The
// shadow run itself (L7-6) reads them from governance state; nothing under
// src/ imports this file except tests.
import type { RuleSpecInputValue } from "../legal-operations/rulespec.ts";
import type { DraftShadowSpec } from "./draft-shadow-specs.ts";

const ratio = (numerator: string, denominator = "1") => ({ kind: "rational" as const, numerator, denominator, unit: "ratio" });
const money = (minorUnits: number) => ({ kind: "money" as const, currency: "ILS", minor_units: minorUnits });
const integer = (value: number, unit: string) => ({ kind: "integer" as const, value, unit });

export const TEST_PARAMETER_VALUES: Readonly<Record<string, RuleSpecInputValue["value"]>> = Object.freeze({
  "parameter.hourly.floor": money(3_468),
  "parameter.wage.cap": money(1_378_800),
  "parameter.employee.share": ratio("6", "100"),
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
  "parameter.days.year.1": integer(5, "days"),
  "parameter.days.years.2.to.3": integer(6, "days"),
  "parameter.days.years.4.to.10": integer(7, "days"),
  "parameter.days.years.11.to.15": integer(8, "days"),
  "parameter.days.years.16.to.19": integer(9, "days"),
  "parameter.days.years.20.and.above": integer(10, "days"),
});

export function testParametersFor(entry: DraftShadowSpec): RuleSpecInputValue[] {
  return entry.spec.parameters.map((declaration) => {
    const value = TEST_PARAMETER_VALUES[declaration.ref_id];
    if (!value) throw new Error(`test parameter missing: ${declaration.ref_id}`);
    return { ref_id: declaration.ref_id, value };
  });
}
