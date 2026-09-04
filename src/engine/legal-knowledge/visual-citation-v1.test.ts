import { describe, expect, it } from "vitest";
import {
  buildVisualCitation,
  resolveVisualReading,
  visualBindingOf,
  visualCitationSchema,
  worstProvenance,
} from "./visual-citation-v1.ts";

const BASE = {
  artifact_sha256: "a".repeat(64),
  page: 4,
  page_pdf_sha256: "b".repeat(64),
  page_image_sha256: "c".repeat(64),
  region: { kind: "stored_line" as const, line_index: 38, line_text: "ןהירחאש תפסונ העש לכ דעבו ,ליגרה רכשהמ 11/4­מתוחפ אל הדובע רכש םוי ותואבש" },
  text_layer_surface: "11/4",
  visual_reading: "1¼",
};

describe("legal-visual-citation-v1 (L6-2, D1)", () => {
  it("resolves the short vocabulary of readings, and nothing outside it", () => {
    expect(resolveVisualReading("1¼")).toEqual({ numerator: "5", denominator: "4" });
    expect(resolveVisualReading("1½")).toEqual({ numerator: "3", denominator: "2" });
    expect(resolveVisualReading("½")).toEqual({ numerator: "1", denominator: "2" });
    expect(resolveVisualReading("6.5%")).toEqual({ numerator: "13", denominator: "200" });
    expect(resolveVisualReading("6%")).toEqual({ numerator: "3", denominator: "50" });
    expect(resolveVisualReading("6,150")).toEqual({ numerator: "6150", denominator: "1" });
    expect(resolveVisualReading("1.25")).toMatchObject({ refusal: "VISUAL_READING_NOT_IN_VOCABULARY:1.25" });
    expect(resolveVisualReading("11/4")).toMatchObject({ refusal: expect.stringMatching(/^VISUAL_READING_NOT_IN_VOCABULARY/u) });
    expect(resolveVisualReading("one and a quarter")).toMatchObject({ refusal: expect.stringMatching(/^VISUAL_READING_NOT_IN_VOCABULARY/u) });
  });

  it("builds a citation that says what it is: inferred, visual, awaiting confirmation", () => {
    const built = buildVisualCitation(BASE);
    expect(built.refusal).toBeNull();
    const citation = built.citation!;
    expect(citation.provenance).toBe("inferred_visual");
    expect(citation.visual_verification_required).toBe(true);
    expect(citation.read_by).toBe("session");
    expect(citation.value).toEqual({ numerator: "5", denominator: "4" });
    expect(citation.region).toEqual({ kind: "stored_line", line_index: 38, line_text: BASE.region.line_text });
    expect(visualCitationSchema.safeParse(citation).success).toBe(true);
    expect(visualBindingOf(citation)).toEqual({ page_pdf_sha256: "b".repeat(64), visual_reading: "1¼" });
  });

  it("refuses a surface that is not on the stored line, and one the lexicon would read instead", () => {
    expect(buildVisualCitation({ ...BASE, text_layer_surface: "11/2" }).refusal).toBe("VISUAL_SURFACE_NOT_ON_STORED_LINE");
    expect(buildVisualCitation({ ...BASE, region: { ...BASE.region, line_text: "שכר עבודה לא פחות מ-מחצית" }, text_layer_surface: "מחצית" }).refusal).toBe("VISUAL_SURFACE_NOT_AMBIGUOUS_USE_TEXT_PATH");
    expect(buildVisualCitation({ ...BASE, region: { ...BASE.region, line_text: "   " } }).refusal).toBe("VISUAL_STORED_LINE_EMPTY");
    expect(buildVisualCitation({ ...BASE, visual_reading: "1.25" }).refusal).toMatch(/^VISUAL_READING_NOT_IN_VOCABULARY/u);
  });

  it("allows an absent text-layer surface — a figure the text layer dropped entirely", () => {
    const built = buildVisualCitation({ ...BASE, text_layer_surface: null, visual_reading: "6.5%" });
    expect(built.refusal).toBeNull();
    expect(built.citation?.text_layer_surface).toBeNull();
    expect(built.citation?.value).toEqual({ numerator: "13", denominator: "200" });
  });

  it("an image-only artifact cites a box on the page, in PDF user space, and carries no text surface", () => {
    const box = { kind: "page_bbox" as const, x0: 250, y0: 480, x1: 400, y1: 520, page_width: 596.16, page_height: 837.84 };
    const built = buildVisualCitation({ ...BASE, region: box, text_layer_surface: null, visual_reading: "6.5%" });
    expect(built.refusal).toBeNull();
    expect(built.citation?.region).toEqual({ ...box, unit: "pdf_user_space" });
    expect(buildVisualCitation({ ...BASE, region: box, text_layer_surface: "6.5%", visual_reading: "6.5%" }).refusal).toBe("VISUAL_BBOX_WITH_TEXT_SURFACE");
    expect(buildVisualCitation({ ...BASE, region: { ...box, x1: 700 }, text_layer_surface: null, visual_reading: "6.5%" }).refusal).toBe("VISUAL_BBOX_NOT_ON_PAGE");
  });

  it("cannot be built as documented, and cannot drop the confirmation flag", () => {
    const citation = buildVisualCitation(BASE).citation!;
    expect(visualCitationSchema.safeParse({ ...citation, provenance: "text_verified" }).success).toBe(false);
    expect(visualCitationSchema.safeParse({ ...citation, visual_verification_required: false }).success).toBe(false);
    expect(visualCitationSchema.safeParse({ ...citation, read_by: "ocr" }).success).toBe(false);
  });

  it("a candidate's grade is the worst of its citations'", () => {
    expect(worstProvenance([])).toBe("text_verified");
    expect(worstProvenance(["text_verified", "lexicon"])).toBe("lexicon");
    expect(worstProvenance(["selection", "inferred_visual", "text_verified"])).toBe("inferred_visual");
    expect(worstProvenance(["administrative", "inferred_visual"])).toBe("administrative");
  });
});
