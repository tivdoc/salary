import { describe, expect, it } from "vitest";
import {
  LEGAL_NORMALIZER_V1_VERSION,
  hebrewOrderSignal,
  normalizeToLogicalOrder,
  toLogicalOrder,
  toLogicalOrderLine,
} from "./normalizer-v1.ts";

// E2-4. Tested against a real clause from the corpus, not a made-up string:
// this is the operative sentence of Annual Vacation Law amendment 15, as it
// actually sits in the extracted text, and what it must read as afterwards.
// The number in it is the whole reason this test exists — get the run handling
// wrong and "16" becomes "61" without anything else looking different.

const AMENDMENT_15_VISUAL = "םוקמב \"4־מ\" אובי \"5־מ\"";
const AMENDMENT_15_LOGICAL = "\"מ־5\" יבוא \"מ־4\" במקום";

describe("E2-4 logical-order Hebrew normalization", () => {
  it("restores a real clause from the corpus, digits intact", () => {
    expect(toLogicalOrderLine(AMENDMENT_15_VISUAL)).toBe(AMENDMENT_15_LOGICAL);
    // The point of the run handling, stated as its own assertion: the digits
    // are still 4 and 5, not 4 and 5 reversed into something else.
    expect(toLogicalOrderLine(AMENDMENT_15_VISUAL)).toContain("4");
    expect(toLogicalOrderLine(AMENDMENT_15_VISUAL)).toContain("5");
  });

  it("never reverses a multi-digit number", () => {
    // "2016" is the case that would fail silently: reversing the line without
    // putting the run back gives "6102", which is still four digits and still
    // looks like a year.
    const visual = `רבמבצד 2016 םוי`;
    const logical = toLogicalOrderLine(visual);
    expect(logical).toContain("2016");
    expect(logical).not.toContain("6102");
    for (const value of ["13/07/1998", "35.40", "182", "13,566"]) {
      expect(toLogicalOrderLine(`םולש ${value} םולש`), value).toContain(value);
    }
  });

  it("is its own inverse on a single line, so nothing is lost in the transform", () => {
    expect(toLogicalOrderLine(toLogicalOrderLine(AMENDMENT_15_VISUAL))).toBe(AMENDMENT_15_VISUAL);
  });

  it("detects visual order from final-form letters, and says how sure it is", () => {
    const visualSignal = hebrewOrderSignal(AMENDMENT_15_VISUAL);
    expect(visualSignal.visual_order).toBe(true);
    expect(visualSignal.words_starting_with_final_form)
      .toBeGreaterThan(visualSignal.words_ending_with_final_form);
    const logicalSignal = hebrewOrderSignal(AMENDMENT_15_LOGICAL);
    expect(logicalSignal.visual_order).toBe(false);
    // Two words is not evidence. The detector must decline rather than guess.
    expect(visualSignal.confident).toBe(false);
    expect(hebrewOrderSignal("hello world 2016").hebrew_words).toBe(0);
  });

  it("passes text through unchanged when it is already logical, or when there is too little to tell", () => {
    const tooLittle = normalizeToLogicalOrder(AMENDMENT_15_VISUAL);
    expect(tooLittle.reordered).toBe(false);
    expect(tooLittle.text).toBe(AMENDMENT_15_VISUAL);
    // `visual_order: false` is what v1 asserts about its own output, whether or
    // not it had to do anything to get there.
    expect(tooLittle.visual_order).toBe(false);
    expect(tooLittle.normalizer_version).toBe(LEGAL_NORMALIZER_V1_VERSION);

    const english = normalizeToLogicalOrder("The quick brown fox jumps over the lazy dog 2016.");
    expect(english.reordered).toBe(false);
    expect(english.text).toBe("The quick brown fox jumps over the lazy dog 2016.");
  });

  it("reorders a text with enough Hebrew to be sure, and the signal flips", () => {
    // Twelve visual-order words, each ending in a final form once corrected.
    const words = ["םוקמב", "םימי", "ןובשח",
      "ץרא", "םלוע", "ןמז",
      "םולש", "םחל", "ןבל",
      "ץע", "םימ", "ןג"];
    const visual = words.join(" ");
    const before = hebrewOrderSignal(visual);
    expect(before.visual_order).toBe(true);
    expect(before.confident).toBe(true);
    const result = normalizeToLogicalOrder(visual);
    expect(result.reordered).toBe(true);
    expect(result.signal_after.visual_order).toBe(false);
    expect(result.text).not.toBe(visual);
  });

  it("treats each line independently: paragraph order is not a bidi question", () => {
    const two = `${AMENDMENT_15_VISUAL}\nsecond line 2016`;
    const out = toLogicalOrder(two);
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[0]).toBe(AMENDMENT_15_LOGICAL);
    expect(out.split("\n")[1]).toContain("2016");
  });
});
