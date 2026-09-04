// L5-1 / D1. The lexicon against the corpus as it actually is.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/numeral-lexicon-proof.mts
//
// Two things are proven by execution rather than asserted. The OCR-mangled
// fraction in the Hours of Work and Rest Law scan is refused by name, from the
// chunk on disk and not from a string retyped into a test. And the sick-pay
// tier stated as a word — `מחצית דמי מחלה` — binds through the lexicon from its
// own chunk, with the surface form recorded, which is the whole reason the
// table exists.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkCitationAnchor } from "../../src/engine/legal-knowledge/citation-anchor.ts";
import {
  bindCompoundThroughLexicon,
  bindThroughLexicon,
  containsOcrAmbiguousFraction,
  LEGAL_NUMERAL_LEXICON,
  LEGAL_NUMERAL_LEXICON_VERSION,
  resolveNumeral,
} from "../../src/engine/legal-knowledge/numeral-lexicon-v1.ts";

const RECEIPT_ROOT = path.join("output", "next", "lexicon");
const BUILD_STATE = path.join("eval", "legal-knowledge", "manifests", "build-state.json");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;

function tableAwareChunks(sourceId: string): ReadonlyArray<{ chunk_id: string; logical_text: string }> {
  const records = (JSON.parse(readFileSync(BUILD_STATE, "utf8")) as { records: Array<{ source_id: string; parse_status: string; chunks_path: string | null }> }).records;
  const record = records.find((entry) => entry.source_id === sourceId && entry.parse_status === "parsed" && entry.chunks_path);
  if (!record?.chunks_path) throw new Error(`L51_SOURCE_NOT_BUILT:${sourceId}`);
  const sidecar = record.chunks_path.replace(/\.chunks\.json$/u, ".t1.chunks.json");
  return (JSON.parse(readFileSync(sidecar, "utf8")) as { chunks: Array<{ chunk_id: string; logical_text: string }> }).chunks;
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const cases: Case[] = [];
  const record = (name: string, passed: boolean, observed: string) =>
    cases.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));

  // --- The refusal, against the chunk on disk.
  const hours = tableAwareChunks("IL_HOURS_WORK_REST_LAW");
  const premium = hours.find((chunk) => chunk.chunk_id.includes("#t0006-"));
  if (!premium) throw new Error("L51_HOURS_CHUNK_0006_MISSING");
  const mangled = [...premium.logical_text.matchAll(/1\s?1\/[24]/gu)].map((match) => match[0]);
  record("hours_law_chunk_0006_carries_the_mangled_fractions", mangled.length >= 2, `${mangled.length} occurrences: ${[...new Set(mangled)].join(", ")}`);
  record("the_chunk_is_flagged_ocr_ambiguous", containsOcrAmbiguousFraction(premium.logical_text), premium.chunk_id);
  const refusals = [...new Set(mangled)].map((surface) => resolveNumeral(surface));
  record("every_mangled_form_is_refused_by_name",
    refusals.length > 0 && refusals.every((entry) => !entry.resolved && entry.refusal === "NUMERAL_OCR_AMBIGUOUS"),
    refusals.map((entry) => (entry.resolved ? "RESOLVED" : entry.refusal)).join(","));
  record("no_binding_from_that_chunk_for_any_reading",
    ["11/2", "11/4", "1 1/2", "1 1/4"].every((surface) => bindThroughLexicon(premium.logical_text, surface).refusal === "NUMERAL_OCR_AMBIGUOUS"),
    "11/2, 11/4, 1 1/2, 1 1/4 all NUMERAL_OCR_AMBIGUOUS");
  // The corpus offers neither clean form anywhere, so nothing else could bind.
  const anyClean = hours.some((chunk) => /½|¼|125%|150%|%125|%150/u.test(chunk.logical_text));
  record("no_clean_fraction_or_percentage_exists_in_the_source", !anyClean, anyClean ? "a clean form exists" : "none");

  // --- The binding, against the chunk on disk.
  const sick = tableAwareChunks("IL_SICK_PAY_LAW");
  const tiers = sick.find((chunk) => chunk.logical_text.includes("מחצית דמי מחלה"));
  if (!tiers) throw new Error("L51_SICK_PAY_TIER_CHUNK_MISSING");
  const half = bindThroughLexicon(tiers.logical_text, "מחצית");
  record("sick_pay_half_tier_binds_as_a_word",
    half.binding !== null && half.binding.numerator === "1" && half.binding.denominator === "2" && half.binding.numeral_form === "word",
    half.binding ? `${half.binding.surface} -> ${half.binding.numerator}/${half.binding.denominator} (${half.binding.numeral_form})` : half.refusal ?? "unbound");
  // The anchor rule is untouched: the clause and the word in one chunk.
  const anchor = checkCitationAnchor(tiers.logical_text, "בעד הימים השני והשלישי");
  record("the_tier_clause_anchors_in_the_same_chunk", anchor.matched, `${tiers.chunk_id}`);
  // The day-one tier is stated by omission and therefore does not bind.
  const exclusion = ["אינו זכאי", "אינה זכאית", "לא ישולם", "לא ישולמו"].map((surface) => bindThroughLexicon(tiers.logical_text, surface));
  record("day_one_has_no_exclusion_clause_to_bind_from",
    exclusion.every((entry) => entry.refusal === "NUMERAL_SURFACE_NOT_IN_CHUNK"),
    "stated by omission in §2(א); no verbatim exclusion surface in the chunk, so no zero is bound");
  // The accrual, a compound word form, binds from its own chunk.
  const accrual = sick.find((chunk) => chunk.logical_text.includes("יוםוחצי") || chunk.logical_text.includes("יום וחצי"));
  const compound = accrual ? bindCompoundThroughLexicon(accrual.logical_text, "יום", "וחצי") : null;
  record("accrual_day_and_a_half_binds_as_a_compound",
    compound?.binding !== null && compound?.binding !== undefined && compound.binding.numerator === "3" && compound.binding.denominator === "2",
    compound?.binding ? `${compound.binding.surface} -> 3/2` : compound?.refusal ?? "chunk missing");

  const failed = cases.filter((entry) => entry.outcome === "fail");
  const receipt = {
    schema_version: "tivdoc-numeral-lexicon-proof-v0.10.17",
    unit: "L5-1",
    lexicon_version: LEGAL_NUMERAL_LEXICON_VERSION,
    entries: LEGAL_NUMERAL_LEXICON.length,
    hours_law_chunk: premium.chunk_id,
    sick_pay_tier_chunk: tiers.chunk_id,
    passed: cases.length - failed.length,
    total: cases.length,
    cases,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "numeral-lexicon-proof.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L5_1_LEXICON ${JSON.stringify({ passed: receipt.passed, total: receipt.total })}`);
  if (failed.length > 0) process.exitCode = 3;
}

main();
