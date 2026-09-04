// L5-5 / D4. `legal-instrument-selector-v1` — an instrument boundary as a draft
// selection artifact.
//
// A gazette issue is one artifact carrying several instruments. The boundary
// between them is a document segmentation, not a legal interpretation: an
// instrument is identified by its own title line — verbatim from the artifact's
// normalized text — and by the next instrument's title line (or the end of the
// artifact). The selection is hashed over the span it delimits.
//
// The span is a PAGE span, not a line span. These gazettes are set in two
// columns and the layout parser emits one text line per physical row across
// both, so a line span from the title would cut through the neighbouring
// column and lose half the instrument. The anchors identify the instrument; the
// pages they bound are what gets chunked, with `chunker-v1` and `#s` ids.
//
// A selection is `draft`, zero attestations, immutable, supersedable. A citation
// into a selected span carries `selection_sha256`, and the attestation binding of
// a parameter resting on it includes that hash — so attesting the parameter
// attests the boundary, and nobody attests a boundary on its own.
import { createHash } from "node:crypto";
import { toLogicalOrderLine } from "./normalizer-v1.ts";

export const LEGAL_INSTRUMENT_SELECTOR_VERSION = "legal-instrument-selector-v1" as const;

export type NormalizedPage = Readonly<{ page: number | null; text: string }>;

export type InstrumentSelection = Readonly<{
  selector_version: typeof LEGAL_INSTRUMENT_SELECTOR_VERSION;
  selection_id: string;
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  /** The selected instrument's own title line, verbatim from the normalized text (visual order as stored). */
  start_anchor: string;
  /** The same line in logical order, for a reader. Derived, never used to select. */
  start_anchor_logical: string;
  /** The next instrument's title line, or `END_OF_ARTIFACT`. */
  end_anchor: string;
  end_anchor_logical: string;
  page_from: number;
  page_to: number;
  /** sha256 of the selected pages' normalized text, joined by "\n\n". */
  selection_sha256: string;
  /** Where each anchor was found, so the selection can be checked without trusting it. */
  start_anchor_at: Readonly<{ page: number; line: number; character_from: number }>;
  end_anchor_at: Readonly<{ page: number; line: number; character_from: number }> | null;
}>;

export const END_OF_ARTIFACT = "END_OF_ARTIFACT" as const;

export type SelectionRefusal =
  | "SELECTION_PAGES_EMPTY"
  | "SELECTION_PAGES_NOT_SEQUENTIAL"
  | "SELECTION_START_ANCHOR_NOT_FOUND"
  | "SELECTION_START_ANCHOR_NOT_UNIQUE"
  | "SELECTION_END_ANCHOR_NOT_FOUND"
  | "SELECTION_END_ANCHOR_NOT_UNIQUE"
  | "SELECTION_END_BEFORE_START"
  | "SELECTION_ANCHOR_TOO_SHORT";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Located = Readonly<{ page: number; line: number; character_from: number }>;

/** Every line equal to `anchor`, as stored. Exact bytes, no normalisation. */
function locate(pages: readonly NormalizedPage[], anchor: string): readonly Located[] {
  const found: Located[] = [];
  pages.forEach((page, pageIndex) => {
    let offset = 0;
    for (const [lineIndex, line] of page.text.split("\n").entries()) {
      if (line === anchor) found.push({ page: pageIndex + 1, line: lineIndex, character_from: offset });
      offset += line.length + 1;
    }
  });
  return found;
}

/**
 * Select an instrument by its title lines. The title must be a whole line of
 * the stored text and must occur exactly once; so must the end anchor, and it
 * must come after. What is selected is the page span from the start anchor's
 * page to the end anchor's page (or the last page).
 */
export function selectInstrument(input: Readonly<{
  selection_id: string;
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  pages: readonly NormalizedPage[];
  start_anchor: string;
  end_anchor: string | typeof END_OF_ARTIFACT;
}>): Readonly<{ selection: InstrumentSelection; refusal: null }> | Readonly<{ selection: null; refusal: SelectionRefusal }> {
  const refuse = (refusal: SelectionRefusal) => Object.freeze({ selection: null, refusal });
  if ([...input.start_anchor].filter((character) => /[א-ת]/u.test(character)).length < 8) return refuse("SELECTION_ANCHOR_TOO_SHORT");
  // Lane B (L5): page numbers come from position, so the pages must arrive in
  // order and complete — a span over a reordered array would hash the wrong
  // text under the right page numbers.
  if (input.pages.length === 0) return refuse("SELECTION_PAGES_EMPTY");
  if (input.pages.some((page, index) => page.page !== index + 1)) return refuse("SELECTION_PAGES_NOT_SEQUENTIAL");
  const starts = locate(input.pages, input.start_anchor);
  if (starts.length === 0) return refuse("SELECTION_START_ANCHOR_NOT_FOUND");
  if (starts.length > 1) return refuse("SELECTION_START_ANCHOR_NOT_UNIQUE");
  const start = starts[0];
  let end: Located | null = null;
  if (input.end_anchor !== END_OF_ARTIFACT) {
    const ends = locate(input.pages, input.end_anchor);
    if (ends.length === 0) return refuse("SELECTION_END_ANCHOR_NOT_FOUND");
    if (ends.length > 1) return refuse("SELECTION_END_ANCHOR_NOT_UNIQUE");
    end = ends[0];
    if (end.page < start.page || (end.page === start.page && end.line <= start.line)) return refuse("SELECTION_END_BEFORE_START");
  }
  const pageFrom = start.page;
  const pageTo = end === null ? input.pages.length : end.page;
  const selected = input.pages.slice(pageFrom - 1, pageTo).map((page) => page.text).join("\n\n");
  return Object.freeze({
    selection: Object.freeze({
      selector_version: LEGAL_INSTRUMENT_SELECTOR_VERSION,
      selection_id: input.selection_id,
      source_id: input.source_id,
      source_version: input.source_version,
      artifact_sha256: input.artifact_sha256,
      start_anchor: input.start_anchor,
      start_anchor_logical: toLogicalOrderLine(input.start_anchor),
      end_anchor: input.end_anchor,
      end_anchor_logical: input.end_anchor === END_OF_ARTIFACT ? END_OF_ARTIFACT : toLogicalOrderLine(input.end_anchor),
      page_from: pageFrom,
      page_to: pageTo,
      selection_sha256: sha256(selected),
      start_anchor_at: start,
      end_anchor_at: end,
    }),
    refusal: null,
  });
}

/** The pages a selection covers, for chunking. Recomputes and checks the hash. */
export function selectedPages(selection: InstrumentSelection, pages: readonly NormalizedPage[]): readonly NormalizedPage[] {
  const span = pages.slice(selection.page_from - 1, selection.page_to);
  const digest = sha256(span.map((page) => page.text).join("\n\n"));
  if (digest !== selection.selection_sha256) throw new Error(`SELECTION_SHA256_MISMATCH:${selection.selection_id}`);
  return span;
}
