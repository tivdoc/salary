import { createHash } from "node:crypto";
import type { LegalChunk, LegalSource } from "../contracts.ts";

export const CANONICAL_CORPUS_CONTRACT_VERSION = "canonical-corpus-boundary-v0.4.1" as const;

const CONVALESCENCE_2025_ID = "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025";
const containerSources = new Set([
  CONVALESCENCE_2025_ID,
  "IL_CONVALESCENCE_EXTENSION_ORDER_2023",
  "IL_GENERAL_OVERTIME_PERMIT_2018",
]);

export type ParsedPage = Readonly<{ page: number | null; text: string }>;

function markerIndex(text: string, patterns: readonly RegExp[]) {
  const candidates = patterns.map((pattern) => text.search(pattern)).filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

/** Mandatory build boundary: a registered instrument never inherits its whole publication container. */
export function selectCanonicalInstrumentPages(source: Pick<LegalSource, "source_id">, pages: readonly ParsedPage[]) {
  if (source.source_id !== CONVALESCENCE_2025_ID) {
    if (containerSources.has(source.source_id)) {
      return Object.freeze({ pages: Object.freeze([]), reason: "instrument_selector_pending_human_review", partial_boundary_pages: Object.freeze([]) });
    }
    return Object.freeze({ pages: Object.freeze([...pages]), reason: "standalone_source_artifact", partial_boundary_pages: Object.freeze([]) });
  }
  const selected = pages.filter((page) => page.page !== null && page.page >= 16 && page.page <= 25).map((page) => ({ ...page }));
  const first = selected.find((page) => page.page === 16);
  const last = selected.find((page) => page.page === 25);
  if (!first || !last) return Object.freeze({ pages: Object.freeze([]), reason: "declared_instrument_pages_missing", partial_boundary_pages: Object.freeze([16, 25]) });
  const start = markerIndex(first.text, [/פרק\s+ז/iu, /ז\s*'?\s*קרפ/iu, /chapter\s+7/iu]);
  const end = markerIndex(last.text, [/פרק\s+ח/iu, /ח\s*'?\s*קרפ/iu, /chapter\s+8/iu]);
  if (start < 0 || end < 0) return Object.freeze({ pages: Object.freeze([]), reason: "mixed_page_boundary_marker_missing", partial_boundary_pages: Object.freeze([16, 25]) });
  first.text = first.text.slice(start).trim();
  last.text = last.text.slice(0, end).trim();
  if (!first.text || !last.text) return Object.freeze({ pages: Object.freeze([]), reason: "instrument_boundary_empty", partial_boundary_pages: Object.freeze([16, 25]) });
  return Object.freeze({ pages: Object.freeze(selected), reason: "gazette_3384_chapter_7_section_24", partial_boundary_pages: Object.freeze([16, 25]) });
}

/** Mandatory retrieval boundary, including defense against legacy whole-container chunk files. */
export function selectCanonicalRetrievalChunks(sources: readonly LegalSource[], chunks: readonly LegalChunk[]) {
  const byVersion = new Map(sources.map((source) => [`${source.source_id}@${source.source_version}`, source]));
  return chunks.filter((chunk) => {
    const source = byVersion.get(`${chunk.source_id}@${chunk.source_version}`);
    if (!source) return false;
    if (!containerSources.has(source.source_id)) return true;
    if (source.source_id !== CONVALESCENCE_2025_ID) return false;
    if (chunk.page_from === null || chunk.page_to === null || chunk.page_from < 16 || chunk.page_to > 25) return false;
    if ((chunk.page_from === 16 || chunk.page_from === 25) && chunk.normalized_text_sha256 === "455549d3f2c54a05380e9df7b7609d730a3068c65f11dcc4138ba351f915467c") return false;
    if (/פרק\s+ח|ח\s*'?\s*קרפ|chapter\s+8/iu.test(`${chunk.heading_path.join(" ")} ${chunk.text}`)) return false;
    return true;
  });
}

export function canonicalEntryHash(value: unknown) {
  const compareKeys = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const stable = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(stable)
    : entry && typeof entry === "object"
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => compareKeys(a, b)).map(([key, item]) => [key, stable(item)]))
      : entry;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
