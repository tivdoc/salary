// E3-1 (BL-10). The Hebrew anchor for every chunk a registered parameter cites.
//
// An anchor is a fragment of the cited clause itself, written the way the law
// writes it. It is compared against the v1 logical-order text with whitespace
// removed and quote/dash forms folded, so glyph-extraction damage does not
// force the author to shorten the anchor until it passes.
//
// Six of the sixteen cited chunks have NO anchor and cannot have one. They are
// bare table rows — "1.04.2023 257.16 222.87 29.95 30.61 5,571.75", with no
// clause text at all, because the chunker split the rate tables row by row and
// left the header behind. A citation to one of those points at a number in a
// table with no textual context, which is exactly the weakness BL-10 names, and
// no anchor can fix it: the remedy is a re-chunk that carries the header with
// the row, which is corpus work rather than a citation edit. They are listed
// here explicitly with that reason rather than omitted, so the gap is counted.

export type ChunkAnchor =
  | Readonly<{ chunk_id: string; anchor: string; anchor_absent?: undefined; replaced_by?: undefined }>
  | Readonly<{ chunk_id: string; anchor?: undefined; anchor_absent: "chunk_has_no_clause_text"; remedy: string; replaced_by?: string }>;

const NO_CLAUSE_TEXT = "chunk_has_no_clause_text" as const;
const RECHUNK =
  "Re-chunk the rate table so each row carries its column headers and the table caption, then re-cite. Until then this citation rests on a number with no textual context." as const;

// L4-1 did the re-chunk. Each of the six now has a table-aware chunk that says
// the same thing with its column headers attached, and the parameter revision
// that cited it has been superseded by one citing the new chunk. The six
// entries below stay exactly as they were — batch 1 still contains those
// citations and always will, because nothing here is edited in place — but they
// now name their replacement instead of only naming a remedy.
const MIN_WAGE_T1 = "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#t0003-78f59eeddfde" as const;
const AVERAGE_WAGE_T1 = "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#t0003-ca1e4b6ac154" as const;

export const POOL_P_CITATION_ANCHORS: readonly ChunkAnchor[] = Object.freeze([
  {
    chunk_id: "IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653",
    anchor: "אורך החופשה לכל שנת-עבודה אצל מעביד אחד",
  },
  {
    // The clause that moved the band and the count together. This is the
    // anchor that would have caught the mis-scoped vacation parameter.
    chunk_id: "IL_ANNUAL_VACATION_LAW_AMENDMENT_15_2016@discovery-v0#0002-ada0a7cfcc75",
    anchor: 'במקום "מ־4" יבוא "מ־5"',
  },
  {
    chunk_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0002-00fe06cb93a9",
    anchor: "שכר ממוצע לפי סעיפים 1 ו-2 לחוק הביטוח הלאומי",
  },
  {
    // The clause that carries the threshold, not the definitional preamble
    // further up the same chunk. The first anchor written here pointed at
    // "סכום ההשתתפות", which is in the chunk and has nothing to do with the
    // 6,000 figure — the check caught it, which is the whole point.
    chunk_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2024@discovery-v0.2#0005-7db36b4a7423",
    anchor: "לחמישה ימי הבראה, ומשכורתו החודשית הממוצעת",
  },
  {
    chunk_id: "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0#0001-152cb60b209f",
    anchor: "צו הרחבה בדבר השתתפות מעסיק בהוצאות נסיעה",
  },
  {
    chunk_id: "IL_MIN_WAGE_LAW@discovery-v0#0002-bcf9eab6819e",
    anchor: "לא יפחת שכר המינימום היומי",
  },
  {
    // Both hourly branches cite this chunk; the divisor in `must_contain`
    // distinguishes them, and this anchor establishes that the chunk is the
    // hourly-rate statement rather than some other row of the same page.
    chunk_id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0002-ec7402f2ab89",
    anchor: "שכר לשעה בהיקף של",
  },
  {
    chunk_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1#0001-c383d0ba2158",
    anchor: "שבוע העבודה יעמוד על 42 שעות",
  },
  {
    chunk_id: "IL_SICK_PAY_LAW@discovery-v0#0002-7e19a95f62cb",
    anchor: "תקופה מצטברת של יום וחצי לכל חודש עבודה מלא",
  },
  {
    chunk_id: "IL_SICK_PAY_LAW@discovery-v0#0003-b11393df222b",
    anchor: "ולא יותר מ-90 יום, בניכוי התקופה",
  },
  { chunk_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0004-4756224b67b5", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: AVERAGE_WAGE_T1 },
  { chunk_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0007-a497d09cf256", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: AVERAGE_WAGE_T1 },
  { chunk_id: "IL_AVERAGE_WAGE_OFFICIAL_RATES@discovery-v0#0011-597f613d66a4", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: AVERAGE_WAGE_T1 },
  { chunk_id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0007-94349aa03f47", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: MIN_WAGE_T1 },
  { chunk_id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0009-b04d9d5b7243", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: MIN_WAGE_T1 },
  { chunk_id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0#0010-12819b83ab84", anchor_absent: NO_CLAUSE_TEXT, remedy: RECHUNK, replaced_by: MIN_WAGE_T1 },
  // The table-aware chunks the replacements cite. Each of these carries the
  // column headers and the caption in the same chunk as the figures, which is
  // the whole point of the re-chunk.
  {
    chunk_id: MIN_WAGE_T1,
    anchor: "שכר מינימום לחודש סכום השכר המינימלי שיש לשלם לעובד בעבור חודש עבודה",
  },
  {
    chunk_id: AVERAGE_WAGE_T1,
    anchor: "שכר חודשי ממוצע",
  },
  {
    chunk_id: "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0#t0007-b1a272cd922a",
    anchor: "ישולמו מדי חודש בחודשו בהתאם לטבלה הזו",
  },
  // L5-4: the sick-pay tier clause, whose figure is a word. The anchor is the
  // clause as a person reads it; the scan glues its words, and the anchor
  // check strips whitespace on both sides, which is why it still matches.
  {
    chunk_id: "IL_SICK_PAY_LAW@discovery-v0#t0001-b0208d864901",
    anchor: "בעד הימים השני והשלישי",
  },
  // L5-5 / L5-6 / L5-7: chunks of instrument SELECTIONS, `#s` ids. Each anchor
  // is the selected instrument's own clause, in the same chunk as the figure.
  {
    chunk_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2#s0001-441d64217a93",
    anchor: "גובה השתתפות המעסיק בהוצאות ההבראה",
  },
  {
    chunk_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2#s0001-3242816cc02a",
    anchor: "גובה השתתפות המעסיק בהוצאות ההבראה",
  },
  {
    chunk_id: "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1#s0001-d88c8300ebf8",
    anchor: "אורך שבוע עבודה לא יעלה על",
  },
  {
    chunk_id: "IL_ANNUAL_VACATION_LAW@discovery-v0#t0001-838721e06653",
    anchor: "אורך החופשה לכל שנת-עבודה אצל מעביד אחד או במקום-עבודה אחד",
  },
]);

export function anchorFor(chunkId: string): ChunkAnchor | null {
  return POOL_P_CITATION_ANCHORS.find((entry) => entry.chunk_id === chunkId) ?? null;
}
