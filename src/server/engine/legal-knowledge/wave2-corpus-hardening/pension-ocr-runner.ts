import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PENSION_2016_OCR_TOOLCHAIN,
  createPensionOcrDerivedBundle,
  normalizeOcrPage,
  sha256,
  stableJson,
  verifyOcrCitationRoundTrip,
} from "../../../../engine/legal-knowledge/corpus-hardening/pension-ocr.ts";

type DownloadEvidence = Readonly<{
  requested_url: string;
  final_url: string;
  redirect_chain: readonly string[];
  observed_at: string;
  server_date: string | null;
  media_type: string;
  declared_content_length: number | null;
  byte_count: number;
  sha256: string;
}>;

const allowedToolingUrls = new Set<string>([
  PENSION_2016_OCR_TOOLCHAIN.language_artifact.url,
  PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.url,
]);

async function downloadOfficialToolingArtifact(url: string, expected: Readonly<{ bytes: number; sha256: string; mediaType: string }>): Promise<Readonly<{ bytes: Buffer; evidence: DownloadEvidence }>> {
  if (!allowedToolingUrls.has(url)) throw new Error("ocr_tooling_url_not_allowlisted");
  let current = url;
  const chain: string[] = [];
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") throw new Error("ocr_tooling_redirect_not_allowlisted");
    chain.push(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(current, { redirect: "manual", signal: controller.signal, headers: { accept: expected.mediaType } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("ocr_tooling_redirect_without_location");
        current = new URL(location, current).toString();
        continue;
      }
      if (response.status !== 200) throw new Error(`ocr_tooling_http_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = sha256(bytes);
      const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      const declared = response.headers.get("content-length");
      if (bytes.length !== expected.bytes || digest !== expected.sha256) throw new Error("ocr_tooling_pin_mismatch");
      if (mediaType !== expected.mediaType) throw new Error("ocr_tooling_media_type_mismatch");
      return Object.freeze({
        bytes,
        evidence: Object.freeze({
          requested_url: url,
          final_url: current,
          redirect_chain: Object.freeze(chain),
          observed_at: new Date().toISOString(),
          server_date: response.headers.get("date"),
          media_type: mediaType,
          declared_content_length: declared && /^\d+$/u.test(declared) ? Number(declared) : null,
          byte_count: bytes.length,
          sha256: digest,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("ocr_tooling_redirect_limit_exceeded");
}

async function assertFreshDirectory(target: string) {
  try {
    await access(target, constants.F_OK);
    throw new Error(`output_directory_must_not_exist:${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: true });
}

export async function acquirePinnedHebrewTooling(outputDirectory: string) {
  await assertFreshDirectory(outputDirectory);
  const [model, license] = await Promise.all([
    downloadOfficialToolingArtifact(PENSION_2016_OCR_TOOLCHAIN.language_artifact.url, {
      bytes: PENSION_2016_OCR_TOOLCHAIN.language_artifact.byte_count,
      sha256: PENSION_2016_OCR_TOOLCHAIN.language_artifact.sha256,
      mediaType: PENSION_2016_OCR_TOOLCHAIN.language_artifact.media_type,
    }),
    downloadOfficialToolingArtifact(PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.url, {
      bytes: PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.byte_count,
      sha256: PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.sha256,
      mediaType: "text/plain",
    }),
  ]);
  const modelPath = path.join(outputDirectory, "heb.traineddata");
  const licensePath = path.join(outputDirectory, "LICENSE");
  await Promise.all([
    writeFile(modelPath, model.bytes, { flag: "wx" }),
    writeFile(licensePath, license.bytes, { flag: "wx" }),
  ]);
  const report = Object.freeze({
    schema_version: "pension-ocr-tooling-acquisition-v0.4" as const,
    upstream_repository: PENSION_2016_OCR_TOOLCHAIN.language_artifact.upstream_repository,
    upstream_commit: PENSION_2016_OCR_TOOLCHAIN.language_artifact.upstream_commit,
    language_artifact: model.evidence,
    license: Object.freeze({ ...license.evidence, spdx: PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.spdx }),
    allowed_network_scope: "official_upstream_tesseract_tooling_only" as const,
  });
  await writeFile(path.join(outputDirectory, "acquisition.json"), stableJson(report), { flag: "wx" });
  return Object.freeze({ modelPath, licensePath, report });
}

export async function verifyPinnedHebrewTooling(toolingDirectory: string) {
  const modelPath = path.join(toolingDirectory, "heb.traineddata");
  const licensePath = path.join(toolingDirectory, "LICENSE");
  const [model, license] = await Promise.all([readFile(modelPath), readFile(licensePath)]);
  if (model.length !== PENSION_2016_OCR_TOOLCHAIN.language_artifact.byte_count || sha256(model) !== PENSION_2016_OCR_TOOLCHAIN.language_artifact.sha256) throw new Error("ocr_model_pin_mismatch");
  if (license.length !== PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.byte_count || sha256(license) !== PENSION_2016_OCR_TOOLCHAIN.language_artifact.license.sha256) throw new Error("ocr_license_pin_mismatch");
  return Object.freeze({ modelPath, licensePath, model_sha256: sha256(model), license_sha256: sha256(license) });
}

function spawnChecked(executable: string, args: readonly string[], options: Readonly<{ cwd?: string; encoding?: BufferEncoding }> = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
  });
  if (result.status !== 0) throw new Error(`tool_failed:${path.basename(executable)}:${result.status}:${String(result.stderr).slice(0, 500)}`);
  return result;
}

export async function verifyPensionSourcePdf(pdfPath: string) {
  const lower = path.resolve(pdfPath).toLowerCase();
  if (lower.includes("customer") || lower.includes("payslip")) throw new Error("prohibited_customer_path");
  if ((await lstat(pdfPath)).isSymbolicLink()) throw new Error("pension_pdf_symlink_rejected");
  const [resolved, bytes, metadata] = await Promise.all([realpath(pdfPath), readFile(pdfPath), stat(pdfPath)]);
  if (metadata.size !== PENSION_2016_OCR_TOOLCHAIN.source_pdf_bytes || sha256(bytes) !== PENSION_2016_OCR_TOOLCHAIN.source_pdf_sha256) throw new Error("pension_source_pdf_pin_mismatch");
  return Object.freeze({ resolved_path: resolved, bytes: metadata.size, sha256: sha256(bytes) });
}

export async function runPinnedPensionOcr(input: Readonly<{
  pdfPath: string;
  toolingDirectory: string;
  outputDirectory: string;
  tesseractExecutable: string;
  pdftoppmExecutable: string;
}>) {
  await assertFreshDirectory(input.outputDirectory);
  const [source, tooling] = await Promise.all([verifyPensionSourcePdf(input.pdfPath), verifyPinnedHebrewTooling(input.toolingDirectory)]);
  const tesseractVersion = `${spawnChecked(input.tesseractExecutable, ["--version"]).stdout}`.split(/\r?\n/u)[0].trim();
  const rendererVersionResult = spawnChecked(input.pdftoppmExecutable, ["-v"]);
  const rendererVersion = `${rendererVersionResult.stderr || rendererVersionResult.stdout}`.split(/\r?\n/u)[0].trim();
  if (tesseractVersion !== `tesseract v${PENSION_2016_OCR_TOOLCHAIN.ocr_engine.version}`) throw new Error("tesseract_version_mismatch");
  if (rendererVersion !== `pdftoppm version ${PENSION_2016_OCR_TOOLCHAIN.renderer.version}`) throw new Error("pdftoppm_version_mismatch");

  const tessdataDirectory = path.join(input.outputDirectory, "tessdata");
  await mkdir(tessdataDirectory);
  await copyFile(tooling.modelPath, path.join(tessdataDirectory, "heb.traineddata"), constants.COPYFILE_EXCL);
  const renderedPrefix = path.join(input.outputDirectory, "rendered-page");
  spawnChecked(input.pdftoppmExecutable, [
    ...PENSION_2016_OCR_TOOLCHAIN.renderer.arguments,
    source.resolved_path,
    renderedPrefix,
  ]);
  const renderedNames = (await readdir(input.outputDirectory)).filter((name) => /^rendered-page-\d+\.png$/u.test(name)).sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (renderedNames.length !== PENSION_2016_OCR_TOOLCHAIN.source_pdf_pages) throw new Error("rendered_page_count_mismatch");
  const pageInputs = [];
  const normalizedPages = [];
  for (let index = 0; index < renderedNames.length; index += 1) {
    const page = index + 1;
    const imagePath = path.join(input.outputDirectory, renderedNames[index]);
    const imageBytes = await readFile(imagePath);
    const imageHash = sha256(imageBytes);
    if (imageHash !== PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256[index]) throw new Error(`rendered_page_hash_mismatch:page-${page}`);
    const rawBase = path.join(input.outputDirectory, `raw-ocr-page-${page}`);
    spawnChecked(input.tesseractExecutable, [
      imagePath,
      rawBase,
      "--tessdata-dir", tessdataDirectory,
      "-l", PENSION_2016_OCR_TOOLCHAIN.ocr_engine.language,
      "--oem", String(PENSION_2016_OCR_TOOLCHAIN.ocr_engine.oem),
      "--psm", String(PENSION_2016_OCR_TOOLCHAIN.ocr_engine.psm),
      "-c", "preserve_interword_spaces=1",
      "-c", "user_defined_dpi=300",
      "quiet",
    ]);
    const rawPath = `${rawBase}.txt`;
    const rawBytes = await readFile(rawPath);
    const rawText = rawBytes.toString("utf8");
    pageInputs.push({ page, rendered_page_sha256: imageHash, raw_ocr_text: rawText, raw_ocr_sha256: sha256(rawBytes) });
    const normalized = normalizeOcrPage(rawText, page);
    normalizedPages.push(normalized);
    await Promise.all([
      writeFile(path.join(input.outputDirectory, `normalized-page-${page}.txt`), normalized.normalized_text, { flag: "wx" }),
      writeFile(path.join(input.outputDirectory, `line-map-page-${page}.json`), stableJson({ page, normalizer_version: normalized.normalizer_version, line_map: normalized.line_map }), { flag: "wx" }),
    ]);
  }
  const bundle = createPensionOcrDerivedBundle(pageInputs);
  const citations = verifyOcrCitationRoundTrip(bundle, normalizedPages);
  if (!citations.passed) throw new Error("ocr_citation_round_trip_failed");
  await writeFile(path.join(input.outputDirectory, "derived-bundle.json"), stableJson(bundle), { flag: "wx" });
  await writeFile(path.join(input.outputDirectory, "citation-round-trip.json"), stableJson(citations), { flag: "wx" });
  const files = (await readdir(input.outputDirectory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
    .map(async (filePath) => {
      const bytes = await readFile(filePath);
      return { path: path.relative(input.outputDirectory, filePath).replaceAll("\\", "/"), byte_count: bytes.length, sha256: sha256(bytes) };
    });
  const inventory = await Promise.all(files);
  const report = Object.freeze({
    schema_version: "pension-2016-ocr-run-report-v0.4" as const,
    toolchain: PENSION_2016_OCR_TOOLCHAIN,
    observed_versions: Object.freeze({ tesseract: tesseractVersion, renderer: rendererVersion }),
    source_pdf: Object.freeze({ byte_count: source.bytes, sha256: source.sha256 }),
    tooling: Object.freeze({ model_sha256: tooling.model_sha256, license_sha256: tooling.license_sha256 }),
    review_state: "needs_review" as const,
    activation_state: "inactive" as const,
    corpus_registration_performed: false as const,
    citation_round_trip: citations,
    file_inventory: inventory,
  });
  await writeFile(path.join(input.outputDirectory, "run-report.json"), stableJson(report), { flag: "wx" });
  return report;
}

export async function runPinnedPensionOcrTwice(input: Readonly<{
  pdfPath: string;
  toolingDirectory: string;
  outputDirectory: string;
  tesseractExecutable: string;
  pdftoppmExecutable: string;
}>) {
  await assertFreshDirectory(input.outputDirectory);
  const runA = await runPinnedPensionOcr({ ...input, outputDirectory: path.join(input.outputDirectory, "run-a") });
  const runB = await runPinnedPensionOcr({ ...input, outputDirectory: path.join(input.outputDirectory, "run-b") });
  const identical = stableJson(runA) === stableJson(runB);
  if (!identical) throw new Error("PENSION_OCR_NONDETERMINISTIC");
  const report = Object.freeze({
    schema_version: "pension-2016-ocr-reproducibility-v0.4" as const,
    status: "PENSION_OCR_DERIVED_NEEDS_HUMAN_REVIEW" as const,
    byte_identical_clean_runs: identical,
    run_report_sha256: sha256(stableJson(runA)),
    rendered_page_sha256: PENSION_2016_OCR_TOOLCHAIN.renderer.expected_page_sha256,
    raw_ocr_page_sha256: runA.file_inventory.filter((entry) => /^raw-ocr-page-\d+\.txt$/u.test(entry.path)).map((entry) => entry.sha256),
    normalized_page_sha256: runA.file_inventory.filter((entry) => /^normalized-page-\d+\.txt$/u.test(entry.path)).map((entry) => entry.sha256),
    review_state: "needs_review" as const,
    activation_state: "inactive" as const,
    legal_confidence_from_ocr: false as const,
  });
  await writeFile(path.join(input.outputDirectory, "reproducibility.json"), stableJson(report), { flag: "wx" });
  return report;
}
