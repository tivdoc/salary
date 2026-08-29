import { createHash } from "node:crypto";
import type { LegalChunk, LegalSource } from "../../../engine/legal-knowledge/contracts.ts";

export const LEGAL_NORMALIZER_VERSION = "legal-normalizer-v0";
export const LEGAL_CHUNKER_VERSION = "legal-structure-chunker-v0";

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

function isHeading(line: string) {
  return line.length <= 180 && /^(?:פרק|סימן|תוספת|נספח|חלק|Chapter|Part|Section|\d{1,3}[.)]|[א-ת]{1,3}[.)])/iu.test(line);
}

export function chunkLegalPages(
  source: LegalSource,
  artifactSha256: string,
  pages: readonly Readonly<{ page: number | null; text: string }>[],
): LegalChunk[] {
  const chunks: LegalChunk[] = [];
  let globalOffset = 0;
  let headingPath: string[] = [];
  let sequence = 0;
  for (const page of pages) {
    const lines = normalizeLegalText(page.text).split("\n").filter(Boolean);
    let buffer: string[] = [];
    let sectionIdentifier = `page-${page.page ?? 1}`;
    const flush = () => {
      const text = normalizeLegalText(buffer.join("\n"));
      if (!text) return;
      const from = globalOffset;
      const to = from + text.length;
      const textHash = hash(text);
      sequence += 1;
      chunks.push({
        chunk_id: `${source.source_id}@${source.source_version}#${String(sequence).padStart(4, "0")}-${textHash.slice(0, 12)}`,
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: artifactSha256,
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
      globalOffset = to + 1;
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
  }
  return chunks;
}

export function normalizedDocumentHash(pages: readonly Readonly<{ text: string }>[]) {
  return hash(pages.map((page) => normalizeLegalText(page.text)).join("\n\n"));
}
