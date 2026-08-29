import { describe, expect, it } from "vitest";
import { reconstructCitationText } from "./citations.ts";
import { legalCitationSchema } from "./contracts.ts";
import { syntheticChunk, syntheticSource } from "./synthetic-fixtures.ts";

function citationFor(chunk = syntheticChunk(), overrides: Record<string, unknown> = {}) {
  const source = syntheticSource();
  return legalCitationSchema.parse({
    source_id: source.source_id,
    source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id,
    raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256,
    parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id,
    title: source.title,
    authority: source.authority,
    canonical_url: source.canonical_url,
    section_or_clause: chunk.section_identifier,
    page: chunk.page_from,
    effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic clause 1",
    review_status: source.status,
    retrieved_at: "2026-08-29T00:00:00Z",
    locator: {
      format: chunk.page_from === null ? "html" : "pdf",
      page: chunk.page_from,
      section: chunk.section_identifier,
      paragraph: null,
      character_from: chunk.character_from,
      character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id],
    excerpt: null,
    ...overrides,
  });
}

describe("citation round-trip", () => {
  it("resolves a unique offset locator when identical text occurs twice", () => {
    const first = syntheticChunk(undefined, { chunk_id: "first", text: "repeat", character_from: 0, character_to: 6 });
    const second = syntheticChunk(undefined, { chunk_id: "second", text: "repeat", character_from: 7, character_to: 13 });
    expect(reconstructCitationText(citationFor(first), first, [{ text: "repeat\nrepeat" }]).reconstructed).toBe("repeat");
    expect(reconstructCitationText(citationFor(second), second, [{ text: "repeat\nrepeat" }]).reconstructed).toBe("repeat");
    expect(citationFor(first).locator.character_from).not.toBe(citationFor(second).locator.character_from);
  });

  it("supports PDF page and HTML offset locators", () => {
    expect(citationFor(syntheticChunk()).locator).toMatchObject({ format: "pdf", page: 1 });
    const htmlChunk = syntheticChunk(undefined, { page_from: null, page_to: null });
    expect(citationFor(htmlChunk).locator).toMatchObject({ format: "html", page: null });
  });

  it("does not break a historical citation when a new source version is added", () => {
    const old = syntheticChunk();
    const oldCitation = citationFor(old);
    const newerSource = syntheticSource({ source_version: "v2" });
    const newer = syntheticChunk(newerSource);
    expect(newer.chunk_id).not.toBe(old.chunk_id);
    expect(oldCitation.chunk_id).toBe(old.chunk_id);
    expect(reconstructCitationText(oldCitation, old, [{ text: old.text }]).passed).toBe(true);
  });
});
