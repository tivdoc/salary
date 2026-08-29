import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import inventory from "./wave1-pension-convalescence.inventory.v0.3.1.json";
import {
  acquireConvalescence2025Official,
  buildPension2016ParseEvidence,
  CONVALESCENCE_2025_OFFICIAL_URL,
  convalescence2025InstrumentBoundary,
  convalescenceResearchClassification,
  pensionParserTestSupport,
  reconstructPensionCitation,
  type ExtractedPage,
  type OcrEngine,
  type PageImageEvidence,
} from "./wave1-pension-convalescence.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const fixtureBytes = new TextEncoder().encode(`%PDF-1.4\n${"synthetic-test-only".repeat(40)}\n%%EOF`);

const images: PageImageEvidence[] = [1, 2, 3].map((page) => ({
  page,
  image_sha256: sha256(`synthetic-image-${page}`),
  width_px: 2484,
  height_px: 3507,
  dpi: 300,
}));

const ocrEngine: OcrEngine = {
  engine: "tesseract",
  engine_version: "synthetic-test-engine-v1",
  language_pack: "heb",
  language_pack_available: true,
  local_only: true,
  dpi: 300,
  page_order: "ascending_pdf_page_number",
  oem: 1,
  psm: 6,
  preserve_interword_spaces: true,
};

const emptyPages: ExtractedPage[] = [1, 2, 3].map((page) => ({ page, text: "" }));
const syntheticPages: ExtractedPage[] = [
  { page: 1, text: "מסמך בדיקה סינתטי בנושא פנסיה בלבד. תוכן זה אינו כלל ואינו פרמטר. ".repeat(2) },
  { page: 2, text: "עמוד סינתטי שני לצורך בדיקת מיפוי וציטוט בלבד. ".repeat(3) },
  { page: 3, text: "עמוד סינתטי שלישי, ללא ערך משפטי וללא תחולה. ".repeat(3) },
];

function baseInput() {
  return {
    bytes: fixtureBytes,
    structural: { page_count: 3, corrupt: false, encrypted: false, has_active_content: false },
    parser_name: "pypdf+tesseract-local",
    parser_version: "synthetic-v1",
    native_pages: emptyPages,
    rendered_pages: images,
    ocr_engine: ocrEngine,
    ocr_run_a: syntheticPages,
    ocr_run_b: syntheticPages,
  } as const;
}

describe("pension 2016 deterministic fail-closed parsing", () => {
  it("keeps the synthetic fixture distinct from the pinned production artifact", () => {
    expect(sha256(fixtureBytes)).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildPension2016ParseEvidence(baseInput()).safe_error_code).toBe("artifact_sha256_mismatch");
  });

  it("fails closed for empty text when Hebrew OCR is unavailable", () => {
    const result = pensionParserTestSupport.buildForSyntheticFixture({
      ...baseInput(),
      ocr_engine: { ...ocrEngine, language_pack_available: false },
      ocr_run_a: null,
      ocr_run_b: null,
    });
    expect(result).toMatchObject({ status: "parse_failed_closed", safe_error_code: "ocr_hebrew_language_pack_unavailable", usable_for_rules: false });
  });

  it("produces identical hashes and page maps for identical OCR runs", () => {
    const first = pensionParserTestSupport.buildForSyntheticFixture(baseInput());
    const second = pensionParserTestSupport.buildForSyntheticFixture(baseInput());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "parsed_needs_review", method: "local_deterministic_ocr", activation_state: "inactive" });
    expect(first.page_map.map((page) => page.page)).toEqual([1, 2, 3]);
  });

  it("rejects OCR output that changes between deterministic runs", () => {
    const result = pensionParserTestSupport.buildForSyntheticFixture({
      ...baseInput(),
      ocr_run_b: syntheticPages.map((page) => page.page === 2 ? { ...page, text: `${page.text} changed` } : page),
    });
    expect(result.safe_error_code).toBe("ocr_nondeterministic_output");
  });

  it("rejects missing or reordered page mapping", () => {
    const result = pensionParserTestSupport.buildForSyntheticFixture({ ...baseInput(), rendered_pages: [images[1], images[0], images[2]] });
    expect(result.safe_error_code).toBe("page_mapping_invalid");
  });

  it.each([
    ["corrupt", { corrupt: true, encrypted: false, has_active_content: false }, "pdf_corrupt"],
    ["encrypted", { corrupt: false, encrypted: true, has_active_content: false }, "pdf_encrypted"],
    ["active", { corrupt: false, encrypted: false, has_active_content: true }, "pdf_active_content_rejected"],
  ] as const)("rejects %s input", (_name, structural, code) => {
    const result = pensionParserTestSupport.buildForSyntheticFixture({ ...baseInput(), structural: { page_count: 3, ...structural } });
    expect(result.safe_error_code).toBe(code);
  });

  it("round-trips every citation anchor to the same page text", () => {
    const result = pensionParserTestSupport.buildForSyntheticFixture(baseInput());
    expect(result.status).toBe("parsed_needs_review");
    expect(result.citation_anchors.map((anchor) => reconstructPensionCitation(anchor, syntheticPages).passed)).toEqual([true, true, true]);
  });
});

describe("convalescence 2025 acquisition boundary", () => {
  const safePdf = new TextEncoder().encode(`%PDF-1.4\n${"safe".repeat(150)}\n%%EOF`);

  it("binds one no-redirect official fetch to the exact document identity", async () => {
    const result = await acquireConvalescence2025Official(async () => ({
      bytes: safePdf,
      finalUrl: CONVALESCENCE_2025_OFFICIAL_URL,
      contentType: "application/pdf",
      safeHeaders: { "content-type": "application/pdf" },
      redirectCount: 0,
      redirectChain: [CONVALESCENCE_2025_OFFICIAL_URL],
    }));
    expect(result).toMatchObject({ relation_claims: [], effectivity_claims: [], review_state: "needs_review", activation_state: "inactive", usable_for_rules: false });
  });

  it("rejects a changed final URL even on the official host", async () => {
    await expect(acquireConvalescence2025Official(async () => ({
      bytes: safePdf,
      finalUrl: "https://fs.knesset.gov.il/25/law/other.pdf",
      contentType: "application/pdf",
      safeHeaders: {},
      redirectCount: 0,
      redirectChain: ["https://fs.knesset.gov.il/25/law/other.pdf"],
    }))).rejects.toThrow("official_artifact_identity_mismatch");
  });

  it("keeps the law separate and research secondary/non-operative", () => {
    expect(convalescence2025InstrumentBoundary).toMatchObject({ relation_claims: [], effectivity_claims: [], operative_candidate: false, activation_state: "inactive" });
    expect(convalescenceResearchClassification).toMatchObject({ artifact_role: "secondary_explanatory_source", operative_candidate: false, can_independently_support_monetary_rule: false });
    expect(convalescence2025InstrumentBoundary.source_id).not.toBe(convalescenceResearchClassification.source_id);
  });

  it("records acquired bytes without relation, effectivity, review, activation, or rule-use claims", () => {
    expect(inventory.convalescence_2025).toMatchObject({
      artifact_sha256: "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa",
      byte_count: 1_251_894,
      relation_claims: [],
      effectivity_claims: [],
      review_state: "needs_review",
      activation_state: "inactive",
      usable_for_rules: false,
    });
    expect(inventory.knesset_research_2025).toMatchObject({ artifact_role: "secondary_explanatory_source", operative_candidate: false });
  });
});
