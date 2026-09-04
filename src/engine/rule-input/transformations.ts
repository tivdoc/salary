// L7-2 / D2. The transformation registry: every way a canonical fact becomes
// a rule input, named and versioned, deterministic, and the only path.
//
// A mapping names a transformation by id and version; preparation looks it
// up here. A transformation accepts named fact paths and produces one
// expected-output kind; anything else is `transformation.unsupported`
// (unknown id/version) or `transformation.failed` (the fact cannot be turned
// into what the slot consumes — a fractional hour where the slot takes whole
// hours, a start date after the period end, a missing period fact). Nothing
// here consults the clock, the locale or the environment; a transformation
// that needs the payslip period reads it from the snapshot's own
// `documents.period` fact, which must be confirmed like any other.
//
// Two transformations deliberately relabel a count as a multiplier — hours
// worked applied to an hourly amount, workdays applied to a daily cap — and
// say so in their ids: `…count.as.multiplier`. The dimension is honest (a
// count times a per-unit amount), the executor's `ratio` is the wire form.
import { calculationValueSchema, type CalculationValue } from "../calculations/contracts.ts";
import type { CanonicalFact } from "../facts/contracts.ts";
import type { FactPath } from "../facts/fact-paths.ts";
import type { RuleInputMapping } from "./mapping-registry.ts";

export type TransformationContext = Readonly<{
  /** Every fact of the snapshot, by path — for transformations that need the period. */
  facts: ReadonlyMap<string, CanonicalFact>;
}>;

export type Transformation = Readonly<{
  transformation_id: string;
  transformation_version: string;
  accepts: readonly FactPath[];
  produces: ReadonlyArray<RuleInputMapping["expected_output"]["kind"]>;
  description: string;
  apply: (fact: CanonicalFact, mapping: RuleInputMapping, context: TransformationContext) => CalculationValue | null;
}>;

const key = (id: string, version: string) => `${id}@${version}`;

function decimalParts(amount: string): { integer: string; fraction: string } {
  const [integer, fraction = ""] = amount.split(".");
  return { integer, fraction };
}

/** A decimal string as a whole number, or null if it has a fractional part. */
function wholeNumber(amount: string): number | null {
  const { integer, fraction } = decimalParts(amount);
  if (fraction.replace(/0+$/u, "").length > 0) return null;
  const value = Number.parseInt(integer, 10);
  return Number.isSafeInteger(value) ? value : null;
}

function hoursValue(fact: CanonicalFact): { amount: string; unit: string } | null {
  const value = fact.value;
  if (value === null || typeof value !== "object" || !("amount" in value) || !("unit" in value)) return null;
  if (typeof value.amount !== "string" || typeof value.unit !== "string") return null;
  return { amount: value.amount, unit: value.unit };
}

function moneyValue(fact: CanonicalFact): { currency: string; minor_units: number } | null {
  const value = fact.value;
  if (value === null || typeof value !== "object" || !("currency" in value) || !("minor_units" in value)) return null;
  if (typeof value.currency !== "string" || typeof value.minor_units !== "number" || !Number.isSafeInteger(value.minor_units)) return null;
  return { currency: value.currency, minor_units: value.minor_units };
}

function periodEnd(context: TransformationContext): string | null {
  const period = context.facts.get("documents.period");
  if (!period || period.status !== "confirmed" || period.value === null || typeof period.value !== "object" || !("period" in period.value)) return null;
  const range = period.value.period as { start_date: string; end_date: string | null };
  return range.end_date ?? null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A calendar date's parts, or null unless it is a plausible YYYY-MM-DD (the fact schema already guarantees the shape; this refuses anyway). */
function civil(date: string): { year: number; month: number; day: number } | null {
  const match = ISO_DATE.exec(date);
  if (!match) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map((part) => Number.parseInt(part, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Days since 1970-01-01 for a civil date — integer arithmetic only (Hinnant's days_from_civil). */
function daysFromCivil(date: { year: number; month: number; day: number }): number {
  const y = date.month <= 2 ? date.year - 1 : date.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (date.month + (date.month > 2 ? -3 : 9)) + 2) / 5) + date.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Whole years (or months) completed between a start date and a period end, calendar arithmetic, no clock. */
function completedUnits(start: string, end: string, unit: "years" | "months"): number | null {
  const from = civil(start);
  const to = civil(end);
  if (from === null || to === null) return null;
  if (daysFromCivil(to) < daysFromCivil(from)) return null;
  const months = (to.year - from.year) * 12 + (to.month - from.month) - (to.day < from.day ? 1 : 0);
  return unit === "months" ? months : Math.floor(months / 12);
}

const decimal = (value: string, unit: string): CalculationValue => calculationValueSchema.parse({ kind: "decimal", value, unit });
const integer = (value: number): CalculationValue => calculationValueSchema.parse({ kind: "integer", value });
const money = (currency: string, minorUnits: number): CalculationValue => calculationValueSchema.parse({ kind: "money", value: { currency, minor_units: minorUnits } });

const HOUR_FACT_PATHS: readonly FactPath[] = ["work.regular_hours", "work.overtime_hours", "work.overtime_125_hours", "work.overtime_150_hours"];
const MONEY_FACT_PATHS: readonly FactPath[] = [
  "compensation.base_monthly_salary", "compensation.hourly_rate", "compensation.gross_salary", "compensation.net_salary",
  "pension.base_salary", "travel.reimbursement", "convalescence.payment",
  "compensation.overtime_pay", "compensation.weekly_rest_pay", "leave.sick_pay",
];

export const TRANSFORMATIONS: readonly Transformation[] = Object.freeze([
  {
    transformation_id: "canonical.hours.amount", transformation_version: "1.0.0",
    accepts: HOUR_FACT_PATHS, produces: ["decimal"],
    description: "An hours fact as a decimal in the unit the fact carries; the mapping's unit must be that unit.",
    apply: (fact, mapping) => {
      const hours = hoursValue(fact);
      if (!hours || mapping.expected_output.kind !== "decimal" || hours.unit !== mapping.expected_output.unit) return null;
      return decimal(hours.amount, hours.unit);
    },
  },
  {
    transformation_id: "canonical.hours.count.as.multiplier", transformation_version: "1.0.0",
    accepts: ["work.regular_hours"], produces: ["rational"],
    description: "Hours worked in the month as a count applied to an hourly amount — the executor's ratio, dimensionally hours × (money per hour).",
    apply: (fact, mapping) => {
      const hours = hoursValue(fact);
      if (!hours || mapping.expected_output.kind !== "rational" || mapping.expected_output.unit !== "ratio" || hours.unit !== "hours_per_month") return null;
      return decimal(hours.amount, "ratio");
    },
  },
  {
    transformation_id: "canonical.hours.per.day.integer", transformation_version: "1.0.0",
    accepts: ["work.hours_worked_day", "work.rest_day_overtime_hours", "work.overtime_hours"], produces: ["integer"],
    description: "Hours in a day as whole hours; a fractional amount cannot be priced by the whole-hour tiers and fails.",
    apply: (fact, mapping) => {
      const hours = hoursValue(fact);
      if (!hours || mapping.expected_output.kind !== "integer" || mapping.expected_output.unit !== "hours" || hours.unit !== "hours_per_day") return null;
      const whole = wholeNumber(hours.amount);
      return whole === null ? null : integer(whole);
    },
  },
  {
    transformation_id: "canonical.money.identity", transformation_version: "1.0.0",
    accepts: MONEY_FACT_PATHS, produces: ["money"],
    description: "A money fact as money, currency checked against the mapping.",
    apply: (fact, mapping) => {
      const value = moneyValue(fact);
      if (!value || mapping.expected_output.kind !== "money" || value.currency !== mapping.expected_output.currency) return null;
      return money(value.currency, value.minor_units);
    },
  },
  {
    transformation_id: "canonical.pension.employee.contribution", transformation_version: "1.0.0",
    accepts: ["pension.contributions"], produces: ["money"],
    description: "The employee's pension contribution amount as paid; a contribution stated only as a rate has no amount to compare and fails.",
    apply: (fact, mapping) => {
      const value = fact.value as { employee?: { amount: { currency: string; minor_units: number } | null } | null } | null;
      const amount = value?.employee?.amount ?? null;
      if (!amount || mapping.expected_output.kind !== "money" || amount.currency !== mapping.expected_output.currency) return null;
      return money(amount.currency, amount.minor_units);
    },
  },
  {
    transformation_id: "canonical.pension.employer.contribution", transformation_version: "1.0.0",
    accepts: ["pension.contributions"], produces: ["money"],
    description: "The employer's pension contribution amount as paid; a contribution stated only as a rate has no amount to compare and fails.",
    apply: (fact, mapping) => {
      const value = fact.value as { employer?: { amount: { currency: string; minor_units: number } | null } | null } | null;
      const amount = value?.employer?.amount ?? null;
      if (!amount || mapping.expected_output.kind !== "money" || amount.currency !== mapping.expected_output.currency) return null;
      return money(amount.currency, amount.minor_units);
    },
  },
  {
    transformation_id: "canonical.seniority.whole.years", transformation_version: "1.0.0",
    accepts: ["employment.start_date"], produces: ["integer"],
    description: "Completed years of service from the start date to the payslip period end (documents.period, confirmed).",
    apply: (fact, mapping, context) => {
      const end = periodEnd(context);
      if (typeof fact.value !== "string" || end === null || mapping.expected_output.kind !== "integer" || mapping.expected_output.unit !== "count.years") return null;
      const years = completedUnits(fact.value, end, "years");
      return years === null ? null : integer(years);
    },
  },
  {
    transformation_id: "canonical.seniority.whole.months", transformation_version: "1.0.0",
    accepts: ["employment.start_date"], produces: ["rational"],
    description: "Completed months of service from the start date to the payslip period end, as a rational in months.",
    apply: (fact, mapping, context) => {
      const end = periodEnd(context);
      if (typeof fact.value !== "string" || end === null || mapping.expected_output.kind !== "rational" || mapping.expected_output.unit !== "months") return null;
      const months = completedUnits(fact.value, end, "months");
      return months === null ? null : decimal(String(months), "months");
    },
  },
  {
    transformation_id: "canonical.workdays.per.week", transformation_version: "1.0.0",
    accepts: ["work.workdays"], produces: ["integer"],
    description: "The number of workdays in the weekly pattern.",
    apply: (fact, mapping) => {
      const value = fact.value as { days?: readonly string[] } | null;
      if (!value?.days || mapping.expected_output.kind !== "integer" || mapping.expected_output.unit !== "days_per_week") return null;
      return integer(value.days.length);
    },
  },
  {
    transformation_id: "canonical.workdays.count.as.multiplier", transformation_version: "1.0.0",
    accepts: ["work.workdays_in_month"], produces: ["rational"],
    description: "Workdays in the month as a count applied to a daily amount — the executor's ratio.",
    apply: (fact, mapping) => {
      const value = fact.value as { days?: number } | null;
      if (typeof value?.days !== "number" || mapping.expected_output.kind !== "rational" || mapping.expected_output.unit !== "ratio") return null;
      return decimal(String(value.days), "ratio");
    },
  },
  {
    transformation_id: "canonical.absence.day.index", transformation_version: "1.0.0",
    accepts: ["leave.sick_absence"], produces: ["integer"],
    description: "The index of the last day of an absence: the inclusive length of the absence date range in days.",
    apply: (fact, mapping) => {
      const value = fact.value as { start_date?: string; end_date?: string | null } | null;
      if (!value?.start_date || !value.end_date || mapping.expected_output.kind !== "integer" || mapping.expected_output.unit !== "days") return null;
      const start = civil(value.start_date);
      const end = civil(value.end_date);
      if (start === null || end === null) return null;
      const length = daysFromCivil(end) - daysFromCivil(start) + 1;
      return length < 1 ? null : integer(length);
    },
  },
  {
    transformation_id: "canonical.leave.days.integer", transformation_version: "1.0.0",
    accepts: ["leave.vacation_balance", "leave.sick_balance", "leave.vacation_days_paid"], produces: ["integer"],
    description: "A leave balance stated in whole days; hours or fractional days fail.",
    apply: (fact, mapping) => {
      const value = hoursValue(fact);
      if (!value || value.unit !== "days" || mapping.expected_output.kind !== "integer" || mapping.expected_output.unit !== "days") return null;
      const whole = wholeNumber(value.amount);
      return whole === null ? null : integer(whole);
    },
  },
]);

const BY_KEY: ReadonlyMap<string, Transformation> = new Map(TRANSFORMATIONS.map((entry) => [key(entry.transformation_id, entry.transformation_version), entry]));

export function findTransformation(mapping: RuleInputMapping): Transformation | null {
  return BY_KEY.get(key(mapping.transformation.transformation_id, mapping.transformation.transformation_version)) ?? null;
}

/** A mapping is well-formed against the registry only if its transformation accepts its fact path and produces its kind. */
export function transformationAccepts(mapping: RuleInputMapping): boolean {
  const transformation = findTransformation(mapping);
  return transformation !== null && transformation.accepts.includes(mapping.fact_path) && transformation.produces.includes(mapping.expected_output.kind);
}
