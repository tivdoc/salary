// Pool E. Parse a byte-complete blocked observation, deterministically.
//
// Sixty-nine observations carry `BYTES_PRESENT_NOT_PARSED` because nothing in
// the Node toolchain reads a PDF. Something in the repository does:
// `scripts/legal-pdf-extract.py` with pypdf, run from a pinned virtual
// environment under the git-ignored `output/`. That is the parser, and its
// version is recorded from the interpreter rather than written down by hand.
//
// What this does NOT do is as important. It writes nothing to any database, it
// activates nothing, it marks nothing reviewed, and it does not touch the
// blocked record — under the anti-graduation rule that record is immutable and
// a parse produces a NEW artifact beside it, never an edit to it. It also does
// not OCR: this host has Tesseract but no Hebrew language data, so an
// observation with no embedded text layer is rejected `TEXT_LAYER_ABSENT` and
// left for a host that has one, rather than being quietly downgraded.
//
// The Hebrew ordering trap is recorded, not silently corrected. pypdf's layout
// mode emits glyphs in visual order, so the extracted text reads reversed, with
// U+FEFF or U+00A0 as separators. Reordering is a semantic decision about a
// legal text and is not one this script is entitled to make, so each artifact
// carries `visual_order: true` and the separator it saw.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  LEGAL_NORMALIZER_VERSION, chunkLegalPages, normalizeLegalText, removeRepeatedPdfMargins,
} from "../../src/server/engine/legal-knowledge/normalization.ts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "observations");
const LEDGER = path.join("output", "wave1", "audit", "reason-breakdown.json");
const CORPUS_ROOT = path.join("output", "parallel-wave-1", "review-package-v0.3",
  "worker-evidence", "batch-a-working-time-permits", "artifacts");
const VENV_PYTHON = path.join("output", "pdf-venv", "Scripts", "python.exe");
const EXTRACTOR = path.join("scripts", "legal-pdf-extract.py");

/** Rejections, each with a code that says what was actually wrong. */
const REJECTIONS = Object.freeze({
  BYTES_NOT_FOUND: "no file under the corpus root has this observation's sha256",
  BYTES_SHA256_MISMATCH: "the file found does not hash to the recorded artifact sha256",
  DUPLICATE_BYTES: "another observation already claims these exact bytes",
  EXTRACTOR_FAILED: "the parser exited non-zero or produced no JSON",
  ENCRYPTED_PDF_UNSUPPORTED: "the document is encrypted and the parser cannot open it",
  TEXT_LAYER_ABSENT_SCANNED: "every page is a scanned image with no font resources; this needs OCR, and this host has Tesseract without Hebrew language data",
  GLYPHS_UNMAPPABLE: "fonts are present but carry no /ToUnicode, so glyph codes cannot be decoded to characters; a parser change would fix this, OCR would not",
  EMPTY_NORMALIZED_TEXT: "the text layer normalized to nothing",
});

type Ledger = Readonly<{
  observation_id: string; reason_code: string; source_url: string; final_url: string;
  declared_media_type: string; media_validation_passed: boolean;
  byte_count: number; raw_artifact_sha256: string;
}>;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under the corpus, indexed by content hash. */
function corpusIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else index.set(sha256(readFileSync(full)), full.replaceAll("\\", "/"));
    }
  };
  if (existsSync(CORPUS_ROOT)) walk(CORPUS_ROOT);
  return index;
}

function parserVersion(): string {
  const version = execFileSync(VENV_PYTHON,
    ["-c", "import pypdf; print(pypdf.__version__)"], { encoding: "utf8" }).trim();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("OBSERVATION_PARSER_VERSION_UNREADABLE");
  return `pypdf-${version}-layout`;
}

type Extraction = Readonly<{
  status?: string;
  pages?: readonly Readonly<{ page: number; text: string }>[];
  page_count?: number;
  font_count?: number;
}>;

function extract(file: string): Extraction {
  const stdout = execFileSync(VENV_PYTHON, [EXTRACTOR, file],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout) as Extraction;
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  if (!existsSync(VENV_PYTHON)) {
    process.stdout.write(`observations=blocked_external reason=venv_absent path=${VENV_PYTHON}\n`);
    process.exitCode = 1;
    return;
  }
  const limit = Number(process.env.TIVDOC_OBSERVATION_LIMIT ?? "0");
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as { rows?: Ledger[] } | Ledger[];
  const rows = (Array.isArray(ledger) ? ledger : ledger.rows ?? []) as Ledger[];
  const index = corpusIndex();
  const version = parserVersion();

  const seenBytes = new Map<string, string>();
  const results: Record<string, unknown>[] = [];
  const candidates = rows.filter((row) => row.reason_code === "BYTES_PRESENT_NOT_PARSED");
  const selected = limit > 0 ? candidates.slice(0, limit) : candidates;

  for (const row of selected) {
    const reject = (code: keyof typeof REJECTIONS, detail = "") => {
      results.push({
        observation_id: row.observation_id, outcome: "rejected",
        rejection_code: code, rejection_reason: REJECTIONS[code], detail,
      });
    };
    const owner = seenBytes.get(row.raw_artifact_sha256);
    if (owner !== undefined) { reject("DUPLICATE_BYTES", owner); continue; }
    seenBytes.set(row.raw_artifact_sha256, row.observation_id);

    const file = index.get(row.raw_artifact_sha256);
    if (file === undefined) { reject("BYTES_NOT_FOUND"); continue; }
    const bytes = readFileSync(file);
    if (sha256(bytes) !== row.raw_artifact_sha256 || bytes.byteLength !== row.byte_count) {
      reject("BYTES_SHA256_MISMATCH", file);
      continue;
    }

    let extraction: Extraction;
    try {
      extraction = extract(file);
    } catch (error) {
      reject("EXTRACTOR_FAILED", String((error as Error).message).slice(0, 160));
      continue;
    }
    if (extraction.status === "encrypted_pdf_unsupported") { reject("ENCRYPTED_PDF_UNSUPPORTED"); continue; }
    const pages = extraction.pages ?? [];
    const withText = pages.filter((page) => page.text.trim().length > 0);
    if (withText.length === 0) {
      // Two different problems with two different fixes, and one code for both
      // makes the OCR backlog uncountable. A page with no font resources at all
      // is a scan; a page with fonts whose glyphs will not map is a parser
      // problem. The extractor reports the font census, so the code says which.
      const fonts = extraction.font_count ?? 0;
      reject(fonts === 0 ? "TEXT_LAYER_ABSENT_SCANNED" : "GLYPHS_UNMAPPABLE",
        `pages=${pages.length} fonts=${fonts}`);
      continue;
    }

    const trimmed = removeRepeatedPdfMargins(pages);
    const normalized = normalizeLegalText(trimmed.map((page) => page.text).join("\n"));
    if (normalized.trim().length === 0) { reject("EMPTY_NORMALIZED_TEXT"); continue; }

    const source = Object.freeze({
      source_id: row.observation_id,
      source_version: row.raw_artifact_sha256.slice(0, 16),
    });
    const chunks = chunkLegalPages(source, row.raw_artifact_sha256, trimmed, {
      normalizedTextSha256: sha256(normalized),
      parserVersion: version,
    });
    // Visual order is a property of the extraction, not a defect to hide. The
    // separator says which convention this document used.
    const separator = normalized.includes("﻿") ? "U+FEFF"
      : normalized.includes(" ") ? "U+00A0" : "space";

    const artifact = {
      schema_version: "tivdoc-observation-parse-artifact-v4",
      observation_id: row.observation_id,
      blocked_record_untouched: true,
      source_url: row.source_url, final_url: row.final_url,
      declared_media_type: row.declared_media_type,
      byte_count: bytes.byteLength,
      raw_artifact_sha256: row.raw_artifact_sha256,
      corpus_path: file,
      parser_version: version,
      normalizer_version: LEGAL_NORMALIZER_VERSION,
      ocr_derived: false,
      visual_order: true,
      whitespace_separator: separator,
      page_count: pages.length,
      pages_with_text: withText.length,
      // A document can parse and still hold a page the parser could not read.
      // Four of the sixty-two do. Naming the count keeps a partial extraction
      // from reading as a whole one.
      pages_without_text: pages.length - withText.length,
      // The reversal is not only alphabetic: digit runs come out reversed too,
      // so 1951 extracts as 1591 and a section number reads backwards. Anything
      // citing an amendment number, section or date from this text has to undo
      // that first, and saying so here is cheaper than a silent mis-citation.
      digits_visually_reversed: true,
      normalized_characters: normalized.length,
      normalized_text_sha256: sha256(normalized),
      chunk_count: chunks.length,
      review_state: "needs_review",
      activation_state: "inactive",
    };
    writeFileSync(path.join(RECEIPT_ROOT, `${row.observation_id.replaceAll(":", "_")}.json`),
      `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    results.push({ observation_id: row.observation_id, outcome: "parsed", ...artifact });
  }

  const parsed = results.filter((entry) => entry.outcome === "parsed");
  const rejected = results.filter((entry) => entry.outcome === "rejected");
  const byCode: Record<string, number> = {};
  for (const entry of rejected) byCode[String(entry.rejection_code)] = (byCode[String(entry.rejection_code)] ?? 0) + 1;
  writeFileSync(path.join(RECEIPT_ROOT, "summary.json"), `${JSON.stringify({
    schema_version: "tivdoc-observation-parse-summary-v4",
    parser_version: version, normalizer_version: LEGAL_NORMALIZER_VERSION,
    candidates: candidates.length, attempted: selected.length,
    parsed: parsed.length, rejected: rejected.length, rejection_codes: byCode,
    results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`parser=${version} normalizer=${LEGAL_NORMALIZER_VERSION}`
    + ` attempted=${selected.length} parsed=${parsed.length} rejected=${rejected.length}`
    + ` ${JSON.stringify(byCode)}\n`);
}

main();
