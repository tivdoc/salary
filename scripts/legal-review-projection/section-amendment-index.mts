// L6-1 / D3. Which sections of the Hours of Work and Rest Law each official
// amendment publication amends — proven from the publication's own text.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/section-amendment-index.mts
//
// Two kinds of publication, two readings, both from the text alone:
//
// - A DIRECT amendment (its title is "חוק שעות עבודה ומנוחה (תיקון …)") amends
//   only that law, so every section reference in it is a section of the Hours
//   law — except inside a nested block that opens another law by name.
// - An INDIRECT amendment (another law that touches this one in passing) names
//   the Hours law where it touches it; the section is in the same sentence,
//   before the name ("סעיף 30(ב) לחוק שעות עבודה ומנוחה") or after it
//   ("בחוק שעות עבודה ומנוחה … בסעיף 25"). A publication whose title says it
//   replaces a term across statutes touches every section of every law it lists,
//   terminologically; its exclusions are quoted as it states them.
//
// Every claim carries the sentence it was read from and the hash of the logical
// text, so a reviewer can find it and a re-chunk invalidates it. The index says
// which publications TOUCH §16, §17 and §18 and in what kind; what an amendment
// did is read from the quoted sentence by a person, never inferred here.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeToLogicalOrder, hebrewOrderSignal } from "../../src/engine/legal-knowledge/normalizer-v1.ts";

export const SECTION_AMENDMENT_INDEX_PATH = path.join("src", "server", "engine", "legal-knowledge", "hours-law-section-amendment-index.v1.json");
const RECEIPT = path.join("output", "next", "acquisition", "section-amendment-index.json");
const HOURS_LAW_NAME = /שעות\s*עבודה\s*ומנוחה/u;
const NESTED_BLOCK_OPEN = /בחוק\s+([^,\n]{4,80}?),\s*(?:ה?תש[א-ת"']{1,6}[­\-־–]?\s*\d[\d ]{3,7})/gu;
const SECTION = /(?:ב|ל)?סעי(?:ף|פים)\s*(\d{1,3})([א-ת])?(?:\s*\(([^)]{1,4})\))?/gu;
const TERM_REPLACEMENT_TITLE = /להחלפת המונח/u;
const SECTIONS_OF_INTEREST = ["16", "17", "18"] as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const squash = (value: string) => value.replace(/\s+/gu, " ").trim();

type Evidence = Readonly<{ reference: string; sentence: string }>;
type Touch = Readonly<{ kind: "substantive" | "terminological"; evidence: readonly Evidence[] }>;

function sentenceAround(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at);
  const end = text.indexOf("\n", at + 1);
  return squash(text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end)).slice(0, 260);
}

function sectionKey(match: RegExpMatchArray): string {
  return `${match[1]}${match[2] ?? ""}`;
}

/** Direct amendment: every section reference outside a nested other-law block. */
function directSections(text: string): Map<string, Evidence[]> {
  const sections = new Map<string, Evidence[]>();
  const nested = [...text.matchAll(NESTED_BLOCK_OPEN)].filter((open) => !HOURS_LAW_NAME.test(open[1]));
  const nestedRanges = nested.map((open, index) => {
    const from = open.index ?? 0;
    const next = nested[index + 1]?.index ?? text.length;
    // A nested block runs to the next block opening or to the next "תיקון" heading.
    const heading = text.indexOf("תיקון", from + 1);
    return [from, Math.min(next, heading === -1 ? text.length : heading)] as const;
  });
  for (const match of text.matchAll(SECTION)) {
    const at = match.index ?? 0;
    if (nestedRanges.some(([from, to]) => at >= from && at < to)) continue;
    const list = sections.get(sectionKey(match)) ?? [];
    list.push({ reference: squash(match[0]), sentence: sentenceAround(text, at) });
    sections.set(sectionKey(match), list);
  }
  return sections;
}

/** Indirect amendment: sections in the same sentence as the Hours law's name. */
function indirectSections(text: string): Map<string, Evidence[]> {
  const sections = new Map<string, Evidence[]>();
  for (const name of text.matchAll(new RegExp(HOURS_LAW_NAME.source, "gu"))) {
    const at = name.index ?? 0;
    const sentenceStart = text.lastIndexOf("\n", at);
    const sentenceEnd = text.indexOf("\n", at + 1);
    const sentence = text.slice(sentenceStart === -1 ? 0 : sentenceStart, sentenceEnd === -1 ? text.length : sentenceEnd);
    for (const match of sentence.matchAll(SECTION)) {
      const list = sections.get(sectionKey(match)) ?? [];
      list.push({ reference: squash(match[0]), sentence: squash(sentence).slice(0, 260) });
      sections.set(sectionKey(match), list);
    }
  }
  return sections;
}

const buildState = JSON.parse(readFileSync(path.join("eval", "legal-knowledge", "manifests", "build-state.json"), "utf8")) as { records: Array<Record<string, unknown>> };
const manifest = JSON.parse(readFileSync(path.join("src", "server", "engine", "legal-knowledge", "legal-sources.v0.json"), "utf8")) as {
  sources: Array<{ source_id: string; source_version: string; title: string; published_at: string | null; publication_reference: string | null; canonical_url: string }>;
};

const publications = [];
for (const source of manifest.sources.filter((entry) => /^IL_HOURS_WORK_REST_LAW_(AMENDMENT_\d\d|ERRATUM_1951)$/u.test(entry.source_id))) {
  const record = buildState.records.find((entry) => entry.source_id === source.source_id && entry.source_version === source.source_version) as
    { chunks_path: string | null; artifact_sha256: string; parse_status: string } | undefined;
  if (!record || record.parse_status !== "parsed" || !record.chunks_path) {
    publications.push({ source_id: source.source_id, title: source.title, status: "not_parsed" as const, kind: "unknown" as const, hours_law_sections: [], touches: {} as Record<string, Touch>, terminology_scope: null });
    continue;
  }
  const document = JSON.parse(readFileSync(record.chunks_path, "utf8")) as { chunks: Array<{ chunk_id: string; text: string }> };
  const joined = document.chunks.map((chunk) => chunk.text).join("\n");
  const signal = hebrewOrderSignal(joined);
  const text = signal.visual_order && signal.confident ? normalizeToLogicalOrder(joined).text : joined;
  const direct = HOURS_LAW_NAME.test(source.title) && !/תיקון טעות/u.test(source.title);
  const termReplacement = TERM_REPLACEMENT_TITLE.test(source.title);
  const sections = direct ? directSections(text) : indirectSections(text);
  const mentionsHoursLaw = HOURS_LAW_NAME.test(text);
  // The term-replacement law lists the Hours law as a whole and states its
  // exclusions in the same sentence; that sentence is the evidence.
  const terminologySentence = termReplacement && mentionsHoursLaw
    ? sentenceAround(text, text.search(HOURS_LAW_NAME))
    : null;
  const touches: Record<string, Touch> = {};
  for (const wanted of SECTIONS_OF_INTEREST) {
    const substantive = [...sections.entries()]
      .filter(([key]) => key === wanted || (key.startsWith(wanted) && /^[0-9]+[א-ת]$/u.test(key)))
      .flatMap(([, list]) => list);
    if (substantive.length > 0) touches[`section_${wanted}`] = { kind: "substantive", evidence: substantive.slice(0, 6) };
    else if (terminologySentence) touches[`section_${wanted}`] = { kind: "terminological", evidence: [{ reference: "(whole law, by title)", sentence: terminologySentence }] };
  }
  publications.push({
    source_id: source.source_id, title: source.title, published_at: source.published_at, publication_reference: source.publication_reference,
    canonical_url: source.canonical_url, artifact_sha256: record.artifact_sha256, logical_text_sha256: sha256(text),
    status: "parsed" as const, kind: direct ? "direct" as const : "indirect" as const, mentions_hours_law: mentionsHoursLaw,
    hours_law_sections: [...sections.keys()].sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || left.localeCompare(right)),
    hours_law_section_evidence: Object.fromEntries([...sections.entries()].map(([key, list]) => [key, list.slice(0, 3)])),
    terminology_scope: terminologySentence ? { whole_law: true, sentence: terminologySentence } : null,
    touches,
  });
}

function conclusion(wanted: string) {
  const substantive = publications.filter((entry) => entry.touches[`section_${wanted}`]?.kind === "substantive");
  const terminological = publications.filter((entry) => entry.touches[`section_${wanted}`]?.kind === "terminological");
  return {
    substantive_publications: substantive.map((entry) => ({ source_id: entry.source_id, title: entry.title, published_at: entry.published_at, evidence: entry.touches[`section_${wanted}`].evidence })),
    terminological_publications: terminological.map((entry) => ({ source_id: entry.source_id, title: entry.title, published_at: entry.published_at, evidence: entry.touches[`section_${wanted}`].evidence })),
    authoritative_text_for_figures: substantive.length === 0
      ? "IL_HOURS_WORK_REST_LAW@discovery-v0 (the 1951 promulgation): no official publication amends this section substantively; the 2014 term replacement changes a word, not a figure"
      : "a later publication amends this section substantively; bind from that publication's text, not from 1951",
  };
}

const index = {
  schema_version: "tivdoc-hours-law-section-amendment-index-v1",
  unit: "L6-1 / D3",
  law: "חוק שעות עבודה ומנוחה, התשי\"א-1951",
  record_url: "https://main.knesset.gov.il/apps/legislation/main/laws/2000019",
  method: "Direct amendments: every section reference outside a nested other-law block is a Hours-law section. Indirect amendments: a section reference in the same sentence as the law's name. A term-replacement law that lists the Hours law touches every section terminologically, with its stated exclusions quoted. Evidence is the sentence the reference sits in; what an amendment did is read from that sentence by a person.",
  publications,
  sections: Object.fromEntries(SECTIONS_OF_INTEREST.map((wanted) => [`section_${wanted}`, conclusion(wanted)])),
};
mkdirSync(path.dirname(RECEIPT), { recursive: true });
writeFileSync(SECTION_AMENDMENT_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
writeFileSync(RECEIPT, `${JSON.stringify({
  written: SECTION_AMENDMENT_INDEX_PATH, index_sha256: sha256(JSON.stringify(index)),
  publications: publications.length, parsed: publications.filter((entry) => entry.status === "parsed").length,
}, null, 2)}\n`, "utf8");
for (const wanted of SECTIONS_OF_INTEREST) {
  const entry = conclusion(wanted);
  console.log(`§${wanted}: substantive [${entry.substantive_publications.map((item) => item.source_id.replace("IL_HOURS_WORK_REST_LAW_", "")).join(", ")}] terminological [${entry.terminological_publications.map((item) => item.source_id.replace("IL_HOURS_WORK_REST_LAW_", "")).join(", ")}]`);
}
