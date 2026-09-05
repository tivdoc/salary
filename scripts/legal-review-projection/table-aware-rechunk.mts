// L4-1 / D2. Re-chunk every parsed source through `legal-structure-chunker-v1`
// and measure what it does to the bare-row problem BL-15 names.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/table-aware-rechunk.mts
//
// Nothing here writes over a v0 file. Each source gets a NEW `.t1.chunks.json`
// beside the v0 and v1 ones, carrying both the chunked text and its logical
// order, and every chunk id carries the `#t` marker so a v1 chunk can never be
// mistaken for a v0 one in a citation. No parameter is rebound by running this;
// rebinding is a separate, supersession-shaped act.
//
// The measurement it reports is the one that matters: a "bare row" is a chunk
// whose text is numbers and nothing else — no Hebrew, no words — which is
// exactly the chunk shape that cannot carry a citation anchor and cannot tell
// you which column a figure came from.
import "../production-refusal.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { chunkLegalPagesTableAware, LEGAL_CHUNKER_VERSION_V1 } from "../../src/server/engine/legal-knowledge/normalization.ts";
import { containsHebrew, hebrewOrderSignal, LEGAL_NORMALIZER_V1_VERSION, normalizeToLogicalOrder } from "../../src/engine/legal-knowledge/normalizer-v1.ts";
import type { LegalChunk, LegalSource } from "../../src/engine/legal-knowledge/contracts.ts";

const BUILD_STATE = path.join("eval", "legal-knowledge", "manifests", "build-state.json");
const RECEIPT_ROOT = path.join("output", "next", "rechunk");

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  parse_status: string;
  chunks_path: string | null;
  normalized_path: string | null;
  chunk_count: number | null;
  normalized_text_sha256: string | null;
  parser_version: string | null;
  artifact_sha256: string;
}>;

/** A chunk that is numbers and nothing else — the shape BL-15 is about. */
function isBareRow(text: string): boolean {
  return !containsHebrew(text) && !/[A-Za-z]/u.test(text) && /\d/u.test(text);
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const records = (JSON.parse(readFileSync(BUILD_STATE, "utf8")) as { records: BuildRecord[] }).records;
  const perSource: Array<Record<string, unknown>> = [];

  for (const record of [...records].sort((left, right) => left.source_id.localeCompare(right.source_id))) {
    if (record.parse_status !== "parsed" || !record.chunks_path || !record.normalized_path) {
      perSource.push({ source_id: record.source_id, source_version: record.source_version, rechunked: false, reason: record.parse_status });
      continue;
    }
    const v0Document = JSON.parse(readFileSync(record.chunks_path, "utf8")) as { chunks: LegalChunk[] };
    const normalized = JSON.parse(readFileSync(record.normalized_path, "utf8")) as { pages: Array<{ page: number | null; text: string }> };
    if (v0Document.chunks.length === 0) {
      perSource.push({ source_id: record.source_id, source_version: record.source_version, rechunked: false, reason: "no_v0_chunks" });
      continue;
    }
    // Source facets are taken from the v0 chunks rather than re-derived, so the
    // two chunk sets describe the same source in the same words.
    const facet = v0Document.chunks[0];
    const source = {
      source_id: record.source_id,
      source_version: record.source_version,
      topics: facet.topics,
      sectors: facet.sectors,
      effective_period: facet.effective_period,
      authority: facet.authority,
    } as unknown as LegalSource;

    const t1 = chunkLegalPagesTableAware(source, record.artifact_sha256, normalized.pages, {
      normalizedTextSha256: record.normalized_text_sha256 ?? undefined,
      parserVersion: record.parser_version ?? undefined,
    });

    // Visual/logical order is decided once per document, exactly as the v1
    // normalizer decides it, so the two sidecars never disagree about a source.
    const signal = hebrewOrderSignal(t1.map((chunk) => chunk.text).join("\n"));
    const reorder = signal.visual_order && signal.confident;
    const chunks = t1.map((chunk) => {
      const logical = reorder ? normalizeToLogicalOrder(chunk.text).text : chunk.text;
      return {
        chunk_id: chunk.chunk_id,
        source_version_id: chunk.source_version_id,
        parsed_version_id: chunk.parsed_version_id,
        section_identifier: chunk.section_identifier,
        heading_path: chunk.heading_path,
        page_from: chunk.page_from,
        page_to: chunk.page_to,
        character_from: chunk.character_from,
        character_to: chunk.character_to,
        text: chunk.text,
        chunk_text_sha256: chunk.chunk_text_sha256,
        logical_text: logical,
        logical_text_sha256: sha256(logical),
        reordered_from_visual: reorder,
        bare_row: isBareRow(logical),
      };
    });

    const document = {
      schema_version: "legal-chunks-table-aware-v1",
      source_id: record.source_id,
      source_version: record.source_version,
      artifact_sha256: record.artifact_sha256,
      chunker_version: LEGAL_CHUNKER_VERSION_V1,
      normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
      visual_order: false,
      supersedes_nothing: true,
      note: "A new chunk set beside the v0 and v1 ones. Neither is opened for writing here, and no parameter is rebound by producing this.",
      chunks,
    };
    const body = `${JSON.stringify(document, null, 2)}\n`;
    const target = record.chunks_path.replace(/\.chunks\.json$/u, ".t1.chunks.json");
    writeFileSync(target, body, "utf8");

    const bareBefore = v0Document.chunks.filter((chunk) => isBareRow(reorder ? normalizeToLogicalOrder(chunk.text).text : chunk.text)).length;
    const bareAfter = chunks.filter((chunk) => chunk.bare_row).length;
    perSource.push({
      source_id: record.source_id,
      source_version: record.source_version,
      rechunked: true,
      v0_chunks: v0Document.chunks.length,
      t1_chunks: chunks.length,
      v0_bare_rows: bareBefore,
      t1_bare_rows: bareAfter,
      reordered_from_visual: reorder,
      chunks_path: target,
      chunks_output_sha256: sha256(body),
    });
  }

  const rechunked = perSource.filter((entry) => entry.rechunked === true);
  const receipt = {
    schema_version: "tivdoc-table-aware-rechunk-v1",
    unit: "L4-1",
    chunker_version: LEGAL_CHUNKER_VERSION_V1,
    sources_total: perSource.length,
    sources_rechunked: rechunked.length,
    v0_bare_rows_total: rechunked.reduce((sum, entry) => sum + Number(entry.v0_bare_rows), 0),
    t1_bare_rows_total: rechunked.reduce((sum, entry) => sum + Number(entry.t1_bare_rows), 0),
    per_source: perSource,
  };
  const receiptPath = path.join(RECEIPT_ROOT, "table-aware-rechunk.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L4_1_RECHUNK ${JSON.stringify({
    sources_rechunked: receipt.sources_rechunked,
    v0_bare_rows_total: receipt.v0_bare_rows_total,
    t1_bare_rows_total: receipt.t1_bare_rows_total,
    receipt: receiptPath,
  })}`);
}

main();
