import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContentAddressedIdPort, Sha256CanonicalHashPort, canonicalJson } from "../../../src/engine/case-operations/canonical.ts";
import {
  canonicalReportPdfContentDisposition,
  canonicalReportPdfFilename,
  DeterministicCaseReportBuilder,
} from "../../../src/server/reports/deterministic-report-builder.ts";
import {
  HEBREW_REPORT_FONT,
  HEBREW_REPORT_PAGE_COUNT,
  SYNTHETIC_REPORT_WATERMARK,
} from "../../../src/server/reports/deterministic-hebrew-pdf.ts";
import { syntheticReportBundle } from "../../../src/server/reports/synthetic-report-fixture.ts";

const repoRoot = process.cwd();
const outputRoot = path.resolve(argument("--output-root") ?? path.join(repoRoot, "tmp", "pdfs", "canonical-hebrew-report"));
const renderedRoot = path.join(outputRoot, "rendered");
mkdirSync(renderedRoot, { recursive: true });
for (const name of readdirSync(renderedRoot)) {
  if (/^page-\d+\.png$/u.test(name) || name === "contact-sheet.png") unlinkSync(path.join(renderedRoot, name));
}

const hash = new Sha256CanonicalHashPort();
const builder = new DeterministicCaseReportBuilder(hash, new ContentAddressedIdPort());
const bundle = syntheticReportBundle(hash);
const first = await builder.build(bundle);
const second = await builder.build(bundle);
assert(Buffer.from(first.json).equals(Buffer.from(second.json)), "REPORT_JSON_TWO_BUILD_MISMATCH");
assert(Buffer.from(first.html).equals(Buffer.from(second.html)), "REPORT_HTML_TWO_BUILD_MISMATCH");
assert(Buffer.from(first.pdf).equals(Buffer.from(second.pdf)), "REPORT_PDF_TWO_BUILD_MISMATCH");
assert(Buffer.from(first.manifest).equals(Buffer.from(second.manifest)), "REPORT_MANIFEST_TWO_BUILD_MISMATCH");

const artifactPaths = {
  json: path.join(outputRoot, "report.json"),
  html: path.join(outputRoot, "report.html"),
  pdf: path.join(outputRoot, "report.pdf"),
  manifest: path.join(outputRoot, "manifest.json"),
};
writeFileSync(artifactPaths.json, first.json);
writeFileSync(artifactPaths.html, first.html);
writeFileSync(artifactPaths.pdf, first.pdf);
writeFileSync(artifactPaths.manifest, first.manifest);

const pdfInfo = executable("pdfinfo", [
  process.env.TIVDOC_PDFINFO,
  bundled("native", "poppler", "Library", "bin", "pdfinfo.exe"),
  "pdfinfo",
]);
const pdftoppm = executable("pdftoppm", [
  process.env.TIVDOC_PDFTOPPM,
  bundled("native", "poppler", "Library", "bin", "pdftoppm.exe"),
  "pdftoppm",
]);
const python = executable("python", [
  process.env.TIVDOC_PDF_PYTHON,
  bundled("python", "python.exe"),
  "python3",
  "python",
]);

const info = run(pdfInfo, [artifactPaths.pdf]);
assert(/^Pages:\s+4$/mu.test(info.stdout), "PDFINFO_PAGE_COUNT_MISMATCH");
assert(/^Page size:\s+595\.28 x 841\.89 pts \(A4\)$/mu.test(info.stdout), "PDFINFO_A4_MISMATCH");
const prefix = path.join(renderedRoot, "page");
run(pdftoppm, ["-png", "-r", "120", artifactPaths.pdf, prefix]);

const inspection = run(python, [
  path.join(repoRoot, "scripts", "product-integration", "report", "inspect_pdf.py"),
  artifactPaths.pdf,
  renderedRoot,
  path.join(renderedRoot, "contact-sheet.png"),
]);
const nativeInspection = JSON.parse(inspection.stdout) as {
  status: string;
  page_count: number;
  hebrew_unicode_codepoints: number;
  missing_phrases: unknown[];
  replacement_glyph_count: number;
  annotations: number;
  forbidden_active_content_keys: unknown[];
  fonts: Array<{ base_font: string; embedded_stream: string; embedded_bytes: number; to_unicode: boolean }>;
  rendered_pages: Array<{ path: string; sha256: string; nonwhite_ratio: number; dark_ratio: number }>;
  contact_sheet: { path: string; sha256: string };
};
assert(nativeInspection.status === "PASSED", "NATIVE_PDF_INSPECTION_FAILED");
assert(nativeInspection.page_count === HEBREW_REPORT_PAGE_COUNT, "NATIVE_PDF_PAGE_COUNT_MISMATCH");
assert(nativeInspection.hebrew_unicode_codepoints >= 100, "NATIVE_HEBREW_EXTRACTION_TOO_SHORT");
assert(nativeInspection.missing_phrases.length === 0 && nativeInspection.replacement_glyph_count === 0, "NATIVE_HEBREW_TEXT_DEFECT");
assert(nativeInspection.annotations === 0 && nativeInspection.forbidden_active_content_keys.length === 0, "NATIVE_ACTIVE_CONTENT_DEFECT");
assert(nativeInspection.fonts.length === 1 && nativeInspection.fonts[0].base_font === "/DejaVuSans" && nativeInspection.fonts[0].embedded_stream === "/FontFile2" && nativeInspection.fonts[0].to_unicode, "NATIVE_FONT_EMBEDDING_DEFECT");
assert(nativeInspection.fonts[0].embedded_bytes === 757_076, "NATIVE_FONT_BYTE_COUNT_MISMATCH");
assert(nativeInspection.rendered_pages.length === HEBREW_REPORT_PAGE_COUNT, "POPPLER_RENDER_PAGE_COUNT_MISMATCH");

const manifest = JSON.parse(Buffer.from(first.manifest).toString("utf8")) as {
  components: Array<{ path: string; sha256: string; byte_count: number }>;
  bindings: { rules_and_parameters: unknown[]; renderer: { font_sha256: string }; approval: { binding_field: string } };
};
assert(manifest.components.map((item) => item.sha256).join(":") === [first.json_sha256, first.html_sha256, first.pdf_sha256].join(":"), "MANIFEST_COMPONENT_BINDING_MISMATCH");
assert(manifest.bindings.rules_and_parameters.length === 7, "MANIFEST_TOPIC_BINDING_COUNT_MISMATCH");
assert(manifest.bindings.renderer.font_sha256 === HEBREW_REPORT_FONT.sha256, "MANIFEST_FONT_BINDING_MISMATCH");
assert(manifest.bindings.approval.binding_field === "report_sha256", "MANIFEST_APPROVAL_BINDING_MISMATCH");
const reportJson = JSON.parse(Buffer.from(first.json).toString("utf8")) as { topics: unknown[]; case_id: string; known_subtotal: { currency: string } | null };
const reportHtml = Buffer.from(first.html).toString("utf8");
assert(reportJson.topics.length === 7, "REPORT_TOPIC_COUNT_MISMATCH");
assert(reportJson.case_id.includes("synthetic") && reportJson.known_subtotal?.currency === "XTS", "REPORT_SYNTHETIC_ID_OR_CURRENCY_MISMATCH");
assert(reportHtml.includes('<html lang="he" dir="rtl">') && reportHtml.includes(SYNTHETIC_REPORT_WATERMARK), "REPORT_HTML_RTL_OR_WATERMARK_MISSING");
assert(!/(?:src|href)=["']https?:/u.test(reportHtml), "REPORT_HTML_REMOTE_RESOURCE_FOUND");

const receipt = {
  schema_version: "tivdoc-canonical-hebrew-report-verification-v0.8.0",
  status: "PASSED",
  deterministic_two_builds: true,
  canonical_input: {
    case_id: bundle.case_id,
    analysis_run_id: bundle.analysis_run_id,
    analysis_result_sha256: bundle.result_sha256,
    topic_count: bundle.topic_results.length,
    currency: bundle.known_subtotal?.currency ?? null,
  },
  artifacts: {
    json: component(artifactPaths.json, first.json_sha256),
    html: component(artifactPaths.html, first.html_sha256),
    pdf: component(artifactPaths.pdf, first.pdf_sha256),
    manifest: component(artifactPaths.manifest, first.manifest_sha256),
  },
  report_sha256: first.report_sha256,
  download: {
    filename: canonicalReportPdfFilename(first.report_id),
    content_disposition: canonicalReportPdfContentDisposition(first.report_id),
    approved_stored_download_equality_target_sha256: first.pdf_sha256,
  },
  font: HEBREW_REPORT_FONT,
  pdfinfo: info.stdout.trim().split(/\r?\n/u),
  native_inspection: nativeInspection,
  tools: {
    pdfinfo: pdfInfo,
    pdftoppm,
    python,
  },
};
const receiptPath = path.join(outputRoot, "verification-receipt.json");
writeFileSync(receiptPath, canonicalJson(receipt), "utf8");
process.stdout.write(canonicalJson({ ...receipt, receipt: component(receiptPath, sha256File(receiptPath)) }));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function bundled(...segments: string[]): string {
  return path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", ...segments);
}

function executable(label: string, candidates: readonly (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    if (!candidate.includes(path.sep)) {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
      if (!probe.error) return candidate;
    }
  }
  throw new Error(`${label.toUpperCase()}_EXECUTABLE_MISSING`);
}

function run(command: string, args: readonly string[]): Readonly<{ stdout: string; stderr: string }> {
  const result = spawnSync(command, [...args], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`COMMAND_FAILED:${path.basename(command)}:${result.status ?? "spawn"}:${(result.stderr || result.error?.message || "").trim()}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function component(filePath: string, expectedSha256: string): Readonly<{ path: string; sha256: string; byte_count: number }> {
  const bytes = readFile(filePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert(actual === expectedSha256, `ARTIFACT_HASH_MISMATCH:${path.basename(filePath)}`);
  return { path: path.relative(repoRoot, filePath).replaceAll("\\", "/"), sha256: actual, byte_count: bytes.byteLength };
}

function readFile(filePath: string): Buffer {
  return readFileSync(filePath);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFile(filePath)).digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
