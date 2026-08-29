import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  acquireConvalescence2025Official,
  buildPension2016ParseEvidence,
  CONVALESCENCE_2025_OFFICIAL_URL,
  PENSION_2016_ARTIFACT_SHA256,
  reconstructPensionCitation,
  type ExtractedPage,
  type OcrEngine,
  type PageImageEvidence,
} from "../src/server/engine/legal-knowledge/wave1-pension-convalescence.ts";

const repoRoot = process.cwd();
const defaultOutputRoot = path.join(repoRoot, "output", "legal-knowledge", "wave1-pension-convalescence");

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function run(command: string, args: readonly string[]) {
  return spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

function assertIgnored(targetPath: string) {
  const relative = path.relative(repoRoot, path.resolve(targetPath)).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("output_path_escape");
  const result = run("git", ["check-ignore", "-q", `${relative}/.ignore-check`]);
  if (result.status !== 0) throw new Error("output_path_not_git_ignored");
}

async function writeAtomic(filePath: string, value: Uint8Array | string) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeImmutable(filePath: string, bytes: Uint8Array) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const current = await readFile(filePath);
    if (!current.equals(Buffer.from(bytes))) throw new Error("immutable_artifact_mismatch");
    return;
  }
  await writeFile(filePath, bytes, { flag: "wx" });
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function executable(preferred: string, fallback: string) {
  const lookup = run("where.exe", [preferred]);
  const first = lookup.status === 0 ? lookup.stdout.split(/\r?\n/u).find(Boolean) : null;
  if (first) return first.trim();
  if (existsSync(fallback)) return fallback;
  throw new Error(`${preferred}_unavailable`);
}

function pythonExecutable() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  if (bundled && existsSync(bundled)) return bundled;
  const lookup = run("where.exe", ["python"]);
  const candidates = lookup.status === 0 ? lookup.stdout.split(/\r?\n/u).filter(Boolean) : [];
  for (const candidate of candidates) {
    const probe = run(candidate.trim(), ["-c", "import sys; print(sys.version)"]);
    if (probe.status === 0) return candidate.trim();
  }
  throw new Error("python_runtime_unavailable");
}

function imageDimensionsPng(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("rendered_page_not_png");
  return { width_px: buffer.readUInt32BE(16), height_px: buffer.readUInt32BE(20) };
}

function pdfStructuralProbe(pdfPath: string, pythonPath: string) {
  const extractor = path.join(repoRoot, "scripts", "legal-pdf-extract.py");
  const result = run(pythonPath, [extractor, pdfPath]);
  let parsed: { pages?: ExtractedPage[]; safe_error_code?: string } = {};
  try { parsed = JSON.parse(result.stdout || "{}"); } catch { parsed = { safe_error_code: "pdf_parse_failed" }; }
  const info = run("pdfinfo", [pdfPath]);
  const pageCount = Number(info.stdout.match(/^Pages:\s+(\d+)$/mu)?.[1] ?? "0");
  const encrypted = /^Encrypted:\s+yes$/imu.test(info.stdout);
  return {
    parser_result: parsed,
    page_count: pageCount,
    corrupt: result.status !== 0 && ![3, 6].includes(result.status ?? -1),
    encrypted: encrypted || result.status === 3,
    has_active_content: result.status === 6,
  };
}

async function parsePension(inputPath: string, outputRoot: string) {
  assertIgnored(outputRoot);
  const bytes = new Uint8Array(await readFile(inputPath));
  if (sha256(bytes) !== PENSION_2016_ARTIFACT_SHA256) throw new Error("pension_artifact_sha256_mismatch");
  const pensionRoot = path.join(outputRoot, "pension-2016");
  const artifactPath = path.join(pensionRoot, "artifacts", `${PENSION_2016_ARTIFACT_SHA256}.pdf`);
  await writeImmutable(artifactPath, bytes);

  const pythonPath = pythonExecutable();
  const probe = pdfStructuralProbe(artifactPath, pythonPath);
  const renderer = executable("pdftoppm", "");
  const renderRoot = path.join(pensionRoot, "intermediate");
  await mkdir(renderRoot, { recursive: true });
  for (const name of await readdir(renderRoot)) {
    if (/^page-\d+\.png$/u.test(name)) await rm(path.join(renderRoot, name));
  }
  const render = run(renderer, ["-png", "-r", "300", artifactPath, path.join(renderRoot, "page")]);
  if (render.status !== 0) throw new Error("pdf_render_failed");
  const renderedNames = (await readdir(renderRoot)).filter((name) => /^page-\d+\.png$/u.test(name)).sort((left, right) => Number(left.match(/\d+/u)?.[0]) - Number(right.match(/\d+/u)?.[0]));
  const renderedPages: PageImageEvidence[] = [];
  for (const [index, name] of renderedNames.entries()) {
    const imageBytes = new Uint8Array(await readFile(path.join(renderRoot, name)));
    renderedPages.push({ page: index + 1, image_sha256: sha256(imageBytes), ...imageDimensionsPng(imageBytes), dpi: 300 });
  }

  const pythonVersion = run(pythonPath, ["-c", "import pypdf; print(pypdf.__version__)"]);
  const rendererVersion = run(renderer, ["-v"]);
  const tesseractPath = executable("tesseract", "C:\\Program Files\\Tesseract-OCR\\tesseract.exe");
  const tesseractVersion = run(tesseractPath, ["--version"]);
  const languageList = run(tesseractPath, ["--list-langs"]);
  const languagePackAvailable = languageList.status === 0 && languageList.stdout.split(/\r?\n/u).some((line) => line.trim() === "heb");
  const ocrEngine: OcrEngine = {
    engine: "tesseract",
    engine_version: tesseractVersion.stdout.split(/\r?\n/u).find(Boolean)?.trim() || "unknown-local-version",
    language_pack: "heb",
    language_pack_available: languagePackAvailable,
    local_only: true,
    dpi: 300,
    page_order: "ascending_pdf_page_number",
    oem: 1,
    psm: 6,
    preserve_interword_spaces: true,
  };

  const runOcr = () => renderedNames.map((name, index) => {
    const result = run(tesseractPath, [path.join(renderRoot, name), "stdout", "-l", "heb", "--oem", "1", "--psm", "6", "-c", "preserve_interword_spaces=1"]);
    if (result.status !== 0) throw new Error("local_ocr_failed");
    return { page: index + 1, text: result.stdout };
  });
  const ocrRunA = languagePackAvailable ? runOcr() : null;
  const ocrRunB = languagePackAvailable ? runOcr() : null;
  const nativePages = probe.parser_result.pages ?? Array.from({ length: probe.page_count }, (_, index) => ({ page: index + 1, text: "" }));
  const parserVersion = `pypdf-${pythonVersion.stdout.trim() || "unknown"}+tesseract-${ocrEngine.engine_version}`;
  const result = buildPension2016ParseEvidence({
    bytes,
    structural: { page_count: probe.page_count, corrupt: probe.corrupt, encrypted: probe.encrypted, has_active_content: probe.has_active_content },
    parser_name: "pypdf-layout+tesseract-local",
    parser_version: parserVersion,
    native_pages: nativePages,
    rendered_pages: renderedPages,
    ocr_engine: ocrEngine,
    ocr_run_a: ocrRunA,
    ocr_run_b: ocrRunB,
  });
  const citationRoundTrip = result.status === "parsed_needs_review" && ocrRunA
    ? result.citation_anchors.map((anchor) => ({ citation_id: anchor.citation_id, ...reconstructPensionCitation(anchor, ocrRunA) }))
    : [{ passed: false, safe_error_code: "not_applicable_unparsed", reconstructed: "" }];
  const evidence = {
    schema_version: "wave1-pension-2016-parse-evidence-v0.3.1",
    artifact: { source_id: result.source_id, artifact_sha256: result.artifact_sha256, byte_count: bytes.byteLength, relative_path: path.relative(repoRoot, artifactPath).replaceAll("\\", "/") },
    engines: {
      parser: { name: "pypdf", version: pythonVersion.stdout.trim() || "unknown", extraction_mode: "layout" },
      renderer: { name: "poppler-pdftoppm", version: `${rendererVersion.stdout}${rendererVersion.stderr}`.trim(), dpi: 300, format: "png", page_order: "ascending_pdf_page_number" },
      ocr: ocrEngine,
    },
    native_page_text_sha256: nativePages.map((page) => ({ page: page.page, sha256: sha256(page.text) })),
    rendered_pages: renderedPages,
    ocr_intermediates: ocrRunA && ocrRunB ? ocrRunA.map((page, index) => ({ page: page.page, run_a_sha256: sha256(page.text), run_b_sha256: sha256(ocrRunB[index].text) })) : [],
    result,
    citation_round_trip: citationRoundTrip,
    limitations: result.status === "parse_failed_closed" ? [result.safe_error_code, "no_legal_values_relations_effectivity_or_applicability_inferred"] : ["human_legal_review_required_before_any_use"],
  };
  await writeAtomic(path.join(pensionRoot, "pension-2016-parse-evidence.json"), stableJson(evidence));
  await writeAtomic(path.join(pensionRoot, "pension-2016-page-map.json"), stableJson({ artifact_sha256: result.artifact_sha256, page_map: result.page_map }));
  await writeAtomic(path.join(pensionRoot, "pension-2016-citation-round-trip.json"), stableJson({ artifact_sha256: result.artifact_sha256, checks: citationRoundTrip }));
  process.stdout.write(stableJson({ command: "parse-pension", status: result.status, safe_error_code: result.safe_error_code, evidence_root: path.relative(repoRoot, pensionRoot).replaceAll("\\", "/") }));
  return result.status === "parsed_needs_review" ? 0 : 2;
}

async function fetchConvalescence2025(outputRoot: string) {
  assertIgnored(outputRoot);
  const lawRoot = path.join(outputRoot, "convalescence-2025");
  const attemptPath = path.join(lawRoot, "fetch-attempt.json");
  if (existsSync(attemptPath)) throw new Error("convalescence_2025_fetch_already_attempted");
  await writeAtomic(attemptPath, stableJson({ schema_version: "wave1-single-fetch-attempt-v0.3.1", canonical_url: CONVALESCENCE_2025_OFFICIAL_URL, state: "started" }));
  try {
    const acquired = await acquireConvalescence2025Official();
    const quarantinePath = path.join(lawRoot, "quarantine", `.pending-${randomUUID()}.pdf`);
    await mkdir(path.dirname(quarantinePath), { recursive: true });
    await writeFile(quarantinePath, acquired.bytes, { flag: "wx" });
    const probe = pdfStructuralProbe(quarantinePath, pythonExecutable());
    if (probe.corrupt || probe.encrypted || probe.has_active_content || probe.page_count < 1) throw new Error("official_pdf_structural_validation_failed");
    const artifactPath = path.join(lawRoot, "artifacts", `${acquired.artifact_sha256}.pdf`);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    if (existsSync(artifactPath)) throw new Error("unexpected_existing_2025_artifact");
    await rename(quarantinePath, artifactPath);
    const observedAt = new Date().toISOString();
    const evidence = {
      schema_version: "wave1-convalescence-2025-official-acquisition-v0.3.1",
      source_id: acquired.source_id,
      instrument_id: acquired.instrument_id,
      canonical_url: acquired.canonical_url,
      final_url: acquired.final_url,
      artifact_sha256: acquired.artifact_sha256,
      byte_count: acquired.byte_count,
      content_type: acquired.content_type,
      safe_headers: acquired.safe_headers,
      redirect_chain: acquired.redirect_chain,
      page_count: probe.page_count,
      observed_at: observedAt,
      artifact_relative_path: path.relative(repoRoot, artifactPath).replaceAll("\\", "/"),
      artifact_role: "primary_promulgation",
      relation_claims: acquired.relation_claims,
      effectivity_claims: acquired.effectivity_claims,
      review_state: acquired.review_state,
      activation_state: acquired.activation_state,
      usable_for_rules: acquired.usable_for_rules,
    };
    await writeAtomic(path.join(lawRoot, "convalescence-2025-acquisition-evidence.json"), stableJson(evidence));
    await writeAtomic(attemptPath, stableJson({ schema_version: "wave1-single-fetch-attempt-v0.3.1", canonical_url: CONVALESCENCE_2025_OFFICIAL_URL, state: "completed", safe_error_code: null, artifact_sha256: acquired.artifact_sha256 }));
    process.stdout.write(stableJson({ command: "fetch-2025", status: "acquired_needs_review", artifact_sha256: acquired.artifact_sha256, byte_count: acquired.byte_count, evidence_root: path.relative(repoRoot, lawRoot).replaceAll("\\", "/") }));
    return 0;
  } catch (error) {
    const safeErrorCode = error instanceof Error ? error.message : "safe_fetch_failed";
    await writeAtomic(attemptPath, stableJson({ schema_version: "wave1-single-fetch-attempt-v0.3.1", canonical_url: CONVALESCENCE_2025_OFFICIAL_URL, state: "blocked", safe_error_code: safeErrorCode }));
    await writeAtomic(path.join(lawRoot, "OWNER-REQUEST.md"), `# Exact owner acquisition request\n\nDownload the unchanged official PDF once from:\n\n${CONVALESCENCE_2025_OFFICIAL_URL}\n\nKeep the exact final URL and original bytes. Do not use Print-to-PDF, conversion, mirrors, login, cookies, CAPTCHA bypass, or private sources. The document remains a separate inactive instrument pending human legal review.\n`);
    process.stdout.write(stableJson({ command: "fetch-2025", status: "owner_request_required", safe_error_code: safeErrorCode, canonical_url: CONVALESCENCE_2025_OFFICIAL_URL }));
    return 2;
  }
}

async function main() {
  const command = process.argv[2];
  const outputRoot = path.resolve(arg("--output-root") ?? defaultOutputRoot);
  if (command === "parse-pension") {
    const input = arg("--input");
    if (!input) throw new Error("--input_required");
    return parsePension(path.resolve(input), outputRoot);
  }
  if (command === "fetch-2025") return fetchConvalescence2025(outputRoot);
  throw new Error("expected_command_parse-pension_or_fetch-2025");
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "wave1_pension_convalescence_failed"}\n`);
  process.exitCode = 1;
});
