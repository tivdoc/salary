import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { legalReviewEventSchema, legalSourceSchema, legalSourceVersionId, type LegalChunk, type LegalReviewEvent, type LegalSource } from "../src/engine/legal-knowledge/contracts.ts";
import { retrieveLegalKnowledge } from "../src/engine/legal-knowledge/retrieval.ts";
import { legalSectors, legalTopics, type LegalSector, type LegalTopic } from "../src/engine/legal-knowledge/taxonomy.ts";
import {
  detectLegalSourceChange,
  selectLegalSourceObservation,
  type LegalSourceObservation,
} from "../src/server/engine/legal-knowledge/change-detection.ts";
import { legalSourceManifestSchema } from "../src/server/engine/legal-knowledge/manifest.ts";
import {
  chunkLegalPages,
  extractHtmlLegalText,
  LEGAL_CHUNKER_VERSION,
  LEGAL_NORMALIZER_VERSION,
  normalizedDocumentHash,
  normalizeLegalText,
  parsedLegalVersionId,
  removeRepeatedPdfMargins,
  validateParsedLegalDocument,
} from "../src/server/engine/legal-knowledge/normalization.ts";
import {
  fetchLegalSourceBytes,
  safeLegalLogEvent,
  SafeLegalFetchError,
  validateLegalContentEnvelope,
  validateLegalSourceUrl,
} from "../src/server/engine/legal-knowledge/security.ts";
import {
  diffOfficialCatalogEntries,
  loadLegalCatalogRegistry,
  parseOfficialCatalogHtml,
  type LegalCatalogEntry,
} from "../src/server/engine/legal-knowledge/catalogs.ts";
import { loadLegalCoverageMatrix } from "../src/server/engine/legal-knowledge/coverage.ts";
import { loadLegalSourceRelations } from "../src/server/engine/legal-knowledge/relations.ts";
import { resolveTemporalSourceSet, type SourceVersionEvidence } from "../src/engine/legal-knowledge/temporal-resolver.ts";

const repoRoot = process.cwd();
const manifestPath = path.resolve(repoRoot, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");
const evaluationRoot = path.resolve(repoRoot, "eval", "legal-knowledge");
const artifactRoot = path.join(evaluationRoot, "artifacts");
const normalizedRoot = path.join(evaluationRoot, "normalized");
const localManifestRoot = path.join(evaluationRoot, "manifests");
const outputRoot = path.resolve(repoRoot, "output", "legal-knowledge");
const fetchStatePath = path.join(localManifestRoot, "fetch-state.json");
const buildStatePath = path.join(localManifestRoot, "build-state.json");
const changeReportPath = path.join(outputRoot, "source-change-report.json");
const catalogRoot = path.join(evaluationRoot, "catalogs");
const auditEventRoot = path.join(evaluationRoot, "audit-events");
const catalogReportPath = path.join(outputRoot, "catalog-discovery-report.json");
const sourceDiffReportPath = path.join(outputRoot, "source-byte-diff-report.json");
const coverageReportPath = path.join(outputRoot, "temporal-coverage-report.json");
const citationReportPath = path.join(outputRoot, "citation-round-trip-report.json");
const reproducibilityReportPath = path.join(outputRoot, "clean-room-reproducibility-report.json");
const reviewPackageRoot = path.join(outputRoot, "review-package-v0.1");
const PDF_EXTRACTOR_VERSION = "pypdf-layout-v1";
const initialTopics = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const;

type FetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  effective_metadata_hash: string;
  final_url: string;
  content_type: string;
  byte_count: number;
  retrieved_at: string;
  artifact_path: string;
  safe_http_metadata: Readonly<Record<string, string>>;
  redirect_count: number;
  redirect_chain: readonly string[];
  status: "fetched" | "content_change_review_required";
  parser_version: string | null;
  normalized_text_sha256: string | null;
  normalized_path: string | null;
  chunks_path: string | null;
  chunk_count: number;
  page_count: number;
  parse_status: "not_built" | "parsed" | "parse_failed" | "unsupported";
  safe_error_code: string | null;
}>;

type FetchState = {
  schema_version: "legal-source-fetch-state-v0";
  observations: FetchObservation[];
  failures: Array<Readonly<{ source_id: string; source_version: string; failed_at: string; safe_error_code: string }>>;
};

type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  normalized_text_sha256: string | null;
  parsed_version_id: string | null;
  normalized_output_sha256: string | null;
  chunks_output_sha256: string | null;
  normalized_path: string | null;
  chunks_path: string | null;
  chunk_count: number;
  page_count: number;
  parser_version: string;
  normalizer_version: string;
  chunker_version: string;
  parse_status: "parsed" | "parse_failed" | "unsupported";
  safe_error_code: string | null;
}>;

type BuildState = { schema_version: "legal-source-build-state-v0"; records: BuildRecord[] };

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertNetworkEnabledForNetworkCommand() {
  if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED === "1") throw new Error("network_disabled_by_runtime_canary");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function stableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function safeRelative(filePath: string) {
  const relative = path.relative(repoRoot, path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path_escape");
  return relative.replaceAll("\\", "/");
}

function assertIgnored(targetPath: string) {
  const result = spawnSync("git", ["check-ignore", "-q", safeRelative(path.join(targetPath, ".git-ignore-check"))], { cwd: repoRoot, windowsHide: true });
  if (result.status !== 0) throw new Error("legal_output_not_git_ignored");
}

async function ensureLocalDirectories() {
  for (const directory of [artifactRoot, normalizedRoot, localManifestRoot, catalogRoot, auditEventRoot, outputRoot]) {
    assertIgnored(directory);
    await mkdir(directory, { recursive: true });
  }
}

async function writeImmutable(filePath: string, content: Uint8Array | string) {
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    const current = await readFile(filePath);
    if (!current.equals(bytes)) throw new Error("immutable_artifact_mismatch");
    return false;
  }
  await writeFile(filePath, bytes, { flag: "wx" });
  return true;
}

async function writeReplaceJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, stableJson(value), { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function loadManifest() {
  const parsed = legalSourceManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  return parsed;
}

function selectedObservation(state: FetchState, source: LegalSource) {
  return selectLegalSourceObservation(state.observations, source);
}

function effectiveMetadataHash(source: LegalSource) {
  return sha256(stableJson({
    source_id: source.source_id,
    source_version: source.source_version,
    source_type: source.source_type,
    title: source.title,
    publication_reference: source.publication_reference,
    published_at: source.published_at,
    effective_from: source.effective_from,
    effective_to: source.effective_to,
    effective_period: source.effective_period,
    language: source.language,
    artifact_format: source.artifact_format,
    topics: source.topics,
    sectors: source.sectors,
    authority: source.authority,
  }));
}

async function validateManifestCommand() {
  const manifest = await loadManifest();
  const issues: string[] = [];
  for (const source of manifest.sources) {
    const url = validateLegalSourceUrl(source.canonical_url);
    if (!url.passed) issues.push(`${source.source_id}:${url.code}`);
    if (source.status === "active") issues.push(`${source.source_id}:premature_active_source`);
    if (source.authority.binding_level === "secondary_explanatory" && source.authority.can_independently_support_monetary_rule) {
      issues.push(`${source.source_id}:secondary_monetary_authority_forbidden`);
    }
  }
  for (const topic of initialTopics) {
    if (!manifest.sources.some((source) => source.topics.includes(topic))) issues.push(`missing_initial_topic:${topic}`);
  }
  if (issues.length > 0) throw new Error(`manifest_validation_failed:${issues.join(",")}`);
  return {
    manifest_version: manifest.manifest_version,
    sources: manifest.sources.length,
    topics: initialTopics.length,
    active_sources: 0,
    status: "valid_pending_content_review",
    manifest_sha256: sha256(await readFile(manifestPath)),
  };
}

async function fetchCommand() {
  assertNetworkEnabledForNetworkCommand();
  await ensureLocalDirectories();
  const manifest = await loadManifest();
  const state = await readJson<FetchState>(fetchStatePath, { schema_version: "legal-source-fetch-state-v0", observations: [], failures: [] });
  state.observations = state.observations.map((entry) => ({
    ...entry,
    parser_version: entry.parser_version ?? null,
    normalized_text_sha256: entry.normalized_text_sha256 ?? null,
    normalized_path: entry.normalized_path ?? null,
    chunks_path: entry.chunks_path ?? null,
    chunk_count: entry.chunk_count ?? 0,
    page_count: entry.page_count ?? 0,
    parse_status: entry.parse_status ?? "not_built",
    safe_error_code: entry.safe_error_code ?? null,
    redirect_chain: entry.redirect_chain ?? [entry.final_url],
  }));
  const results: Array<Record<string, unknown>> = [];
  for (const source of manifest.sources) {
    const started = Date.now();
    try {
      const fetched = await fetchLegalSourceBytes(source);
      const artifactSha256 = sha256(fetched.bytes);
      const metadataHash = effectiveMetadataHash(source);
      const extension = source.artifact_format === "pdf" ? "pdf" : source.artifact_format === "html" ? "html" : "txt";
      const artifactPath = path.join(artifactRoot, source.source_id, source.source_version, `${artifactSha256}.${extension}`);
      await writeImmutable(artifactPath, fetched.bytes);
      let previous = selectedObservation(state, source);
      if (previous && !previous.effective_metadata_hash) {
        const previousIndex = state.observations.indexOf(previous);
        previous = { ...previous, effective_metadata_hash: metadataHash };
        state.observations[previousIndex] = previous;
      }
      const status = previous && (previous.artifact_sha256 !== artifactSha256 || previous.effective_metadata_hash !== metadataHash)
        ? "content_change_review_required"
        : "fetched";
      const observationIndex = state.observations.findIndex((entry) =>
        entry.source_id === source.source_id
          && entry.source_version === source.source_version
          && entry.artifact_sha256 === artifactSha256
          && entry.effective_metadata_hash === metadataHash,
      );
      let observation = observationIndex >= 0 ? state.observations[observationIndex] : null;
      if (!observation) {
        observation = {
          source_id: source.source_id,
          source_version: source.source_version,
          artifact_sha256: artifactSha256,
          effective_metadata_hash: metadataHash,
          final_url: fetched.finalUrl,
          content_type: fetched.contentType,
          byte_count: fetched.bytes.byteLength,
          retrieved_at: new Date().toISOString(),
          artifact_path: safeRelative(artifactPath),
          safe_http_metadata: fetched.safeHeaders,
          redirect_count: fetched.redirectCount,
          redirect_chain: fetched.redirectChain,
          status,
          parser_version: null,
          normalized_text_sha256: null,
          normalized_path: null,
          chunks_path: null,
          chunk_count: 0,
          page_count: 0,
          parse_status: "not_built",
          safe_error_code: null,
        };
        state.observations.push(observation);
      } else if (observation.status === "content_change_review_required" && source.content_sha256 === artifactSha256) {
        observation = { ...observation, status: "fetched" };
        state.observations[observationIndex] = observation;
      }
      state.failures = state.failures.filter((entry) => !(entry.source_id === source.source_id && entry.source_version === source.source_version));
      results.push(safeLegalLogEvent({
        source_id: source.source_id,
        source_version: source.source_version,
        domain: new URL(fetched.finalUrl).hostname,
        stage: "fetch",
        status: observation.status,
        duration_ms: Date.now() - started,
        byte_count: fetched.bytes.byteLength,
        hash_prefix: artifactSha256.slice(0, 12),
      }));
    } catch (error) {
      const safeErrorCode = error instanceof SafeLegalFetchError ? error.code : "fetch_failed";
      state.failures = state.failures.filter((entry) => !(entry.source_id === source.source_id && entry.source_version === source.source_version));
      state.failures.push({ source_id: source.source_id, source_version: source.source_version, failed_at: new Date().toISOString(), safe_error_code: safeErrorCode });
      results.push(safeLegalLogEvent({
        source_id: source.source_id,
        source_version: source.source_version,
        domain: new URL(source.canonical_url).hostname,
        stage: "fetch",
        status: "failed",
        duration_ms: Date.now() - started,
        safe_error_code: safeErrorCode,
      }));
    }
  }
  await writeReplaceJson(fetchStatePath, state);
  return {
    sources_total: manifest.sources.length,
    fetched: results.filter((entry) => entry.status !== "failed").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    content_changes: results.filter((entry) => entry.status === "content_change_review_required").length,
    results,
  };
}

function pythonCandidates() {
  const candidates: string[] = [];
  if (process.env.TIVDOC_PYTHON) candidates.push(process.env.TIVDOC_PYTHON);
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe"));
  }
  candidates.push("python");
  return [...new Set(candidates)];
}

function extractPdfPages(filePath: string) {
  const scriptPath = path.resolve(repoRoot, "scripts", "legal-pdf-extract.py");
  for (const candidate of pythonCandidates()) {
    const result = spawnSync(candidate, [scriptPath, filePath], {
      encoding: "utf8",
      env: { ...process.env, PYTHONHASHSEED: "0" },
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
    if (result.status !== 0) {
      try {
        const parsed = JSON.parse(result.stdout || "{}") as { safe_error_code?: string };
        throw new Error(parsed.safe_error_code ?? "pdf_parse_failed");
      } catch (error) {
        if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
        throw new Error("pdf_parse_failed");
      }
    }
    const parsed = JSON.parse(result.stdout) as { pages?: Array<{ page: number; text: string }>; safe_error_code?: string };
    if (!parsed.pages) throw new Error(parsed.safe_error_code ?? "pdf_parse_failed");
    return removeRepeatedPdfMargins(parsed.pages);
  }
  throw new Error("pdf_parser_unavailable");
}

function decodeHtml(bytes: Uint8Array, observation: FetchObservation) {
  const contentType = observation.safe_http_metadata["content-type"] ?? "";
  const charset = contentType.match(/charset=([^;\s]+)/iu)?.[1]?.replaceAll('"', "") ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function byteDiffSummary(previous: Uint8Array, current: Uint8Array) {
  let commonPrefix = 0;
  while (commonPrefix < previous.length && commonPrefix < current.length && previous[commonPrefix] === current[commonPrefix]) commonPrefix += 1;
  let commonSuffix = 0;
  while (commonSuffix < previous.length - commonPrefix
    && commonSuffix < current.length - commonPrefix
    && previous[previous.length - 1 - commonSuffix] === current[current.length - 1 - commonSuffix]) commonSuffix += 1;
  return {
    previous_bytes: previous.length,
    current_bytes: current.length,
    common_prefix_bytes: commonPrefix,
    common_suffix_bytes: commonSuffix,
    previous_changed_bytes: previous.length - commonPrefix - commonSuffix,
    current_changed_bytes: current.length - commonPrefix - commonSuffix,
  };
}

function normalizedLineDiff(previous: string, current: string) {
  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  const previousSet = new Set(previousLines);
  const currentSet = new Set(currentLines);
  const removed = previousLines.filter((line) => !currentSet.has(line));
  const added = currentLines.filter((line) => !previousSet.has(line));
  return {
    removed_lines: removed.slice(0, 200),
    added_lines: added.slice(0, 200),
    removed_line_count: removed.length,
    added_line_count: added.length,
    truncated: removed.length > 200 || added.length > 200,
  };
}

function attachBuildRecord(state: FetchState, observation: FetchObservation, record: BuildRecord) {
  const index = state.observations.indexOf(observation);
  if (index < 0) throw new Error("fetch_observation_missing");
  state.observations[index] = {
    ...observation,
    parser_version: record.parser_version,
    normalized_text_sha256: record.normalized_text_sha256,
    normalized_path: record.normalized_path,
    chunks_path: record.chunks_path,
    chunk_count: record.chunk_count,
    page_count: record.page_count,
    parse_status: record.parse_status,
    safe_error_code: record.safe_error_code,
  };
}

async function buildCommand() {
  await ensureLocalDirectories();
  const manifest = await loadManifest();
  const fetchState = await readJson<FetchState>(fetchStatePath, { schema_version: "legal-source-fetch-state-v0", observations: [], failures: [] });
  const buildState: BuildState = { schema_version: "legal-source-build-state-v0", records: [] };
  for (const source of manifest.sources) {
    const observation = selectedObservation(fetchState, source);
    if (!observation) {
      const record: BuildRecord = {
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: "0".repeat(64),
        normalized_text_sha256: null,
        parsed_version_id: null,
        normalized_output_sha256: null,
        chunks_output_sha256: null,
        normalized_path: null,
        chunks_path: null,
        chunk_count: 0,
        page_count: 0,
        parser_version: source.artifact_format === "pdf" ? PDF_EXTRACTOR_VERSION : LEGAL_NORMALIZER_VERSION,
        normalizer_version: LEGAL_NORMALIZER_VERSION,
        chunker_version: LEGAL_CHUNKER_VERSION,
        parse_status: "parse_failed",
        safe_error_code: "artifact_not_fetched",
      };
      buildState.records.push(record);
      continue;
    }
    try {
      const artifactPath = path.resolve(repoRoot, observation.artifact_path);
      if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`)) throw new Error("artifact_path_escape");
      const bytes = await readFile(artifactPath);
      if (sha256(bytes) !== observation.artifact_sha256) throw new Error("artifact_hash_mismatch");
      const envelope = validateLegalContentEnvelope(source, bytes, observation.content_type);
      if (!envelope.passed) throw new Error(envelope.code);
      let pages: Array<{ page: number | null; text: string }>;
      let parserVersion: string;
      if (source.artifact_format === "pdf") {
        pages = extractPdfPages(artifactPath);
        parserVersion = PDF_EXTRACTOR_VERSION;
      } else if (source.artifact_format === "html") {
        pages = [{ page: null, text: extractHtmlLegalText(decodeHtml(bytes, observation)) }];
        parserVersion = LEGAL_NORMALIZER_VERSION;
      } else if (["text", "table"].includes(source.artifact_format)) {
        pages = [{ page: null, text: normalizeLegalText(new TextDecoder("utf-8").decode(bytes)) }];
        parserVersion = LEGAL_NORMALIZER_VERSION;
      } else {
        throw new Error("unsupported_artifact_format");
      }
      const sanity = validateParsedLegalDocument(source, pages);
      if (!sanity.passed) throw new Error(sanity.code);
      const normalizedHash = normalizedDocumentHash(pages);
      const runtimeSource = legalSourceSchema.parse({
        ...source,
        content_sha256: observation.artifact_sha256,
        retrieved_at: observation.retrieved_at,
      });
      const chunks = chunkLegalPages(runtimeSource, observation.artifact_sha256, pages, {
        normalizedTextSha256: normalizedHash,
        parserVersion,
      });
      if (chunks.length === 0) throw new Error("chunks_empty");
      const normalizedDocument = stableJson({
        schema_version: "normalized-legal-source-v0",
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: normalizedHash,
        parsed_version_id: parsedLegalVersionId(source, observation.artifact_sha256, normalizedHash, parserVersion),
        parser_version: parserVersion,
        normalizer_version: LEGAL_NORMALIZER_VERSION,
        pages,
      });
      const chunkDocument = stableJson({
        schema_version: "legal-chunks-v0",
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        chunker_version: LEGAL_CHUNKER_VERSION,
        chunks,
      });
      const normalizedPath = path.join(normalizedRoot, source.source_id, source.source_version, `${observation.artifact_sha256}.${sha256(normalizedDocument)}.normalized.json`);
      const chunksPath = path.join(normalizedRoot, source.source_id, source.source_version, `${observation.artifact_sha256}.${sha256(chunkDocument)}.chunks.json`);
      await writeImmutable(normalizedPath, normalizedDocument);
      await writeImmutable(chunksPath, chunkDocument);
      const record: BuildRecord = {
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: normalizedHash,
        parsed_version_id: parsedLegalVersionId(source, observation.artifact_sha256, normalizedHash, parserVersion),
        normalized_output_sha256: sha256(normalizedDocument),
        chunks_output_sha256: sha256(chunkDocument),
        normalized_path: safeRelative(normalizedPath),
        chunks_path: safeRelative(chunksPath),
        chunk_count: chunks.length,
        page_count: pages.length,
        parser_version: parserVersion,
        normalizer_version: LEGAL_NORMALIZER_VERSION,
        chunker_version: LEGAL_CHUNKER_VERSION,
        parse_status: "parsed",
        safe_error_code: null,
      };
      buildState.records.push(record);
      attachBuildRecord(fetchState, observation, record);
    } catch (error) {
      const safeErrorCode = error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "parse_failed";
      const record: BuildRecord = {
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: null,
        parsed_version_id: null,
        normalized_output_sha256: null,
        chunks_output_sha256: null,
        normalized_path: null,
        chunks_path: null,
        chunk_count: 0,
        page_count: 0,
        parser_version: source.artifact_format === "pdf" ? PDF_EXTRACTOR_VERSION : LEGAL_NORMALIZER_VERSION,
        normalizer_version: LEGAL_NORMALIZER_VERSION,
        chunker_version: LEGAL_CHUNKER_VERSION,
        parse_status: "parse_failed",
        safe_error_code: safeErrorCode,
      };
      buildState.records.push(record);
      attachBuildRecord(fetchState, observation, record);
    }
  }
  await writeReplaceJson(fetchStatePath, fetchState);
  await writeReplaceJson(buildStatePath, buildState);
  return {
    sources_total: buildState.records.length,
    parsed: buildState.records.filter((record) => record.parse_status === "parsed").length,
    failed: buildState.records.filter((record) => record.parse_status !== "parsed").length,
    chunks: buildState.records.reduce((sum, record) => sum + record.chunk_count, 0),
    normalized_corpus_sha256: sha256(stableJson(buildState.records.map((record) => ({
      source_id: record.source_id,
      source_version: record.source_version,
      artifact_sha256: record.artifact_sha256,
      normalized_text_sha256: record.normalized_text_sha256,
      parsed_version_id: record.parsed_version_id,
      normalized_output_sha256: record.normalized_output_sha256,
      chunks_output_sha256: record.chunks_output_sha256,
      chunk_count: record.chunk_count,
      parser_version: record.parser_version,
      normalizer_version: record.normalizer_version,
      chunker_version: record.chunker_version,
      parse_status: record.parse_status,
      safe_error_code: record.safe_error_code,
    })))),
    failures: buildState.records.filter((record) => record.parse_status !== "parsed").map((record) => ({ source_id: record.source_id, safe_error_code: record.safe_error_code })),
  };
}

async function loadRuntimeCorpus() {
  const manifest = await loadManifest();
  const fetchState = await readJson<FetchState>(fetchStatePath, { schema_version: "legal-source-fetch-state-v0", observations: [], failures: [] });
  const buildState = await readJson<BuildState>(buildStatePath, { schema_version: "legal-source-build-state-v0", records: [] });
  const sources: LegalSource[] = [];
  const chunks: LegalChunk[] = [];
  for (const source of manifest.sources) {
    const observation = selectedObservation(fetchState, source);
    if (observation) sources.push(legalSourceSchema.parse({ ...source, content_sha256: observation.artifact_sha256, retrieved_at: observation.retrieved_at }));
    else sources.push(source);
    if (observation?.chunks_path && observation.parse_status === "parsed") {
      const chunkDocument = JSON.parse(await readFile(path.resolve(repoRoot, observation.chunks_path), "utf8")) as { chunks: LegalChunk[] };
      chunks.push(...chunkDocument.chunks);
    }
  }
  return { manifest, fetchState, buildState, sources, chunks };
}

async function statusCommand() {
  const { manifest, fetchState, buildState } = await loadRuntimeCorpus();
  const topics = initialTopics.map((topic) => {
    const topicSources = manifest.sources.filter((source) => source.topics.includes(topic));
    const parsed = topicSources.filter((source) => selectedObservation(fetchState, source)?.parse_status === "parsed");
    return {
      topic,
      discovered_sources: topicSources.length,
      fetched_sources: topicSources.filter((source) => selectedObservation(fetchState, source)).length,
      parsed_sources: parsed.length,
      status: parsed.length === 0 ? "incomplete_unbuilt" : "content_review_required",
    };
  });
  return {
    manifest_sources: manifest.sources.length,
    fetched_source_versions: manifest.sources.filter((source) => selectedObservation(fetchState, source)).length,
    parsed_source_versions: manifest.sources.filter((source) => selectedObservation(fetchState, source)?.parse_status === "parsed").length,
    chunks: manifest.sources.reduce((sum, source) => sum + (selectedObservation(fetchState, source)?.chunk_count ?? 0), 0),
    source_records: manifest.sources.length,
    source_versions: manifest.sources.length,
    active_sources: manifest.sources.filter((source) => source.status === "active").length,
    numeric_candidates: 0,
    active_parameters: 0,
    manifest_sha256: sha256(await readFile(manifestPath)),
    normalized_corpus_sha256: sha256(stableJson(buildState.records.map((record) => ({
      source_id: record.source_id,
      source_version: record.source_version,
      artifact_sha256: record.artifact_sha256,
      normalized_text_sha256: record.normalized_text_sha256,
      parsed_version_id: record.parsed_version_id,
      normalized_output_sha256: record.normalized_output_sha256,
      chunks_output_sha256: record.chunks_output_sha256,
      chunk_count: record.chunk_count,
      parser_version: record.parser_version,
      normalizer_version: record.normalizer_version,
      chunker_version: record.chunker_version,
      parse_status: record.parse_status,
      safe_error_code: record.safe_error_code,
    })))),
    corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    topics,
  };
}

function parseOptions(args: string[]) {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) continue;
    const key = args[index].slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

async function searchCommand(args: string[]) {
  const options = parseOptions(args);
  const topic = String(options.topic ?? "") as LegalTopic;
  const sector = String(options.sector ?? "general") as LegalSector;
  const targetDate = String(options.date ?? "");
  const limit = Number(options.limit ?? 5);
  if (!legalTopics.includes(topic)) throw new Error("invalid_or_missing_topic");
  if (!legalSectors.includes(sector)) throw new Error("invalid_sector");
  const parsedDate = new Date(`${targetDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(targetDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== targetDate) {
    throw new Error("invalid_or_missing_date");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_limit");
  const { sources, chunks, buildState } = await loadRuntimeCorpus();
  const relations = await loadLegalSourceRelations();
  const evidence = runtimeEvidenceMap(sources, chunks, buildState);
  const temporalResolution = resolveTemporalSourceSet({
    sources,
    relations: relations.relations,
    evidence,
    topic,
    targetDate,
    sector,
    activeOnly: options["active-only"] === true,
  });
  const result = retrieveLegalKnowledge(sources, chunks, {
    topic,
    targetDate,
    sector,
    role: typeof options.role === "string" ? options.role : null,
    activeOnly: options["active-only"] === true,
    keywords: typeof options.keywords === "string" ? options.keywords.split(",").map((entry) => entry.trim()).filter(Boolean) : [],
    limit,
  });
  return {
    query: { topic, target_date: targetDate, sector, active_only: options["active-only"] === true },
    temporal_resolution: temporalResolution,
    results: result.results.map((entry) => ({
      source_id: entry.source.source_id,
      source_version: entry.source.source_version,
      chunk_id: entry.chunk.chunk_id,
      score: entry.score,
      reasons: entry.reasons,
      effective_date_match: entry.effectiveDateMatch,
      requires_review: entry.requiresReview,
    })),
    conflicts: result.conflicts,
    incomplete: result.incomplete,
  };
}

async function changesCommand() {
  assertNetworkEnabledForNetworkCommand();
  await ensureLocalDirectories();
  const { manifest, fetchState } = await loadRuntimeCorpus();
  const records: Array<Record<string, unknown>> = [];
  for (const source of manifest.sources) {
    const previousFetch = selectedObservation(fetchState, source);
    const previous: LegalSourceObservation | null = previousFetch ? {
      artifact_sha256: previousFetch.artifact_sha256,
      normalized_text_sha256: previousFetch.normalized_text_sha256 ?? null,
      final_url: previousFetch.final_url,
      content_type: previousFetch.content_type,
      effective_metadata_hash: previousFetch.effective_metadata_hash ?? effectiveMetadataHash(source),
      source_status: source.status,
    } : null;
    try {
      const fetched = await fetchLegalSourceBytes(source);
      const currentHash = sha256(fetched.bytes);
      const current: LegalSourceObservation = {
        artifact_sha256: currentHash,
        normalized_text_sha256: previous?.artifact_sha256 === currentHash ? previous.normalized_text_sha256 : null,
        final_url: fetched.finalUrl,
        content_type: fetched.contentType,
        effective_metadata_hash: effectiveMetadataHash(source),
        source_status: source.status,
      };
      const change = detectLegalSourceChange(previous, current);
      records.push({ source_id: source.source_id, source_version: source.source_version, status: change.status, review_required: change.reviewRequired, change_codes: change.changes });
    } catch (error) {
      const safeErrorCode = error instanceof SafeLegalFetchError ? error.code : "fetch_failed";
      const change = detectLegalSourceChange(previous, null);
      records.push({ source_id: source.source_id, source_version: source.source_version, status: change.status, review_required: true, change_codes: change.changes, safe_error_code: safeErrorCode });
    }
  }
  const report = { schema_version: "legal-source-change-report-v0", checked_at: new Date().toISOString(), records };
  await writeReplaceJson(changeReportPath, report);
  return {
    sources_checked: records.length,
    unchanged: records.filter((record) => record.status === "source_unchanged").length,
    review_required: records.filter((record) => record.review_required === true).length,
    unavailable: records.filter((record) => record.status === "url_unavailable").length,
    report_path: safeRelative(changeReportPath),
  };
}

type CatalogReportRecord = Readonly<{
  catalog_id: string;
  canonical_url: string;
  final_url: string | null;
  raw_sha256: string | null;
  byte_count: number | null;
  observed_at: string;
  status: "snapshot_stored" | "unavailable";
  safe_error_code: string | null;
  entries: readonly LegalCatalogEntry[];
  diff: ReturnType<typeof diffOfficialCatalogEntries>;
  required_detection: readonly Readonly<{ candidate_id: string; status: "detected" | "not_detected" | "unresolved_catalog_unavailable"; matching_entry_ids: readonly string[] }>[];
  review_events: readonly LegalReviewEvent[];
}>;

async function catalogsCommand() {
  assertNetworkEnabledForNetworkCommand();
  await ensureLocalDirectories();
  const registry = await loadLegalCatalogRegistry();
  const previous = await readJson<{ records: CatalogReportRecord[] }>(catalogReportPath, { records: [] });
  const records: CatalogReportRecord[] = [];
  for (const catalog of registry.catalogs) {
    const observedAt = new Date().toISOString();
    const previousRecord = previous.records.find((record) => record.catalog_id === catalog.catalog_id && record.status === "snapshot_stored");
    try {
      const fetched = await fetchLegalSourceBytes({ canonical_url: catalog.canonical_url, artifact_format: "html" });
      const rawHash = sha256(fetched.bytes);
      const artifactPath = path.join(catalogRoot, catalog.catalog_id, `${rawHash}.html`);
      await writeImmutable(artifactPath, fetched.bytes);
      const html = new TextDecoder("utf-8").decode(fetched.bytes);
      const entries = parseOfficialCatalogHtml(html, fetched.finalUrl);
      const diff = diffOfficialCatalogEntries(previousRecord?.entries ?? [], entries);
      const catalogChanges = [
        ...diff.additions.map((entry) => ({ decision: "catalog_entry_added", reason: entry.entry_id })),
        ...diff.removals.map((entry) => ({ decision: "catalog_entry_removed", reason: entry.entry_id })),
        ...diff.metadata_changes.map((entry) => ({ decision: "catalog_entry_metadata_changed", reason: entry.current.entry_id })),
      ];
      const reviewEvents = catalogChanges.map((change) => legalReviewEventSchema.parse({
        event_id: `catalog:${sha256(`${catalog.catalog_id}\n${rawHash}\n${change.decision}\n${change.reason}`).slice(0, 32)}`,
        event_type: "candidate_created",
        source_id: catalog.catalog_id,
        source_version_id: `${catalog.catalog_id}@snapshot-${rawHash.slice(0, 16)}`,
        artifact_sha256: rawHash,
        normalized_text_sha256: null,
        effective_period: { effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "requires_historical_version_review" },
        actor_id: "tivdoc-legal-catalog-tooling",
        actor_type: "system",
        occurred_at: observedAt,
        decision: change.decision,
        reason: `Official catalog change requires review: ${change.reason}`,
      }));
      const requiredDetection = catalog.required_detection.map((required) => {
        const matches = entries.filter((entry) => required.title_tokens.every((token) => entry.title.includes(token)));
        return { candidate_id: required.candidate_id, status: matches.length > 0 ? "detected" as const : "not_detected" as const, matching_entry_ids: matches.map((entry) => entry.entry_id) };
      });
      records.push({
        catalog_id: catalog.catalog_id,
        canonical_url: catalog.canonical_url,
        final_url: fetched.finalUrl,
        raw_sha256: rawHash,
        byte_count: fetched.bytes.byteLength,
        observed_at: observedAt,
        status: "snapshot_stored",
        safe_error_code: null,
        entries,
        diff,
        required_detection: requiredDetection,
        review_events: reviewEvents,
      });
    } catch (error) {
      records.push({
        catalog_id: catalog.catalog_id,
        canonical_url: catalog.canonical_url,
        final_url: null,
        raw_sha256: null,
        byte_count: null,
        observed_at: observedAt,
        status: "unavailable",
        safe_error_code: error instanceof SafeLegalFetchError ? error.code : "catalog_fetch_failed",
        entries: [],
        diff: diffOfficialCatalogEntries(previousRecord?.entries ?? [], previousRecord?.entries ?? []),
        required_detection: catalog.required_detection.map((required) => ({
          candidate_id: required.candidate_id,
          status: "unresolved_catalog_unavailable",
          matching_entry_ids: [],
        })),
        review_events: [legalReviewEventSchema.parse({
          event_id: `catalog:${sha256(`${catalog.catalog_id}\n${observedAt}\nunavailable`).slice(0, 32)}`,
          event_type: "unavailable",
          source_id: catalog.catalog_id,
          source_version_id: `${catalog.catalog_id}@unavailable-${observedAt.slice(0, 10)}`,
          artifact_sha256: null,
          normalized_text_sha256: null,
          effective_period: { effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "requires_historical_version_review" },
          actor_id: "tivdoc-legal-catalog-tooling",
          actor_type: "system",
          occurred_at: observedAt,
          decision: "catalog_unavailable",
          reason: "Official catalog snapshot could not be retrieved; no source was promoted",
        })],
      });
    }
  }
  const report = {
    schema_version: "official-catalog-discovery-report-v0.1",
    status: records.every((record) => record.status === "snapshot_stored" && record.required_detection.every((item) => item.status === "detected"))
      ? "complete_pending_review"
      : "incomplete",
    automatic_promotion: false,
    records,
  };
  for (const event of records.flatMap((record) => record.review_events)) {
    const eventDocument = stableJson(event);
    await writeImmutable(path.join(auditEventRoot, `${sha256(eventDocument)}.json`), eventDocument);
  }
  await writeReplaceJson(catalogReportPath, report);
  return {
    catalogs: records.length,
    snapshots_stored: records.filter((record) => record.status === "snapshot_stored").length,
    unavailable: records.filter((record) => record.status === "unavailable").length,
    required_detections: records.flatMap((record) => record.required_detection),
    automatic_promotions: 0,
    report_path: safeRelative(catalogReportPath),
  };
}

async function sourceDiffsCommand() {
  await ensureLocalDirectories();
  const { manifest, fetchState } = await loadRuntimeCorpus();
  const targetIds = new Set(["IL_MIN_WAGE_OFFICIAL_RATES", "IL_HOURS_WORK_REST_LAW"]);
  const records: Array<Record<string, unknown>> = [];
  const reviewEvents: LegalReviewEvent[] = [];
  for (const source of manifest.sources.filter((entry) => targetIds.has(entry.source_id))) {
    const baseline = selectedObservation(fetchState, source);
    if (!baseline) {
      records.push({ source_id: source.source_id, status: "baseline_missing", classification: "indeterminate" });
      continue;
    }
    const candidatesByHash = new Map(
      fetchState.observations
        .filter((entry) => entry.source_id === source.source_id
          && entry.source_version === source.source_version
          && entry.status === "content_change_review_required"
          && entry.artifact_sha256 !== baseline.artifact_sha256)
        .map((entry) => [entry.artifact_sha256, entry]),
    );
    const baselineBytes = await readFile(path.resolve(repoRoot, baseline.artifact_path));
    const baselineNormalizedDocument = baseline.normalized_path
      ? JSON.parse(await readFile(path.resolve(repoRoot, baseline.normalized_path), "utf8")) as { pages: Array<{ text: string }> }
      : null;
    const baselineNormalizedText = baselineNormalizedDocument?.pages.map((page) => page.text).join("\n\n") ?? "";
    const candidates: Array<Record<string, unknown>> = [];
    for (const candidate of [...candidatesByHash.values()].sort((left, right) => left.retrieved_at.localeCompare(right.retrieved_at))) {
      const candidateBytes = await readFile(path.resolve(repoRoot, candidate.artifact_path));
      let normalizedText = "";
      let normalizedHash: string | null = null;
      let contentStatus: "valid_candidate_content" | "invalid_content_observation" = "valid_candidate_content";
      let safeErrorCode: string | null = null;
      const envelope = validateLegalContentEnvelope(source, candidateBytes, candidate.content_type);
      if (!envelope.passed) {
        contentStatus = "invalid_content_observation";
        safeErrorCode = envelope.code;
      } else if (source.artifact_format === "html") {
        normalizedText = extractHtmlLegalText(decodeHtml(candidateBytes, candidate));
        const sanity = validateParsedLegalDocument(source, [{ text: normalizedText }]);
        if (!sanity.passed) {
          contentStatus = "invalid_content_observation";
          safeErrorCode = sanity.code;
        } else normalizedHash = normalizedDocumentHash([{ text: normalizedText }]);
      }
      const classification = contentStatus === "invalid_content_observation"
        ? "indeterminate"
        : normalizedHash && normalizedHash === baseline.normalized_text_sha256
          ? "presentation_or_transport_only"
          : "indeterminate";
      const candidateVersionId = `${source.source_id}@${source.source_version}#${candidate.artifact_sha256.slice(0, 16)}`;
      reviewEvents.push(legalReviewEventSchema.parse({
        event_id: `candidate:${sha256(`${candidateVersionId}\n${candidate.artifact_sha256}`).slice(0, 32)}`,
        event_type: "candidate_created",
        source_id: source.source_id,
        source_version_id: candidateVersionId,
        artifact_sha256: candidate.artifact_sha256,
        normalized_text_sha256: normalizedHash,
        effective_period: source.effective_period,
        actor_id: "tivdoc-legal-change-tooling",
        actor_type: "system",
        occurred_at: candidate.retrieved_at,
        decision: "bytes_change_candidate_isolated",
        reason: `${classification}:${safeErrorCode ?? "content_valid"}`,
      }));
      candidates.push({
        candidate_version_id: candidateVersionId,
        observation_status: contentStatus,
        raw_sha256: candidate.artifact_sha256,
        normalized_sha256: normalizedHash,
        byte_count: candidate.byte_count,
        final_url: candidate.final_url,
        retrieved_at: candidate.retrieved_at,
        safe_error_code: safeErrorCode,
        raw_diff: byteDiffSummary(baselineBytes, candidateBytes),
        normalized_diff: normalizedHash && baseline.normalized_text_sha256
          ? normalizedLineDiff(baselineNormalizedText, normalizedText)
          : { status: "unavailable", reason: safeErrorCode ?? "candidate_normalized_text_unavailable" },
        technical_classification: classification,
        promoted: false,
      });
    }
    records.push({
      source_id: source.source_id,
      source_version: source.source_version,
      selected_baseline_unchanged: true,
      baseline: {
        raw_sha256: baseline.artifact_sha256,
        normalized_sha256: baseline.normalized_text_sha256,
        byte_count: baseline.byte_count,
        final_url: baseline.final_url,
        retrieved_at: baseline.retrieved_at,
      },
      candidates,
      status: candidates.length > 0 ? "candidate_versions_isolated_pending_review" : "no_candidate_observation",
    });
  }
  const report = {
    schema_version: "legal-source-byte-diff-report-v0.1",
    generated_offline: true,
    baselines_modified: false,
    automatic_promotions: 0,
    review_events: reviewEvents,
    records,
  };
  for (const event of reviewEvents) {
    const eventDocument = stableJson(event);
    await writeImmutable(path.join(auditEventRoot, `${sha256(eventDocument)}.json`), eventDocument);
  }
  await writeReplaceJson(sourceDiffReportPath, report);
  return {
    sources: records.length,
    candidate_versions: records.reduce((sum, record) => sum + (Array.isArray(record.candidates) ? record.candidates.length : 0), 0),
    baselines_modified: false,
    automatic_promotions: 0,
    report_path: safeRelative(sourceDiffReportPath),
  };
}

function runtimeEvidenceMap(sources: readonly LegalSource[], chunks: readonly LegalChunk[], buildState: BuildState) {
  const result: Record<string, SourceVersionEvidence> = {};
  const effectiveEvidence: Readonly<Record<string, string>> = {
    "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1": "official PDF page 1: commencement is the first day of the month after publication; gazette publication 2018-03-19",
  };
  for (const source of sources) {
    const versionId = legalSourceVersionId(source);
    const build = buildState.records.find((record) => record.source_id === source.source_id && record.source_version === source.source_version);
    const chunk = chunks.find((entry) => entry.source_id === source.source_id && entry.source_version === source.source_version);
    result[versionId] = {
      artifact_sha256: build?.artifact_sha256 && build.artifact_sha256 !== "0".repeat(64) ? build.artifact_sha256 : source.content_sha256,
      parsed_version_id: build?.parsed_version_id ?? null,
      normalized_text_sha256: build?.normalized_text_sha256 ?? null,
      parser_version: build?.parse_status === "parsed" ? build.parser_version : null,
      citation: chunk ? {
        chunk_id: chunk.chunk_id,
        locator: `${chunk.page_from === null ? "html" : `page:${chunk.page_from}`} chars:${chunk.character_from}-${chunk.character_to}`,
        effective_date_evidence_locator: effectiveEvidence[versionId] ?? "UNRESOLVED: requires owner/legal confirmation against official text",
      } : null,
    };
  }
  return result;
}

async function coverageCommand() {
  await ensureLocalDirectories();
  const matrix = await loadLegalCoverageMatrix();
  const relationManifest = await loadLegalSourceRelations();
  const { sources, chunks, buildState } = await loadRuntimeCorpus();
  const evidence = runtimeEvidenceMap(sources, chunks, buildState);
  const reports = initialTopics.flatMap((topic) => [
    { label: "historical", targetDate: matrix.coverage_window.from },
    { label: "current", targetDate: matrix.coverage_window.to },
  ].map(({ label, targetDate }) => ({
    label,
    review: resolveTemporalSourceSet({ sources, relations: relationManifest.relations, evidence, topic, targetDate, sector: "general", activeOnly: false }),
    active_only: resolveTemporalSourceSet({ sources, relations: relationManifest.relations, evidence, topic, targetDate, sector: "general", activeOnly: true }),
  })));
  const report = {
    schema_version: "legal-temporal-coverage-report-v0.1",
    generated_offline: true,
    coverage_window: matrix.coverage_window,
    corpus_status: matrix.corpus_status,
    matrix: matrix.rows,
    queries: reports,
    nearest_version_fallback: false,
    needs_review_active_fallback: false,
  };
  await writeReplaceJson(coverageReportPath, report);
  return {
    topics: initialTopics.length,
    matrix_rows: matrix.rows.length,
    queries: reports.length,
    resolved_active: reports.filter((entry) => entry.active_only.status === "RESOLVED_ACTIVE").length,
    active_needs_review_fallbacks: reports.filter((entry) => entry.active_only.source_set.some((source) => source.review_status !== "active")).length,
    corpus_status: matrix.corpus_status,
    report_path: safeRelative(coverageReportPath),
  };
}

async function citationAuditCommand() {
  await ensureLocalDirectories();
  const { manifest, fetchState, buildState } = await loadRuntimeCorpus();
  const records: Array<Record<string, unknown>> = [];
  for (const build of buildState.records) {
    const source = manifest.sources.find((entry) => entry.source_id === build.source_id && entry.source_version === build.source_version);
    const observation = source ? selectedObservation(fetchState, source) : null;
    if (!source || !observation || build.parse_status !== "parsed" || !build.normalized_path || !build.chunks_path || !build.normalized_text_sha256) {
      records.push({
        source_id: build.source_id,
        source_version_id: `${build.source_id}@${build.source_version}`,
        status: "not_auditable",
        reason: build.safe_error_code ?? "parsed_lineage_missing",
        chunks_checked: 0,
        failures: 1,
      });
      continue;
    }
    const rawBytes = await readFile(path.resolve(repoRoot, observation.artifact_path));
    const normalized = JSON.parse(await readFile(path.resolve(repoRoot, build.normalized_path), "utf8")) as {
      pages: Array<{ page: number | null; text: string }>;
      normalized_text_sha256: string;
      parser_version: string;
    };
    const chunkDocument = JSON.parse(await readFile(path.resolve(repoRoot, build.chunks_path), "utf8")) as { chunks: LegalChunk[] };
    const fullText = normalized.pages.map((page) => page.text).join("\n");
    const failures: Array<Record<string, unknown>> = [];
    if (sha256(rawBytes) !== build.artifact_sha256) failures.push({ code: "raw_hash_mismatch" });
    if (normalizedDocumentHash(normalized.pages) !== build.normalized_text_sha256) failures.push({ code: "normalized_hash_mismatch" });
    const locatorKeys = new Set<string>();
    for (const chunk of chunkDocument.chunks) {
      const locatorKey = `${chunk.source_version_id}:${chunk.page_from ?? "html"}:${chunk.character_from}:${chunk.character_to}`;
      if (locatorKeys.has(locatorKey)) failures.push({ chunk_id: chunk.chunk_id, code: "locator_not_unique" });
      locatorKeys.add(locatorKey);
      const reconstructed = fullText.slice(chunk.character_from, chunk.character_to);
      if (reconstructed !== chunk.text) failures.push({ chunk_id: chunk.chunk_id, code: "round_trip_text_mismatch" });
      if (chunk.artifact_sha256 !== build.artifact_sha256
        || chunk.parsed_version_id !== build.parsed_version_id
        || chunk.normalized_text_sha256 !== build.normalized_text_sha256
        || chunk.parser_version !== build.parser_version) {
        failures.push({ chunk_id: chunk.chunk_id, code: "chunk_lineage_mismatch" });
      }
      if (source.artifact_format === "pdf" ? chunk.page_from === null : chunk.page_from !== null) {
        failures.push({ chunk_id: chunk.chunk_id, code: "format_locator_mismatch" });
      }
    }
    records.push({
      source_id: source.source_id,
      source_version_id: legalSourceVersionId(source),
      parsed_version_id: build.parsed_version_id,
      raw_artifact_sha256: build.artifact_sha256,
      normalized_text_sha256: build.normalized_text_sha256,
      parser_version: build.parser_version,
      canonical_url: source.canonical_url,
      review_status: source.status,
      status: failures.length === 0 ? "round_trip_passed" : "round_trip_failed",
      chunks_checked: chunkDocument.chunks.length,
      failures,
      samples: chunkDocument.chunks.slice(0, 2).map((chunk) => ({
        chunk_id: chunk.chunk_id,
        locator: { format: source.artifact_format, page: chunk.page_from, section: chunk.section_identifier, character_from: chunk.character_from, character_to: chunk.character_to },
        effective_date_evidence_locator: "UNRESOLVED: owner/legal review required",
      })),
    });
  }
  const report = {
    schema_version: "legal-citation-round-trip-report-v0.1",
    generated_offline: true,
    fuzzy_search_used: false,
    records,
    passed: records.every((record) => record.status === "round_trip_passed"),
  };
  await writeReplaceJson(citationReportPath, report);
  return {
    source_versions: records.length,
    round_trip_passed: records.filter((record) => record.status === "round_trip_passed").length,
    chunks_checked: records.reduce((sum, record) => sum + Number(record.chunks_checked ?? 0), 0),
    failures: records.reduce((sum, record) => sum + (Array.isArray(record.failures) ? record.failures.length : Number(record.failures ?? 0)), 0),
    report_path: safeRelative(citationReportPath),
  };
}

async function createCleanRoomSnapshot(reverseOrder = false) {
  const manifest = await loadManifest();
  const fetchState = await readJson<FetchState>(fetchStatePath, { schema_version: "legal-source-fetch-state-v0", observations: [], failures: [] });
  const ordered = reverseOrder ? [...manifest.sources].reverse() : [...manifest.sources];
  const records: Array<Record<string, unknown>> = [];
  for (const source of ordered) {
    const observation = selectedObservation(fetchState, source);
    if (!observation) {
      records.push({ source_version_id: legalSourceVersionId(source), parse_status: "parse_failed", safe_error_code: "artifact_not_fetched" });
      continue;
    }
    try {
      const artifactPath = path.resolve(repoRoot, observation.artifact_path);
      if (!artifactPath.startsWith(`${artifactRoot}${path.sep}`)) throw new Error("artifact_path_escape");
      const bytes = await readFile(artifactPath);
      if (sha256(bytes) !== observation.artifact_sha256) throw new Error("artifact_hash_mismatch");
      const envelope = validateLegalContentEnvelope(source, bytes, observation.content_type);
      if (!envelope.passed) throw new Error(envelope.code);
      let pages: Array<{ page: number | null; text: string }>;
      let parserVersion: string;
      if (source.artifact_format === "pdf") {
        pages = extractPdfPages(artifactPath);
        parserVersion = PDF_EXTRACTOR_VERSION;
      } else if (source.artifact_format === "html") {
        pages = [{ page: null, text: extractHtmlLegalText(decodeHtml(bytes, observation)) }];
        parserVersion = LEGAL_NORMALIZER_VERSION;
      } else {
        pages = [{ page: null, text: normalizeLegalText(new TextDecoder("utf-8").decode(bytes)) }];
        parserVersion = LEGAL_NORMALIZER_VERSION;
      }
      const sanity = validateParsedLegalDocument(source, pages);
      if (!sanity.passed) throw new Error(sanity.code);
      const normalizedHash = normalizedDocumentHash(pages);
      const runtimeSource = legalSourceSchema.parse({ ...source, content_sha256: observation.artifact_sha256, retrieved_at: observation.retrieved_at });
      const chunks = chunkLegalPages(runtimeSource, observation.artifact_sha256, pages, { normalizedTextSha256: normalizedHash, parserVersion });
      const normalizedBytes = stableJson({
        schema_version: "normalized-legal-source-v0",
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: normalizedHash,
        parsed_version_id: parsedLegalVersionId(source, observation.artifact_sha256, normalizedHash, parserVersion),
        parser_version: parserVersion,
        normalizer_version: LEGAL_NORMALIZER_VERSION,
        pages,
      });
      const chunkBytes = stableJson({
        schema_version: "legal-chunks-v0",
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        chunker_version: LEGAL_CHUNKER_VERSION,
        chunks,
      });
      records.push({
        source_version_id: legalSourceVersionId(source),
        parsed_version_id: parsedLegalVersionId(source, observation.artifact_sha256, normalizedHash, parserVersion),
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: normalizedHash,
        normalized_output_sha256: sha256(normalizedBytes),
        chunks_output_sha256: sha256(chunkBytes),
        chunk_ids: chunks.map((chunk) => chunk.chunk_id),
        parse_status: "parsed",
      });
    } catch (error) {
      records.push({
        source_version_id: legalSourceVersionId(source),
        artifact_sha256: observation.artifact_sha256,
        parse_status: "parse_failed",
        safe_error_code: error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "parse_failed",
      });
    }
  }
  records.sort((left, right) => String(left.source_version_id).localeCompare(String(right.source_version_id)));
  const document = stableJson({
    schema_version: "legal-clean-room-corpus-v0.1",
    hash_input_policy: {
      included: ["source_version_id", "parsed_version_id", "artifact_sha256", "normalized_text_sha256", "normalized_output_sha256", "chunks_output_sha256", "chunk_ids", "parse_status", "safe_error_code"],
      excluded: ["retrieved_at", "observed_at", "ingested_at", "reviewed_at", "run_id", "filesystem_path", "timezone"],
    },
    records,
  });
  return { corpus_sha256: sha256(document), document, records };
}

async function reproducibilityProbe(args: string[]) {
  const options = parseOptions(args);
  const snapshot = await createCleanRoomSnapshot(options.order === "reverse");
  return { corpus_sha256: snapshot.corpus_sha256, document_sha256: sha256(snapshot.document), records: snapshot.records.length };
}

async function reproducibilityCommand() {
  await ensureLocalDirectories();
  const reproducibilityRoot = path.join(outputRoot, "reproducibility");
  const runAPath = path.join(reproducibilityRoot, "run-a", "corpus.json");
  const runBPath = path.join(reproducibilityRoot, "run-b", "corpus.json");
  for (const runPath of [path.dirname(runAPath), path.dirname(runBPath)]) {
    const relative = path.relative(outputRoot, runPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("reproducibility_path_escape");
    await rm(runPath, { recursive: true, force: true });
  }
  const runA = await createCleanRoomSnapshot(false);
  const runB = await createCleanRoomSnapshot(true);
  await mkdir(path.dirname(runAPath), { recursive: true });
  await mkdir(path.dirname(runBPath), { recursive: true });
  await writeFile(runAPath, runA.document, { flag: "wx" });
  await writeFile(runBPath, runB.document, { flag: "wx" });

  const probe = (timezone: string, order: "normal" | "reverse") => spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    path.resolve(repoRoot, "scripts", "legal-sources.mts"),
    "reproducibility-probe",
    "--order",
    order,
  ], {
    cwd: repoRoot,
    env: { ...process.env, TZ: timezone },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const utc = probe("UTC", "normal");
  const jerusalem = probe("Asia/Jerusalem", "reverse");
  if (utc.status !== 0 || jerusalem.status !== 0) throw new Error("reproducibility_probe_failed");
  const utcResult = JSON.parse(utc.stdout) as { corpus_sha256: string };
  const jerusalemResult = JSON.parse(jerusalem.stdout) as { corpus_sha256: string };
  const byteForByte = Buffer.from(runA.document).equals(Buffer.from(runB.document));
  const report = {
    schema_version: "legal-clean-room-reproducibility-report-v0.1",
    generated_offline: true,
    run_a: { path: safeRelative(runAPath), corpus_sha256: runA.corpus_sha256 },
    run_b: { path: safeRelative(runBPath), corpus_sha256: runB.corpus_sha256 },
    byte_for_byte_equal: byteForByte,
    source_order_invariant: runA.corpus_sha256 === runB.corpus_sha256,
    timezone_invariant: utcResult.corpus_sha256 === jerusalemResult.corpus_sha256,
    working_path_excluded_from_hash: true,
    volatile_metadata_excluded_from_hash: true,
    stale_output_removed_before_build: true,
    corpus_sha256: runA.corpus_sha256,
    passed: byteForByte && runA.corpus_sha256 === runB.corpus_sha256 && utcResult.corpus_sha256 === jerusalemResult.corpus_sha256,
  };
  await writeReplaceJson(reproducibilityReportPath, report);
  return { ...report, report_path: safeRelative(reproducibilityReportPath) };
}

async function scopeAudit() {
  const targets = [
    path.join("src", "engine", "legal-knowledge"),
    path.join("src", "server", "engine", "legal-knowledge"),
    path.join("scripts", "legal-sources.mts"),
    path.join("scripts", "legal-pdf-extract.py"),
  ];
  const forbiddenPatterns = [
    "from [\\\"']open[a]i", "@sup[a]base", "customer[_-](?:payslip|data)", "\\bprod[u]ction\\b", "migr[a]tion", "dep[l]oy", "eligib[i]lity", "find[i]ngs?",
  ];
  const matches: Array<{ pattern: string; output: string }> = [];
  for (const pattern of forbiddenPatterns) {
    const result = spawnSync("rg", ["-n", "-i", pattern, ...targets], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    if (result.status === 0 && result.stdout.trim()) matches.push({ pattern, output: result.stdout.trim().slice(0, 4_000) });
  }
  return {
    scope: targets.map((target) => target.replaceAll("\\", "/")),
    forbidden_patterns: forbiddenPatterns,
    matches,
    passed: matches.length === 0,
    note: "Repository-level dependencies outside the legal-knowledge boundary are not executed or imported by this subsystem.",
  };
}

async function reviewPackageCommand() {
  await ensureLocalDirectories();
  const reviewRelative = path.relative(outputRoot, reviewPackageRoot);
  if (reviewRelative !== "review-package-v0.1") throw new Error("review_package_path_escape");
  await rm(reviewPackageRoot, { recursive: true, force: true });
  await mkdir(reviewPackageRoot, { recursive: true });
  const { manifest, fetchState, buildState, sources, chunks } = await loadRuntimeCorpus();
  const matrix = await loadLegalCoverageMatrix();
  const relations = await loadLegalSourceRelations();
  const catalogReport = await readJson<Record<string, unknown>>(catalogReportPath, { status: "missing", records: [] });
  const diffReport = await readJson<Record<string, unknown>>(sourceDiffReportPath, { status: "missing", records: [] });
  const temporalReport = await readJson<Record<string, unknown>>(coverageReportPath, { status: "missing", matrix: [], queries: [] });
  const citationReport = await readJson<Record<string, unknown>>(citationReportPath, { status: "missing", records: [] });
  const reproducibilityReport = await readJson<Record<string, unknown>>(reproducibilityReportPath, { status: "missing", passed: false });
  const scope = await scopeAudit();
  const evidence = runtimeEvidenceMap(sources, chunks, buildState);
  const diffRecords = Array.isArray(diffReport.records) ? diffReport.records as Array<Record<string, unknown>> : [];
  const inventory = manifest.sources.map((source) => {
    const observation = selectedObservation(fetchState, source);
    const build = buildState.records.find((record) => record.source_id === source.source_id && record.source_version === source.source_version);
    const coverageRows = matrix.rows.filter((row) => row.source_version_id === legalSourceVersionId(source));
    const change = diffRecords.find((record) => record.source_id === source.source_id);
    return {
      source_id: source.source_id,
      source_version: source.source_version,
      source_version_id: legalSourceVersionId(source),
      topics: source.topics,
      instrument_type: source.source_type,
      authority: source.authority,
      canonical_url: source.canonical_url,
      retrieval_url: source.canonical_url,
      final_url: observation?.final_url ?? null,
      redirect_chain: observation?.redirect_chain ?? [],
      media_type: observation?.content_type ?? null,
      raw_sha256: observation?.artifact_sha256 ?? null,
      normalized_text_sha256: build?.normalized_text_sha256 ?? null,
      parser_version: build?.parser_version ?? null,
      effective_interval: source.effective_period,
      sectors: source.sectors,
      parse_status: build?.parse_status ?? "not_built",
      parse_reason_code: build?.safe_error_code ?? null,
      review_status: source.status,
      activation_status: "inactive",
      change_status: change?.status ?? "initial_or_unchanged_candidate",
      selected_candidate: observation !== null,
      selected_does_not_mean_active: true,
      coverage_reason_codes: [...new Set(coverageRows.flatMap((row) => row.reason_codes))],
    };
  });
  const evidenceSheets = inventory.map((entry) => ({
    source_version_id: entry.source_version_id,
    immutable_lineage: evidence[entry.source_version_id],
    official_provenance: { canonical_url: entry.canonical_url, final_url: entry.final_url, media_type: entry.media_type, authority: entry.authority },
    legal_valid_time: entry.effective_interval,
    system_time: {
      retrieved_at: selectedObservation(fetchState, manifest.sources.find((source) => legalSourceVersionId(source) === entry.source_version_id)!)?.retrieved_at ?? null,
      reviewed_at: null,
      activated_at: null,
    },
    review_status: entry.review_status,
    numeric_candidates_created: 0,
  }));
  const files: Array<readonly [string, unknown]> = [
    ["01-source-inventory.json", { schema_version: "review-source-inventory-v0.1", records: inventory }],
    ["02-coverage-matrix.json", { schema_version: matrix.schema_version, coverage_window: matrix.coverage_window, corpus_status: matrix.corpus_status, rows: matrix.rows }],
    ["03-evidence-sheets.json", { schema_version: "review-evidence-sheets-v0.1", records: evidenceSheets }],
    ["04-source-lineage-gaps.json", {
      schema_version: relations.schema_version,
      automatic_legal_inference: false,
      relations: relations.relations,
      gaps: matrix.rows.filter((row) => row.coverage_status !== "candidate_needs_review"),
    }],
    ["05-catalog-snapshot-diff.json", catalogReport],
    ["06-source-byte-diffs.json", diffReport],
    ["07-temporal-query-report.json", temporalReport],
    ["08-citation-round-trip-report.json", citationReport],
    ["09-parser-sanity-qa.json", {
      schema_version: "parser-sanity-qa-v0.1",
      checks: ["declared_mime", "magic_bytes", "challenge_or_error_page", "minimum_content", "source_specific_markers", "page_limit", "normalized_character_limit", "active_content"],
      records: inventory.map((entry) => ({ source_version_id: entry.source_version_id, parse_status: entry.parse_status, reason_code: entry.parse_reason_code, raw_sha256: entry.raw_sha256, normalized_text_sha256: entry.normalized_text_sha256 })),
      visual_inspection_samples: [
        { source_version_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1", page: 1, image_path: "output/legal-knowledge/pdf-inspection/short-week.png", observed_structure: "official emblem, order title, preamble, commencement paragraph, numbered clauses" },
        { source_version_id: "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1", page: 2, image_path: "output/legal-knowledge/pdf-inspection/overtime-p2.png", observed_structure: "official gazette header and general overtime permit heading" },
        { source_version_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2016@discovery-v0.1", page: 2, image_path: "output/legal-knowledge/pdf-inspection/convalescence-p2.png", observed_structure: "official gazette page, highlighted order title, operative clauses, signature and date" },
      ],
      qa_status: "pending_owner_legal_review",
    }],
    ["10-clean-room-reproducibility.json", reproducibilityReport],
    ["11-security-fail-closed.json", {
      schema_version: "security-fail-closed-review-v0.1",
      static_scope_audit: scope,
      test_files: [
        "src/server/engine/legal-knowledge/security.test.ts",
        "src/server/engine/legal-knowledge/normalization.test.ts",
        "src/server/engine/legal-knowledge/manifest-and-changes.test.ts",
        "src/engine/legal-knowledge/temporal-resolver.test.ts",
      ],
      network_boundary: "only fetch, changes, and catalogs commands use fetchLegalSourceBytes; build/search/coverage/citations/reproducibility are artifact-only",
      runtime_llm_calls: 0,
      private_input_accesses: 0,
    }],
    ["12-owner-legal-review-questions.json", {
      schema_version: "owner-legal-review-questions-v0.1",
      questions: [
        "Provide or approve a stable processable official representation of the Hours of Work and Rest Law; the Knesset endpoint returns a challenge shell.",
        "Confirm the exact effective evidence and operative relationship for the 2018 short-work-week order and general overtime permit.",
        "Resolve official permit-catalog history, sector applicability, temporary orders, expiry, and resumption relations across the declared window.",
        "Resolve the official 2026 convalescence catalog record URL and verify the complete 2019-2026 convalescence instrument chain and intervals.",
        "Review both isolated byte-change observations and decide whether any valid candidate should become a new baseline.",
        "Confirm historical effective intervals and sector coverage for every topic before activation.",
      ],
    }],
    ["13-future-activation-checklist.json", {
      schema_version: "future-activation-checklist-v0.1",
      current_active_sources: 0,
      checklist: [
        "Bind approval to exact raw and normalized hashes, parser version, source-version ID, effective interval, and sector.",
        "Require a named human actor and append-only review event; never infer review from fetch, parse, build, or tests.",
        "Resolve all gaps, overlaps, conflicts, amendments, temporary overrides, suspensions, expiry, and resumption relations.",
        "Re-run offline build, temporal boundaries, citation round-trip, security, and clean-room reproducibility checks.",
        "Keep numeric candidates and active numeric parameters at zero in this review package.",
      ],
    }],
  ];
  for (const [name, content] of files) await writeReplaceJson(path.join(reviewPackageRoot, name), content);
  const index = {
    schema_version: "legal-source-review-package-v0.1",
    package_status: "pending_owner_legal_review",
    corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    source_records: manifest.sources.length,
    selected_source_versions: manifest.sources.filter((source) => selectedObservation(fetchState, source)).length,
    parsed_source_versions: buildState.records.filter((record) => record.parse_status === "parsed").length,
    chunks: buildState.records.reduce((sum, record) => sum + record.chunk_count, 0),
    active_sources: manifest.sources.filter((source) => source.status === "active").length,
    numeric_candidates: 0,
    active_numeric_parameters: 0,
    case_law_contract_present: true,
    case_law_operational_sources: manifest.sources.filter((source) => source.source_type === "case_law").length,
    components: files.map(([name]) => name),
  };
  await writeReplaceJson(path.join(reviewPackageRoot, "review-package-index.json"), index);
  return { ...index, review_package_path: safeRelative(reviewPackageRoot) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "validate") result = await validateManifestCommand();
  else if (command === "fetch") result = await fetchCommand();
  else if (command === "build") result = await buildCommand();
  else if (command === "status") result = await statusCommand();
  else if (command === "search") result = await searchCommand(args);
  else if (command === "changes") result = await changesCommand();
  else if (command === "catalogs") result = await catalogsCommand();
  else if (command === "diffs") result = await sourceDiffsCommand();
  else if (command === "coverage") result = await coverageCommand();
  else if (command === "citations") result = await citationAuditCommand();
  else if (command === "reproducibility") result = await reproducibilityCommand();
  else if (command === "reproducibility-probe") result = await reproducibilityProbe(args);
  else if (command === "review-package") result = await reviewPackageCommand();
  else throw new Error("unknown_legal_sources_command");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Za-z0-9_:,.-]+$/u.test(error.message) ? error.message : "legal_sources_command_failed";
  process.stderr.write(`LEGAL_SOURCES_COMMAND_FAILED ${code}\n`);
  process.exitCode = 1;
});
