// Pool P batch 10 (L5-5, L5-6, L5-7 / D4, D6). Figures that sit inside selected
// instruments.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-10-selections.mts
//
// Every citation here goes through `selectionCitation()`: the chunk is a `#s`
// chunk of a registered instrument selection, the Hebrew anchor is mandatory
// and checked in the same chunk, and the selection's hash rides on the
// citation into the binding — attesting the parameter attests the boundary.
//
//   il.convalescence.daily_rate@2023.1.0   418.00 ILS  2023 order, selected span
//   il.convalescence.daily_rate@2026.1.0   451.50 ILS  2026 order, calendar year 2026
//   il.convalescence.daily_rate@2026.2.0   451.50 ILS  2026 order, from signature (27.7.2026)
//   il.working_time.daily_hours_cap_including_overtime@2018.1.0     12 hours_per_day
//   il.working_time.weekly_overtime_hours_cap@2018.1.0              16 hours_per_week
//   il.working_time.weekly_hours_cap_including_overtime@2018.1.0    58 hours_per_week
//
// One open decision: which twelve months the 2026 rate covers. The order says
// "for the convalescence year 2026" and is signed on 27 July 2026; the two
// branches carry the same figure with different periods.
//
// One date deliberately NOT read. The 2023 order's own start date reads
// `172023` in the text — the dots of 1.7.2023 collapsed by the layout parser —
// and could as easily be 17.2.2023. It is recorded in the locator as it stands
// and the parameter's effective date is the signature date the text spells out
// in words, 11 September 2023. The same collapse produces `3062024` for the
// end date; it is likewise recorded, not read.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, importPoolPBatch, selectionCitation, TABLE_AWARE_CITATIONS, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const ORDER_2023 = { source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2023", source_version: "discovery-v0.2" };
const ORDER_2026 = { source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2026", source_version: "discovery-v0.2" };
const PERMIT_2018 = { source_id: "IL_GENERAL_OVERTIME_PERMIT_2018", source_version: "discovery-v0.1" };

const CHUNK_2023 = "IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2#s0001-441d64217a93";
const CHUNK_2026 = "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2#s0001-3242816cc02a";
const CHUNK_2018 = "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1#s0001-d88c8300ebf8";

const CONVALESCENCE_ANCHOR = "גובה השתתפות המעסיק בהוצאות ההבראה";
const PERIOD_DECISION = `${TENANT}.decision.convalescence_2026_rate_period`;

const rate2023 = buildCandidate({
  parameter_id: "il.convalescence.daily_rate",
  parameter_version: "2023.1.0",
  topic: "convalescence",
  value: { kind: "money", value: { currency: "ILS", minor_units: 41800 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: "2023-09-11",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [selectionCitation(ORDER_2023, CHUNK_2023,
    "Convalescence extension order 2023 §3, instrument selection over gazette 11651 page 136: the employer's participation per convalescence day (מחיר יום הבראה) stands at 418 new shekels. The order's own start date reads `172023` in the text and its end date `3062024` — dots collapsed by the layout parser, each readable two ways — so neither is read; effective_from is the signature date the text spells out, 11 September 2023.",
    ["418"], CONVALESCENCE_ANCHOR)],
});

const rate2026 = (version: string, effectiveFrom: string, effectiveTo: string | null, branch: string) => buildCandidate({
  parameter_id: "il.convalescence.daily_rate",
  parameter_version: version,
  topic: "convalescence",
  value: { kind: "money", value: { currency: "ILS", minor_units: 45150 } },
  unit: "currency.ils",
  rounding_policy: "exact",
  effective_from: effectiveFrom,
  effective_to: effectiveTo,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  decision_id: PERIOD_DECISION,
  branch,
  citations: [selectionCitation(ORDER_2026, CHUNK_2026,
    `Convalescence extension order 2026 §3, instrument selection over gazette 14863 page 9134: the employer's participation per convalescence day for the convalescence year 2026 (מחיר יום הבראה) stands at 451.50 new shekels. Branch ${branch}: ${effectiveTo === null ? "from the signature date, 27 July 2026" : "the calendar year 2026"}.`,
    ["451.50"], CONVALESCENCE_ANCHOR)],
});

const cap = (parameterId: string, value: number, unit: string, needle: string, anchor: string, clause: string) => buildCandidate({
  parameter_id: parameterId,
  parameter_version: "2018.1.0",
  topic: "working_time",
  value: { kind: "integer", value, unit },
  unit,
  rounding_policy: "exact",
  effective_from: "2018-03-12",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [selectionCitation(PERMIT_2018, CHUNK_2018,
    `General overtime permit 2018, instrument selection over gazette 7732 pages 6286-6287: ${clause}. Signed 12 March 2018 (כ"ה באדר התשע"ח); effective_from is that date.`,
    [needle], anchor)],
});

const caps = [
  cap("il.working_time.daily_hours_cap_including_overtime", 12, "hours_per_day", "12 שעות", "אורך יום עבודה",
    "§1 — the length of a work day under §§2, 4 or 5 of the Law, overtime included, shall not exceed 12 hours"),
  cap("il.working_time.weekly_overtime_hours_cap", 16, "hours_per_week", "16 שעות נוספות", "בשבוע עבודה לא יועסק עובד מעל",
    "§2(א) — in a work week an employee shall not be employed for more than 16 overtime hours"),
  cap("il.working_time.weekly_hours_cap_including_overtime", 58, "hours_per_week", "58 שעות", "אורך שבוע עבודה לא יעלה על",
    "§2(ב) — the length of a work week, overtime included, shall not exceed 58 hours"),
];

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const candidates = [
    rate2023,
    rate2026("2026.1.0", "2026-01-01", "2026-12-31", "calendar_year_2026"),
    rate2026("2026.2.0", "2026-07-27", null, "from_signature_2026_07"),
    ...caps,
  ];
  await importPoolPBatch("batch-10-selections", candidates, [{
    decision_id: PERIOD_DECISION,
    topic: "convalescence",
    question: "Which twelve months does the 2026 convalescence day rate of 451.50 cover? The order states it 'for the convalescence year 2026' (עבור שנת ההבראה 2026) and is signed on 27 July 2026. Branch calendar_year_2026 reads the convalescence year as the calendar year; branch from_signature_2026_07 reads the rate as running from the order's signature. The figure is the same on both branches; the period is not.",
    dossier_anchor: "Convalescence extension order 2026 §3 and §4, instrument selection over gazette 14863 page 9134",
  }]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-10-v1",
    unit: "L5-5/L5-6/L5-7",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    open_decisions: [PERIOD_DECISION],
    citations: TABLE_AWARE_CITATIONS,
    selections_cited: [CHUNK_2023, CHUNK_2026, CHUNK_2018],
    dates_not_read: [
      { source: "IL_CONVALESCENCE_EXTENSION_ORDER_2023", text: "החל מיום 172023", reason: "dots collapsed by the layout parser; 1.7.2023 or 17.2.2023" },
      { source: "IL_CONVALESCENCE_EXTENSION_ORDER_2023", text: "בתוקף עד 3062024", reason: "dots collapsed; 30.6.2024 or 3.06.2024" },
    ],
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-10-selections.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L5_5_BATCH10 ${JSON.stringify({ registered: candidates.length, decisions: 1 })}`);
}

await main();
