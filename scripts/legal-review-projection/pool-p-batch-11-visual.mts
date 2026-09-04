// Pool P batch 11 (L6-3 / D1). The figures the 1951 promulgation typesets as
// stacked fractions, read from the page image.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/pool-p-batch-11-visual.mts
//
// §16(א): overtime pay for the first two hours of a day, "לא פחות מ-1¼
// מהשכר הרגיל", and for every hour after them "לא פחות מ-1½". §17(א)(1):
// work in the weekly rest, "לא פחות מ-1½ משכרו הרגיל". The text layer of the
// 2008 scan renders each stacked fraction as "11/4" or "11/2", which the
// lexicon refuses by name (L5-1). The page image is unambiguous, and the
// section read it from a render of the artifact's own scan stream (L6-2).
//
// Every citation here is `inferred_visual`: the parameter row says so, the
// report and the rendering show it, and an attestation without
// `visual_confirmed: true` against this very page and reading is refused by
// the database. Nothing here is documented, and nothing is read from "11/4".
//
// The 1951 text is the authoritative text for these figures: the section
// amendment index (L6-1) shows no official publication amends §16 or §17
// substantively; the 2014 term replacement changed a word.
//
//   il.working_time.overtime_rate_first_tier@1951.1.0   5/4 ratio  §16(א), first two hours
//   il.working_time.overtime_rate_second_tier@1951.1.0  3/2 ratio  §16(א), hours after them
//   il.working_time.weekly_rest_rate@1951.1.0           3/2 ratio  §17(א)(1)
//
// 175% and 200% for overtime on the weekly rest are not figures in the law
// and are not registered; D2 composes the two sections under an open decision.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCandidate, importPoolPBatch, TABLE_AWARE_CITATIONS, TENANT, VISUAL_CITATIONS, visualCitation } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const LAW = { source_id: "IL_HOURS_WORK_REST_LAW", source_version: "discovery-v0" };
const PAGE4 = "IL_HOURS_WORK_REST_LAW@discovery-v0#t0006-1cec5eccebec";
const EFFECTIVE_FROM = "1951-09-27";

const rate = (parameterId: string, numerator: string, denominator: string, citation: Awaited<ReturnType<typeof visualCitation>>) => buildCandidate({
  parameter_id: parameterId,
  parameter_version: "1951.1.0",
  topic: "working_time",
  value: { kind: "rational", numerator, denominator, unit: "ratio" },
  unit: "ratio",
  rounding_policy: "exact",
  effective_from: EFFECTIVE_FROM,
  effective_to: null,
  sectors: ["general"],
  populations: ["general"],
  support_roles: ["primary_binding"],
  citations: [citation],
});

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  // Page 4 of the promulgation; the stored (visual-order) text-layer lines the
  // figures sit on, quoted as they stand in the normalized JSON.
  const firstTier = await visualCitation(LAW, PAGE4,
    "Hours of Work and Rest Law 1951 §16(א), gazette ס\"ח 76 p. 207 (page 4 of the promulgation scan): overtime pay for the first two overtime hours of a day is not less than 1¼ of the regular wage. Text layer line 38 reads the stacked fraction as 11/4; read from the page image as 1¼.",
    4, 38, "11/4", "1¼", "בעד שתי השעות הנוספות הראשונות");
  const secondTier = await visualCitation(LAW, PAGE4,
    "Hours of Work and Rest Law 1951 §16(א), page 4: for every overtime hour after the first two, not less than 1½ of the regular wage. Text layer line 37 reads the stacked fraction as 11/2; read from the page image as 1½.",
    4, 37, "11/2", "1½", "ובעד כל שעה נוספת שאחריהן");
  const weeklyRest = await visualCitation(LAW, PAGE4,
    "Hours of Work and Rest Law 1951 §17(א)(1), page 4: for hours worked in the weekly rest the employer pays not less than 1½ of the regular wage. Text layer line 24 reads the stacked fraction as 11/2; read from the page image as 1½.",
    4, 24, "11/2", "1½", "ישלם לו המעביד בעד שעות אלה");
  const candidates = [
    rate("il.working_time.overtime_rate_first_tier", "5", "4", firstTier),
    rate("il.working_time.overtime_rate_second_tier", "3", "2", secondTier),
    rate("il.working_time.weekly_rest_rate", "3", "2", weeklyRest),
  ];
  await importPoolPBatch("batch-11-visual", candidates, []);
  const receipt = {
    schema_version: "tivdoc-pool-p-batch-11-v1",
    unit: "L6-3 / D1",
    tenant: TENANT,
    registered: candidates.map((entry) => `${entry.parameter_id}@${entry.parameter_version}`),
    provenance_grade: "inferred_visual",
    visual_verification_required: true,
    visual_citations: VISUAL_CITATIONS,
    citations: TABLE_AWARE_CITATIONS,
    not_registered: [
      { figure: "overtime on the weekly rest, 175% / 200%", reason: "not_a_figure_in_the_law", detail: "§17(א)(1) states 1½ for rest-day hours and §16(א) states 1¼ / 1½ for overtime; the rest-day-overtime premium is a composition of the two sections and the composition rule is a reading, not a citation. D2 carries it as an open decision with an additive and a multiplicative branch; no figure 175 or 200 is authored." },
    ],
    authoritative_text: "IL_HOURS_WORK_REST_LAW@discovery-v0 (1951 promulgation) — hours-law-section-amendment-index.v1.json shows §16 and §17 amended by no official publication substantively; the 2014 term replacement changed a word.",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "batch-11-visual.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L6_3_BATCH11 ${JSON.stringify({ registered: candidates.length, visual_citations: VISUAL_CITATIONS.length })}`);
}

await main();
