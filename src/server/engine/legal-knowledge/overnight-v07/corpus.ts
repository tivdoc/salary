import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  BuildRecord,
  CitationState,
  FetchState,
  LifecycleTotals,
} from "../../../../engine/legal-knowledge/overnight-v07/inventory.ts";
import { recomputeCorpusInventory } from "../../../../engine/legal-knowledge/overnight-v07/inventory.ts";
import { loadLegalSourceManifest } from "../manifest.ts";
import { loadCanonicalRoleInventory, loadWorkingTimeCandidateGraph } from "../wave21-canonical-corpus/canonical-inventory.ts";
import { summarizeWorkingTimePermitInventories } from "../wave1-working-time-permits.ts";

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function assertObject(value: unknown, code: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
}

function asArray<T>(value: unknown, code: string): T[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value as T[];
}

export type LoadedP3Corpus = Awaited<ReturnType<typeof loadCurrentP3Corpus>>;

export async function loadCurrentP3Corpus(input: Readonly<{
  repository_root: string;
  corpus_state_root: string;
}>) {
  const repositoryRoot = path.resolve(input.repository_root);
  const corpusStateRoot = path.resolve(input.corpus_state_root);
  const trackedLegalRoot = path.join(repositoryRoot, "src", "server", "engine", "legal-knowledge");
  const manifest = await loadLegalSourceManifest(path.join(trackedLegalRoot, "legal-sources.v0.json"));
  const [buildRaw, fetchRaw, citationRaw, lifecycleRaw, pensionRaw, minimumWageRaw, permitsRaw, publicationsRaw, acquisitionRaw] = await Promise.all([
    readJson(path.join(corpusStateRoot, "eval", "legal-knowledge", "manifests", "build-state.json")),
    readJson(path.join(corpusStateRoot, "eval", "legal-knowledge", "manifests", "fetch-state.json")),
    readJson(path.join(corpusStateRoot, "output", "legal-knowledge", "citation-round-trip-report.json")),
    readJson(path.join(corpusStateRoot, "output", "parallel-wave-2.3", "workers", "w2-corpus-trust", "lifecycle-reconciliation.json")),
    readJson(path.join(trackedLegalRoot, "wave1-pension-convalescence.inventory.v0.3.1.json")),
    readJson(path.join(repositoryRoot, "src", "engine", "legal-knowledge", "review-dossier", "minimum-wage-evidence.v0.4.json")),
    readJson(path.join(trackedLegalRoot, "wave1-working-time-permits-catalog.v0.3.json")),
    readJson(path.join(trackedLegalRoot, "wave1-working-time-permits-publications.v0.3.json")),
    readJson(path.join(corpusStateRoot, "output", "parallel-wave-1", "review-package-v0.3", "worker-evidence", "batch-a-working-time-permits", "artifact-acquisition-report.json")),
  ]);
  assertObject(buildRaw, "P3_BUILD_STATE_INVALID");
  assertObject(fetchRaw, "P3_FETCH_STATE_INVALID");
  assertObject(citationRaw, "P3_CITATION_STATE_INVALID");
  assertObject(lifecycleRaw, "P3_LIFECYCLE_STATE_INVALID");
  assertObject(pensionRaw, "P3_PENSION_INVENTORY_INVALID");
  assertObject(minimumWageRaw, "P3_MINIMUM_WAGE_INVENTORY_INVALID");
  assertObject(acquisitionRaw, "P3_WORKING_TIME_ACQUISITION_INVALID");

  const buildRecords = asArray<BuildRecord>(buildRaw.records, "P3_BUILD_RECORDS_INVALID");
  const fetchState: FetchState = {
    observations: asArray<FetchState["observations"][number]>(fetchRaw.observations, "P3_FETCH_OBSERVATIONS_INVALID"),
    failures: asArray(fetchRaw.failures, "P3_FETCH_FAILURES_INVALID"),
  };
  const citationState: CitationState = {
    records: asArray<CitationState["records"][number]>(citationRaw.records, "P3_CITATION_RECORDS_INVALID"),
  };
  assertObject(lifecycleRaw.totals, "P3_LIFECYCLE_TOTALS_INVALID");
  assertObject(pensionRaw.pension_2016, "P3_PENSION_2016_INVALID");
  assertObject(minimumWageRaw.byte_change_baseline, "P3_MINIMUM_WAGE_BASELINE_INVALID");
  const minimumWageSources = asArray<Record<string, unknown>>(minimumWageRaw.sources, "P3_MINIMUM_WAGE_SOURCES_INVALID");
  const minimumWageCandidates = asArray<Record<string, unknown>>(minimumWageRaw.byte_change_candidates, "P3_MINIMUM_WAGE_CANDIDATES_INVALID");
  const acquisitionResults = asArray<Record<string, unknown>>(acquisitionRaw.results, "P3_ACQUISITION_RESULTS_INVALID");
  const workingTimeSummary = summarizeWorkingTimePermitInventories(permitsRaw, publicationsRaw);
  const workingTime = {
    hours_publications: workingTimeSummary.hours_publications,
    permit_catalog_entries: workingTimeSummary.permit_catalog_entries,
    permit_artifact_links: workingTimeSummary.permit_artifact_links,
    acquisition_requested: acquisitionResults.length,
    acquisition_acquired: acquisitionResults.filter((result) => result.safe_error_code === null || result.safe_error_code === undefined).length,
    acquisition_failed_403: acquisitionResults.filter((result) => result.safe_error_code === "http_status_403").length,
    acquisition_failed_404: acquisitionResults.filter((result) => result.safe_error_code === "http_status_404").length,
  };
  if (workingTime.acquisition_requested !== 88 || workingTime.acquisition_acquired !== 72 || workingTime.acquisition_failed_403 !== 15 || workingTime.acquisition_failed_404 !== 1) {
    throw new Error("P3_HISTORICAL_WORKING_TIME_ACQUISITION_RECONCILIATION_MISMATCH");
  }

  const roleInventory = loadCanonicalRoleInventory();
  const candidateGraph = loadWorkingTimeCandidateGraph();
  if (roleInventory.source_count !== manifest.sources.length || candidateGraph.node_count !== workingTime.hours_publications) {
    throw new Error("P3_CANONICAL_INVENTORY_CROSSCHECK_FAILED");
  }
  const inventory = recomputeCorpusInventory({
    sources: manifest.sources,
    build_records: buildRecords,
    fetch_state: fetchState,
    citation_state: citationState,
    working_time: workingTime,
    pension_inventory: { pension_2016: pensionRaw.pension_2016 as never },
    minimum_wage: {
      source_activation_states: minimumWageSources.map((source) => String(source.activation_state)),
      baseline_sha256: String(minimumWageRaw.byte_change_baseline.artifact_sha256),
      candidate_sha256s: minimumWageCandidates.map((candidate) => String(candidate.artifact_sha256)),
    },
    lifecycle_totals: lifecycleRaw.totals as LifecycleTotals,
    // B-0: the frozen lifecycle document names the source versions it accounts
    // for. Its totals are compared against those and nothing else.
    lifecycle_scope_source_version_ids: asArray<Record<string, unknown>>(
      lifecycleRaw.sources, "P3_LIFECYCLE_SOURCES_INVALID",
    ).map((entry) => String(entry.source_version_id)),
  });
  return Object.freeze({
    inventory,
    sources: Object.freeze(manifest.sources),
    build_records: Object.freeze(buildRecords),
    fetch_state: Object.freeze(fetchState),
    citation_state: Object.freeze(citationState),
    canonical_crosschecks: Object.freeze({
      role_inventory_source_count: roleInventory.source_count,
      working_time_candidate_graph_node_count: candidateGraph.node_count,
      unresolved_working_time_edges: candidateGraph.edges.length,
    }),
  });
}
