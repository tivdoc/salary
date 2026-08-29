import { describe, expect, it } from "vitest";
import { syntheticSource } from "../../../engine/legal-knowledge/synthetic-fixtures.ts";
import {
  chunkLegalPages,
  extractHtmlLegalText,
  normalizedDocumentHash,
  normalizeLegalText,
  parsedLegalVersionId,
  removeRepeatedPdfMargins,
  validateParsedLegalDocument,
} from "./normalization.ts";

describe("deterministic legal normalization", () => {
  it("normalizes Unicode, whitespace, bidi controls, and dash variants", () => {
    expect(normalizeLegalText("Ａ\u200f  B\r\nC—D\n\n\nE")).toBe("A B\nC-D\n\nE");
  });

  it("extracts legal HTML structure without scripts or style text", () => {
    const text = extractHtmlLegalText(`
      <html><style>.secret { color:red }</style><script>rawHidden()</script>
      <h1>פרק ראשון</h1><p>טקסט רשמי</p><table><tr><td>סעיף</td><td>ערך</td></tr></table></html>
    `);
    expect(text).toContain("פרק ראשון\nטקסט רשמי");
    expect(text).toContain("סעיף ערך");
    expect(text).not.toContain("rawHidden");
    expect(text).not.toContain("color:red");
  });

  it("decodes named and numeric HTML entities", () => {
    expect(extractHtmlLegalText("<p>A&amp;B &#1488; &#x5D1;</p>")).toBe("A&B א ב");
  });

  it("removes only repeated PDF edge lines", () => {
    const pages = [1, 2, 3].map((page) => ({ page, text: `Repeated official header\nUnique ${page}\nRepeated footer` }));
    expect(removeRepeatedPdfMargins(pages).map((page) => page.text)).toEqual(["Unique 1", "Unique 2", "Unique 3"]);
  });

  it("preserves edge lines when fewer than three pages exist", () => {
    expect(removeRepeatedPdfMargins([{ page: 1, text: "Header\nBody" }])[0].text).toBe("Header\nBody");
  });

  it("produces a stable normalized hash", () => {
    expect(normalizedDocumentHash([{ text: "A  B" }])).toBe(normalizedDocumentHash([{ text: "Ａ B" }]));
  });

  it("creates a new parsed version when the parser changes without rewriting the raw version", () => {
    const source = syntheticSource();
    const first = parsedLegalVersionId(source, "a".repeat(64), "b".repeat(64), "parser-v1");
    const second = parsedLegalVersionId(source, "a".repeat(64), "b".repeat(64), "parser-v2");
    expect(first).not.toBe(second);
    expect(first).toContain(`${source.source_id}@${source.source_version}#parsed-`);
  });

  it("rejects challenge content and missing source-specific structure", () => {
    expect(validateParsedLegalDocument({ source_id: "IL_HOURS_WORK_REST_LAW" }, [{ text: "Cloudflare captcha ".repeat(10) }]))
      .toMatchObject({ passed: false, code: "challenge_page_rejected" });
    expect(validateParsedLegalDocument({ source_id: "IL_HOURS_WORK_REST_LAW" }, [{ text: "unrelated official content ".repeat(10) }]))
      .toMatchObject({ passed: false, code: "document_sanity_required_marker_missing" });
  });

  it("accepts deterministic reversed-Hebrew PDF extraction markers", () => {
    expect(validateParsedLegalDocument({ source_id: "IL_SICK_PAY_LAW" }, [{ text: `הלחמ ימד ${"ףיעס ".repeat(20)}` }]).passed).toBe(true);
  });

  it("enforces parser page and normalized-text resource limits before indexing", () => {
    expect(validateParsedLegalDocument({ source_id: "IL_SYNTHETIC" }, Array.from({ length: 1001 }, () => ({ text: "legal content" }))))
      .toMatchObject({ passed: false, code: "parser_page_limit_exceeded" });
  });
});

describe("legal-structure chunking", () => {
  it("chunks at legal headings and preserves source order and page references", () => {
    const source = syntheticSource();
    const chunks = chunkLegalPages(source, "a".repeat(64), [
      { page: 1, text: "פרק ראשון\nפתיחה\n1. סעיף ראשון\nתוכן" },
      { page: 2, text: "2. סעיף שני\nתוכן נוסף" },
    ]);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((chunk) => chunk.page_from)).toEqual([...chunks.map((chunk) => chunk.page_from)].sort());
    expect(chunks[0]).toMatchObject({ source_id: source.source_id, artifact_sha256: "a".repeat(64), page_from: 1 });
    expect(chunks.at(-1)?.page_to).toBe(2);
  });

  it("includes stable hashes, character offsets, topics, sectors, and authority", () => {
    const source = syntheticSource();
    const [chunk] = chunkLegalPages(source, "a".repeat(64), [{ page: null, text: "1. Synthetic heading\nSynthetic content" }]);
    expect(chunk.chunk_text_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(chunk.character_to).toBeGreaterThan(chunk.character_from);
    expect(chunk.topics).toEqual(source.topics);
    expect(chunk.sectors).toEqual(source.sectors);
    expect(chunk.authority).toEqual(source.authority);
  });

  it("splits very large structural sections deterministically", () => {
    const source = syntheticSource();
    const text = `1. Heading\n${"Synthetic legal line\n".repeat(300)}`;
    const first = chunkLegalPages(source, "a".repeat(64), [{ page: 1, text }]);
    const second = chunkLegalPages(source, "a".repeat(64), [{ page: 1, text }]);
    expect(first.length).toBeGreaterThan(1);
    expect(first.map((chunk) => chunk.chunk_id)).toEqual(second.map((chunk) => chunk.chunk_id));
  });
});
