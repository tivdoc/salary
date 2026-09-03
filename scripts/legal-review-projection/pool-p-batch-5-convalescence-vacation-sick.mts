// Pool P batch 5 (Addendum 5): P-30, P-34, P-35.
//
// Not registered here (recorded blocked_dependency in the state-doc
// checkpoint, each with a one-line, corpus-anchored reason):
//  - P-26 (2023 convalescence rate, 418): source parse_failed
//    (instrument_selector_pending_human_review).
//  - P-27/P-28 (2026 convalescence order rate + period, public 511.6):
//    the fetched IL_CONVALESCENCE_EXTENSION_ORDER_2026 artifact contains
//    no occurrence of the word "convalescence" (הבראה, in either letter
//    order) anywhere across its 14 chunks — its actual content is an
//    unrelated set of government-appointment notices, not this order. A
//    genuine content mismatch on a registered source, not a fabricable
//    citation.
//  - P-29 (seniority bands 5/6/7/8/9/10 days): not found in the 1988
//    order's 4 built chunks; the dossier's own tracker 6.17 already flags
//    this exact instrument's page-boundary segmentation as unreliable.
//  - P-31 (2025 half-day threshold, 6,150): the 2024 sibling law's 6,000
//    threshold is cleanly present in its own text (registered below as
//    P-30), but the 2025 law's PDF text layer is materially more garbled
//    (many multi-digit numbers extract as clearly-wrong fragments, e.g.
//    "5219", "5319") and no clean "6,150"/"6150" occurrence exists to cite
//    — the 418/471.4 frozen rates ARE clean in this same document, but
//    that is a different figure than the addendum's P-31 ask.
//  - P-32, P-33a/P-33b (calendar-days table; 5-day workday conversion):
//    the fetched IL_ANNUAL_VACATION_LAW gives 14 days for years 1-4 in
//    its own §3(a)(1) — the PRE-amendment-15 (2017) figure, not the
//    current 16 the dossier and addendum both expect (this same source's
//    own amendment footnote list stops at 2013, confirming it predates
//    2017's amendment 15). Binding a "current" parameter to a stale law
//    text would be wrong regardless of citation rigor. P-33's own
//    working-day conversion (11 vs 12) has no primary source in the
//    dossier's own account (its only source is an explanatory site) —
//    not a corpus gap, a genuine absence of an official target.
//  - P-36/P-37 (sick-pay payment tiers 0%/50%/100%): not found anywhere
//    in IL_SICK_PAY_LAW's 5 built chunks — the same "primary clause not in
//    this fetched text" pattern as the overtime-rate and pension-increase
//    gaps above.
import { buildCandidate, citation, importPoolPBatch } from "./pool-p-parameter-import.mts";

const D_CONV_2024 = { source_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2024", source_version: "discovery-v0.2" };
const D_VACATION = { source_id: "IL_ANNUAL_VACATION_LAW", source_version: "discovery-v0" };
const D_SICK = { source_id: "IL_SICK_PAY_LAW", source_version: "discovery-v0" };

const p30 = buildCandidate({
  parameter_id: "il.convalescence.2024_partial_reduction_wage_threshold",
  parameter_version: "2024.1.0",
  topic: "convalescence",
  value: { kind: "money", value: { currency: "ILS", minor_units: 600000 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2024-01-01",
  effective_to: "2024-12-31",
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [citation(D_CONV_2024, "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2024@discovery-v0.2#0005-7db36b4a7423",
    "Law on the Freeze and Reduction of Convalescence Pay in 2024 (for the funding of benefits for reserve-duty soldiers), definition of \"employee in partial reduction\": an employee whose average monthly salary over January-March 2024 does not exceed 6,000 new shekels (or the equivalent for a part-time position)",
    ["6,000"])],
});

const p34Full = buildCandidate({
  parameter_id: "il.vacation.full_year_relationship_minimum_days_threshold",
  parameter_version: "1.0.0",
  topic: "vacation",
  value: { kind: "integer", value: 200, unit: "days" },
  unit: "days",
  rounding_policy: "exact",
  effective_from: "1951-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["employment_relationship_spans_full_work_year"],
  support_roles: ["primary_binding"],
  citations: [citation(D_VACATION, "IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653",
    "Annual Vacation Law 1951 §3(b): where the legal employment relationship existed for the entire work-year and the employee worked in that year at least 200 days, the full vacation-day entitlement per §3(a) applies; fewer than 200 days pro-rates it. Caveat: this fetched artifact's own §3(a) day-count table is a pre-amendment-15 (2017) revision (its amendment footnote list stops at 2013) — cited here only for the 200/240-day threshold structure, not for any day-count figure in the same section.",
    ["200"])],
});
const p34Partial = buildCandidate({
  parameter_id: "il.vacation.partial_year_relationship_minimum_days_threshold",
  parameter_version: "1.0.0",
  topic: "vacation",
  value: { kind: "integer", value: 240, unit: "days" },
  unit: "days",
  rounding_policy: "exact",
  effective_from: "1951-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["employment_relationship_spans_partial_work_year"],
  support_roles: ["primary_binding"],
  citations: [citation(D_VACATION, "IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653",
    "Annual Vacation Law 1951 §3(c): where the legal employment relationship existed for only part of the work-year and the employee worked in that partial year at least 240 days, the full §3(a) entitlement applies; fewer than 240 pro-rates it. This resolves the research dossier's own \"200 vs 240, sources disagree\" flag (topic 6, open decision 2): they are not competing figures, they are the same section's two thresholds for two different situations (full-year vs partial-year employment relationship). Same source-vintage caveat as the full-year threshold above.",
    ["240"])],
});

const p35Accrual = buildCandidate({
  parameter_id: "il.sick_pay.accrual_days_per_month",
  parameter_version: "1.0.0",
  topic: "sick_leave",
  value: { kind: "rational", numerator: "3", denominator: "2", unit: "days_per_month" },
  unit: "days_per_month",
  rounding_policy: "exact",
  effective_from: "1976-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [citation(D_SICK, "IL_SICK_PAY_LAW@discovery-v0#0002-7e19a95f62cb",
    "Sick Pay Law 1976 §4: the maximum sick-pay entitlement period accrues at one and a half days for each full work month the employee worked for the same employer or at the same workplace",
    ["1.5"])],
});
const p35Cap = buildCandidate({
  parameter_id: "il.sick_pay.accrual_cap_days",
  parameter_version: "1.0.0",
  topic: "sick_leave",
  value: { kind: "integer", value: 90, unit: "days" },
  unit: "days",
  rounding_policy: "exact",
  effective_from: "1976-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [citation(D_SICK, "IL_SICK_PAY_LAW@discovery-v0#0003-b11393df222b",
    "Sick Pay Law 1976 §4(a): the accrued sick-pay entitlement period shall not exceed 90 days, deducting the period for which the employee already received sick pay under this law",
    ["90"])],
});

await importPoolPBatch("batch-5-convalescence-vacation-sick", [p30, p34Full, p34Partial, p35Accrual, p35Cap]);
