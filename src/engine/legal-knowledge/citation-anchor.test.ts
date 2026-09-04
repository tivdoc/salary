import { describe, expect, it } from "vitest";
import {
  anchorRejection,
  checkCitationAnchor,
  normalizeForAnchor,
  verifyCitation,
} from "./citation-anchor.ts";

// E3-1 (BL-10). The regression case first, because it is the reason this
// module exists: amendment 15 changes the seniority band and the day count in
// the same clause, and the old numeric-only check passed a parameter that got
// the count right and the band wrong.

// The clause as it sits in the v1 logical-order text of
// IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@discovery-v0#0002-ada0a7cfcc75,
// glyph-extraction spacing and all.
const AMENDMENT_15_CLAUSE =
  'תיקון סעיף 3 1 בחוק חופשה שנתית, התשי"א-1 5 19 1 (להלן - החוק העיקרי), בסעיף 3(א) -\n'
  + '(1) בפסקה (1), במקום "מ־4" יבוא "מ־5" ובמקום " 14" יבוא "16 ";';

// The clause fragment that says the band moved. Any parameter claiming years
// 1-4 for the post-2017 rule has to sit beside this sentence.
const BAND_ANCHOR = 'במקום "מ־4" יבוא "מ־5"';

describe("E3-1 citation anchors", () => {
  it("catches the vacation band: numbers alone pass, the anchor decides", () => {
    // The old check. Both needles present — this is exactly what passed.
    const numbersOnly = verifyCitation({
      chunk_id: "amendment-15",
      chunk_text: AMENDMENT_15_CLAUSE,
      must_contain: ["16", "14"],
      anchor: BAND_ANCHOR,
    });
    expect(numbersOnly.numbers_missing).toEqual([]);
    expect(numbersOnly.anchor.matched).toBe(true);
    expect(numbersOnly.verified).toBe(true);

    // And the case that matters: a citation to a DIFFERENT clause of the same
    // document, carrying the same numbers, is now refused. This is the shape
    // of the mis-scoped vacation parameter — right figure, wrong sentence.
    const wrongClause = 'ועד ליום התחילה יקראו את סעיף 3(א)(1) לחוק העיקרי כך שבמקום " 14" יבוא "15 "';
    const misplaced = verifyCitation({
      chunk_id: "amendment-15-temporary-provision",
      chunk_text: wrongClause,
      must_contain: ["14"],
      anchor: BAND_ANCHOR,
    });
    expect(misplaced.numbers_missing, "the number is still there").toEqual([]);
    expect(misplaced.anchor.matched, "but the clause is not").toBe(false);
    expect(misplaced.verified).toBe(false);
  });

  it("matches through the spacing that PDF glyph extraction destroys", () => {
    // The sick-pay clause reads "יוםוחצי לכלחודש" in the extracted text where
    // the statute has "יום וחצי לכל חודש". An anchor written the way the law
    // writes it must still match, or the author is pushed to shorten the
    // anchor until it passes — the opposite of the point.
    const extracted = "תקופה מצטברת של יוםוחצי לכלחודש עבודה מלא שהעובדעבד אצל אותומעסיק";
    const asWritten = "תקופה מצטברת של יום וחצי לכל חודש עבודה מלא";
    expect(checkCitationAnchor(extracted, asWritten).matched).toBe(true);
  });

  it("folds the quote and dash forms these documents mix within one line", () => {
    expect(normalizeForAnchor('התשי"א')).toBe(normalizeForAnchor("התשי״א"));
    expect(normalizeForAnchor("מ־4")).toBe(normalizeForAnchor("מ-4"));
    expect(normalizeForAnchor("סעיף 3(א)")).toBe("סעיף3(א)");
  });

  it("refuses an anchor that would reintroduce the weakness it exists to remove", () => {
    // A numeric anchor is the old check wearing a new name.
    expect(anchorRejection("47.5")).toBe("ANCHOR_HAS_NO_HEBREW");
    expect(anchorRejection("§3(b), §3(c)")).toBe("ANCHOR_HAS_NO_HEBREW");
    // One short word matches half the corpus.
    expect(anchorRejection("שכר")).toBe("ANCHOR_TOO_SHORT");
    expect(anchorRejection("חוק חופשה")).toBeNull();
  });

  it("an unusable anchor never matches, so a bad anchor cannot pass by being vacuous", () => {
    const result = checkCitationAnchor("anything at all", "42");
    expect(result.usable).toBe(false);
    expect(result.matched).toBe(false);
    const verification = verifyCitation({
      chunk_id: "any", chunk_text: "42", must_contain: ["42"], anchor: "42",
    });
    expect(verification.numbers_missing).toEqual([]);
    expect(verification.verified, "numbers alone are no longer enough").toBe(false);
  });

  it("requires the number and the anchor in the SAME chunk, not one each", () => {
    const wrongNumber = verifyCitation({
      chunk_id: "amendment-15",
      chunk_text: AMENDMENT_15_CLAUSE,
      must_contain: ["999"],
      anchor: BAND_ANCHOR,
    });
    expect(wrongNumber.anchor.matched).toBe(true);
    expect(wrongNumber.numbers_missing).toEqual(["999"]);
    expect(wrongNumber.verified).toBe(false);
  });

  it("does not match an anchor against the visual-order form of the same clause", () => {
    // Anchors are written in logical order and checked against v1 text. Given
    // the same clause in visual order, the anchor must fail rather than
    // accidentally match a reversed fragment — otherwise the anchor would be
    // as order-blind as the numbers were.
    const visual = [...AMENDMENT_15_CLAUSE].reverse().join("");
    expect(checkCitationAnchor(visual, BAND_ANCHOR).matched).toBe(false);
  });
});
