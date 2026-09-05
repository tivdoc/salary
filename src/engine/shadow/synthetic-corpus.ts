// L7-4 / D5. The synthetic facts corpus: one payslip month per golden
// scenario family per topic — forty-two — and the edge cases each spec
// refuses. Every month is a canonical employment snapshot built by
// `buildSyntheticPayslipMonth` from a seed, so the corpus is a pure function
// of this file and its hash is pinned in the test beside it.
//
// What a month carries: the facts the topic's specs read (through the
// mapping registries, never directly), the paid component the payslip shows
// for that topic (for the L7-5 delta), and the period. Source types are
// mixed on purpose — documented figures next to declared ones, a derived
// count, an inferred amount — so the L7-3 grade has something to propagate.
// Nothing here came from a document: `synthetic: true` on every case, and
// the ids say so by construction.
//
// The scenario families follow the golden set. `missing_conflicted_facts`
// withholds one fact and conflicts another so the case REFUSES;
// `sector_population` names a population — until L8-4 the fact model did not carry it, so
// the case runs on the general figure and its label says so;
// `precedence_overlap` is an ordinary month whose specs carry an open
// decision, run per branch in L7-7; `parameter_rounding_boundary` chooses
// figures whose scaling cannot come out exact.
import { GOLDEN_SCENARIOS } from "../legal-quality/golden-case-templates.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { DRAFT_SHADOW_SPECS, DRAFT_SHADOW_TOPICS } from "./draft-shadow-specs.ts";
import { buildSyntheticPayslipMonth, periodFact, type SyntheticFactSeed } from "./synthetic-payslip-month.ts";

export type GoldenScenario = typeof GOLDEN_SCENARIOS[number];

export type SyntheticCaseExpectation =
  | Readonly<{ kind: "runs" }>
  | Readonly<{ kind: "runs"; note: string }>
  | Readonly<{ kind: "preparation_refuses"; codes: readonly string[] }>
  | Readonly<{ kind: "executor_refuses"; error_code: string }>;

export type SyntheticCase = Readonly<{
  case_id: string;
  synthetic: true;
  topic: string;
  family: "golden" | "edge";
  scenario: GoldenScenario | string;
  /** The shadow specs this month is run through. */
  shadow_ids: readonly string[];
  population: string;
  snapshot: EmploymentSnapshot;
  snapshot_sha256: string;
  expected: SyntheticCaseExpectation;
}>;

type Period = Readonly<{ start: string; end: string }>;

const PERIODS: Readonly<Record<GoldenScenario, Period>> = Object.freeze({
  current: { start: "2026-06-01", end: "2026-06-30" },
  effective_date_boundary: { start: "2026-04-01", end: "2026-04-30" },
  sector_population: { start: "2026-06-01", end: "2026-06-30" },
  missing_conflicted_facts: { start: "2026-06-01", end: "2026-06-30" },
  precedence_overlap: { start: "2026-06-01", end: "2026-06-30" },
  parameter_rounding_boundary: { start: "2026-06-01", end: "2026-06-30" },
});

const POPULATION: Readonly<Record<GoldenScenario, string>> = Object.freeze({
  current: "general",
  effective_date_boundary: "general",
  sector_population: "youth_16_17",
  missing_conflicted_facts: "general",
  precedence_overlap: "general",
  parameter_rounding_boundary: "general",
});

/** A start date `years` completed years before the period end (first of the month, so the count is exact). */
function startYearsBefore(period: Period, years: number): string {
  const [year, month] = period.end.split("-");
  return `${Number.parseInt(year, 10) - years}-${month}-01`;
}

/** A start date `months` completed months before the period end. */
function startMonthsBefore(period: Period, months: number): string {
  const [year, month] = period.end.split("-").map((part) => Number.parseInt(part, 10));
  const index = year * 12 + (month - 1) - months;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}

/** An absence of `days` days starting on the 6th of the period's month. */
function absence(period: Period, days: number): { start_date: string; end_date: string } {
  const [year, month] = period.start.split("-");
  return { start_date: `${year}-${month}-06`, end_date: `${year}-${month}-${String(5 + days).padStart(2, "0")}` };
}

const ils = (minorUnits: number) => ({ currency: "ILS", minor_units: minorUnits });
const hoursPerMonth = (amount: string) => ({ amount, unit: "hours_per_month" as const });
const hoursPerDay = (amount: string) => ({ amount, unit: "hours_per_day" as const });
/** L12-2. A five-day week, Sunday to Thursday: the schedule the derived daily norm needs. */
const FIVE_DAY_WEEK = Object.freeze({ days: ["sunday", "monday", "tuesday", "wednesday", "thursday"] as const });
const days = (amount: string) => ({ amount, unit: "days" as const });

const CONFLICTED: Pick<SyntheticFactSeed, "value" | "status"> = { value: null, status: "conflicted" };

type TopicMonth = (scenario: GoldenScenario, period: Period) => readonly SyntheticFactSeed[];

// Per topic: the facts of the month, by scenario. A `null` fact is withheld.
const TOPIC_MONTHS: Readonly<Record<string, TopicMonth>> = Object.freeze({
  minimum_wage: (scenario) => {
    const hours: Record<GoldenScenario, string | null> = { current: "182", effective_date_boundary: "182", sector_population: "91", missing_conflicted_facts: null, precedence_overlap: "186", parameter_rounding_boundary: "170.3" };
    const gross: Record<GoldenScenario, number | null> = { current: 640_000, effective_date_boundary: 620_000, sector_population: 300_000, missing_conflicted_facts: 640_000, precedence_overlap: 640_000, parameter_rounding_boundary: 590_000 };
    return [
      hours[scenario] === null
        ? { path: "work.regular_hours", ...CONFLICTED, source_type: "documented" }
        : { path: "work.regular_hours", value: hoursPerMonth(hours[scenario]!), source_type: "documented" },
      ...(scenario === "missing_conflicted_facts" ? [] : [{ path: "compensation.gross_salary" as const, value: ils(gross[scenario]!), source_type: "documented" as const }]),
    ];
  },
  working_time: (scenario) => {
    const overtime: Record<GoldenScenario, string> = { current: "4", effective_date_boundary: "3", sector_population: "2", missing_conflicted_facts: "4", precedence_overlap: "5", parameter_rounding_boundary: "1" };
    const rest: Record<GoldenScenario, string> = { current: "3", effective_date_boundary: "2", sector_population: "1", missing_conflicted_facts: "3", precedence_overlap: "4", parameter_rounding_boundary: "1" };
    // L7-9 / D6: the hours worked in the day — the declared overtime above plus
    // the statute's eight — so the derived overtime agrees with the declared.
    const worked: Record<GoldenScenario, string> = { current: "12", effective_date_boundary: "11", sector_population: "10", missing_conflicted_facts: "12", precedence_overlap: "13", parameter_rounding_boundary: "9" };
    const wage = scenario === "parameter_rounding_boundary" ? 3_333 : 4_000;
    // L12-2 / D2: every working-time month declares its five-day schedule, so
    // the derived norm applies; a month without one is refused schedule_unknown.
    const schedule = { path: "work.workdays" as const, value: FIVE_DAY_WEEK, source_type: "documented" as const };
    if (scenario === "missing_conflicted_facts") {
      return [
        schedule,
        { path: "work.overtime_hours", ...CONFLICTED, source_type: "documented" },
        { path: "work.hours_worked_day", value: hoursPerDay(worked[scenario]), source_type: "documented" },
        { path: "work.rest_day_overtime_hours", value: hoursPerDay(rest[scenario]), source_type: "declared" },
        // the hourly wage is withheld
        { path: "compensation.overtime_pay", value: ils(20_000), source_type: "documented" },
        { path: "compensation.weekly_rest_pay", value: ils(18_000), source_type: "documented" },
      ];
    }
    return [
      schedule,
      { path: "work.overtime_hours", value: hoursPerDay(overtime[scenario]), source_type: "documented" },
      { path: "work.hours_worked_day", value: hoursPerDay(worked[scenario]), source_type: "documented" },
      { path: "work.rest_day_overtime_hours", value: hoursPerDay(rest[scenario]), source_type: "declared" },
      { path: "compensation.hourly_rate", value: ils(wage), source_type: "documented" },
      { path: "compensation.overtime_pay", value: ils(20_000), source_type: "documented" },
      { path: "compensation.weekly_rest_pay", value: ils(18_000), source_type: "inferred", confidence: 0.85 },
    ];
  },
  pension: (scenario, period) => {
    const wage: Record<GoldenScenario, number> = { current: 1_500_000, effective_date_boundary: 1_378_800, sector_population: 700_000, missing_conflicted_facts: 1_500_000, precedence_overlap: 1_000_000, parameter_rounding_boundary: 1_234_567 };
    const contributions = (employee: number) => ({
      employee: { amount: ils(employee), rate_basis_points: 600 },
      employer: { amount: ils(Math.round(employee * 65 / 60)), rate_basis_points: 650 },
      period: { start_date: period.start, end_date: period.end },
    });
    if (scenario === "missing_conflicted_facts") {
      // the pensionable wage is withheld; the contributions conflict
      return [{ path: "pension.contributions", ...CONFLICTED, source_type: "documented" }];
    }
    return [
      { path: "pension.base_salary", value: ils(wage[scenario]), source_type: scenario === "sector_population" ? "declared" : "documented" },
      { path: "pension.contributions", value: contributions(Math.round(Math.min(wage[scenario], 1_378_800) * 6 / 100) - (scenario === "current" ? 2_000 : 0)), source_type: "documented" },
      // L8-3 / D4: the severance component, 6% of the capped wage, paid 10.00 short in the current month.
      { path: "pension.severance_contribution", value: { amount: ils(Math.round(Math.min(wage[scenario], 1_378_800) * 6 / 100) - (scenario === "current" ? 1_000 : 0)), rate_basis_points: 600 }, source_type: "documented" },
    ];
  },
  travel: (scenario) => {
    const workdays: Record<GoldenScenario, number> = { current: 22, effective_date_boundary: 22, sector_population: 11, missing_conflicted_facts: 22, precedence_overlap: 22, parameter_rounding_boundary: 23 };
    if (scenario === "missing_conflicted_facts") {
      return [{ path: "travel.reimbursement", ...CONFLICTED, source_type: "documented" }];
    }
    return [
      { path: "work.workdays_in_month", value: { days: workdays[scenario] }, source_type: "derived" },
      { path: "travel.reimbursement", value: ils(scenario === "sector_population" ? 24_860 : 45_000), source_type: "documented" },
    ];
  },
  convalescence: (scenario, period) => {
    const years: Record<GoldenScenario, number> = { current: 3, effective_date_boundary: 1, sector_population: 12, missing_conflicted_facts: 3, precedence_overlap: 20, parameter_rounding_boundary: 4 };
    if (scenario === "missing_conflicted_facts") {
      return [{ path: "convalescence.payment", ...CONFLICTED, source_type: "declared" }];
    }
    return [
      { path: "employment.start_date", value: startYearsBefore(period, years[scenario]), source_type: "declared" },
      { path: "convalescence.payment", value: ils(scenario === "current" ? 225_750 : 270_900), source_type: "documented" },
    ];
  },
  vacation: (scenario, period) => {
    const years: Record<GoldenScenario, number> = { current: 3, effective_date_boundary: 8, sector_population: 7, missing_conflicted_facts: 3, precedence_overlap: 5, parameter_rounding_boundary: 15 };
    if (scenario === "missing_conflicted_facts") {
      return [{ path: "leave.vacation_days_paid", ...CONFLICTED, source_type: "documented" }];
    }
    return [
      { path: "employment.start_date", value: startYearsBefore(period, years[scenario]), source_type: "documented" },
      { path: "leave.vacation_days_paid", value: days(scenario === "current" ? "14" : "16"), source_type: "documented" },
    ];
  },
  sick_leave: (scenario, period) => {
    const months: Record<GoldenScenario, number> = { current: 12, effective_date_boundary: 12, sector_population: 6, missing_conflicted_facts: 12, precedence_overlap: 60, parameter_rounding_boundary: 7 };
    const dayIndex: Record<GoldenScenario, number> = { current: 5, effective_date_boundary: 4, sector_population: 3, missing_conflicted_facts: 5, precedence_overlap: 2, parameter_rounding_boundary: 7 };
    if (scenario === "missing_conflicted_facts") {
      return [
        { path: "leave.sick_absence", ...CONFLICTED, source_type: "declared" },
        // the start date is withheld
        { path: "leave.sick_pay", value: ils(50_000), source_type: "documented" },
      ];
    }
    return [
      { path: "employment.start_date", value: startMonthsBefore(period, months[scenario]), source_type: "declared" },
      { path: "leave.sick_absence", value: absence(period, dayIndex[scenario]), source_type: "declared" },
      { path: "leave.sick_pay", value: ils(50_000), source_type: "documented" },
    ];
  },
});

const REFUSAL_CODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  minimum_wage: ["fact.conflicted"],
  working_time: ["fact.conflicted", "fact.missing"],
  pension: ["fact.missing"],
  travel: ["fact.missing"],
  convalescence: ["fact.missing"],
  vacation: ["fact.missing"],
  sick_leave: ["fact.conflicted", "fact.missing"],
});

function shadowIdsOf(topic: string): readonly string[] {
  return DRAFT_SHADOW_SPECS.filter((entry) => entry.topic === topic).map((entry) => entry.shadow_id);
}

function makeCase(input: Omit<SyntheticCase, "snapshot" | "snapshot_sha256" | "synthetic" | "case_id"> & { seed: string; facts: readonly SyntheticFactSeed[] }): SyntheticCase {
  const snapshot = buildSyntheticPayslipMonth({ seed: input.seed, facts: input.facts });
  const { seed, facts, ...rest } = input;
  void seed; void facts;
  return Object.freeze({
    case_id: `synthetic.${input.topic}.${input.family}.${input.scenario}`,
    synthetic: true,
    ...rest,
    snapshot,
    snapshot_sha256: canonicalSha256(snapshot),
  });
}

function goldenCase(topic: string, scenario: GoldenScenario): SyntheticCase {
  const period = PERIODS[scenario];
  // L8-4 / D5: the population is a fact of the month, not a label on the case.
  const facts = [
    periodFact(`${topic}.${scenario}`, period.start, period.end),
    { path: "employment.population" as const, value: { population: POPULATION[scenario] }, source_type: "documented" as const },
    ...TOPIC_MONTHS[topic](scenario, period),
  ];
  const expected: SyntheticCaseExpectation = scenario === "missing_conflicted_facts"
    ? { kind: "preparation_refuses", codes: REFUSAL_CODES[topic] }
    : scenario === "sector_population"
      ? { kind: "runs", note: "the month declares its population (youth_16_17); a spec with a population-selected slot binds that population's registered figure, the rest run as for an adult" }
      : { kind: "runs" };
  return makeCase({ seed: `golden.${topic}.${scenario}`, topic, family: "golden", scenario, shadow_ids: shadowIdsOf(topic), population: POPULATION[scenario], facts, expected });
}

/** The edge cases: what each spec refuses, one month each. */
function edgeCases(): readonly SyntheticCase[] {
  const period = PERIODS.current;
  const month = (name: string, topic: string, shadowIds: readonly string[], facts: readonly SyntheticFactSeed[], expected: SyntheticCaseExpectation, own: Period = period) =>
    makeCase({ seed: `edge.${topic}.${name}`, topic, family: "edge", scenario: name, shadow_ids: shadowIds, population: "general", facts: [periodFact(`${topic}.${name}`, own.start, own.end), ...facts], expected });
  return [
    month("fractional_overtime_hour", "working_time", ["working.time.overtime.pay"],
      [{ path: "work.overtime_hours", value: hoursPerDay("2.5"), source_type: "documented" }, { path: "compensation.hourly_rate", value: ils(4_000), source_type: "documented" }],
      { kind: "preparation_refuses", codes: ["transformation.failed"] }),
    month("hours_in_the_wrong_unit", "minimum_wage", ["minimum.wage.hourly.entitlement"],
      [{ path: "work.regular_hours", value: { amount: "42", unit: "hours_per_week" }, source_type: "documented" }],
      { kind: "preparation_refuses", codes: ["transformation.failed"] }),
    month("year_zero", "vacation", ["vacation.seniority.band.entitlement"],
      [{ path: "employment.start_date", value: period.start, source_type: "declared" }],
      { kind: "executor_refuses", error_code: "RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE" }),
    month("year_zero", "convalescence", ["convalescence.days.by.seniority", "convalescence.pay.by.seniority"],
      [{ path: "employment.start_date", value: period.start, source_type: "declared" }],
      { kind: "executor_refuses", error_code: "RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE" }),
    month("first_day_of_absence", "sick_leave", ["sick.pay.daily.rate"],
      [{ path: "leave.sick_absence", value: absence(period, 1), source_type: "declared" }],
      { kind: "executor_refuses", error_code: "RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE" }),
    month("open_ended_absence", "sick_leave", ["sick.pay.daily.rate"],
      [{ path: "leave.sick_absence", value: { start_date: `${period.start.slice(0, 8)}06`, end_date: null }, source_type: "declared" }],
      { kind: "preparation_refuses", codes: ["transformation.failed"] }),
    month("start_after_period", "vacation", ["vacation.seniority.band.entitlement"],
      [{ path: "employment.start_date", value: "2026-09-01", source_type: "declared" }],
      { kind: "preparation_refuses", codes: ["transformation.failed"] }),
    month("period_unconfirmed", "sick_leave", ["sick.pay.accrual"],
      [{ path: "employment.start_date", value: "2020-01-01", source_type: "declared" }],
      { kind: "preparation_refuses", codes: ["transformation.failed"] }),
    month("low_confidence_wage", "pension", ["pension.wage.cap.on.wage", "pension.employee.contribution.on.wage", "pension.employer.contribution.on.wage", "pension.severance.contribution.on.wage"],
      [{ path: "pension.base_salary", value: ils(1_000_000), source_type: "inferred", confidence: 0.4 }],
      { kind: "preparation_refuses", codes: ["fact.below_confidence_threshold"] }),
    month("stale_workdays", "travel", ["travel.daily.cap.entitlement"],
      [{ path: "work.workdays_in_month", value: { days: 22 }, source_type: "derived", created_at: "2024-01-01T00:00:00.000Z" }],
      { kind: "preparation_refuses", codes: ["fact.stale"] }),
    month("unconfirmed_wage", "working_time", ["working.time.overtime.pay", "working.time.overtime.from.hours.worked", "working.time.overtime.five.day.norm", "working.time.rest.day.overtime.additive"],
      [{ path: "work.workdays", value: FIVE_DAY_WEEK, source_type: "documented" }, { path: "work.overtime_hours", value: hoursPerDay("2"), source_type: "documented" }, { path: "work.hours_worked_day", value: hoursPerDay("10"), source_type: "documented" }, { path: "work.rest_day_overtime_hours", value: hoursPerDay("2"), source_type: "documented" }, { path: "compensation.hourly_rate", value: ils(4_000), source_type: "documented", status: "needs_confirmation" }],
      { kind: "preparation_refuses", codes: ["fact.unconfirmed"] }),
    // L11-4 / D3.4: June 2026, six convalescence days paid at the 2023 rate
    // (418.00). Under the havraa_year branch the month is short 6 × 33.50, and
    // the shortfall carries the retroactive tag: the rate became known on
    // 18.8.2026, after the payment.
    month("paid_at_previous_rate", "convalescence", ["convalescence.pay.by.seniority"],
      [{ path: "employment.start_date", value: startYearsBefore(period, 3), source_type: "declared" }, { path: "convalescence.payment", value: ils(250_800), source_type: "documented" }],
      { kind: "runs", note: "six days paid at 418.00 in June 2026: under havraa_year the delta is 6 × 33.50 = 201.00, tagged retroactive_update_2026-08-18; the two calendar branches see the same shortfall untagged" }),
    // L11-4 / D3.4: January 2027 pays for convalescence year 2027, whose rate
    // is not published. The havraa_year branch refuses it (rate_not_published)
    // in the shadow run; the two calendar branches run on their own figure.
    month("havraa_year_2027_rate_not_published", "convalescence", ["convalescence.pay.by.seniority"],
      [{ path: "employment.start_date", value: startYearsBefore({ start: "2027-01-01", end: "2027-01-31" }, 3), source_type: "declared" }, { path: "convalescence.payment", value: ils(270_900), source_type: "documented" }],
      { kind: "runs", note: "a 2027 payslip: the havraa_year branch refuses rate_not_published before running (the branch guard, not the executor); the calendar branches run" },
      { start: "2027-01-01", end: "2027-01-31" }),
    // L7-9 / D6: a day within the eight-hour threshold has no overtime — zero pay, not a refusal.
    month("within_daily_threshold", "working_time", ["working.time.overtime.from.hours.worked", "working.time.overtime.five.day.norm"],
      [{ path: "work.workdays", value: FIVE_DAY_WEEK, source_type: "documented" }, { path: "work.hours_worked_day", value: hoursPerDay("7"), source_type: "documented" }, { path: "compensation.hourly_rate", value: ils(4_000), source_type: "documented" }, { path: "compensation.overtime_pay", value: ils(0), source_type: "documented" }],
      { kind: "runs", note: "seven hours worked over an eight-hour threshold: zero overtime hours, zero pay, a zero delta" }),
  ].map((entry) => (entry.scenario === "period_unconfirmed"
    ? { ...entry, snapshot: unconfirmPeriod(entry.snapshot), snapshot_sha256: canonicalSha256(unconfirmPeriod(entry.snapshot)) }
    : entry));
}

function unconfirmPeriod(snapshot: EmploymentSnapshot): EmploymentSnapshot {
  return {
    ...snapshot,
    facts: snapshot.facts.map((fact) => (fact.path === "documents.period" ? { ...fact, status: "candidate" as const } : fact)),
  };
}

export const SYNTHETIC_CORPUS: readonly SyntheticCase[] = Object.freeze([
  ...DRAFT_SHADOW_TOPICS.flatMap((topic) => GOLDEN_SCENARIOS.map((scenario) => goldenCase(topic, scenario))),
  ...edgeCases(),
]);

export const SYNTHETIC_CORPUS_SHA256: string = canonicalSha256(SYNTHETIC_CORPUS.map((entry) => ({ case_id: entry.case_id, snapshot_sha256: entry.snapshot_sha256, expected: entry.expected })));

export function syntheticCase(caseId: string): SyntheticCase {
  const found = SYNTHETIC_CORPUS.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`SYNTHETIC_CASE_UNKNOWN:${caseId}`);
  return found;
}
