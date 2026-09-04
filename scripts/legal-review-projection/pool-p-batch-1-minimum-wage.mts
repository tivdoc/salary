// Pool P batch 1 (Addendum 5): P-1..P-6, minimum wage monthly/hourly/daily.
// Every numeric value and every citation below was looked up against the
// actual built chunks of the cited Pool D artifact (not typed from memory
// or from the research dossier's own tables) — pool-p-parameter-import.mts's
// citation() helper re-reads the chunk at run time and refuses to import if
// the cited chunk does not literally contain the quoted figure.
import { buildCandidate, citation, importPoolPBatch, TENANT } from "./pool-p-parameter-import.mts";

const D1 = { source_id: "IL_MIN_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const D2 = { source_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES", source_version: "discovery-v0" };
const D3 = { source_id: "IL_MIN_WAGE_LAW", source_version: "discovery-v0" };
const D8_182 = { source_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018", source_version: "discovery-v0.1" };

// The §6 47.5%-of-average-wage derivation clause. Present in the
// "consolidated_through_2015" text (D-3's own annotation, commit 6c73202) —
// this clause predates 2015 and is unaffected by that gap.
const derivationClause = citation(D3, "IL_MIN_WAGE_LAW@discovery-v0#0002-bcf9eab6819e",
  "Minimum Wage Law 1987 §6 — monthly minimum wage = 47.5% of the average wage per National Insurance Law §1, as of 1 April each year",
  ["47.5"]);

const HOURLY_DIVISOR_DECISION = `${TENANT}.decision.min_wage_hourly_divisor`;

const MONTHLY = [
  {
    parameter_version: "2023.1.0", effective_from: "2023-04-01", effective_to: "2024-03-31",
    minor_units: 557175,
    avgWage: citation(D2, "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0011-597f613d66a4", "Average wage per National Insurance Law §1, effective 1.1.2023: 11,730 ILS", ["11,730"]),
    corroboration: citation(D1, "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0010-12819b83ab84", "BTL published monthly rate table row, effective 1.4.2023", ["5,571.75"]),
  },
  {
    parameter_version: "2024.1.0", effective_from: "2024-04-01", effective_to: "2025-03-31",
    minor_units: 588002,
    avgWage: citation(D2, "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0007-a497d09cf256", "Average wage per National Insurance Law §1, effective 1.1.2024: 12,379 ILS", ["12,379"]),
    corroboration: citation(D1, "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0009-b04d9d5b7243", "BTL published monthly rate table row, effective 1.4.2024", ["5,880.02"]),
  },
  {
    parameter_version: "2025.1.0", effective_from: "2025-04-01", effective_to: "2026-03-31",
    minor_units: 624767,
    avgWage: citation(D2, "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0004-4756224b67b5", "Average wage per National Insurance Law §1, effective 1.1.2025: 13,153 ILS", ["13,153"]),
    corroboration: citation(D1, "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0007-94349aa03f47", "BTL published monthly rate table row, effective 1.4.2025", ["6,247.67"]),
  },
  {
    parameter_version: "2026.1.0", effective_from: "2026-04-01", effective_to: null,
    minor_units: 644385,
    avgWage: citation(D2, "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0002-00fe06cb93a9", "Average wage per National Insurance Law §1, effective 1.1.2026: 13,566 ILS (§1 figure — §2 gives 13,769; the pension wage-cap open decision, P-24a/b, is about which of the two applies there, not here — the minimum-wage derivation always uses §1)", ["13,566"]),
    corroboration: citation(D1, "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0002-ec7402f2ab89", "BTL published monthly rate table row, effective 1.4.2026", ["6,443.85"]),
  },
];

const candidates = MONTHLY.map((row) => buildCandidate({
  parameter_id: "il.minimum_wage.monthly",
  parameter_version: row.parameter_version,
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: row.minor_units } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: row.effective_from,
  effective_to: row.effective_to,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [derivationClause, row.avgWage, row.corroboration],
}));

// P-5a/P-5b: the two hourly rates BTL publishes side by side for the
// current period — an open decision (research dossier Finding 3) between
// the statutory ÷186 (Minimum Wage Law §6, as consolidated through 2015 —
// the exact ÷186 divisor clause itself is a later amendment not yet in that
// consolidated text; D-3's own citation here is the general §6 derivation
// authority, not a literal "186" token) and the ÷182 the 2018 42-hour-week
// extension order produces in practice (Ministry of Labor directive
// 10.6.2018 enforces ÷182; that directive has no separately fetched
// artifact of its own, so P-5a's legal-basis citation is the extension
// order that produces the 182-hour month, not the directive itself).
const hourlyRateChunk = { source_id: D1.source_id, source_version: D1.source_version, id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0002-ec7402f2ab89" };
const p5a = buildCandidate({
  parameter_id: "il.minimum_wage.hourly",
  parameter_version: "2026.1.0",
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: 3540 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [
    citation(D1, hourlyRateChunk.id, "BTL: hourly minimum wage on a 182-hour month, effective 1.4.2026", ["35.4"]),
    citation(D8_182, "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1#0001-c383d0ba2158",
      "General 42-hour work-week extension order, 19.3.2018 (in force 1.4.2018): the work week is shortened to 42 hours with no reduction in pay — the extension order text itself states the 42-hour week, not the derived 182 hours/month figure", ["42"]),
  ],
  decision_id: HOURLY_DIVISOR_DECISION,
  branch: "182",
});
const p5b = buildCandidate({
  parameter_id: "il.minimum_wage.hourly",
  parameter_version: "2026.2.0",
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: 3464 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [
    citation(D1, hourlyRateChunk.id, "BTL: hourly minimum wage on a 186-hour month, effective 1.4.2026", ["34.64"]),
    derivationClause,
  ],
  decision_id: HOURLY_DIVISOR_DECISION,
  branch: "186",
});

// P-6: daily rates, BTL-published, cross-cited to the §6 derivation per the
// dossier's own explicit conclusion (#5): "IL_MIN_WAGE_OFFICIAL_RATES
// remains an implementation, not a source for the parameter on its own."
const p6six = buildCandidate({
  parameter_id: "il.minimum_wage.daily_6day",
  parameter_version: "2026.1.0",
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: 25775 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["employed_6day_week"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [derivationClause, citation(D1, hourlyRateChunk.id, "BTL: daily minimum wage, 6-day work week, effective 1.4.2026", ["257.75"])],
});
const p6five = buildCandidate({
  parameter_id: "il.minimum_wage.daily_5day",
  parameter_version: "2026.1.0",
  topic: "minimum_wage",
  value: { kind: "money", value: { currency: "ILS", minor_units: 29740 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2026-04-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["employed_5day_week"],
  support_roles: ["primary_binding", "official_implementation"],
  citations: [derivationClause, citation(D1, hourlyRateChunk.id, "BTL: daily minimum wage, 5-day work week, effective 1.4.2026", ["297.4"])],
});

await importPoolPBatch("batch-1-minimum-wage", [...candidates, p5a, p5b, p6six, p6five], [
  {
    decision_id: HOURLY_DIVISOR_DECISION,
    topic: "minimum_wage",
    question: "Research dossier Finding 3: the law says the hourly minimum wage is the monthly rate divided by 186 hours (Minimum Wage Law §6, as far as the currently fetched consolidated text — through 2015 — establishes); the 2018 general 42-hour work-week extension order plus the Ministry of Labor's 10.6.2018 enforcement directive instead divide by 182, and BTL, the Ministry, and employers use 182 in practice. Which divisor governs, and does 186 remain relevant for any employee not covered by the extension order?",
    dossier_anchor: "docs/legal/research-dossier-2026-09-03.md#1-שכר-מינימום, finding 3",
  },
]);
