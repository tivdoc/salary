// Pool P batch 20 (run 12, L12-1 / D1). The five-day daily norm, derived.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-20-derived-daily-norm.mts
//
// Run 11 recorded the owner's default for working_time_daily_threshold as
// `administrative` — 8.6 hours on four days and 7.6 on the shortened day of a
// five-day week — and left it unbound: no official artifact carries the
// figures (BL-24). They are not text. They are arithmetic on the 2018
// extension order plus one declared assumption, and this batch binds them as
// exactly that, at the grade `derived`:
//
//   weekly_after   42 hours  — §2.1: "כך ששבוע העבודה יעמוד על 42 שעות עבודה"
//   reduction       1 hour   — §2.1: "יקוצר בשעה אחת"; §2.2: "על ידי הפחתת שעת
//                              עבודה אחת ביום מוגדר וקבוע"
//   weekly_before  43 hours  — 42 + 1. The 2000 framework order's own sentence
//                              ("העובדים יעברו לשבוע עבודה בן 43 שעות") is NOT in
//                              the corpus; the figure rests on the 2018 order's
//                              one-hour reduction and its 42, and the record
//                              says so. Acquiring the 2000 order is the
//                              owner's, through the official path.
//   assumption     five_day_even_distribution: 43 ÷ 5 = 8.6, the reduced hour
//                              on one fixed day → 7.6; 4 × 8.6 + 7.6 = 42.
//                              Mandatory, on the row, in every rendering; V11
//                              (§5 ministerial approval) can invalidate it. The
//                              competing reading, 9 × 4 + 7, is the branch
//                              nine_hour_day and is not derived here.
//
//   il.working_time.daily_overtime_threshold_hours@2018.1.0      43/5 hours  branch administrative
//   il.working_time.short_day_overtime_threshold_hours@2018.1.0  38/5 hours
//
// Both cite the 2018 order's §2 chunk (text-verified inputs) and carry the
// same derivation record; the engine recomputes the record and refuses to
// build a candidate whose identity fails. Corroboration at interpretation
// grade — the steering committee of 24.4.2018 and kolzchut — is named on the
// record, never as a citation. Grade derived, never text_verified, never
// administrative. Draft; nothing attested; the resolution row is not touched.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { derivationSha256, deriveFiveDayDailyNorm, renderExact } from "../../src/engine/legal-operations/derivation.ts";
import { WORKING_TIME_DAILY_THRESHOLD_DECISION } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { buildCandidate, importPoolPBatch, tableAwareCitation, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const ORDER_2018 = { source_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018", source_version: "discovery-v0.1" };
// The table-aware chunk: its logical-order text is what a person reads and what
// the needles and the anchor are checked against (the v0 chunk of this scan is
// in visual order, letter by letter reversed).
const CHUNK_2 = "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1#t0001-c383d0ba2158";
const ANCHOR_2 = "היקף שבוע עבודה במשק יקוצר";

export const FIVE_DAY_DERIVATION = deriveFiveDayDailyNorm({
  weekly_after: {
    value: { numerator: "42", denominator: "1", unit: "hours_per_week" },
    source: { ...ORDER_2018, chunk_id: CHUNK_2 },
    locator: "General 42-hour work-week extension order, 19.3.2018 (in force 1.4.2018), §2.1: the work week is shortened by one hour so that the work week stands at 42 hours of work, with no reduction in pay",
  },
  reduction: {
    value: { numerator: "1", denominator: "1", unit: "hours" },
    source: { ...ORDER_2018, chunk_id: CHUNK_2 },
    locator: "§2.1 'יקוצר בשעה אחת' and §2.2: the shortening is carried out by reducing one working hour on a defined and fixed day of the work week (the shortened day)",
  },
  weekly_before: {
    value: { numerator: "43", denominator: "1", unit: "hours_per_week" },
    source: null,
    origin: "derived_step",
    locator: "weekly_after + reduction = 42 + 1 = 43. The 2000 framework extension order's sentence 'העובדים יעברו לשבוע עבודה בן 43 שעות ללא הפחתה בשכר' is not in the corpus; the pre-reduction week rests on the 2018 order's own one-hour reduction and its 42",
  },
  assumption: {
    days_per_week: 5,
    reduced_days: 1,
    statement: "The 43-hour week is spread evenly over the five working days of a five-day week (43 ÷ 5 = 8.6), and the one reduced hour falls on one defined, fixed day (8.6 − 1 = 7.6). The order states the reduction and the fixed day; the even spreading is assumed.",
    competing_reading: "nine_hour_day",
    invalidated_by: "V11 — the lawyer's answer on §5 ministerial approval of the shortened-week agreements (1988/1990/1996/2000/2017) can invalidate the even-distribution assumption; V12 — the 1990 and 2000 orders' wording",
  },
  corroboration: [
    { source: "steering_committee_2018-04-24", grade: "agreement_interpretation", note: "the steering committee's interpretation of the 42-hour order: 8.6 hours on four days, 7.6 on the shortened day" },
    { source: "kolzchut", grade: "agreement_interpretation", note: "reports the committee's reading; a non-official page, corroboration only, not a citation" },
  ],
});

const inputs = [
  tableAwareCitation(ORDER_2018, CHUNK_2,
    "General 42-hour work-week extension order, 19.3.2018 (in force 1.4.2018), §2.1–2.2: the week is shortened by one hour to 42 hours of work with no reduction in pay, by reducing one working hour on a defined and fixed day (the shortened day). Input of the derivation five_day_daily_norm_from_weekly_reduction; the figures 8.6 and 7.6 are not in this text.",
    ["42 שעות", "בשעה אחת", "ביום מוגדר וקבוע"], ANCHOR_2),
];

function derived(parameterId: string, value: { numerator: string; denominator: string; unit: string }, branch: string | null) {
  return buildCandidate({
    parameter_id: parameterId,
    parameter_version: "2018.1.0",
    topic: "working_time",
    value: { kind: "rational", numerator: value.numerator, denominator: value.denominator, unit: value.unit },
    unit: value.unit,
    rounding_policy: "exact",
    effective_from: "2018-04-01",
    effective_to: null,
    sectors: ["general"],
    populations: ["general"],
    support_roles: ["primary_binding"],
    citations: inputs,
    ...(branch ? { decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION, branch } : {}),
    derivation: FIVE_DAY_DERIVATION,
  });
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const regularDay = derived("il.working_time.daily_overtime_threshold_hours", FIVE_DAY_DERIVATION.outputs.regular_day, "administrative");
  const shortDay = derived("il.working_time.short_day_overtime_threshold_hours", FIVE_DAY_DERIVATION.outputs.short_day, null);
  const candidates = [regularDay, shortDay];
  for (const candidate of candidates) {
    if (candidate.provenance_grade !== "derived" || candidate.derivation === undefined) throw new Error(`L121_NOT_DERIVED:${candidate.parameter_id}`);
  }
  await importPoolPBatch("batch-20-derived-daily-norm", candidates);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-20-v1",
    unit: "L12-1 / D1",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    candidate_sha256: Object.fromEntries(candidates.map((entry) => [`${entry.parameter_id}@${entry.parameter_version}`, entry.candidate_sha256])),
    provenance_grade: "derived",
    derivation_sha256: derivationSha256(FIVE_DAY_DERIVATION),
    derivation: FIVE_DAY_DERIVATION,
    values: { regular_day: renderExact(FIVE_DAY_DERIVATION.outputs.regular_day), short_day: renderExact(FIVE_DAY_DERIVATION.outputs.short_day) },
    decision: { decision_id: WORKING_TIME_DAILY_THRESHOLD_DECISION, branch: "administrative", bound: true, grade: "derived" },
    assumption_slot: FIVE_DAY_DERIVATION.assumption.slot,
    inputs_cited: [CHUNK_2],
    weekly_before_source: "derived_step (42 + 1); the 2000 framework order is not in the corpus",
    blocked_ledger: "BL-24 closes as bound_derived_pending_V11: the branch is bound at grade derived on a stated assumption that V11 can invalidate; no official artifact carries 8.6 / 7.6 and none is claimed",
    state: "draft",
    attestations: 0,
    resolution_row_touched: false,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-20-derived-daily-norm.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L12_1_BATCH20 ${JSON.stringify({ registered: candidates.length, grade: "derived", regular_day: receipt.values.regular_day, short_day: receipt.values.short_day, derivation_sha256: receipt.derivation_sha256.slice(0, 16) })}`);
}

await main();
