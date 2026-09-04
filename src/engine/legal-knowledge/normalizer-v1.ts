// E2-4. `legal-normalizer-v1`: logical-order Hebrew.
//
// Most of the corpus was extracted from PDFs whose text layer stores glyphs in
// VISUAL order — the order they appear left to right on the page — rather than
// logical order, which is the order someone reads them. For Hebrew that means
// every line arrives backwards. The citation check has been fighting it ever
// since: `must_contain: ["16", "14"]` works only because digits happen to
// survive, and a Hebrew phrase can never be matched at all.
//
// The reconstruction is the standard one and it has exactly one subtlety worth
// stating. Reversing the character order of a visual line restores the Hebrew.
// It also reverses any embedded number, because digits are a left-to-right run
// inside a right-to-left line and were therefore already the right way round.
// So each numeric or Latin run is reversed back afterwards. Get that wrong and
// a statute's "2016" silently becomes "6102" — which is exactly the class of
// error this repository exists to make impossible, so it is tested against a
// known clause rather than assumed.
//
// v0 texts are never touched. Under the supersession rules this produces new
// parsed versions with new hashes beside the old ones, and nothing rebinds
// automatically: a rebind is a new candidate revision and belongs to the
// P-pool.

export const LEGAL_NORMALIZER_V1_VERSION = "legal-normalizer-v1" as const;

const HEBREW = /[֐-׿]/u;
// ך ם ן ף ץ — the five letters that may only end a word.
const FINAL_FORMS = /[ךםןףץ]/u;
// A left-to-right run: digits, Latin letters, and the separators that live
// inside one (dates, section numbers, decimals, ranges).
const LTR_RUN = /[0-9A-Za-z]+(?:[.,:/\\-][0-9A-Za-z]+)*/gu;

/**
 * Reverses one line and puts its left-to-right runs back the way round they
 * started. Applied per line: paragraph order is not affected by bidi.
 */
export function toLogicalOrderLine(line: string): string {
  const reversed = [...line].reverse().join("");
  return reversed.replace(LTR_RUN, (run) => [...run].reverse().join(""));
}

export function toLogicalOrder(text: string): string {
  return text.split("\n").map(toLogicalOrderLine).join("\n");
}

export type HebrewOrderSignal = Readonly<{
  hebrew_words: number;
  words_starting_with_final_form: number;
  words_ending_with_final_form: number;
  visual_order: boolean;
  confident: boolean;
}>;

/**
 * Decides whether a text is stored visually, from a property of the script
 * itself rather than a guess: five Hebrew letters have a distinct final form
 * and may only END a word. In logical order those letters cluster at word
 * ends; in visual order the same letters cluster at word starts. The signal is
 * counted both ways and reported with its own evidence, and `confident` is
 * false when there is too little Hebrew to tell — a small file must not be
 * reordered on the strength of two words.
 */
export function hebrewOrderSignal(text: string): HebrewOrderSignal {
  let startCount = 0;
  let endCount = 0;
  let hebrewWords = 0;
  for (const raw of text.split(/\s+/u)) {
    const hebrew = raw.replace(/[^֐-׿]/gu, "");
    if (hebrew.length < 2) continue;
    hebrewWords += 1;
    if (FINAL_FORMS.test(hebrew[0])) startCount += 1;
    if (FINAL_FORMS.test(hebrew[hebrew.length - 1])) endCount += 1;
  }
  return Object.freeze({
    hebrew_words: hebrewWords,
    words_starting_with_final_form: startCount,
    words_ending_with_final_form: endCount,
    visual_order: startCount > endCount,
    // Both a floor on the sample and a margin on the difference: a text where
    // the two counts are close is not evidence of anything.
    confident: hebrewWords >= 8 && Math.abs(startCount - endCount) >= 2,
  });
}

export function containsHebrew(text: string): boolean {
  return HEBREW.test(text);
}

export type NormalizedV1 = Readonly<{
  normalizer_version: typeof LEGAL_NORMALIZER_V1_VERSION;
  visual_order: false;
  reordered: boolean;
  signal_before: HebrewOrderSignal;
  signal_after: HebrewOrderSignal;
  text: string;
}>;

/**
 * Produces the v1 text. A text already in logical order, or with too little
 * Hebrew to tell, is passed through unchanged and says so — `reordered: false`
 * is a result, not a failure. `visual_order` is `false` on the output either
 * way, because that is what the v1 contract asserts about its own output.
 */
export function normalizeToLogicalOrder(text: string): NormalizedV1 {
  const before = hebrewOrderSignal(text);
  const shouldReorder = before.visual_order && before.confident;
  const output = shouldReorder ? toLogicalOrder(text) : text;
  return Object.freeze({
    normalizer_version: LEGAL_NORMALIZER_V1_VERSION,
    visual_order: false as const,
    reordered: shouldReorder,
    signal_before: before,
    signal_after: hebrewOrderSignal(output),
    text: output,
  });
}
