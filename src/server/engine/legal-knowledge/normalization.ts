import { createHash } from "node:crypto";
import { legalSourceVersionId, type LegalChunk, type LegalSource } from "../../../engine/legal-knowledge/contracts.ts";

export const LEGAL_NORMALIZER_VERSION = "legal-normalizer-v0";
export const LEGAL_CHUNKER_VERSION = "legal-structure-chunker-v0";
export const LEGAL_PARSER_MAX_PAGES = 1_000;
export const LEGAL_PARSER_MAX_NORMALIZED_CHARACTERS = 20_000_000;

const requiredSanityMarkers: Readonly<Record<string, readonly string[]>> = {
  IL_MIN_WAGE_LAW: ["שכר מינימום"],
  IL_MIN_WAGE_OFFICIAL_RATES: ["שכר מינימום"],
  IL_HOURS_WORK_REST_LAW: ["שעות עבודה", "מנוחה"],
  IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018: ["קיצור שבוע העבודה"],
  IL_GENERAL_OVERTIME_PERMIT_2018: ["היתר כללי", "שעות נוספות"],
  IL_GENERAL_PENSION_EXTENSION_ORDER_2011: ["פנסיה", "צו הרחבה"],
  IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016: ["נסיעה", "צו הרחבה"],
  IL_CONVALESCENCE_EXTENSION_ORDER_1988: ["הבראה"],
  IL_CONVALESCENCE_EXTENSION_ORDER_2016: ["הבראה", "צו הרחבה"],
  IL_CONVALESCENCE_KNESSET_RESEARCH_2025: ["הבראה"],
  IL_ANNUAL_VACATION_LAW: ["חופשה שנתית"],
  IL_SICK_PAY_LAW: ["דמי מחלה"],
};

function decodeHtmlEntities(value: string) {
  const named: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|([a-z]+));/giu, (_match, decimal, hexadecimal, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    return named[String(name).toLowerCase()] ?? " ";
  });
}

export function normalizeLegalText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
    .replace(/[‐‑‒–—−]/gu, "-")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function extractHtmlLegalText(html: string) {
  const withoutNonContent = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/giu, "")
    .replace(/<\/(?:h[1-6]|p|li|tr|section|article|div|table|thead|tbody)>/giu, "\n")
    .replace(/<(?:br|hr)\b[^>]*>/giu, "\n")
    .replace(/<t[dh]\b[^>]*>/giu, "\t")
    .replace(/<[^>]+>/gu, " ");
  return normalizeLegalText(decodeHtmlEntities(withoutNonContent));
}

export function removeRepeatedPdfMargins(pages: readonly Readonly<{ page: number; text: string }>[]) {
  if (pages.length < 3) return pages.map((page) => ({ ...page, text: normalizeLegalText(page.text) }));
  const normalizedPages = pages.map((page) => ({ ...page, lines: normalizeLegalText(page.text).split("\n").filter(Boolean) }));
  const edgeCounts = new Map<string, number>();
  for (const page of normalizedPages) {
    for (const line of [...page.lines.slice(0, 2), ...page.lines.slice(-2)]) {
      if (line.length <= 160) edgeCounts.set(line, (edgeCounts.get(line) ?? 0) + 1);
    }
  }
  const repeated = new Set([...edgeCounts.entries()].filter(([, count]) => count >= Math.ceil(pages.length * 0.7)).map(([line]) => line));
  return normalizedPages.map((page) => ({ page: page.page, text: normalizeLegalText(page.lines.filter((line) => !repeated.has(line)).join("\n")) }));
}

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function parsedLegalVersionId(
  source: Readonly<{ source_id: string; source_version: string }>,
  artifactSha256: string,
  normalizedTextSha256: string,
  parserVersion: string,
) {
  const lineageHash = hash(`${legalSourceVersionId(source)}\n${artifactSha256}\n${normalizedTextSha256}\n${parserVersion}\n${LEGAL_NORMALIZER_VERSION}`);
  return `${legalSourceVersionId(source)}#parsed-${lineageHash.slice(0, 24)}`;
}

function isHeading(line: string) {
  return line.length <= 180 && /^(?:פרק|סימן|תוספת|נספח|חלק|Chapter|Part|Section|\d{1,3}[.)]|[א-ת]{1,3}[.)])/iu.test(line);
}

export function chunkLegalPages(
  source: LegalSource,
  artifactSha256: string,
  pages: readonly Readonly<{ page: number | null; text: string }>[],
  lineage: Readonly<{ normalizedTextSha256?: string; parserVersion?: string }> = {},
): LegalChunk[] {
  const chunks: LegalChunk[] = [];
  const normalizedTextSha256 = lineage.normalizedTextSha256 ?? normalizedDocumentHash(pages);
  const parserVersion = lineage.parserVersion ?? LEGAL_NORMALIZER_VERSION;
  const parsedVersionId = parsedLegalVersionId(source, artifactSha256, normalizedTextSha256, parserVersion);
  let documentOffset = 0;
  let headingPath: string[] = [];
  let sequence = 0;
  for (const page of pages) {
    const pageText = normalizeLegalText(page.text);
    const lines = pageText.split("\n");
    let pageCursor = 0;
    let buffer: string[] = [];
    let sectionIdentifier = `page-${page.page ?? 1}`;
    const flush = () => {
      const text = normalizeLegalText(buffer.join("\n"));
      if (!text) return;
      const localFrom = pageText.indexOf(text, pageCursor);
      if (localFrom < 0) throw new Error("chunk_locator_resolution_failed");
      const from = documentOffset + localFrom;
      const to = from + text.length;
      const textHash = hash(text);
      sequence += 1;
      chunks.push({
        chunk_id: `${source.source_id}@${source.source_version}#${String(sequence).padStart(4, "0")}-${textHash.slice(0, 12)}`,
        source_id: source.source_id,
        source_version: source.source_version,
        source_version_id: legalSourceVersionId(source),
        parsed_version_id: parsedVersionId,
        artifact_sha256: artifactSha256,
        normalized_text_sha256: normalizedTextSha256,
        parser_version: parserVersion,
        section_identifier: sectionIdentifier,
        heading_path: headingPath,
        page_from: page.page,
        page_to: page.page,
        character_from: from,
        character_to: to,
        text,
        chunk_text_sha256: textHash,
        topics: source.topics,
        sectors: source.sectors,
        effective_period: source.effective_period,
        authority: source.authority,
      });
      pageCursor = localFrom + text.length;
      buffer = [];
    };
    for (const line of lines) {
      if (isHeading(line)) {
        flush();
        headingPath = [line];
        sectionIdentifier = normalizeLegalText(line).slice(0, 120);
        buffer.push(line);
      } else {
        buffer.push(line);
      }
      if (buffer.join("\n").length >= 3_500) flush();
    }
    flush();
    documentOffset += pageText.length + 1;
  }
  return chunks;
}

export function normalizedDocumentHash(pages: readonly Readonly<{ text: string }>[]) {
  return hash(pages.map((page) => normalizeLegalText(page.text)).join("\n\n"));
}

export function validateParsedLegalDocument(
  source: Readonly<{ source_id: string }>,
  pages: readonly Readonly<{ text: string }>[],
) {
  if (pages.length === 0) return { passed: false as const, code: "normalized_text_empty" };
  if (pages.length > LEGAL_PARSER_MAX_PAGES) return { passed: false as const, code: "parser_page_limit_exceeded" };
  const normalized = pages.map((page) => normalizeLegalText(page.text)).join("\n\n");
  if (normalized.length === 0) return { passed: false as const, code: "normalized_text_empty" };
  if (normalized.length > LEGAL_PARSER_MAX_NORMALIZED_CHARACTERS) return { passed: false as const, code: "parser_text_limit_exceeded" };
  if (/(?:kramericaindustries|cf-chl-|cloudflare|captcha|access\s+denied|enable\s+javascript\s+and\s+cookies)/iu.test(normalized)) {
    return { passed: false as const, code: "challenge_page_rejected" };
  }
  if (normalized.length < 80) return { passed: false as const, code: "document_sanity_minimum_content_failed" };
  const markers = requiredSanityMarkers[source.source_id] ?? [];
  if (markers.some((marker) => !normalized.includes(marker) && !normalized.includes([...marker].reverse().join("")))) {
    return { passed: false as const, code: "document_sanity_required_marker_missing" };
  }
  return { passed: true as const, code: null };
}

// ---------------------------------------------------------------------------
// L4-1 / D2. `legal-structure-chunker-v1` — the table-aware chunker.
//
// The v0 chunker treats any line starting `\d{1,3}[.)]` as a heading. Every
// date cell in a rate table starts that way — `01.04.2026`, `1.1.2014` — so v0
// cut the tables into date-only chunks and value-only chunks and left the column
// headers several chunks upstream. Six citations rest on chunks like
// `"1.04.2023 257.16 222.87 29.95 30.61 5,571.75"`: a row with no headers, no
// Hebrew, and therefore no anchor and no safe way to say which column is which.
// That is BL-15.
//
// v1 changes exactly two things and nothing else:
//   1. a line that is entirely numeric tokens never opens a heading, and
//   2. inside a table region the soft size flush is suspended, so a table is
//      never cut in half.
// On entering a table region the buffer is split: everything older than the
// header lookback is flushed as its own chunk, and the lookback lines stay to
// open the table chunk. The result is one chunk per table carrying its headers
// and every row, which is what a citation needs to be anchorable and what a
// binding needs to know which column it read.
//
// v0 is untouched and its output is unchanged. This produces a NEW chunk set
// beside it — `#t0001-…` ids that cannot collide with v0's `#0001-…` — and
// nothing is rebound in place; a parameter whose citation moves to a v1 chunk
// becomes a new candidate revision and the old row is superseded.

export const LEGAL_CHUNKER_VERSION_V1 = "legal-structure-chunker-v1";
/** How far back a table chunk reaches for its column headers, in lines. */
export const LEGAL_CHUNKER_V1_HEADER_LOOKBACK_LINES = 16;
/** A table chunk may exceed the soft limit, but not without bound. */
export const LEGAL_CHUNKER_V1_MAX_TABLE_CHARACTERS = 12_000;
/** A run of this many numeric lines is a table; fewer is a stray figure. */
export const LEGAL_CHUNKER_V1_MINIMUM_TABLE_ROWS = 2;

const NUMERIC_CELL = /^[%(\[]*[+-]?\d[\d.,:/%־-]*[%)\]]*$/u;

/**
 * A line every one of whose whitespace-separated tokens is a number, a date, a
 * percentage or a money figure. `"01.04.2026"`, `"33.58 34.32 6,247.67"` and
 * `"1.1.2014 %6 %5.5 %6 %17.5"` all qualify; anything carrying a word does not.
 */
export function isTableRowLine(line: string): boolean {
  if (line.length === 0 || line.length > 200) return false;
  const tokens = line.split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => NUMERIC_CELL.test(token));
}

/**
 * Marks the lines belonging to a table. A table is a maximal run of numeric
 * lines, blank lines allowed between them, holding at least
 * `LEGAL_CHUNKER_V1_MINIMUM_TABLE_ROWS` numeric lines — so one stray figure in
 * running prose is not a table.
 */
export function markTableLines(lines: readonly string[]): readonly boolean[] {
  const isRow = lines.map((line) => isTableRowLine(line));
  const marked = lines.map(() => false);
  let index = 0;
  while (index < lines.length) {
    if (!isRow[index]) { index += 1; continue; }
    let end = index;
    let rows = 0;
    let cursor = index;
    while (cursor < lines.length && (isRow[cursor] || lines[cursor].trim().length === 0)) {
      if (isRow[cursor]) { end = cursor; rows += 1; }
      cursor += 1;
    }
    if (rows >= LEGAL_CHUNKER_V1_MINIMUM_TABLE_ROWS) for (let mark = index; mark <= end; mark += 1) marked[mark] = true;
    index = end + 1;
  }
  return marked;
}

export function chunkLegalPagesTableAware(
  source: LegalSource,
  artifactSha256: string,
  pages: readonly Readonly<{ page: number | null; text: string }>[],
  lineage: Readonly<{ normalizedTextSha256?: string; parserVersion?: string }> = {},
): LegalChunk[] {
  const chunks: LegalChunk[] = [];
  const normalizedTextSha256 = lineage.normalizedTextSha256 ?? normalizedDocumentHash(pages);
  const parserVersion = lineage.parserVersion ?? LEGAL_NORMALIZER_VERSION;
  const parsedVersionId = parsedLegalVersionId(source, artifactSha256, normalizedTextSha256, parserVersion);
  let documentOffset = 0;
  let headingPath: string[] = [];
  let sequence = 0;
  for (const page of pages) {
    const pageText = normalizeLegalText(page.text);
    const lines = pageText.split("\n");
    const table = markTableLines(lines);
    let pageCursor = 0;
    let buffer: string[] = [];
    let sectionIdentifier = `page-${page.page ?? 1}`;
    const emit = (candidate: readonly string[]) => {
      const text = normalizeLegalText(candidate.join("\n"));
      if (!text) return;
      const localFrom = pageText.indexOf(text, pageCursor);
      if (localFrom < 0) throw new Error("chunk_locator_resolution_failed");
      const from = documentOffset + localFrom;
      const textHash = hash(text);
      sequence += 1;
      chunks.push({
        chunk_id: `${source.source_id}@${source.source_version}#t${String(sequence).padStart(4, "0")}-${textHash.slice(0, 12)}`,
        source_id: source.source_id,
        source_version: source.source_version,
        source_version_id: legalSourceVersionId(source),
        parsed_version_id: parsedVersionId,
        artifact_sha256: artifactSha256,
        normalized_text_sha256: normalizedTextSha256,
        parser_version: parserVersion,
        section_identifier: sectionIdentifier,
        heading_path: headingPath,
        page_from: page.page,
        page_to: page.page,
        character_from: from,
        character_to: from + text.length,
        text,
        chunk_text_sha256: textHash,
        topics: source.topics,
        sectors: source.sectors,
        effective_period: source.effective_period,
        authority: source.authority,
      });
      pageCursor = localFrom + text.length;
    };
    const flush = () => { emit(buffer); buffer = []; };
    /** Flush everything before the header lookback, keeping the lookback to open the table. */
    const flushKeepingHeader = () => {
      if (buffer.length <= LEGAL_CHUNKER_V1_HEADER_LOOKBACK_LINES) return;
      const split = buffer.length - LEGAL_CHUNKER_V1_HEADER_LOOKBACK_LINES;
      emit(buffer.slice(0, split));
      buffer = buffer.slice(split);
    };
    for (const [index, line] of lines.entries()) {
      const insideTable = table[index];
      const enteringTable = insideTable && !(index > 0 && table[index - 1]);
      const leavingTable = !insideTable && index > 0 && table[index - 1];
      if (enteringTable) flushKeepingHeader();
      if (leavingTable) flush();
      if (!insideTable && isHeading(line)) {
        flush();
        headingPath = [line];
        sectionIdentifier = normalizeLegalText(line).slice(0, 120);
      }
      buffer.push(line);
      const size = buffer.join("\n").length;
      if (insideTable ? size >= LEGAL_CHUNKER_V1_MAX_TABLE_CHARACTERS : size >= 3_500) flush();
    }
    flush();
    documentOffset += pageText.length + 1;
  }
  return chunks;
}
