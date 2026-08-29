import { createHash } from "node:crypto";
import { z } from "zod";
import { fetchLegalSourceBytes, type SafeLegalFetchResult } from "./security.ts";

export const PENSION_2016_SOURCE_ID = "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016";
export const PENSION_2016_ARTIFACT_SHA256 = "f3e7de9d9b36900e18efa33f0286a1eeddbb8e062d8a19e102af94967921dd70";
export const CONVALESCENCE_2025_SOURCE_ID = "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025";
export const CONVALESCENCE_2025_OFFICIAL_URL = "https://fs.knesset.gov.il/25/law/25_lsr_6133485.pdf";
export const CONVALESCENCE_2025_INSTRUMENT_ID = "INSTRUMENT:IL:CONVALESCENCE-REDUCTION-FREEZE-LAW-2025";
export const CONVALESCENCE_RESEARCH_2025_SOURCE_ID = "IL_CONVALESCENCE_KNESSET_RESEARCH_2025";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const pageImageEvidenceSchema = z.object({
  page: z.number().int().positive(),
  image_sha256: sha256Schema,
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  dpi: z.literal(300),
}).strict();

export const extractedPageSchema = z.object({
  page: z.number().int().positive(),
  text: z.string(),
}).strict();

export const ocrEngineSchema = z.object({
  engine: z.literal("tesseract"),
  engine_version: z.string().min(1),
  language_pack: z.literal("heb"),
  language_pack_available: z.boolean(),
  local_only: z.literal(true),
  dpi: z.literal(300),
  page_order: z.literal("ascending_pdf_page_number"),
  oem: z.literal(1),
  psm: z.literal(6),
  preserve_interword_spaces: z.literal(true),
}).strict();

export type ExtractedPage = z.infer<typeof extractedPageSchema>;
export type PageImageEvidence = z.infer<typeof pageImageEvidenceSchema>;
export type OcrEngine = z.infer<typeof ocrEngineSchema>;

export type CitationAnchor = Readonly<{
  citation_id: string;
  page: number;
  character_from: number;
  character_to: number;
  text_sha256: string;
  image_sha256: string;
}>;

export type PensionParseFailureCode =
  | "artifact_sha256_mismatch"
  | "pdf_magic_mismatch"
  | "pdf_eof_missing"
  | "pdf_corrupt"
  | "pdf_encrypted"
  | "pdf_active_content_rejected"
  | "page_mapping_invalid"
  | "native_text_insufficient"
  | "ocr_engine_unavailable"
  | "ocr_hebrew_language_pack_unavailable"
  | "ocr_nondeterministic_output"
  | "ocr_text_sanity_failed";

export type PensionParseResult = Readonly<{
  source_id: typeof PENSION_2016_SOURCE_ID;
  artifact_sha256: string;
  status: "parsed_needs_review" | "parse_failed_closed";
  safe_error_code: PensionParseFailureCode | null;
  method: "native_text" | "local_deterministic_ocr" | null;
  parser_name: string;
  parser_version: string;
  normalized_text_sha256: string | null;
  parsed_version_id: string | null;
  page_count: number;
  page_map: readonly Readonly<{
    page: number;
    image_sha256: string;
    text_sha256: string | null;
    character_from: number | null;
    character_to: number | null;
  }>[];
  citation_anchors: readonly CitationAnchor[];
  review_state: "needs_review";
  activation_state: "inactive";
  usable_for_rules: false;
}>;

type PensionParseInput = Readonly<{
  bytes: Uint8Array;
  structural: Readonly<{
    page_count: number;
    corrupt: boolean;
    encrypted: boolean;
    has_active_content: boolean;
  }>;
  parser_name: string;
  parser_version: string;
  native_pages: readonly ExtractedPage[];
  rendered_pages: readonly PageImageEvidence[];
  ocr_engine: OcrEngine | null;
  ocr_run_a: readonly ExtractedPage[] | null;
  ocr_run_b: readonly ExtractedPage[] | null;
}>;

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function sortedSequential<T extends Readonly<{ page: number }>>(values: readonly T[], expectedPageCount: number) {
  return values.length === expectedPageCount && values.every((value, index) => value.page === index + 1);
}

function hasSanePensionText(pages: readonly ExtractedPage[]) {
  const text = pages.map((page) => normalizedText(page.text)).join("\n");
  return text.length >= 80 && (text.includes("פנסיה") || text.includes("היסנפ"));
}

function failure(input: PensionParseInput, artifactSha256: string, code: PensionParseFailureCode): PensionParseResult {
  return {
    source_id: PENSION_2016_SOURCE_ID,
    artifact_sha256: artifactSha256,
    status: "parse_failed_closed",
    safe_error_code: code,
    method: null,
    parser_name: input.parser_name,
    parser_version: input.parser_version,
    normalized_text_sha256: null,
    parsed_version_id: null,
    page_count: input.structural.page_count,
    page_map: input.rendered_pages.map((page) => ({
      page: page.page,
      image_sha256: page.image_sha256,
      text_sha256: null,
      character_from: null,
      character_to: null,
    })),
    citation_anchors: [],
    review_state: "needs_review",
    activation_state: "inactive",
    usable_for_rules: false,
  };
}

function parsed(input: PensionParseInput, artifactSha256: string, pages: readonly ExtractedPage[], method: "native_text" | "local_deterministic_ocr"): PensionParseResult {
  const normalizedPages = pages.map((page) => ({ page: page.page, text: normalizedText(page.text) }));
  const pageMap: Array<{
    page: number;
    image_sha256: string;
    text_sha256: string;
    character_from: number;
    character_to: number;
  }> = [];
  const anchors: CitationAnchor[] = [];
  let cursor = 0;
  for (const page of normalizedPages) {
    const image = input.rendered_pages[page.page - 1];
    const characterFrom = cursor;
    const characterTo = characterFrom + page.text.length;
    const textSha256 = sha256(page.text);
    pageMap.push({ page: page.page, image_sha256: image.image_sha256, text_sha256: textSha256, character_from: characterFrom, character_to: characterTo });
    anchors.push({
      citation_id: `PENSION-2016-PAGE-${page.page}-${textSha256.slice(0, 12)}`,
      page: page.page,
      character_from: characterFrom,
      character_to: characterTo,
      text_sha256: textSha256,
      image_sha256: image.image_sha256,
    });
    cursor = characterTo + (page.page < normalizedPages.length ? 1 : 0);
  }
  const documentText = normalizedPages.map((page) => page.text).join("\n");
  const normalizedTextSha256 = sha256(documentText);
  const lineage = sha256(`${PENSION_2016_SOURCE_ID}\n${artifactSha256}\n${normalizedTextSha256}\n${input.parser_name}\n${input.parser_version}\n${method}`);
  return {
    source_id: PENSION_2016_SOURCE_ID,
    artifact_sha256: artifactSha256,
    status: "parsed_needs_review",
    safe_error_code: null,
    method,
    parser_name: input.parser_name,
    parser_version: input.parser_version,
    normalized_text_sha256: normalizedTextSha256,
    parsed_version_id: `${PENSION_2016_SOURCE_ID}@discovery-v0.2#parsed-${lineage.slice(0, 24)}`,
    page_count: input.structural.page_count,
    page_map: pageMap,
    citation_anchors: anchors,
    review_state: "needs_review",
    activation_state: "inactive",
    usable_for_rules: false,
  };
}

function buildPensionParseEvidence(input: PensionParseInput, expectedArtifactSha256: string): PensionParseResult {
  const actualHash = sha256(input.bytes);
  if (actualHash !== expectedArtifactSha256) return failure(input, actualHash, "artifact_sha256_mismatch");
  if (new TextDecoder("ascii").decode(input.bytes.slice(0, 5)) !== "%PDF-") return failure(input, actualHash, "pdf_magic_mismatch");
  if (!new TextDecoder("ascii").decode(input.bytes.slice(-1024)).includes("%%EOF")) return failure(input, actualHash, "pdf_eof_missing");
  if (input.structural.corrupt || input.structural.page_count < 1) return failure(input, actualHash, "pdf_corrupt");
  if (input.structural.encrypted) return failure(input, actualHash, "pdf_encrypted");
  if (input.structural.has_active_content) return failure(input, actualHash, "pdf_active_content_rejected");
  if (!sortedSequential(input.rendered_pages, input.structural.page_count)
    || !input.rendered_pages.every((page) => pageImageEvidenceSchema.safeParse(page).success)
    || !sortedSequential(input.native_pages, input.structural.page_count)) {
    return failure(input, actualHash, "page_mapping_invalid");
  }
  if (hasSanePensionText(input.native_pages)) return parsed(input, actualHash, input.native_pages, "native_text");
  if (!input.ocr_engine) return failure(input, actualHash, "ocr_engine_unavailable");
  if (!ocrEngineSchema.safeParse(input.ocr_engine).success) return failure(input, actualHash, "ocr_engine_unavailable");
  if (!input.ocr_engine.language_pack_available) return failure(input, actualHash, "ocr_hebrew_language_pack_unavailable");
  if (!input.ocr_run_a || !input.ocr_run_b) return failure(input, actualHash, "ocr_engine_unavailable");
  if (!sortedSequential(input.ocr_run_a, input.structural.page_count) || !sortedSequential(input.ocr_run_b, input.structural.page_count)) {
    return failure(input, actualHash, "page_mapping_invalid");
  }
  const first = input.ocr_run_a.map((page) => normalizedText(page.text));
  const second = input.ocr_run_b.map((page) => normalizedText(page.text));
  if (sha256(first.join("\n")) !== sha256(second.join("\n"))) return failure(input, actualHash, "ocr_nondeterministic_output");
  const pages = input.ocr_run_a.map((page, index) => ({ page: page.page, text: first[index] }));
  if (!hasSanePensionText(pages)) return failure(input, actualHash, "ocr_text_sanity_failed");
  return parsed(input, actualHash, pages, "local_deterministic_ocr");
}

export function buildPension2016ParseEvidence(input: PensionParseInput): PensionParseResult {
  return buildPensionParseEvidence(input, PENSION_2016_ARTIFACT_SHA256);
}

export const pensionParserTestSupport = Object.freeze({
  buildForSyntheticFixture(input: PensionParseInput) {
    return buildPensionParseEvidence(input, sha256(input.bytes));
  },
});

export function reconstructPensionCitation(anchor: CitationAnchor, pages: readonly ExtractedPage[]) {
  const normalizedPages = pages.map((page) => normalizedText(page.text));
  const documentText = normalizedPages.join("\n");
  const pageText = normalizedPages[anchor.page - 1];
  if (pageText === undefined) return { passed: false as const, safe_error_code: "citation_page_missing", reconstructed: "" };
  const reconstructed = documentText.slice(anchor.character_from, anchor.character_to);
  const passed = reconstructed === pageText && sha256(reconstructed) === anchor.text_sha256;
  return { passed, safe_error_code: passed ? null : "citation_round_trip_mismatch", reconstructed } as const;
}

export type Convalescence2025Acquisition = Readonly<{
  bytes: Uint8Array;
  source_id: typeof CONVALESCENCE_2025_SOURCE_ID;
  instrument_id: typeof CONVALESCENCE_2025_INSTRUMENT_ID;
  canonical_url: typeof CONVALESCENCE_2025_OFFICIAL_URL;
  final_url: typeof CONVALESCENCE_2025_OFFICIAL_URL;
  artifact_sha256: string;
  byte_count: number;
  content_type: string;
  safe_headers: Readonly<Record<string, string>>;
  redirect_chain: readonly string[];
  relation_claims: readonly [];
  effectivity_claims: readonly [];
  review_state: "needs_review";
  activation_state: "inactive";
  usable_for_rules: false;
}>;

type OfficialFetcher = () => Promise<SafeLegalFetchResult>;

function validateStaticPdfBytes(bytes: Uint8Array) {
  const prefix = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (prefix !== "%PDF-") throw new Error("pdf_magic_mismatch");
  const tail = new TextDecoder("ascii").decode(bytes.slice(-1024));
  if (!tail.includes("%%EOF")) throw new Error("pdf_eof_missing");
  const ascii = new TextDecoder("latin1").decode(bytes);
  if (/\/(?:JavaScript|JS|Launch|GoToR|SubmitForm|EmbeddedFiles)\b/u.test(ascii)) throw new Error("pdf_active_content_rejected");
}

export async function acquireConvalescence2025Official(fetcher?: OfficialFetcher): Promise<Convalescence2025Acquisition> {
  const result = await (fetcher ?? (() => fetchLegalSourceBytes(
    { canonical_url: CONVALESCENCE_2025_OFFICIAL_URL, artifact_format: "pdf" },
    { maxRedirects: 0 },
  )))();
  if (result.finalUrl !== CONVALESCENCE_2025_OFFICIAL_URL || result.redirectCount !== 0
    || result.redirectChain.length !== 1 || result.redirectChain[0] !== CONVALESCENCE_2025_OFFICIAL_URL) {
    throw new Error("official_artifact_identity_mismatch");
  }
  validateStaticPdfBytes(result.bytes);
  return {
    bytes: result.bytes,
    source_id: CONVALESCENCE_2025_SOURCE_ID,
    instrument_id: CONVALESCENCE_2025_INSTRUMENT_ID,
    canonical_url: CONVALESCENCE_2025_OFFICIAL_URL,
    final_url: CONVALESCENCE_2025_OFFICIAL_URL,
    artifact_sha256: sha256(result.bytes),
    byte_count: result.bytes.byteLength,
    content_type: result.contentType,
    safe_headers: result.safeHeaders,
    redirect_chain: result.redirectChain,
    relation_claims: [],
    effectivity_claims: [],
    review_state: "needs_review",
    activation_state: "inactive",
    usable_for_rules: false,
  };
}

export const convalescenceResearchClassification = Object.freeze({
  source_id: CONVALESCENCE_RESEARCH_2025_SOURCE_ID,
  artifact_role: "secondary_explanatory_source" as const,
  operative_candidate: false as const,
  can_independently_support_monetary_rule: false as const,
  review_state: "needs_review" as const,
  activation_state: "inactive" as const,
});

export const convalescence2025InstrumentBoundary = Object.freeze({
  source_id: CONVALESCENCE_2025_SOURCE_ID,
  instrument_id: CONVALESCENCE_2025_INSTRUMENT_ID,
  canonical_url: CONVALESCENCE_2025_OFFICIAL_URL,
  instrument_type: "statute" as const,
  artifact_role: "primary_promulgation" as const,
  relation_claims: [] as const,
  effectivity_claims: [] as const,
  review_state: "needs_review" as const,
  activation_state: "inactive" as const,
  operative_candidate: false as const,
  usable_for_rules: false as const,
});
