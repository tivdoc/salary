// E3-7. Executable RuleSpecs for the topics whose slots are all bound, built so
// the open decisions can actually be run rather than described.
//
// Two things about these that matter more than the code.
//
// First, what they compute is definitional, not interpretive. The minimum-wage
// spec multiplies the hourly floor by a dimensionless hours multiplier; the
// pension spec caps a pensionable wage at the mandatory cap with `min`. Neither
// decides anything a lawyer decides — no seniority band, no precedence between
// instruments, no sector rule. Everything of that kind stays in the unbound
// slots of the Q-1..Q-7 drafts, which is why those drafts still cannot execute
// and these narrower specs can.
//
// Second, `catalog_boundary` is `real_inactive` and stays there. These bind real
// draft parameter values so the sensitivity run produces real numbers, and
// nothing in the package lifecycle can move them: activation needs two
// independent attestations and the database refuses to record even one from a
// single identity.
//
// The pension spec is deliberately NARROWER than the pension draft: it binds
// only the wage cap and not the employee contribution rate, which is unbound in
// Pool P. The full pension draft therefore stays `not_run: slot_unbound`, and
// this spec is reported for what it is — the cap applied on its own, which is
// exactly the quantity the open decision moves.
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import { createRuleSpecPackage, type RuleSpecPackage } from "../legal-operations/rulespec.ts";
import { buildBlankGoldenCaseTemplates } from "./golden-case-templates.ts";

/**
 * The golden-case binding. These specs point at the BLANK templates for their
 * topic — the real golden set, with every expected field still null — because
 * that is the golden set that exists. Pointing at a set with filled
 * expectations would require filling them, which D1 forbids.
 */
function blankGoldenSetSha256(topic: string): string {
  const templates = buildBlankGoldenCaseTemplates().filter((entry) => entry.topic === topic);
  if (templates.length === 0) throw new Error(`SENSITIVITY_GOLDEN_TEMPLATES_MISSING:${topic}`);
  return canonicalSha256(templates.map((entry) => entry.content_sha256));
}

export const MINIMUM_WAGE_HOURLY_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.minimum.wage.hourly.entitlement",
  rule_spec_version: "1.0.0",
  topic: "minimum_wage",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-04-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.hours.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.hourly.floor",
    parameter_id: "il.minimum.wage.hourly",
    parameter_version: "2026.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  // One node. The hourly floor scaled by the hours multiplier, rounded half-up,
  // which is the whole computation and contains no legal judgement.
  nodes: [{
    node_id: "entitlement.at.hourly.floor",
    operation: "money.scale",
    money_ref: "parameter.hourly.floor",
    rational_ref: "fact.hours.multiplier",
    rounding: "half_up",
  }],
  output_ref: "entitlement.at.hourly.floor",
  golden_case_set_sha256: blankGoldenSetSha256("minimum_wage"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export const PENSION_WAGE_CAP_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.pension.wage.cap.application",
  rule_spec_version: "1.0.0",
  topic: "pension",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.pensionable.wage.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.wage.cap",
    parameter_id: "il.pension.mandatory.wage.cap",
    parameter_version: "2026.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  nodes: [{
    node_id: "pensionable.wage.capped",
    operation: "money.scale",
    money_ref: "parameter.wage.cap",
    rational_ref: "fact.pensionable.wage.multiplier",
    rounding: "half_up",
  }],
  output_ref: "pensionable.wage.capped",
  golden_case_set_sha256: blankGoldenSetSha256("pension"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export const TRAVEL_DAILY_CAP_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.travel.daily.cap.entitlement",
  rule_spec_version: "1.0.0",
  topic: "travel",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0"],
  effective_period: { from: "2016-02-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.workdays.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.daily.cap",
    parameter_id: "il.travel.daily.reimbursement.cap",
    parameter_version: "2016.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  nodes: [{
    node_id: "reimbursement.at.daily.cap",
    operation: "money.scale",
    money_ref: "parameter.daily.cap",
    rational_ref: "fact.workdays.multiplier",
    rounding: "half_up",
  }],
  output_ref: "reimbursement.at.daily.cap",
  golden_case_set_sha256: blankGoldenSetSha256("travel"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

/**
 * L4-3, completed by L5-3 (D3). The vacation entitlement, §3(א) of the Annual
 * Vacation Law 1951 as Amendment 15 left it — the whole clause this time.
 *
 * Years one to seven are the band table L4-3 built. From the eighth year §3(א)(5)
 * states a rule rather than a figure: one additional day for each further work
 * year, up to twenty-eight. L4-3 stopped at the seventh year because the
 * vocabulary had no subtraction and the intermediate figures — 22 through 27 —
 * are not written anywhere in the law. They still are not written anywhere, and
 * they are still not here: the spec carries 21, the increment of one day, and
 * the ceiling of 28, each a cited parameter, and the arithmetic
 * `min(21 + 1 × (years − 7), 28)` is what produces 22 through 27. That is a
 * computation stated by the clause, not a figure authored by me.
 *
 * The one integer written into the shape is 7 — the boundary between the seventh
 * year's fixed figure and the eighth year's rule, the same boundary the band
 * table carries as `from_inclusive: 8`. It is a constant.integer node, visible
 * in the spec, hashed with it, and named in the trace.
 */
export const VACATION_SENIORITY_BAND_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.vacation.seniority.band.entitlement",
  rule_spec_version: "2.0.0",
  topic: "vacation",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_ANNUAL_VACATION_LAW@discovery-v0", "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@discovery-v0"],
  effective_period: { from: "2017-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.seniority.year", value_kind: "integer", unit: "count.years" }],
  parameters: [
    { ref_id: "parameter.days.years.1.to.5", parameter_id: "il.vacation.calendar_days_years_1_to_5", parameter_version: "2017.1.0", value_kind: "integer", unit: "calendar_days" },
    { ref_id: "parameter.days.year.6", parameter_id: "il.vacation.calendar_days_year_6", parameter_version: "1951.1.0", value_kind: "integer", unit: "calendar_days" },
    { ref_id: "parameter.days.year.7", parameter_id: "il.vacation.calendar_days_year_7", parameter_version: "1951.1.0", value_kind: "integer", unit: "calendar_days" },
    { ref_id: "parameter.increment.per.year", parameter_id: "il.vacation.calendar_days_increment_per_year_from_year_8", parameter_version: "1951.1.0", value_kind: "integer", unit: "calendar_days_per_year" },
    { ref_id: "parameter.days.cap", parameter_id: "il.vacation.calendar_days_years_8_and_above_cap", parameter_version: "1951.1.0", value_kind: "integer", unit: "calendar_days" },
  ],
  nodes: [
    { node_id: "boundary.year.7", operation: "constant.integer", value: 7, unit: "count.years" },
    { node_id: "years.beyond.7", operation: "subtract", left_ref: "fact.seniority.year", right_ref: "boundary.year.7" },
    // calendar_days_per_year × count.years = calendar_days, derived, not relabelled.
    { node_id: "days.added", operation: "multiply", left_ref: "parameter.increment.per.year", right_ref: "years.beyond.7" },
    { node_id: "days.uncapped", operation: "add", refs: ["parameter.days.year.7", "days.added"] },
    { node_id: "days.from.year.8", operation: "min", refs: ["days.uncapped", "parameter.days.cap"] },
    {
      node_id: "entitlement.calendar.days",
      operation: "band.lookup",
      input_ref: "fact.seniority.year",
      bands: [
        { from_inclusive: 1, to_exclusive: 6, value_ref: "parameter.days.years.1.to.5" },
        { from_inclusive: 6, to_exclusive: 7, value_ref: "parameter.days.year.6" },
        { from_inclusive: 7, to_exclusive: 8, value_ref: "parameter.days.year.7" },
        { from_inclusive: 8, to_exclusive: null, value_ref: "days.from.year.8" },
      ],
    },
  ],
  output_ref: "entitlement.calendar.days",
  golden_case_set_sha256: blankGoldenSetSha256("vacation"),
  resource_policy: { max_steps: 8, max_depth: 8, max_aggregate_items: 8, max_integer_digits: 32 },
});

/**
 * L5-2 (D2). Sick-pay accrual, §4(א) of the Sick Pay Law: a day and a half for
 * every full month, to a ceiling of ninety. The two parameters were bound two
 * runs ago and could not meet, because one is days per month and the other is
 * days. Now the product derives its unit — days_per_month × months = days —
 * and the ceiling is a min over one dimension.
 */
export const SICK_PAY_ACCRUAL_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.sick.pay.accrual",
  rule_spec_version: "1.0.0",
  topic: "sick_leave",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_SICK_PAY_LAW@discovery-v0"],
  effective_period: { from: "1976-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.months.employed", value_kind: "rational", unit: "months" }],
  parameters: [
    { ref_id: "parameter.accrual.per.month", parameter_id: "il.sick_pay.accrual_days_per_month", parameter_version: "1.0.0", value_kind: "rational", unit: "days_per_month" },
    { ref_id: "parameter.accrual.cap", parameter_id: "il.sick_pay.accrual_cap_days", parameter_version: "1.0.0", value_kind: "integer", unit: "days" },
  ],
  nodes: [
    { node_id: "days.accrued", operation: "multiply", left_ref: "fact.months.employed", right_ref: "parameter.accrual.per.month" },
    { node_id: "entitlement.days", operation: "min", refs: ["days.accrued", "parameter.accrual.cap"] },
  ],
  output_ref: "entitlement.days",
  golden_case_set_sha256: blankGoldenSetSha256("sick_leave"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

/**
 * L5-4 (D1). The rate of sick pay on day n of an absence, §2(א) of the Sick Pay
 * Law: nothing for the first day, half from the second and third, full from
 * the fourth. Read against the text as it stands:
 *
 *   - The half tier is a word — `מחצית דמי מחלה` — and binds through the
 *     lexicon from its own chunk, with the surface form on the citation.
 *   - The full tier is not a figure in the text at all. §2(א)(1) says "payment
 *     under this law" from the fourth day, and §5(א) defines that payment as the
 *     wage. Full is the identity, and the identity is `constant.rational 1`:
 *     shape, not a parameter, because there is no figure to cite.
 *   - The first day is stated by OMISSION. There is no exclusion clause in the
 *     chunk, so under D1 there is nothing to bind a zero from, and day one
 *     refuses — `RULESPEC_BAND_LOOKUP_INPUT_OUT_OF_RANGE` — rather than being
 *     priced at nothing by inference.
 *
 * It is a per-day rate rather than a cumulative sum over an absence for the
 * same reason: a cumulative table with a hole at day one cannot price any
 * absence honestly, and the executor now refuses such tables outright.
 *
 * The base is the registered 5-day-week daily minimum wage, so this is "sick
 * pay at the minimum daily wage" — narrower than the draft, and it says so.
 */
export const SICK_PAY_DAILY_RATE_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.sick.pay.daily.rate",
  rule_spec_version: "1.0.0",
  topic: "sick_leave",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_SICK_PAY_LAW@discovery-v0", "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0"],
  effective_period: { from: "2026-04-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.absence.day.index", value_kind: "integer", unit: "days" }],
  parameters: [
    { ref_id: "parameter.rate.days.2.to.3", parameter_id: "il.sick_pay.rate_days_2_to_3", parameter_version: "1.0.0", value_kind: "rational", unit: "ratio" },
    { ref_id: "parameter.daily.wage", parameter_id: "il.minimum_wage.daily_5day", parameter_version: "2026.1.0", value_kind: "money", unit: "currency.ils" },
  ],
  nodes: [
    { node_id: "rate.full", operation: "constant.rational", value: "1", unit: "ratio" },
    {
      node_id: "rate.on.day",
      operation: "band.lookup",
      input_ref: "fact.absence.day.index",
      bands: [
        { from_inclusive: 2, to_exclusive: 4, value_ref: "parameter.rate.days.2.to.3" },
        { from_inclusive: 4, to_exclusive: null, value_ref: "rate.full" },
      ],
    },
    { node_id: "sick.pay.on.day", operation: "money.scale", money_ref: "parameter.daily.wage", rational_ref: "rate.on.day", rounding: "half_up" },
  ],
  output_ref: "sick.pay.on.day",
  golden_case_set_sha256: blankGoldenSetSha256("sick_leave"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

/**
 * L5-5 (D4). Convalescence pay for a number of convalescence days at the day
 * rate the extension order states. The rate is a money parameter cited into an
 * INSTRUMENT SELECTION — the 2026 gazette issue carries several instruments,
 * and the convalescence order is selected by its own title line — so the
 * citation carries the selection's hash and attesting the parameter attests
 * the boundary.
 *
 * The open decision here is the PERIOD, not the figure: the order states the
 * rate "for the convalescence year 2026" and is signed in July, and which
 * twelve months that names is a question the text leaves open. The two
 * branches carry the same figure with different effective periods, so a
 * sensitivity run reports no difference in the amount — which is the honest
 * shape of a decision about when, not how much.
 */
export const CONVALESCENCE_DAILY_RATE_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.convalescence.daily.rate.entitlement",
  rule_spec_version: "1.0.0",
  topic: "convalescence",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2"],
  effective_period: { from: "2026-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.convalescence.days.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [{
    ref_id: "parameter.daily.rate",
    parameter_id: "il.convalescence.daily.rate",
    parameter_version: "2026.1.0",
    value_kind: "money",
    unit: "currency.ils",
  }],
  nodes: [{
    node_id: "convalescence.pay",
    operation: "money.scale",
    money_ref: "parameter.daily.rate",
    rational_ref: "fact.convalescence.days.multiplier",
    rounding: "half_up",
  }],
  output_ref: "convalescence.pay",
  golden_case_set_sha256: blankGoldenSetSha256("convalescence"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

/** One governance parameter bound into one spec ref. */
export type SensitivityBinding = Readonly<{
  ref_id: string;
  parameter_id: string;
  /** Fixed here, or null when the open decision's branches choose the version. */
  parameter_version: string | null;
}>;


// --- L6-3 / D1: working time — the §16(א) tiers over a day's overtime hours -
//
// The first two overtime hours of a day at the first-tier premium, every hour
// after them at the second, each on the regular hourly wage: tiered.rate is
// exactly that computation. Both premiums are visual citations of the 1951
// page (batch 11), registered inferred_visual; the draft binds them as drafts
// and the report shows the grade. The output is the pay due for the overtime
// hours, premium included.
export const WORKING_TIME_OVERTIME_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.working.time.overtime.pay",
  rule_spec_version: "1.0.0",
  topic: "working_time",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_HOURS_WORK_REST_LAW@discovery-v0"],
  effective_period: { from: "1951-09-27", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [
    { ref_id: "fact.overtime.hours.day", value_kind: "integer", unit: "hours" },
    { ref_id: "fact.regular.hourly.wage", value_kind: "money", unit: "currency.ils" },
  ],
  parameters: [
    { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
    { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
  ],
  nodes: [
    {
      node_id: "overtime.pay",
      operation: "tiered.rate",
      input_ref: "fact.overtime.hours.day",
      base_ref: "fact.regular.hourly.wage",
      tiers: [
        { from_inclusive: 0, to_exclusive: 2, rate_ref: "parameter.rate.first" },
        { from_inclusive: 2, to_exclusive: null, rate_ref: "parameter.rate.second" },
      ],
      rounding: "half_up",
    },
  ],
  output_ref: "overtime.pay",
  golden_case_set_sha256: blankGoldenSetSha256("working_time"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

// --- L7-9 / D6: a day's overtime from hours worked and the daily threshold --
//
// §2(א) of the 1951 law: a working day shall not exceed eight hours. The
// overtime of a day is the hours worked beyond that threshold; the L6-3 spec
// above prices overtime hours it is GIVEN, this one derives them. The
// threshold is an open decision with two readings: the statute's eight hours
// (bound, through the lexicon from the word שמונה on page 1), and the Labour
// Ministry directive of 10.6.2018 — 8.6 hours on a five-day week, 7.6 on a
// six-day week — whose official text is not discoverable (BL-24) and which
// is therefore an UNBOUND branch, named and not run. A copy of the directive
// on a non-official site is a mirror and is not acceptable as a source.
export const WORKING_TIME_DAILY_THRESHOLD_DECISION = "legal.reference.il.decision.working_time_daily_threshold";

export const WORKING_TIME_OVERTIME_FROM_HOURS_WORKED_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.working.time.overtime.from.hours.worked",
  rule_spec_version: "1.0.0",
  topic: "working_time",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_HOURS_WORK_REST_LAW@discovery-v0"],
  effective_period: { from: "1951-09-27", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [
    { ref_id: "fact.hours.worked.day", value_kind: "integer", unit: "hours" },
    { ref_id: "fact.regular.hourly.wage", value_kind: "money", unit: "currency.ils" },
  ],
  parameters: [
    { ref_id: "parameter.daily.threshold", parameter_id: "il.working_time.daily_overtime_threshold_hours", parameter_version: "1951.1.0", value_kind: "integer", unit: "hours" },
    { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
    { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
  ],
  nodes: [
    { node_id: "zero.hours", operation: "constant.integer", value: 0, unit: "hours" },
    { node_id: "hours.over.threshold", operation: "subtract", left_ref: "fact.hours.worked.day", right_ref: "parameter.daily.threshold" },
    // A day within the threshold has no overtime — zero, not a refusal and
    // not a negative count.
    { node_id: "overtime.hours", operation: "max", refs: ["hours.over.threshold", "zero.hours"] },
    {
      node_id: "overtime.pay",
      operation: "tiered.rate",
      input_ref: "overtime.hours",
      base_ref: "fact.regular.hourly.wage",
      tiers: [
        { from_inclusive: 0, to_exclusive: 2, rate_ref: "parameter.rate.first" },
        { from_inclusive: 2, to_exclusive: null, rate_ref: "parameter.rate.second" },
      ],
      rounding: "half_up",
    },
  ],
  output_ref: "overtime.pay",
  golden_case_set_sha256: blankGoldenSetSha256("working_time"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

// --- L6-4 / D2: overtime on the weekly rest — a composition, not a figure ---
//
// §17(א)(1) states 1½ for rest-day hours; §16(א) states 1¼ and 1½ for
// overtime. What an overtime hour ON the rest day pays is a composition of the
// two, and the composition rule is a reading: additive (the rest premium plus
// the overtime increment) or multiplicative (the rest premium times the
// overtime premium). Neither 175 nor 200 is authored anywhere; each branch
// derives its rates from the registered parameters through the executor,
// under the open decision rest_day_overtime_composition.
function restDayCompositionSpec(branch: "additive" | "multiplicative"): RuleSpecPackage {
  const one = { node_id: "one", operation: "constant.rational" as const, value: "1" as const, unit: "ratio" };
  const composed = branch === "additive"
    ? [
      { node_id: "increment.first", operation: "subtract" as const, left_ref: "parameter.rate.first", right_ref: "one" },
      { node_id: "increment.second", operation: "subtract" as const, left_ref: "parameter.rate.second", right_ref: "one" },
      { node_id: "rest.rate.first", operation: "add" as const, refs: ["parameter.rate.rest", "increment.first"] },
      { node_id: "rest.rate.second", operation: "add" as const, refs: ["parameter.rate.rest", "increment.second"] },
    ]
    : [
      { node_id: "rest.rate.first", operation: "multiply" as const, left_ref: "parameter.rate.rest", right_ref: "parameter.rate.first" },
      { node_id: "rest.rate.second", operation: "multiply" as const, left_ref: "parameter.rate.rest", right_ref: "parameter.rate.second" },
    ];
  return createRuleSpecPackage({
    schema_version: "tivdoc-rulespec-v0.6.0",
    rule_spec_id: `il.rulespec.working.time.rest.day.overtime.${branch}`,
    rule_spec_version: "1.0.0",
    topic: "working_time",
    catalog_boundary: "real_inactive",
    source_version_ids: ["IL_HOURS_WORK_REST_LAW@discovery-v0"],
    effective_period: { from: "1951-09-27", to: null },
    sectors: ["general"],
    populations: ["general"],
    facts: [
      { ref_id: "fact.rest.day.overtime.hours.day", value_kind: "integer", unit: "hours" },
      { ref_id: "fact.regular.hourly.wage", value_kind: "money", unit: "currency.ils" },
    ],
    parameters: [
      { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
      { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
      { ref_id: "parameter.rate.rest", parameter_id: "il.working_time.weekly_rest_rate", parameter_version: "1951.1.0", value_kind: "rational", unit: "ratio" },
    ],
    nodes: [
      ...(branch === "additive" ? [one] : []),
      ...composed,
      {
        node_id: "rest.day.overtime.pay",
        operation: "tiered.rate" as const,
        input_ref: "fact.rest.day.overtime.hours.day",
        base_ref: "fact.regular.hourly.wage",
        tiers: [
          { from_inclusive: 0, to_exclusive: 2, rate_ref: "rest.rate.first" },
          { from_inclusive: 2, to_exclusive: null, rate_ref: "rest.rate.second" },
        ],
        rounding: "half_up" as const,
      },
    ],
    output_ref: "rest.day.overtime.pay",
    golden_case_set_sha256: blankGoldenSetSha256("working_time"),
    resource_policy: { max_steps: 12, max_depth: 6, max_aggregate_items: 8, max_integer_digits: 32 },
  });
}
export const REST_DAY_OVERTIME_ADDITIVE_SPEC: RuleSpecPackage = restDayCompositionSpec("additive");
export const REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC: RuleSpecPackage = restDayCompositionSpec("multiplicative");
export const REST_DAY_OVERTIME_COMPOSITION_DECISION = "legal.reference.il.decision.rest_day_overtime_composition";


// --- L6-5 / D7: the employee's contribution, under the precedence decision -
//
// The pensionable wage is the cap scaled by the scenario's multiplier (as the
// cap spec does); the contribution is that wage times the employee share.
// Which share — the 2011 order's 1.1.2014 row (5.5%) or the 2016 order's
// 1.1.2017 row (6%, read from the page image) — is the open decision, and the
// report runs both. The cap is pinned to one of its own two versions so this
// spec carries exactly one decision.
export const PENSION_CONTRIBUTION_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.pension.employee.contribution",
  rule_spec_version: "1.0.0",
  topic: "pension",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0", "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2"],
  effective_period: { from: "2014-01-01", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.pensionable.wage.multiplier", value_kind: "rational", unit: "ratio" }],
  parameters: [
    { ref_id: "parameter.wage.cap", parameter_id: "il.pension.mandatory_wage_cap", parameter_version: "2026.1.0", value_kind: "money", unit: "currency.ils" },
    { ref_id: "parameter.employee.share", parameter_id: "il.pension.employee_contribution_rate", parameter_version: "2017.1.0", value_kind: "rational", unit: "ratio" },
  ],
  nodes: [
    { node_id: "pensionable.wage", operation: "money.scale", money_ref: "parameter.wage.cap", rational_ref: "fact.pensionable.wage.multiplier", rounding: "half_up" },
    { node_id: "employee.contribution", operation: "money.scale", money_ref: "pensionable.wage", rational_ref: "parameter.employee.share", rounding: "half_up" },
  ],
  output_ref: "employee.contribution",
  golden_case_set_sha256: blankGoldenSetSha256("pension"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});


// --- L6-6 / D4 (P-29): convalescence days by seniority, the 1988 order -----
//
// §4(א) of the 1988 order: days of convalescence by completed years of service
// at the plant — a band table, looked up by a whole year. Year 0 is the edge of
// the table and refuses: §4(ב) says entitlement starts after the first year is
// completed, and a spec that priced year 0 would be inventing a row. Which
// instrument governs today (this order, or the 1998 agreement that restates
// bands) is the draft's precedence slot; the spec computes what THIS instrument
// says.
export const CONVALESCENCE_DAYS_SPEC: RuleSpecPackage = createRuleSpecPackage({
  schema_version: "tivdoc-rulespec-v0.6.0",
  rule_spec_id: "il.rulespec.convalescence.days.by.seniority",
  rule_spec_version: "1.0.0",
  topic: "convalescence",
  catalog_boundary: "real_inactive",
  source_version_ids: ["IL_CONVALESCENCE_EXTENSION_ORDER_1988@discovery-v0"],
  effective_period: { from: "1988-11-14", to: null },
  sectors: ["general"],
  populations: ["general"],
  facts: [{ ref_id: "fact.years.employed", value_kind: "integer", unit: "count.years" }],
  parameters: [
    { ref_id: "parameter.days.year.1", parameter_id: "il.convalescence.days_year_1", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
    { ref_id: "parameter.days.years.2.to.3", parameter_id: "il.convalescence.days_years_2_to_3", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
    { ref_id: "parameter.days.years.4.to.10", parameter_id: "il.convalescence.days_years_4_to_10", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
    { ref_id: "parameter.days.years.11.to.15", parameter_id: "il.convalescence.days_years_11_to_15", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
    { ref_id: "parameter.days.years.16.to.19", parameter_id: "il.convalescence.days_years_16_to_19", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
    { ref_id: "parameter.days.years.20.and.above", parameter_id: "il.convalescence.days_years_20_and_above", parameter_version: "1988.1.0", value_kind: "integer", unit: "days" },
  ],
  nodes: [
    {
      node_id: "days.by.band",
      operation: "band.lookup",
      input_ref: "fact.years.employed",
      bands: [
        { from_inclusive: 1, to_exclusive: 2, value_ref: "parameter.days.year.1" },
        { from_inclusive: 2, to_exclusive: 4, value_ref: "parameter.days.years.2.to.3" },
        { from_inclusive: 4, to_exclusive: 11, value_ref: "parameter.days.years.4.to.10" },
        { from_inclusive: 11, to_exclusive: 16, value_ref: "parameter.days.years.11.to.15" },
        { from_inclusive: 16, to_exclusive: 20, value_ref: "parameter.days.years.16.to.19" },
        { from_inclusive: 20, to_exclusive: null, value_ref: "parameter.days.years.20.and.above" },
      ],
    },
  ],
  output_ref: "days.by.band",
  golden_case_set_sha256: blankGoldenSetSha256("convalescence"),
  resource_policy: { max_steps: 8, max_depth: 4, max_aggregate_items: 8, max_integer_digits: 32 },
});

export type SensitivitySpec = Readonly<{
  spec: RuleSpecPackage;
  bindings: readonly SensitivityBinding[];
  decision_id: string | null;
  branches: ReadonlyArray<readonly [string, string]>;
  narrower_than_draft: string | null;
  // L6-4 / D2. A decision whose branches are different COMPUTATIONS over the
  // same parameters, not different parameter versions: each branch is its own
  // spec, named here, and the report compares the two specs' outputs per
  // scenario under the one decision id.
  composition_branch?: string;
  // L7-9 / D6. A decision may have a branch that is named but not bound — a
  // reading whose source is not in the corpus. It is listed here with the
  // reason, is never run, and the report shows it as not run rather than
  // omitting it.
  unbound_branches?: ReadonlyArray<Readonly<{ branch: string; reason: string }>>;
}>;

export const SENSITIVITY_SPECS: readonly SensitivitySpec[] = Object.freeze([
  {
    spec: MINIMUM_WAGE_HOURLY_SPEC,
    bindings: [{ ref_id: "parameter.hourly.floor", parameter_id: "il.minimum_wage.hourly", parameter_version: null }],
    decision_id: "legal.reference.il.decision.min_wage_hourly_divisor",
    branches: [["182", "2026.1.0"], ["186", "2026.2.0"]],
    narrower_than_draft: null,
  },
  {
    spec: PENSION_WAGE_CAP_SPEC,
    bindings: [{ ref_id: "parameter.wage.cap", parameter_id: "il.pension.mandatory_wage_cap", parameter_version: null }],
    decision_id: "legal.reference.il.decision.pension_wage_cap_section",
    branches: [["section1", "2026.1.0"], ["section2", "2026.2.0"]],
    narrower_than_draft:
      "Binds only the mandatory wage cap. The full pension draft also needs il.pension.employee_contribution_rate — registered at 2014.1.0 in L4-1 from the 2011 order's own table, but that instrument's last row is 2014 and whether a later instrument governs is the open precedence question, so this spec does not reach for it.",
  },
  {
    spec: TRAVEL_DAILY_CAP_SPEC,
    bindings: [{ ref_id: "parameter.daily.cap", parameter_id: "il.travel.daily_reimbursement_cap", parameter_version: "2016.1.0" }],
    decision_id: null,
    branches: [],
    narrower_than_draft: null,
  },
  {
    spec: VACATION_SENIORITY_BAND_SPEC,
    bindings: [
      { ref_id: "parameter.days.years.1.to.5", parameter_id: "il.vacation.calendar_days_years_1_to_5", parameter_version: "2017.1.0" },
      { ref_id: "parameter.days.year.6", parameter_id: "il.vacation.calendar_days_year_6", parameter_version: "1951.1.0" },
      { ref_id: "parameter.days.year.7", parameter_id: "il.vacation.calendar_days_year_7", parameter_version: "1951.1.0" },
      { ref_id: "parameter.increment.per.year", parameter_id: "il.vacation.calendar_days_increment_per_year_from_year_8", parameter_version: "1951.1.0" },
      { ref_id: "parameter.days.cap", parameter_id: "il.vacation.calendar_days_years_8_and_above_cap", parameter_version: "1951.1.0" },
    ],
    decision_id: null,
    branches: [],
    narrower_than_draft:
      "The whole of §3(א): a band table for years one to seven and, from the eighth, 21 + 1 × (years − 7) capped at 28. The figures 22 to 27 are computed from three cited parameters, not written into the spec; the one shape integer is the year-7 boundary. Year zero refuses.",
  },
  {
    spec: SICK_PAY_ACCRUAL_SPEC,
    bindings: [
      { ref_id: "parameter.accrual.per.month", parameter_id: "il.sick_pay.accrual_days_per_month", parameter_version: "1.0.0" },
      { ref_id: "parameter.accrual.cap", parameter_id: "il.sick_pay.accrual_cap_days", parameter_version: "1.0.0" },
    ],
    decision_id: null,
    branches: [],
    narrower_than_draft:
      "Accrual only, §4(א): 1.5 days per full month of work, to a ceiling of 90. The output is a day count, not money. The derived unit days_per_month × months = days is what let these two parameters meet.",
  },
  {
    spec: SICK_PAY_DAILY_RATE_SPEC,
    bindings: [
      { ref_id: "parameter.rate.days.2.to.3", parameter_id: "il.sick_pay.rate_days_2_to_3", parameter_version: "1.0.0" },
      { ref_id: "parameter.daily.wage", parameter_id: "il.minimum_wage.daily_5day", parameter_version: "2026.1.0" },
    ],
    decision_id: null,
    branches: [],
    narrower_than_draft:
      "The rate on day n of an absence at the 5-day-week daily minimum wage, §2(א) with §5(א). Half from the second and third day is a word in the text and binds through the lexicon (מחצית). Full from the fourth is the identity — §2(א)(1) says 'payment under this law' and §5(א) defines that payment as the wage — and is the constant 1, not a cited figure. Day one is stated by omission, has no exclusion clause to bind a zero from, and refuses.",
  },
  {
    spec: CONVALESCENCE_DAILY_RATE_SPEC,
    bindings: [{ ref_id: "parameter.daily.rate", parameter_id: "il.convalescence.daily_rate", parameter_version: null }],
    decision_id: "legal.reference.il.decision.convalescence_2026_rate_period",
    branches: [["calendar_year_2026", "2026.1.0"], ["from_signature_2026_07", "2026.2.0"]],
    narrower_than_draft:
      "The day rate the 2026 order states, 451.50, cited into the instrument selection over the 2026 gazette issue; the 2023 order's 418 is registered beside it from its own selection. The open decision is the period the 2026 rate covers — the order says 'for the convalescence year 2026' and is signed in July — and both branches carry the same figure, so no scenario separates them in amount. The full draft also needs the seniority-band day counts, which are not in the corpus.",
  },
  // L6-3: working time runs — both §16(א) premiums are visual citations.
  {
    spec: WORKING_TIME_OVERTIME_SPEC,
    bindings: [
      { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0" },
    ],
    decision_id: null,
    branches: [],
    narrower_than_draft:
      "Binds the two §16(א) premiums, read from the page image (inferred_visual, awaiting visual confirmation at attestation). The full draft also carries the 42-hour weekly threshold and the 2018 permit's caps, which bound the hours a scenario may supply rather than price them; this spec prices the hours it is given.",
  },
  // L7-9 / D6: the day's overtime from hours worked and the threshold.
  {
    spec: WORKING_TIME_OVERTIME_FROM_HOURS_WORKED_SPEC,
    bindings: [
      { ref_id: "parameter.daily.threshold", parameter_id: "il.working_time.daily_overtime_threshold_hours", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0" },
    ],
    decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION,
    branches: [["statute", "1951.1.0"]],
    unbound_branches: [{
      branch: "administrative",
      reason: "BL-24: the Labour Ministry directive of 10.6.2018 (8.6 hours on a five-day week, 7.6 on a six-day week) is not discoverable on an official host; a copy on a non-official site is a mirror and is not acceptable. Unbound; not run; would bind at administrative grade.",
    }],
    narrower_than_draft:
      "Derives the day's overtime from hours worked and the daily threshold, then prices it by the §16(א) tiers. The statute branch binds eight hours from §2(א) through the lexicon (text_verified); the administrative branch is unbound (BL-24). The full draft also carries the 42-hour weekly threshold and the 2018 permit's caps.",
  },
  // L6-4: overtime on the weekly rest, one decision, two computations.
  {
    spec: REST_DAY_OVERTIME_ADDITIVE_SPEC,
    bindings: [
      { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.rest", parameter_id: "il.working_time.weekly_rest_rate", parameter_version: "1951.1.0" },
    ],
    decision_id: REST_DAY_OVERTIME_COMPOSITION_DECISION,
    branches: [],
    composition_branch: "additive",
    narrower_than_draft: "The additive reading: the rest premium plus the overtime increment. 175% and 200% appear as outputs of the executor, never as figures in a source.",
  },
  {
    spec: REST_DAY_OVERTIME_MULTIPLICATIVE_SPEC,
    bindings: [
      { ref_id: "parameter.rate.first", parameter_id: "il.working_time.overtime_rate_first_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.second", parameter_id: "il.working_time.overtime_rate_second_tier", parameter_version: "1951.1.0" },
      { ref_id: "parameter.rate.rest", parameter_id: "il.working_time.weekly_rest_rate", parameter_version: "1951.1.0" },
    ],
    decision_id: REST_DAY_OVERTIME_COMPOSITION_DECISION,
    branches: [],
    composition_branch: "multiplicative",
    narrower_than_draft: "The multiplicative reading: the rest premium times the overtime premium — 187.5% and 225%, again outputs and not figures.",
  },
  // L6-5 / D7: the pension precedence, both branches executed.
  {
    spec: PENSION_CONTRIBUTION_SPEC,
    bindings: [
      { ref_id: "parameter.wage.cap", parameter_id: "il.pension.mandatory_wage_cap", parameter_version: "2026.1.0" },
      { ref_id: "parameter.employee.share", parameter_id: "il.pension.employee_contribution_rate", parameter_version: null },
    ],
    decision_id: "legal.reference.il.decision.pension_2011_2016_precedence",
    branches: [["order_2011_2014_row", "2014.2.0"], ["order_2016_2017_rates", "2017.1.0"]],
    narrower_than_draft:
      "Binds the employee share under the precedence decision and pins the wage cap to its section-1 version so the spec carries one decision; the cap's own decision runs in the cap spec. The 2017 share is a visual citation of an image-only scan (inferred_visual).",
  },
  // L6-6 / D4 (P-29): the 1988 seniority bands, text-verified.
  {
    spec: CONVALESCENCE_DAYS_SPEC,
    bindings: [
      { ref_id: "parameter.days.year.1", parameter_id: "il.convalescence.days_year_1", parameter_version: "1988.1.0" },
      { ref_id: "parameter.days.years.2.to.3", parameter_id: "il.convalescence.days_years_2_to_3", parameter_version: "1988.1.0" },
      { ref_id: "parameter.days.years.4.to.10", parameter_id: "il.convalescence.days_years_4_to_10", parameter_version: "1988.1.0" },
      { ref_id: "parameter.days.years.11.to.15", parameter_id: "il.convalescence.days_years_11_to_15", parameter_version: "1988.1.0" },
      { ref_id: "parameter.days.years.16.to.19", parameter_id: "il.convalescence.days_years_16_to_19", parameter_version: "1988.1.0" },
      { ref_id: "parameter.days.years.20.and.above", parameter_id: "il.convalescence.days_years_20_and_above", parameter_version: "1988.1.0" },
    ],
    decision_id: null,
    branches: [],
    narrower_than_draft:
      "Computes the days the 1988 order states for a completed year of service; year 0 refuses at the table's edge. Whether the 1988 order or the 1998 agreement governs today is the draft's precedence slot, left unbound.",
  },
]);
