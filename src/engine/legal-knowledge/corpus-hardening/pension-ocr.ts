import { createHash } from "node:crypto";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PENSION_2016_OCR_TOOLCHAIN = Object.freeze({
  contract_version: "pension-2016-deterministic-ocr-v0.4",
  source_version_id: "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2",
  source_pdf_sha256: "f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70",
  source_pdf_bytes: 64_285,
  source_pdf_pages: 3,
  renderer: Object.freeze({
    implementation: "Poppler pdftoppm",
    version: "26.05.0",
    dpi: 300,
    color_conversion: "DeviceGray via pdftoppm -gray",
    output_format: "PNG",
    page_order: "ascending_1_to_3",
    arguments: Object.freeze(["-f", "1", "-l", "3", "-r", "300", "-gray", "-png"]),
    expected_page_sha256: Object.freeze([
      "0f5e7473d3fd13cbf295df370ac52e2917a94950434a83ac0966afca7e9b5823",
      "2b76d2423ec3e9360d4e28f4f596ecc38b3a8c0c531e2517706f4136381a96c5",
      "d62d857c27d6403d8a15f7397c92064fb3417dca1b3701bd6cd198821a44cc15",
    ]),
  }),
  ocr_engine: Object.freeze({
    implementation: "Tesseract OCR",
    version: "5.4.0.20240606",
    language: "heb",
    oem: 1,
    psm: 6,
    flags: Object.freeze(["preserve_interword_spaces=1", "user_defined_dpi=300", "quiet"]),
  }),
  language_artifact: Object.freeze({
    upstream_repository: "https://github.com/tesseract-ocr/tessdata",
    upstream_commit: "ced78752cc61322fb554c280d13360b35b8684e4",
    url: "https://raw.githubusercontent.com/tesseract-ocr/tessdata/ced78752cc61322fb554c280d13360b35b8684e4/heb.traineddata",
    media_type: "application/octet-stream",
    byte_count: 5_413_459,
    sha256: "7da6ea6b7a2620ec8e8b41de2967a13d429635a56657a0b30b622501a573d3e1",
    license: Object.freeze({
      spdx: "Apache-2.0",
      url: "https://raw.githubusercontent.com/tesseract-ocr/tessdata/ced78752cc61322fb554c280d13360b35b8684e4/LICENSE",
      byte_count: 11_358,
      sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    }),
  }),
  normalizer_version: "pension-ocr-normalizer-v1",
});

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export const ocrLineMappingSchema = z.object({
  page: z.number().int().positive(),
  raw_line: z.number().int().positive(),
  normalized_line: z.number().int().positive().nullable(),
  normalized_text_sha256: sha256Schema.nullable(),
}).strict().readonly();

export type OcrLineMapping = z.infer<typeof ocrLineMappingSchema>;

function normalizeLine(line: string) {
  return line
    .normalize("NFKC")
    .replace(/[\u200e\u200f\ufeff]/gu, "")
    .replace(/\t/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

/** Mechanical Unicode/whitespace normalization only; it performs no language correction. */
export function normalizeOcrPage(rawText: string, page: number) {
  const rawLines = rawText.replace(/\r\n?/gu, "\n").split("\n");
  const normalizedLines: string[] = [];
  const lineMap: OcrLineMapping[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const normalized = normalizeLine(rawLines[index]);
    if (!normalized) {
      lineMap.push(ocrLineMappingSchema.parse({ page, raw_line: index + 1, normalized_line: null, normalized_text_sha256: null }));
      continue;
    }
    normalizedLines.push(normalized);
    lineMap.push(ocrLineMappingSchema.parse({
      page,
      raw_line: index + 1,
      normalized_line: normalizedLines.length,
      normalized_text_sha256: sha256(normalized),
    }));
  }
  const normalizedText = normalizedLines.length ? `${normalizedLines.join("\n")}\n` : "";
  return Object.freeze({
    page,
    normalizer_version: PENSION_2016_OCR_TOOLCHAIN.normalizer_version,
    normalized_text: normalizedText,
    normalized_text_sha256: sha256(normalizedText),
    line_map: Object.freeze(lineMap),
  });
}

export type OcrPageInput = Readonly<{
  page: number;
  rendered_page_sha256: string;
  raw_ocr_text: string;
  raw_ocr_sha256: string;
}>;

export function createPensionOcrDerivedBundle(pagesInput: readonly OcrPageInput[]) {
  const pages = [...pagesInput].sort((left, right) => left.page - right.page);
  if (pages.length !== PENSION_2016_OCR_TOOLCHAIN.source_pdf_pages || pages.some((page, index) => page.page !== index + 1)) {
    throw new Error("ocr_page_order_or_count_mismatch");
  }
  for (const page of pages) {
    if (sha256(page.raw_ocr_text) !== page.raw_ocr_sha256) throw new Error(`raw_ocr_hash_mismatch:page-${page.page}`);
    if (page.rendered_page_sha256 !== PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256[page.page - 1]) {
      throw new Error(`rendered_page_hash_mismatch:page-${page.page}`);
    }
  }
  const normalizedPages = pages.map((page) => normalizeOcrPage(page.raw_ocr_text, page.page));
  const citations = normalizedPages.flatMap((page) => page.normalized_text.trimEnd().split("\n").filter(Boolean).map((text, index) => Object.freeze({
    citation_id: `PENSION-2016-OCR:p${page.page}:l${index + 1}`,
    page: page.page,
    normalized_line_from: index + 1,
    normalized_line_to: index + 1,
    text_sha256: sha256(text),
    review_state: "needs_review" as const,
  })));
  const normalizedDocument = normalizedPages.map((page) => `[[page:${page.page}]]\n${page.normalized_text}`).join("");
  return Object.freeze({
    schema_version: "pension-2016-ocr-derived-bundle-v0.4" as const,
    source_version_id: PENSION_2016_OCR_TOOLCHAIN.source_version_id,
    source_pdf_sha256: PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256,
    parse_status: "derived_ocr_needs_review" as const,
    review_state: "needs_review" as const,
    activation_state: "inactive" as const,
    corpus_registration_performed: false as const,
    legal_confidence: "not_assessed" as const,
    ocr_confidence_is_legal_confidence: false as const,
    page_count: pages.length,
    pages: normalizedPages.map((normalized, index) => Object.freeze({
      page: normalized.page,
      rendered_page_sha256: pages[index].rendered_page_sha256,
      raw_ocr_sha256: pages[index].raw_ocr_sha256,
      normalized_text_sha256: normalized.normalized_text_sha256,
      normalized_line_count: normalized.normalized_text ? normalized.normalized_text.trimEnd().split("\n").length : 0,
      line_map: normalized.line_map,
    })),
    citations,
    normalized_document_sha256: sha256(normalizedDocument),
    required_human_action: "line_by_line_page_verification_before_any_corpus_registration_or_use",
  });
}

export function verifyOcrCitationRoundTrip(bundle: ReturnType<typeof createPensionOcrDerivedBundle>, normalizedPages: readonly ReturnType<typeof normalizeOcrPage>[]) {
  const byPage = new Map(normalizedPages.map((page) => [page.page, page.normalized_text.trimEnd().split("\n")]));
  const failures = bundle.citations.filter((citation) => {
    const line = byPage.get(citation.page)?.[citation.normalized_line_from - 1];
    return !line || sha256(line) !== citation.text_sha256;
  }).map((citation) => citation.citation_id);
  return Object.freeze({ passed: failures.length === 0, citation_count: bundle.citations.length, failures });
}

export function createReviewedTranscriptRevision(input: Readonly<{
  revision: number;
  parent_revision_sha256: string | null;
  raw_pdf_sha256: string;
  rendered_page_sha256: readonly string[];
  raw_ocr_page_sha256: readonly string[];
  normalized_page_sha256: readonly string[];
  reviewed_transcript_page_sha256: readonly string[];
  reviewer_id: string;
  reviewed_at: string;
  decision: "synthetic_accept" | "synthetic_reject";
}>) {
  if (input.revision < 1 || !Number.isInteger(input.revision)) throw new Error("invalid_transcript_revision");
  if (input.raw_pdf_sha256 !== PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256) throw new Error("raw_pdf_hash_mismatch");
  if (input.rendered_page_sha256.length !== 3 || input.raw_ocr_page_sha256.length !== 3 || input.normalized_page_sha256.length !== 3 || input.reviewed_transcript_page_sha256.length !== 3) throw new Error("transcript_revision_page_hashes_incomplete");
  if (![input.raw_pdf_sha256, ...input.rendered_page_sha256, ...input.raw_ocr_page_sha256, ...input.normalized_page_sha256, ...input.reviewed_transcript_page_sha256].every((hash) => sha256Schema.safeParse(hash).success)) throw new Error("transcript_revision_hash_invalid");
  if (input.revision > 1 && !input.parent_revision_sha256) throw new Error("parent_revision_required");
  if (input.revision === 1 && input.parent_revision_sha256) throw new Error("first_revision_cannot_have_parent");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input.reviewed_at)) throw new Error("review_timestamp_must_be_utc");
  if (!input.reviewer_id.trim()) throw new Error("reviewer_id_required");
  const body = {
    schema_version: "pension-reviewed-transcript-revision-v0.4.2" as const,
    revision: input.revision,
    parent_revision_sha256: input.parent_revision_sha256,
    raw_pdf_sha256: input.raw_pdf_sha256,
    rendered_page_sha256: Object.freeze([...input.rendered_page_sha256]),
    raw_ocr_page_sha256: Object.freeze([...input.raw_ocr_page_sha256]),
    normalized_page_sha256: Object.freeze([...input.normalized_page_sha256]),
    reviewed_transcript_page_sha256: Object.freeze([...input.reviewed_transcript_page_sha256]),
    reviewer_id: input.reviewer_id,
    reviewed_at: input.reviewed_at,
    decision: input.decision,
    raw_ocr_overwritten: false as const,
    corpus_registration_performed: false as const,
    review_state: "needs_review" as const,
    activation_state: "inactive" as const,
  };
  return Object.freeze({ ...body, revision_sha256: sha256(stableJson(body)) });
}
