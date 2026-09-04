// L5-1 / D1. `legal-numeral-lexicon-v1` — a lexical table, not a source.
//
// A law that says "half the sick pay" has stated a rate. It has stated it as a
// word, and a citation check that only recognises digits cannot see it, which
// is why sick_leave sat at `slot_unbound` through two runs while the figure was
// on disk the whole time. This table maps the words and fraction glyphs Israeli
// labour law uses to exact rationals, and nothing else.
//
// Three rules keep it a lexicon rather than a source of law:
//
//   1. An entry carries a surface form and a rational. No unit, no topic, no
//      money, no clause. A test asserts that shape, so an entry cannot quietly
//      grow a meaning of its own.
//   2. A binding through it records the exact surface string and its form —
//      `word`, `glyph` or `exclusion_clause` — and that string must sit in the
//      same chunk as the Hebrew anchor. BL-10 is unchanged: the number and the
//      clause are found together or not at all.
//   3. An OCR-mangled fraction never binds. The 1951 gazette scan renders 1¼
//      and 1½ as `11/4` and `11/2`, which read as eleven halves as easily as
//      one and a half, and a table that guessed would be authoring the rate.
//      Those forms are recognised so they can be REFUSED, with a name.
//
// The exclusion clause is the one entry that is a phrase rather than a numeral.
// "Not entitled" is how the law states a tier of zero, and a tier of zero is a
// rate the executor must be able to bind. It binds only from the verbatim
// surface string, never from an inference that a tier was omitted.

export const LEGAL_NUMERAL_LEXICON_VERSION = "legal-numeral-lexicon-v1" as const;

export type NumeralForm = "word" | "glyph" | "exclusion_clause";

export type LexiconEntry = Readonly<{
  surface: string;
  form: NumeralForm;
  numerator: string;
  denominator: string;
  /** `וחצי` adds a half to the preceding whole; it is not a value on its own. */
  additive: boolean;
}>;

const entry = (surface: string, form: NumeralForm, numerator: string, denominator = "1", additive = false): LexiconEntry =>
  Object.freeze({ surface, form, numerator, denominator, additive });

export const LEGAL_NUMERAL_LEXICON: readonly LexiconEntry[] = Object.freeze([
  // Fractions as words.
  entry("מחצית", "word", "1", "2"),
  entry("חצי", "word", "1", "2"),
  entry("רבע", "word", "1", "4"),
  entry("שליש", "word", "1", "3"),
  entry("שני שלישים", "word", "2", "3"),
  entry("שלושה רבעים", "word", "3", "4"),
  // Wholes as words.
  entry("אחד", "word", "1"),
  entry("אחת", "word", "1"),
  entry("יום", "word", "1"),
  entry("יום אחד", "word", "1"),
  entry("יום נוסף", "word", "1"),
  entry("מלא", "word", "1"),
  entry("מלאים", "word", "1"),
  entry("מלאה", "word", "1"),
  // Additive halves and quarters: "יום וחצי" is one day plus this.
  entry("וחצי", "word", "1", "2", true),
  entry("ורבע", "word", "1", "4", true),
  // Fraction glyphs.
  entry("¼", "glyph", "1", "4"),
  entry("½", "glyph", "1", "2"),
  entry("¾", "glyph", "3", "4"),
  entry("⅓", "glyph", "1", "3"),
  entry("⅔", "glyph", "2", "3"),
  // The tier the law states as non-entitlement. Verbatim only.
  entry("אינו זכאי", "exclusion_clause", "0"),
  entry("אינה זכאית", "exclusion_clause", "0"),
  entry("לא ישולם", "exclusion_clause", "0"),
  entry("לא ישולמו", "exclusion_clause", "0"),
]);

/**
 * The OCR forms that must never be read. `11/2` is what a scanned 1½ becomes
 * once the glyph is split into "1" and "1/2" with the space lost; it is also,
 * read plainly, eleven halves. Neither reading is safe. The patterns match the
 * lost-space form, the kept-space form, and the bare `1/2` that follows a
 * standalone `1` — all of which appear in the Hours of Work and Rest Law scan.
 */
const OCR_AMBIGUOUS_FRACTION = /(?:^|[^\d])1\s?1\/[234](?!\d)/u;

export type NumeralResolution =
  | Readonly<{ resolved: true; surface: string; form: NumeralForm; numerator: string; denominator: string; additive: boolean }>
  | Readonly<{ resolved: false; surface: string; refusal: "NUMERAL_OCR_AMBIGUOUS" | "NUMERAL_NOT_IN_LEXICON" }>;

/** Exact-match resolution of one surface string. No normalisation, no fuzz. */
export function resolveNumeral(surface: string): NumeralResolution {
  if (OCR_AMBIGUOUS_FRACTION.test(surface)) return Object.freeze({ resolved: false, surface, refusal: "NUMERAL_OCR_AMBIGUOUS" });
  const found = LEGAL_NUMERAL_LEXICON.find((candidate) => candidate.surface === surface);
  if (!found) return Object.freeze({ resolved: false, surface, refusal: "NUMERAL_NOT_IN_LEXICON" });
  return Object.freeze({ resolved: true, surface, form: found.form, numerator: found.numerator, denominator: found.denominator, additive: found.additive });
}

/** True when the chunk contains an OCR-mangled fraction anywhere. Used to refuse a whole chunk as a rate source. */
export function containsOcrAmbiguousFraction(chunkText: string): boolean {
  return OCR_AMBIGUOUS_FRACTION.test(chunkText);
}

export type LexiconBinding = Readonly<{
  lexicon_version: typeof LEGAL_NUMERAL_LEXICON_VERSION;
  surface: string;
  numeral_form: NumeralForm;
  numerator: string;
  denominator: string;
}>;

export type LexiconBindingRefusal =
  | "NUMERAL_OCR_AMBIGUOUS"
  | "NUMERAL_NOT_IN_LEXICON"
  | "NUMERAL_SURFACE_NOT_IN_CHUNK"
  | "NUMERAL_ADDITIVE_NEEDS_A_WHOLE";

export type LexiconBindingOutcome =
  | Readonly<{ binding: LexiconBinding; refusal: null }>
  | Readonly<{ binding: null; refusal: LexiconBindingRefusal }>;

const refuse = (refusal: LexiconBindingRefusal): LexiconBindingOutcome => Object.freeze({ binding: null, refusal });

/**
 * Bind a rate from a chunk through the lexicon. The surface string must appear
 * in the chunk verbatim — the same chunk the anchor check runs on — and an
 * additive entry cannot bind alone because it has no whole to add to.
 */
export function bindThroughLexicon(chunkText: string, surface: string): LexiconBindingOutcome {
  const resolution = resolveNumeral(surface);
  if (!resolution.resolved) return refuse(resolution.refusal);
  if (resolution.additive) return refuse("NUMERAL_ADDITIVE_NEEDS_A_WHOLE");
  if (!chunkText.includes(surface)) return refuse("NUMERAL_SURFACE_NOT_IN_CHUNK");
  return Object.freeze({
    binding: Object.freeze({
      lexicon_version: LEGAL_NUMERAL_LEXICON_VERSION,
      surface,
      numeral_form: resolution.form,
      numerator: resolution.numerator,
      denominator: resolution.denominator,
    }),
    refusal: null,
  });
}

/**
 * "יום וחצי" — a whole followed by an additive fraction. Both surface strings
 * must be adjacent in the chunk, in that order, and the result is their sum.
 */
export function bindCompoundThroughLexicon(chunkText: string, whole: string, additive: string): LexiconBindingOutcome {
  const base = resolveNumeral(whole);
  const extra = resolveNumeral(additive);
  if (!base.resolved) return refuse(base.refusal);
  if (!extra.resolved) return refuse(extra.refusal);
  if (base.additive || !extra.additive) return refuse("NUMERAL_ADDITIVE_NEEDS_A_WHOLE");
  const compound = `${whole} ${additive}`;
  const fused = `${whole}${additive}`;
  const surface = chunkText.includes(compound) ? compound : chunkText.includes(fused) ? fused : null;
  if (surface === null) return refuse("NUMERAL_SURFACE_NOT_IN_CHUNK");
  const numerator = BigInt(base.numerator) * BigInt(extra.denominator) + BigInt(extra.numerator) * BigInt(base.denominator);
  const denominator = BigInt(base.denominator) * BigInt(extra.denominator);
  return Object.freeze({
    binding: Object.freeze({
      lexicon_version: LEGAL_NUMERAL_LEXICON_VERSION,
      surface,
      numeral_form: "word" as const,
      numerator: numerator.toString(),
      denominator: denominator.toString(),
    }),
    refusal: null,
  });
}
