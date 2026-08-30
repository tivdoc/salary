import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "../../../../engine/rule-runtime/canonical.ts";
import { loadAcquisitionTargets } from "../acquisition.ts";
import { storeImmutableLegalArtifact } from "../artifacts.ts";
import {
  fetchLegalSourceBytes,
  SafeLegalFetchError,
  sanitizeLegalUrlForLog,
  type SafeLegalFetchResult,
} from "../security.ts";
import { loadLegalSourceManifest } from "../manifest.ts";

export type P3AcquisitionTarget = Readonly<{
  attempt_id: string;
  source_id: string;
  canonical_url: string;
  artifact_format: "pdf" | "html";
  baseline_sha256: string | null;
  gap_class: "registered_target" | "historical_working_time_failure";
  historical_safe_error_code: string | null;
}>;

export type P3AcquisitionReceipt = Readonly<{
  attempt_id: string;
  source_id: string;
  safe_url: string;
  attempted_method: "GET";
  attempts: 1;
  status: "inactive_candidate" | "SKIPPED_BLOCKED";
  blocker_code: string | null;
  historical_safe_error_code: string | null;
  artifact_sha256: string | null;
  baseline_sha256: string | null;
  byte_relation: "baseline_match" | "changed_or_unregistered" | "unavailable";
  byte_count: number;
  content_type: string | null;
  redirect_chain: readonly string[];
  acquired_at: string;
  tool_version: "tivdoc-p3-bounded-official-fetch-v0.7.0";
  selected_corpus_mutated: false;
  readiness_mutated: false;
  safe_fallback_completed: true;
  affected_acceptance_ids: readonly ["V07-P3-ACQUISITION"];
  direct_downstream_impact: string;
  next_human_or_environment_action: string;
}>;

export interface P3OfficialFetcher {
  fetch(target: P3AcquisitionTarget): Promise<SafeLegalFetchResult>;
}

function safeId(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9_-]/gu, "_").slice(0, 72);
}

export async function loadP3AcquisitionTargets(input: Readonly<{
  repository_root: string;
  corpus_state_root: string;
}>) {
  const legalRoot = path.join(path.resolve(input.repository_root), "src", "server", "engine", "legal-knowledge");
  const [registry, manifest, buildState] = await Promise.all([
    loadAcquisitionTargets(path.join(legalRoot, "legal-acquisition-targets.v0.2.json")),
    loadLegalSourceManifest(path.join(legalRoot, "legal-sources.v0.json")),
    readFile(path.join(path.resolve(input.corpus_state_root), "eval", "legal-knowledge", "manifests", "build-state.json"), "utf8").then((text) => JSON.parse(text) as { records?: Record<string, unknown>[] }),
  ]);
  if (!Array.isArray(buildState.records)) throw new Error("P3_BUILD_STATE_REQUIRED_FOR_ACQUISITION_BASELINES");
  const baselineBySource = new Map(buildState.records.map((record) => [String(record.source_id), String(record.artifact_sha256)]));
  for (const source of manifest.sources) {
    const buildHash = baselineBySource.get(source.source_id);
    if (source.content_sha256 !== null && buildHash !== source.content_sha256) throw new Error(`P3_ACQUISITION_BASELINE_HASH_MISMATCH:${source.source_id}`);
  }
  const registered: P3AcquisitionTarget[] = registry.targets.map((target) => {
    const url = target.artifact_url ?? target.canonical_landing_url;
    return Object.freeze({
      attempt_id: `P3-REGISTRY-${target.target_id}`,
      source_id: target.source_id,
      canonical_url: url,
      artifact_format: /\.pdf(?:$|\?)/iu.test(url) ? "pdf" as const : "html" as const,
      baseline_sha256: baselineBySource.get(target.source_id) ?? null,
      gap_class: "registered_target" as const,
      historical_safe_error_code: target.browser_safe_error_code,
    });
  });

  const historicalPath = path.join(path.resolve(input.corpus_state_root), "output", "parallel-wave-1", "review-package-v0.3", "worker-evidence", "batch-a-working-time-permits", "artifact-acquisition-report.json");
  const historical = JSON.parse(await readFile(historicalPath, "utf8")) as { results?: unknown[] };
  if (!Array.isArray(historical.results)) throw new Error("P3_HISTORICAL_ACQUISITION_RESULTS_INVALID");
  const failed = historical.results.filter((result): result is Record<string, unknown> => {
    return result !== null && typeof result === "object" && ["http_status_403", "http_status_404"].includes(String((result as Record<string, unknown>).safe_error_code));
  });
  if (failed.length !== 16) throw new Error("P3_EXPECTED_16_HISTORICAL_WORKING_TIME_FAILURES");
  const workingTime: P3AcquisitionTarget[] = failed.map((result, index) => {
    const url = String(result.official_url ?? "");
    if (!url) throw new Error("P3_HISTORICAL_FAILURE_URL_MISSING");
    return Object.freeze({
      attempt_id: `P3-WORKING-TIME-REATTEMPT-${String(index + 1).padStart(2, "0")}`,
      source_id: `P3_WORKING_TIME_GAP_${String(index + 1).padStart(2, "0")}`,
      canonical_url: url,
      artifact_format: "pdf" as const,
      baseline_sha256: null,
      gap_class: "historical_working_time_failure" as const,
      historical_safe_error_code: String(result.safe_error_code),
    });
  });
  const all = [...registered, ...workingTime].sort((left, right) => left.attempt_id.localeCompare(right.attempt_id));
  if (new Set(all.map((target) => target.attempt_id)).size !== all.length) throw new Error("P3_DUPLICATE_ACQUISITION_ATTEMPT_ID");
  return Object.freeze(all);
}

export function createCanonicalP3Fetcher(): P3OfficialFetcher {
  return Object.freeze({
    async fetch(target: P3AcquisitionTarget) {
      return fetchLegalSourceBytes(
        { canonical_url: target.canonical_url, artifact_format: target.artifact_format },
        { maxBytes: 8 * 1024 * 1024, maxRedirects: 2, timeoutMs: 12_000 },
      );
    },
  });
}

export async function attemptP3OfficialTarget(input: Readonly<{
  target: P3AcquisitionTarget;
  candidate_root: string;
  fetcher: P3OfficialFetcher;
  now?: () => string;
}>): Promise<P3AcquisitionReceipt> {
  const acquiredAt = (input.now ?? (() => new Date().toISOString()))();
  try {
    const fetched = await input.fetcher.fetch(input.target);
    const hash = createHash("sha256").update(fetched.bytes).digest("hex");
    await storeImmutableLegalArtifact({
      root: input.candidate_root,
      sourceId: safeId(input.target.source_id),
      sourceVersion: "candidate-v07",
      artifactSha256: hash,
      extension: input.target.artifact_format === "pdf" ? "pdf" : "html",
      bytes: fetched.bytes,
    });
    return Object.freeze({
      attempt_id: input.target.attempt_id,
      source_id: input.target.source_id,
      safe_url: sanitizeLegalUrlForLog(input.target.canonical_url),
      attempted_method: "GET",
      attempts: 1,
      status: "inactive_candidate",
      blocker_code: null,
      historical_safe_error_code: input.target.historical_safe_error_code,
      artifact_sha256: hash,
      baseline_sha256: input.target.baseline_sha256,
      byte_relation: hash === input.target.baseline_sha256 ? "baseline_match" : "changed_or_unregistered",
      byte_count: fetched.bytes.byteLength,
      content_type: fetched.contentType,
      redirect_chain: Object.freeze([...fetched.redirectChain]),
      acquired_at: acquiredAt,
      tool_version: "tivdoc-p3-bounded-official-fetch-v0.7.0",
      selected_corpus_mutated: false,
      readiness_mutated: false,
      safe_fallback_completed: true,
      affected_acceptance_ids: Object.freeze(["V07-P3-ACQUISITION"] as const),
      direct_downstream_impact: "candidate remains outside selected corpus until canonical human review and import",
      next_human_or_environment_action: "review exact inactive candidate bytes and complete a valid hash-bound signed decision",
    });
  } catch (error) {
    const code = error instanceof SafeLegalFetchError ? error.code : "bounded_fetch_or_storage_failed";
    return Object.freeze({
      attempt_id: input.target.attempt_id,
      source_id: input.target.source_id,
      safe_url: sanitizeLegalUrlForLog(input.target.canonical_url),
      attempted_method: "GET",
      attempts: 1,
      status: "SKIPPED_BLOCKED",
      blocker_code: code,
      historical_safe_error_code: input.target.historical_safe_error_code,
      artifact_sha256: null,
      baseline_sha256: input.target.baseline_sha256,
      byte_relation: "unavailable",
      byte_count: 0,
      content_type: null,
      redirect_chain: Object.freeze([]),
      acquired_at: acquiredAt,
      tool_version: "tivdoc-p3-bounded-official-fetch-v0.7.0",
      selected_corpus_mutated: false,
      readiness_mutated: false,
      safe_fallback_completed: true,
      affected_acceptance_ids: Object.freeze(["V07-P3-ACQUISITION"] as const),
      direct_downstream_impact: "official byte gap remains unresolved; source and topic readiness remain inactive",
      next_human_or_environment_action: "use an ordinary public browser on the exact official URL without bypass, or provide immutable official bytes through the owner handoff",
    });
  }
}

export async function runBoundedP3Acquisition(input: Readonly<{
  targets: readonly P3AcquisitionTarget[];
  candidate_root: string;
  fetcher: P3OfficialFetcher;
  concurrency?: number;
  now?: () => string;
}>) {
  const concurrency = input.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("P3_ACQUISITION_CONCURRENCY_MUST_BE_1_OR_2");
  const receipts = new Array<P3AcquisitionReceipt>(input.targets.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, input.targets.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= input.targets.length) return;
      receipts[index] = await attemptP3OfficialTarget({ target: input.targets[index], candidate_root: input.candidate_root, fetcher: input.fetcher, now: input.now });
    }
  });
  await Promise.all(workers);
  const reportCore = Object.freeze({
    schema_version: "tivdoc-p3-official-acquisition-report-v0.7.0" as const,
    method: "public_GET_only" as const,
    retry_count: 0,
    concurrency,
    receipts: Object.freeze(receipts),
    totals: Object.freeze({
      attempted: receipts.length,
      inactive_candidates: receipts.filter((receipt) => receipt.status === "inactive_candidate").length,
      blocked: receipts.filter((receipt) => receipt.status === "SKIPPED_BLOCKED").length,
      selected_corpus_mutations: 0,
      readiness_mutations: 0,
    }),
    prohibited_actions: Object.freeze({ bypasses: 0, unofficial_mirrors: 0, authenticated_requests: 0, retries: 0, legal_activations: 0 }),
  });
  return Object.freeze({ ...reportCore, report_sha256: createHash("sha256").update(canonicalStringify(reportCore)).digest("hex") });
}
