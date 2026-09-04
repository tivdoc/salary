// L6-2 / D1. legal-visual-citation-v1: a citation kind for a figure that is
// unambiguous in the official artifact's page IMAGE and ambiguous or absent in
// its text layer — the 1951 promulgation's "1¼" typeset as a full-size 1 with a
// stacked fraction, which the OCR text layer renders as "11/4".
//
// A visual citation is the explicit, displayed escape from the lexicon's
// `ocr_ambiguous` refusal. It is never silent and never documented: its value
// is `inferred_visual`, read from the page by the session, and it carries
//
//   - the artifact hash and the page number;
//   - the hash of that page extracted as a standalone PDF (what the review
//     package ships beside the locator), and the hash of the rendered page
//     image the reading was made from;
//   - the region: the stored text-layer line the figure sits on, and what that
//     line's text layer says (the ambiguous surface, quoted as it stands);
//   - the visual reading, as a glyph string, and the rational it resolves to;
//   - `visual_verification_required: true`, which an attestation can only
//     discharge with `visual_confirmed: true` against the same page hash and
//     the same reading — enforced in the database, not here.
//
// The reading is checked for internal consistency only: the glyph string must
// resolve to the stated value through a fixed table, and the text-layer surface
// must be one the lexicon refuses or absent. Whether the glyphs on the page
// really are those glyphs is exactly what a person confirms.
import { z } from "zod";
import { containsOcrAmbiguousFraction } from "./numeral-lexicon-v1.ts";

export const LEGAL_VISUAL_CITATION_VERSION = "legal-visual-citation-v1" as const;
export const PROVENANCE_INFERRED_VISUAL = "inferred_visual" as const;

/** Provenance grades, best first. A candidate's grade is the worst of its citations'. */
export const PROVENANCE_GRADES = ["text_verified", "lexicon", "selection", "inferred_visual", "administrative"] as const;
export type ProvenanceGrade = typeof PROVENANCE_GRADES[number];

export function worstProvenance(grades: readonly ProvenanceGrade[]): ProvenanceGrade {
  if (grades.length === 0) return "text_verified";
  return grades.reduce((worst, grade) => (PROVENANCE_GRADES.indexOf(grade) > PROVENANCE_GRADES.indexOf(worst) ? grade : worst), grades[0]);
}

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const digits = z.string().regex(/^[0-9]{1,24}$/u);

export const visualCitationSchema = z.object({
  kind: z.literal(LEGAL_VISUAL_CITATION_VERSION),
  artifact_sha256: sha,
  page: z.number().int().min(1),
  page_pdf_sha256: sha,
  page_image_sha256: sha,
  region: z.object({
    kind: z.literal("stored_line"),
    line_index: z.number().int().min(0),
    line_text: z.string().min(1).max(400),
  }).strict(),
  text_layer_surface: z.string().min(1).max(40).nullable(),
  visual_reading: z.string().min(1).max(40),
  value: z.object({ numerator: digits, denominator: digits }).strict(),
  provenance: z.literal(PROVENANCE_INFERRED_VISUAL),
  visual_verification_required: z.literal(true),
  read_by: z.literal("session"),
  // The toolchain the page image was rendered with (tool version, sharp and
  // libvips versions), so a reviewer reproducing page_image_sha256 knows what
  // to reproduce it with. A different encoder gives different bytes for the
  // same pixels; the page PDF hash, which the attestation binds, does not
  // depend on it.
  render_tool_version: z.string().min(1).max(120).optional(),
}).strict().readonly();

export type VisualCitation = z.infer<typeof visualCitationSchema>;

/**
 * The glyph strings a session may read, and what each resolves to. A reading
 * outside this table is refused — the table is the vocabulary a reviewer
 * confirms against, and it is deliberately short.
 */
const VULGAR: Readonly<Record<string, readonly [bigint, bigint]>> = Object.freeze({
  "¼": [BigInt(1), BigInt(4)], "½": [BigInt(1), BigInt(2)], "¾": [BigInt(3), BigInt(4)], "⅓": [BigInt(1), BigInt(3)], "⅔": [BigInt(2), BigInt(3)],
});

function gcd(left: bigint, right: bigint): bigint {
  let a = left < BigInt(0) ? -left : left;
  let b = right < BigInt(0) ? -right : right;
  while (b !== BigInt(0)) [a, b] = [b, a % b];
  return a;
}

/** "1¼" → 5/4; "1½" → 3/2; "½" → 1/2; "6.5%" → 13/200; "6%" → 3/50; "6,150" → 6150/1. */
export function resolveVisualReading(reading: string): { numerator: string; denominator: string } | { refusal: string } {
  const text = reading.replace(/\s+/gu, "");
  const mixed = /^(\d{0,6})([¼½¾⅓⅔])$/u.exec(text);
  if (mixed) {
    const whole = mixed[1] === "" ? BigInt(0) : BigInt(mixed[1]);
    const [num, den] = VULGAR[mixed[2]];
    return reduced(whole * den + num, den);
  }
  const percent = /^(\d{1,6})(?:[.,](\d{1,4}))?%$/u.exec(text);
  if (percent) {
    const fraction = percent[2] ?? "";
    const scale = BigInt(10) ** BigInt(fraction.length);
    return reduced(BigInt(percent[1]) * scale + (fraction === "" ? BigInt(0) : BigInt(fraction)), BigInt(100) * scale);
  }
  const integer = /^(\d{1,3}(?:,\d{3})*|\d{1,9})$/u.exec(text);
  if (integer) return reduced(BigInt(integer[1].replaceAll(",", "")), BigInt(1));
  return { refusal: `VISUAL_READING_NOT_IN_VOCABULARY:${reading}` };
}

function reduced(numerator: bigint, denominator: bigint): { numerator: string; denominator: string } {
  const divisor = gcd(numerator, denominator) || BigInt(1);
  return { numerator: (numerator / divisor).toString(), denominator: (denominator / divisor).toString() };
}

export type VisualCitationInput = Readonly<{
  artifact_sha256: string;
  page: number;
  page_pdf_sha256: string;
  page_image_sha256: string;
  line_index: number;
  line_text: string;
  text_layer_surface: string | null;
  visual_reading: string;
  render_tool_version?: string;
}>;

/**
 * Build a visual citation or refuse. Refusals, all by name:
 * - the reading is outside the vocabulary;
 * - the text layer surface, when given, is not on the stored line;
 * - the text layer surface is a figure the lexicon would READ (not refuse) —
 *   then a visual citation is the wrong kind, and the lexicon path must be used;
 * - the stored line is empty.
 */
export function buildVisualCitation(input: VisualCitationInput): { citation: VisualCitation; refusal: null } | { citation: null; refusal: string } {
  const resolved = resolveVisualReading(input.visual_reading);
  if ("refusal" in resolved) return { citation: null, refusal: resolved.refusal };
  if (input.line_text.trim().length === 0) return { citation: null, refusal: "VISUAL_STORED_LINE_EMPTY" };
  if (input.text_layer_surface !== null) {
    if (!input.line_text.includes(input.text_layer_surface)) return { citation: null, refusal: "VISUAL_SURFACE_NOT_ON_STORED_LINE" };
    if (!containsOcrAmbiguousFraction(input.text_layer_surface)) return { citation: null, refusal: "VISUAL_SURFACE_NOT_AMBIGUOUS_USE_TEXT_PATH" };
  }
  const parsed = visualCitationSchema.safeParse({
    kind: LEGAL_VISUAL_CITATION_VERSION,
    artifact_sha256: input.artifact_sha256,
    page: input.page,
    page_pdf_sha256: input.page_pdf_sha256,
    page_image_sha256: input.page_image_sha256,
    region: { kind: "stored_line", line_index: input.line_index, line_text: input.line_text },
    text_layer_surface: input.text_layer_surface,
    visual_reading: input.visual_reading,
    value: resolved,
    provenance: PROVENANCE_INFERRED_VISUAL,
    visual_verification_required: true,
    read_by: "session",
    ...(input.render_tool_version ? { render_tool_version: input.render_tool_version } : {}),
  });
  if (!parsed.success) return { citation: null, refusal: `VISUAL_CITATION_INVALID:${parsed.error.issues[0]?.path.join(".") ?? "shape"}` };
  return { citation: parsed.data, refusal: null };
}

/**
 * What an attestation must carry to discharge a visual citation: the page it
 * confirms and the reading it confirms, nothing that could be copied from a
 * different page. The database compares this list against the candidate's.
 */
export function visualBindingOf(citation: VisualCitation): { page_pdf_sha256: string; visual_reading: string } {
  return { page_pdf_sha256: citation.page_pdf_sha256, visual_reading: citation.visual_reading };
}
