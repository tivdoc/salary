// Pool P batch 14 (L6-6 / D4, P-29). The 1988 convalescence order's seniority
// bands, from the table-aware chunk of its page 3.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-14-convalescence-bands.mts
//
// L4 recorded P-29 blocked: "not found in the 1988 order's 4 built chunks;
// page-boundary segmentation unreliable". The cause closed in L4-1/L5: the
// table-aware chunker keeps page 3 whole, and its logical text carries §4(א)
// with all six bands — interleaved line by line with an unrelated notice
// (an appointment under the Settlement of Labour Disputes Law) that shares
// the two-column page. The band rows read, in the chunk's own stored lines:
//
//   year 1            5 ימי הבראה   (line 20)
//   years 2–3         6 ימי הבראה   (lines 21–22)
//   years 4–10        7 ימי הבראה   (lines 23–24)
//   years 11–15       8 ימי הבראה   (lines 26–27, the OCR prefixes an apostrophe)
//   years 16–19       9 ימי הבראה   (lines 28–29, the OCR reads "ימן" for "ימי")
//   year 20 onward   10 ימי הבראה   (lines 30–31)
//
// Every citation is a table-aware citation into that one chunk: the figure
// with its unit word as the stored text carries it, plus the clause anchor.
// Where the OCR garbled the unit word ("ימן"), the needle is the stored text,
// the locator says so, and the figure itself is a plain digit; nothing is
// read that the chunk does not carry. The 1998 general agreement restates
// bands; which instrument governs today is the convalescence draft's
// precedence slot, which stays unbound. Registered against 1988 as that
// instrument's own figures.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, importPoolPBatch, TABLE_AWARE_CITATIONS, TENANT, tableAwareCitation } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const ORDER_1988 = { source_id: "IL_CONVALESCENCE_EXTENSION_ORDER_1988", source_version: "discovery-v0" };
const CHUNK = "IL_CONVALESCENCE_EXTENSION_ORDER_1988@discovery-v0#t0004-65c7115d3b4a";
const ANCHOR = "קצובת ההבראה תינתן בשיעורים הבאים";
// The order's own signature date, spelled out in the text: ה' בכסלו התשמ"ט
// (14 November 1988). The manifest's publication date (1988-11-09) precedes
// it; the text is taken over the manifest and the receipt records both.
const EFFECTIVE_FROM = "1988-11-14";

type Band = Readonly<{ id: string; days: number; needles: readonly string[]; clause: string }>;
const BANDS: readonly Band[] = [
  { id: "il.convalescence.days_year_1", days: 5, needles: ["משנה אחת לעבודה במפעל: 5 ימי הבראה"], clause: "§4(א): from one year of work at the plant, 5 convalescence days" },
  { id: "il.convalescence.days_years_2_to_3", days: 6, needles: ["עבור השנה השנייה עד השנה", "השלישית לעבודה במפעל: 6 ימי הבראה"], clause: "§4(א): for the second to the third year, 6 convalescence days (the row breaks across two stored lines)" },
  { id: "il.convalescence.days_years_4_to_10", days: 7, needles: ["עבור השנה הרביעית עד השנה", "העשירית לעבודה במפעל: . 7 ימי הבראה"], clause: "§4(א): for the fourth to the tenth year, 7 convalescence days" },
  { id: "il.convalescence.days_years_11_to_15", days: 8, needles: ["עבור השנה האחת־עשרה", "עד החמש־עשרה לעבודה במפעל: '8 ימי הבראה"], clause: "§4(א): for the eleventh to the fifteenth year, 8 convalescence days (the OCR prefixes an apostrophe to the 8)" },
  { id: "il.convalescence.days_years_16_to_19", days: 9, needles: ["עבור השנה השש־עשרה עד", "9 ימן הבראה"], clause: "§4(א): for the sixteenth to the nineteenth year, 9 convalescence days (the OCR reads the unit word as ימן and the ordinal as התשע־עשדה; the digit is plain)" },
  { id: "il.convalescence.days_years_20_and_above", days: 10, needles: ["עבור השנה העשרים ואילך", "לעבודה במפעל: 10 ימי הבראה"], clause: "§4(א): from the twentieth year onward, 10 convalescence days" },
];

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const candidates = BANDS.map((band) => buildCandidate({
    parameter_id: band.id,
    parameter_version: "1988.1.0",
    topic: "convalescence",
    value: { kind: "integer", value: band.days, unit: "days" },
    unit: "days",
    rounding_policy: "exact",
    effective_from: EFFECTIVE_FROM,
    effective_to: null,
    sectors: ["general"],
    populations: ["general"],
    support_roles: ["primary_binding"],
    citations: [tableAwareCitation(ORDER_1988, CHUNK,
      `Convalescence extension order 1988 (gazette page 3, table-aware chunk, two columns interleaved with an appointment notice): ${band.clause}. Effective from the signature date the text spells out, 14 November 1988.`,
      band.needles, ANCHOR)],
  }));
  await importPoolPBatch("batch-14-convalescence-bands", candidates, []);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-14-v1",
    unit: "L6-6 / D4 (P-29)",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    provenance_grade: "text_verified",
    cause_closed_by: "legal-structure-chunker-v1 (L4-1): page 3 is one chunk whose logical text carries the whole band clause; L4's 'page-boundary segmentation unreliable' no longer holds",
    citations: TABLE_AWARE_CITATIONS,
    dates: { text_signature_date: "1988-11-14", manifest_published_at: "1988-11-09", used: EFFECTIVE_FROM, note: "the text's own date is taken; the manifest date precedes it and is recorded here for the reviewer" },
    precedence: "The 1998 general agreement (in the corpus) restates seniority bands; which instrument governs is the convalescence draft's unbound precedence slot, not decided here.",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-14-convalescence-bands.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L6_6_BATCH14 ${JSON.stringify({ registered: candidates.length })}`);
}

await main();
