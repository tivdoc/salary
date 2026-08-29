import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { legalSourceSchema, type LegalChunk, type LegalSource } from "../src/engine/legal-knowledge/contracts.ts";
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
  removeRepeatedPdfMargins,
} from "../src/server/engine/legal-knowledge/normalization.ts";
import {
  fetchLegalSourceBytes,
  safeLegalLogEvent,
  SafeLegalFetchError,
  validateLegalSourceUrl,
} from "../src/server/engine/legal-knowledge/security.ts";

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
  for (const directory of [artifactRoot, normalizedRoot, localManifestRoot, outputRoot]) {
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
  await writeFile(filePath, stableJson(value));
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
      if (!pages.some((page) => page.text.trim().length > 0)) throw new Error("normalized_text_empty");
      const normalizedHash = normalizedDocumentHash(pages);
      const runtimeSource = legalSourceSchema.parse({
        ...source,
        content_sha256: observation.artifact_sha256,
        retrieved_at: observation.retrieved_at,
      });
      const chunks = chunkLegalPages(runtimeSource, observation.artifact_sha256, pages);
      if (chunks.length === 0) throw new Error("chunks_empty");
      const normalizedDocument = stableJson({
        schema_version: "normalized-legal-source-v0",
        source_id: source.source_id,
        source_version: source.source_version,
        artifact_sha256: observation.artifact_sha256,
        normalized_text_sha256: normalizedHash,
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
      chunk_count: record.chunk_count,
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
  const { manifest, fetchState } = await loadRuntimeCorpus();
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
    active_sources: 0,
    active_parameters: 0,
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
  const { sources, chunks } = await loadRuntimeCorpus();
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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result: unknown;
  if (command === "validate") result = await validateManifestCommand();
  else if (command === "fetch") result = await fetchCommand();
  else if (command === "build") result = await buildCommand();
  else if (command === "status") result = await statusCommand();
  else if (command === "search") result = await searchCommand(args);
  else if (command === "changes") result = await changesCommand();
  else throw new Error("unknown_legal_sources_command");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Za-z0-9_:,.-]+$/u.test(error.message) ? error.message : "legal_sources_command_failed";
  process.stderr.write(`LEGAL_SOURCES_COMMAND_FAILED ${code}\n`);
  process.exitCode = 1;
});
