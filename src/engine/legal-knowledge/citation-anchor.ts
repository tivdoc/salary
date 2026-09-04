// E3-1 (BL-10). A citation must anchor Hebrew text, not only a number.
//
// Every registered citation so far required only that certain digit strings
// appear in the cited chunk. Digits survive the visual-to-logical transform in
// both directions, so the check passed on visual-order text it could not read —
// and it passed on amendment 15's clause while the seniority band recorded in
// the parameter disagreed with the band in the clause, because the clause does
// contain "16" and "14". A number tells you a figure is somewhere on the page.
// It does not tell you the page says what you think it says.
//
// An anchor is a short fragment of the clause itself, in logical order, and the
// run-time check requires the number AND the anchor in the same chunk.
//
// The one hard part is whitespace. These texts come out of PDF glyph
// extraction, which loses and invents spaces freely: the sick-pay clause reads
// "יוםוחצי לכלחודש" where the statute has "יום וחצי לכל חודש". Matching on
// exact bytes would fail on correct anchors and tempt the author to shorten the
// anchor until it passed, which is the opposite of what this is for. So both
// sides are normalized — whitespace removed entirely, and the several Unicode
// forms of Hebrew quotes and hyphens folded — before comparison.

const HEBREW_LETTER = /[א-ת]/u;

// Geresh/gershayim and the maqaf appear in these documents in both their
// Hebrew-block forms and their ASCII lookalikes, sometimes in the same line.
const FOLD: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/[״“”"]/gu, '"'],
  [/[׳‘’']/gu, "'"],
  [/[־‐‑‒–—―-]/gu, "-"],
  [/[֑-ׇ]/gu, ""],
]);

/**
 * The form both sides are compared in: no whitespace at all, quotes and dashes
 * folded to one representative each, Hebrew points stripped.
 */
export function normalizeForAnchor(text: string): string {
  let value = text;
  for (const [pattern, replacement] of FOLD) value = value.replace(pattern, replacement);
  return value.replace(/\s+/gu, "");
}

export type AnchorRejection =
  | "ANCHOR_TOO_SHORT"
  | "ANCHOR_HAS_NO_HEBREW"
  | "ANCHOR_IS_ONLY_DIGITS_AND_PUNCTUATION";

/**
 * Why an anchor is not usable, or null when it is. Rejections are about the
 * anchor itself, before any chunk is consulted: an anchor that is only digits
 * would reintroduce exactly the weakness this unit exists to remove, so it is
 * refused at authoring time rather than silently passing later.
 */
export function anchorRejection(anchor: string): AnchorRejection | null {
  const normalized = normalizeForAnchor(anchor);
  const hebrewLetters = [...normalized].filter((character) => HEBREW_LETTER.test(character)).length;
  if (hebrewLetters === 0) return "ANCHOR_HAS_NO_HEBREW";
  // Enough of the clause to be a clause. Four Hebrew letters is one short word;
  // an anchor that short would match half the corpus.
  if (hebrewLetters < 8) return "ANCHOR_TOO_SHORT";
  if (!/[א-ת]{2,}/u.test(normalized)) return "ANCHOR_IS_ONLY_DIGITS_AND_PUNCTUATION";
  return null;
}

export function assertUsableAnchor(anchor: string): void {
  const rejection = anchorRejection(anchor);
  if (rejection) throw new Error(`${rejection}:${anchor.slice(0, 60)}`);
}

export type CitationAnchorResult = Readonly<{
  anchor: string;
  usable: boolean;
  rejection: AnchorRejection | null;
  matched: boolean;
}>;

/**
 * Whether this chunk carries this anchor. An unusable anchor never matches:
 * it is reported as unusable and not matched, so a bad anchor cannot pass by
 * being vacuous.
 */
export function checkCitationAnchor(chunkText: string, anchor: string): CitationAnchorResult {
  const rejection = anchorRejection(anchor);
  return Object.freeze({
    anchor,
    usable: rejection === null,
    rejection,
    matched: rejection === null && normalizeForAnchor(chunkText).includes(normalizeForAnchor(anchor)),
  });
}

export type CitationVerification = Readonly<{
  chunk_id: string;
  numbers_required: readonly string[];
  numbers_matched: readonly string[];
  numbers_missing: readonly string[];
  anchor: CitationAnchorResult;
  verified: boolean;
}>;

/**
 * The run-time check in full: every required number AND the Hebrew anchor, in
 * the same chunk. Numbers are matched against the chunk as stored — they
 * already survive both orders — and the anchor against the normalized form.
 */
export function verifyCitation(input: Readonly<{
  chunk_id: string;
  chunk_text: string;
  must_contain: readonly string[];
  anchor: string;
}>): CitationVerification {
  const matched = input.must_contain.filter((needle) => input.chunk_text.includes(needle));
  const missing = input.must_contain.filter((needle) => !input.chunk_text.includes(needle));
  const anchor = checkCitationAnchor(input.chunk_text, input.anchor);
  return Object.freeze({
    chunk_id: input.chunk_id,
    numbers_required: Object.freeze([...input.must_contain]),
    numbers_matched: Object.freeze(matched),
    numbers_missing: Object.freeze(missing),
    anchor,
    verified: missing.length === 0 && anchor.matched,
  });
}
