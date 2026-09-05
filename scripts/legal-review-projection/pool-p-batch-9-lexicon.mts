// Pool P batch 9 (L5-4 / D1, L5-3 / D3). Figures the law states as words.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-9-lexicon.mts
//
// Two parameters, each bound through `legal-numeral-lexicon-v1` from the chunk
// that states it, with the surface form recorded on the citation:
//
//   il.sick_pay.rate_days_2_to_3          1/2   "מחצית"     IL_SICK_PAY_LAW §2(א)(2)
//   il.vacation.calendar_days_increment_
//     per_year_from_year_8                1     "יום נוסף"  IL_ANNUAL_VACATION_LAW §3(א)(5)
//
// And two figures the brief expected that are NOT registered, each with the
// reason written into the receipt rather than into a comment somebody would
// have to find:
//
//   day one of sick leave -> 0   The law states it by omission. §2(א) lists
//                                the fourth day onward and the second and
//                                third; it never says "not entitled" for the
//                                first. D1 binds a zero only from a verbatim
//                                exclusion clause, and there is none. The
//                                daily-rate spec refuses day one instead.
//   day four onward       -> 1   Not a figure. §2(א)(1) says "payment under
//                                this law" and §5(א) defines that payment as
//                                the wage; the rate is the identity, and the
//                                spec carries it as constant.rational 1.
//
// Everything registered stays draft, zero attestations.
import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, importPoolPBatch, lexiconCitation, TABLE_AWARE_CITATIONS, TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const SICK = { source_id: "IL_SICK_PAY_LAW", source_version: "discovery-v0" };
const VACATION = { source_id: "IL_ANNUAL_VACATION_LAW", source_version: "discovery-v0" };
const SICK_TIER_CHUNK = "IL_SICK_PAY_LAW@discovery-v0#t0001-b0208d864901";
const VACATION_CLAUSE = "IL_ANNUAL_VACATION_LAW@discovery-v0#t0001-838721e06653";

const halfRate = buildCandidate({
  parameter_id: "il.sick_pay.rate_days_2_to_3",
  parameter_version: "1.0.0",
  topic: "sick_leave",
  value: { kind: "rational", numerator: "1", denominator: "2", unit: "ratio" },
  unit: "ratio",
  rounding_policy: "exact",
  effective_from: "1976-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [lexiconCitation(SICK, SICK_TIER_CHUNK,
    "Sick Pay Law 1976 §2(א)(2) — for the second and third day of absence, half of the sick pay; the figure is the word מחצית, resolved through legal-numeral-lexicon-v1",
    "מחצית", "בעד הימים השני והשלישי", { numerator: "1", denominator: "2" })],
});

const increment = buildCandidate({
  parameter_id: "il.vacation.calendar_days_increment_per_year_from_year_8",
  parameter_version: "1951.1.0",
  topic: "vacation",
  value: { kind: "integer", value: 1, unit: "calendar_days_per_year" },
  unit: "calendar_days_per_year",
  rounding_policy: "exact",
  effective_from: "1951-01-01",
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [lexiconCitation(VACATION, VACATION_CLAUSE,
    "Annual Vacation Law 1951 §3(א)(5) — from the eighth year, one additional day for each work year up to 28; the increment is the words יום נוסף, resolved through legal-numeral-lexicon-v1",
    "יום נוסף", "בעד השנה השמינית ואילך", { numerator: "1", denominator: "1" })],
});

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  await importPoolPBatch("batch-9-lexicon", [halfRate, increment]);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-9-v1",
    unit: "L5-4",
    tenant: TENANT,
    registered: [halfRate, increment].map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    citations: TABLE_AWARE_CITATIONS,
    lexicon_bindings: [halfRate, increment].map((entry) => ({
      parameter: `${entry.parameter_id}@${entry.parameter_version}`,
      value: entry.value,
    })),
    not_registered: [
      {
        figure: "sick pay, day one of absence -> 0",
        reason: "stated_by_omission",
        detail: "§2(א) of the Sick Pay Law lists the fourth day onward and the second and third; it never states non-entitlement for the first day. D1 binds a zero only from a verbatim exclusion clause (אינו זכאי / לא ישולם), and none is in the chunk. The daily-rate spec refuses day one rather than pricing it by inference.",
      },
      {
        figure: "sick pay, day four onward -> 1",
        reason: "definitional_identity",
        detail: "Not a figure in the text. §2(א)(1) says 'payment under this law' from the fourth day and §5(א) defines that payment as the wage. The rate is the identity and the spec carries it as constant.rational 1, which is shape, not a cited parameter.",
      },
    ],
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-9-lexicon.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L5_4_BATCH9 ${JSON.stringify({ registered: receipt.registered.length, not_registered: receipt.not_registered.length })}`);
}

await main();
