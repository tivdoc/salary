import { describe, expect, it } from "vitest";
import {
  PENSION_2016_OCR_TOOLCHAIN,
  createPensionOcrDerivedBundle,
  normalizeOcrPage,
  sha256,
  stableJson,
  verifyOcrCitationRoundTrip,
  createReviewedTranscriptRevision,
} from "./pension-ocr.ts";

const syntheticHebrewPages = [
  "  כותרת\r\nשורה   ראשונה\r\n\r\n",
  "עמוד\tשני\nערך סינתטי בלבד\n",
  "עמוד שלישי\nללא פרשנות משפטית\n",
];

describe("deterministic Pension OCR contracts", () => {
  it("normalizes synthetic Hebrew mechanically and maps every raw line", () => {
    const normalized = normalizeOcrPage(syntheticHebrewPages[0], 1);
    expect(normalized.normalized_text).toBe("כותרת\nשורה ראשונה\n");
    expect(normalized.line_map).toEqual([
      expect.objectContaining({ raw_line: 1, normalized_line: 1 }),
      expect.objectContaining({ raw_line: 2, normalized_line: 2 }),
      expect.objectContaining({ raw_line: 3, normalized_line: null }),
      expect.objectContaining({ raw_line: 4, normalized_line: null }),
    ]);
  });

  it("produces byte-identical derived evidence and round-trip citations", () => {
    const inputs = syntheticHebrewPages.map((raw_ocr_text, index) => ({
      page: index + 1,
      rendered_page_sha256: PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256[index],
      raw_ocr_text,
      raw_ocr_sha256: sha256(raw_ocr_text),
    }));
    const runA = createPensionOcrDerivedBundle(inputs);
    const runB = createPensionOcrDerivedBundle([...inputs].reverse());
    expect(stableJson(runA)).toBe(stableJson(runB));
    const normalized = syntheticHebrewPages.map((text, index) => normalizeOcrPage(text, index + 1));
    expect(verifyOcrCitationRoundTrip(runA, normalized)).toMatchObject({ passed: true, citation_count: 6, failures: [] });
    expect(runA).toMatchObject({ review_state: "needs_review", activation_state: "inactive", corpus_registration_performed: false, ocr_confidence_is_legal_confidence: false });
  });

  it("pins the official upstream Hebrew model and license", () => {
    expect(PENSION_2016_OCR_TOOLCHAIN.language_artifact).toMatchObject({
      upstream_commit: "ced78752cc61322fb554c280d13360b35b8684e4",
      sha256: "7da6ea6b7a2620ec8e8b41de2967a13d429635a56657a0b30b622501a573d3e1",
      byte_count: 5_413_459,
      license: { spdx: "Apache-2.0", sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" },
    });
  });

  it("creates append-only reviewed transcript revisions without overwriting OCR", () => {
    const hashes = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    const first = createReviewedTranscriptRevision({
      revision: 1,
      parent_revision_sha256: null,
      raw_pdf_sha256: PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256,
      rendered_page_sha256: PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256,
      raw_ocr_page_sha256: hashes,
      normalized_page_sha256: [...hashes].reverse(),
      reviewer_id: "synthetic-reviewer",
      decision: "synthetic_reject",
    });
    const second = createReviewedTranscriptRevision({ ...first, revision: 2, parent_revision_sha256: first.revision_sha256, decision: "synthetic_accept" });
    expect(second).toMatchObject({ raw_ocr_overwritten: false, corpus_registration_performed: false, activation_state: "inactive", parent_revision_sha256: first.revision_sha256 });
    expect(second.revision_sha256).not.toBe(first.revision_sha256);
  });
});
