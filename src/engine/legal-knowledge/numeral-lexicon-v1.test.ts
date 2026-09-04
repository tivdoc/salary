// L5-1 / D1. The lexicon is a table of surface forms and rationals, and the
// tests hold it to exactly that.
import { describe, expect, it } from "vitest";
import {
  bindCompoundThroughLexicon,
  bindThroughLexicon,
  containsOcrAmbiguousFraction,
  LEGAL_NUMERAL_LEXICON,
  LEGAL_NUMERAL_LEXICON_VERSION,
  resolveNumeral,
} from "./numeral-lexicon-v1.ts";

/**
 * The exact bytes of the Hours of Work and Rest Law scan, chunk
 * `IL_HOURS_WORK_REST_LAW@discovery-v0#t0006-1cec5eccebec`, around the overtime
 * premium. The soft hyphen (U+00AD) between `מ` and `11/2` is in the source;
 * it is what OCR made of a hyphenated "מ-1½". This string is the reason the
 * refusal exists, so it is pinned here verbatim rather than described.
 */
const HOURS_LAW_OCR_LINE = "שנעשתה בשעות הנוספות שלמעלה משתים ­ לא פחותמ­11/2 מהשכר המשתלם בעד כל";
const HOURS_LAW_OCR_QUARTER = "שבאותו יום שכר עבודה לא פחותמ­11/4 מהשכר הרגיל";

describe("legal-numeral-lexicon-v1", () => {
  it("is versioned and every entry is a surface form and a rational, nothing else", () => {
    expect(LEGAL_NUMERAL_LEXICON_VERSION).toBe("legal-numeral-lexicon-v1");
    for (const entry of LEGAL_NUMERAL_LEXICON) {
      expect(Object.keys(entry).sort()).toEqual(["additive", "denominator", "form", "numerator", "surface"]);
      expect(entry.numerator).toMatch(/^\d+$/u);
      expect(entry.denominator).toMatch(/^[1-9]\d*$/u);
      // No unit, no topic, no money, no clause reference. A lexicon entry that
      // carried any of those would be a parameter wearing a dictionary's coat.
      for (const forbidden of ["unit", "topic", "currency", "minor_units", "clause", "source", "value"]) {
        expect(entry, `${entry.surface} carries ${forbidden}`).not.toHaveProperty(forbidden);
      }
    }
  });

  it("has no duplicate surface forms", () => {
    const surfaces = LEGAL_NUMERAL_LEXICON.map((entry) => entry.surface);
    expect(new Set(surfaces).size).toBe(surfaces.length);
  });

  it("resolves the words and glyphs the law uses to exact rationals", () => {
    const cases: Array<[string, string, string]> = [
      ["מחצית", "1", "2"], ["חצי", "1", "2"], ["רבע", "1", "4"], ["שליש", "1", "3"],
      ["אחד", "1", "1"], ["יום אחד", "1", "1"], ["יום נוסף", "1", "1"], ["מלא", "1", "1"], ["מלאים", "1", "1"],
      ["¼", "1", "4"], ["½", "1", "2"], ["¾", "3", "4"],
    ];
    for (const [surface, numerator, denominator] of cases) {
      const resolved = resolveNumeral(surface);
      expect(resolved.resolved, surface).toBe(true);
      if (resolved.resolved) {
        expect(resolved.numerator).toBe(numerator);
        expect(resolved.denominator).toBe(denominator);
        expect(resolved.additive).toBe(false);
      }
    }
  });

  it("marks the additive forms as additive and refuses to bind them alone", () => {
    for (const surface of ["וחצי", "ורבע"]) {
      const resolved = resolveNumeral(surface);
      expect(resolved.resolved && resolved.additive, surface).toBe(true);
      expect(bindThroughLexicon(`יום ${surface}`, surface).refusal).toBe("NUMERAL_ADDITIVE_NEEDS_A_WHOLE");
    }
  });

  it("binds a compound whole-plus-half, including the glued form the sick-pay scan has", () => {
    const spaced = bindCompoundThroughLexicon("תקופה מצטברת של יום וחצי לכל חודש", "יום", "וחצי");
    expect(spaced.binding).toMatchObject({ numerator: "3", denominator: "2", surface: "יום וחצי" });
    const glued = bindCompoundThroughLexicon("תקופה מצטברת של יוםוחצי לכלחודש עבודה מלא", "יום", "וחצי");
    expect(glued.binding).toMatchObject({ numerator: "3", denominator: "2", surface: "יוםוחצי" });
    expect(bindCompoundThroughLexicon("nothing here", "יום", "וחצי").refusal).toBe("NUMERAL_SURFACE_NOT_IN_CHUNK");
  });

  it("the exclusion clause binds to zero only from its verbatim surface", () => {
    for (const surface of ["אינו זכאי", "לא ישולם"]) {
      const resolved = resolveNumeral(surface);
      expect(resolved.resolved && resolved.form === "exclusion_clause" && resolved.numerator === "0", surface).toBe(true);
    }
    // Absence of a tier is not an exclusion clause. There is no surface to bind.
    expect(resolveNumeral("").resolved).toBe(false);
    expect(bindThroughLexicon("עובד שנעדר יהיה זכאי החל מהיום הרביעי", "אינו זכאי").refusal).toBe("NUMERAL_SURFACE_NOT_IN_CHUNK");
  });

  it("refuses the OCR-mangled fractions of the Hours of Work and Rest Law scan, by name", () => {
    // The exact string, soft hyphen and all.
    expect(containsOcrAmbiguousFraction(HOURS_LAW_OCR_LINE)).toBe(true);
    expect(containsOcrAmbiguousFraction(HOURS_LAW_OCR_QUARTER)).toBe(true);
    for (const surface of ["11/2", "11/4", "1 1/2", "1 1/4", "פחותמ­11/2"]) {
      const resolved = resolveNumeral(surface);
      expect(resolved.resolved, surface).toBe(false);
      if (!resolved.resolved) expect(resolved.refusal).toBe("NUMERAL_OCR_AMBIGUOUS");
      expect(bindThroughLexicon(HOURS_LAW_OCR_LINE, surface).refusal).toBe("NUMERAL_OCR_AMBIGUOUS");
    }
    // And neither reading is offered: not one-and-a-half, not eleven halves.
    expect(LEGAL_NUMERAL_LEXICON.some((entry) => entry.surface.includes("11/"))).toBe(false);
  });

  it("does not mistake a clean fraction glyph or a date for the OCR form", () => {
    expect(containsOcrAmbiguousFraction("לא פחות מ-1½ מהשכר")).toBe(false);
    expect(containsOcrAmbiguousFraction("11.5.2022")).toBe(false);
    expect(containsOcrAmbiguousFraction("1/2")).toBe(false);
    expect(containsOcrAmbiguousFraction("211/2")).toBe(false);
  });

  it("binds a surface only when it is in the chunk, and records the form", () => {
    const chunk = "(2) בעד הימים השני והשלישי להעדרו כאמור - מחצית דמי מחלה;";
    const half = bindThroughLexicon(chunk, "מחצית");
    expect(half.binding).toEqual({
      lexicon_version: "legal-numeral-lexicon-v1", surface: "מחצית", numeral_form: "word", numerator: "1", denominator: "2",
    });
    expect(bindThroughLexicon(chunk, "רבע").refusal).toBe("NUMERAL_SURFACE_NOT_IN_CHUNK");
    expect(bindThroughLexicon(chunk, "שלושת רבעי").refusal).toBe("NUMERAL_NOT_IN_LEXICON");
    expect(bindThroughLexicon("½ מהשכר", "½").binding?.numeral_form).toBe("glyph");
  });
});
