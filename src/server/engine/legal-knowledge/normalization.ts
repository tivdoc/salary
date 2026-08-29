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
