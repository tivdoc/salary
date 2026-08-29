import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildUnverifiedAmendmentCandidateGraph } from "../../../../engine/legal-knowledge/corpus-hardening/amendment-candidates.ts";
import { CONVALESCENCE_2025_SEGMENT } from "../../../../engine/legal-knowledge/corpus-hardening/container-segmentation.ts";
import { classifyPermit8753 } from "../../../../engine/legal-knowledge/corpus-hardening/permit-8753.ts";
import { evaluateStrictRealCorpusReadiness } from "../../../../engine/legal-knowledge/corpus-hardening/readiness.ts";
import { classifyRegisteredSourceRole, proveKnownNonOperativeRoles } from "../../../../engine/legal-knowledge/corpus-hardening/source-roles.ts";
import { stableJson } from "../../../../engine/legal-knowledge/corpus-hardening/pension-ocr.ts";
import { legalSourceManifestSchema } from "../manifest.ts";

type FetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  content_type: string;
  byte_count: number;
  parse_status: string;
  safe_error_code: string | null;
}>;

type FetchState = Readonly<{
  observations: readonly FetchObservation[];
  failures: readonly unknown[];
}>;

type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  parsed_version_id: string | null;
  parse_status: string;
  chunk_count: number;
}>;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeEvidence(directory: string, name: string, value: unknown) {
  const filePath = path.join(directory, name);
  await writeFile(filePath, stableJson(value), { flag: "wx" });
  const bytes = await readFile(filePath);
  return Object.freeze({ path: name, byte_count: bytes.length, sha256: sha256(bytes) });
}

function isQuarantined(observation: FetchObservation) {
  return (observation.content_type.toLowerCase().includes("text/html") && observation.byte_count <= 4_096 && observation.parse_status !== "parsed")
    || observation.safe_error_code === "html_challenge_or_error_page";
}

export function reconcileCorpusCounts(input: Readonly<{
  sourceVersionIds: readonly string[];
  fetchState: FetchState;
  buildRecords: readonly BuildRecord[];
  stagedPublicationCount: number;
  stagedPermitRecordCount: number;
  stagedPermitArtifactUrlCount: number;
}>) {
  const snapshot = Object.freeze({
    registered_source_versions: input.sourceVersionIds.length,
    fetch_observations: input.fetchState.observations.length,
    unavailable_observations: input.fetchState.failures.length,
    observations_including_unavailable: input.fetchState.observations.length + input.fetchState.failures.length,
    quarantined_or_unavailable_observations: input.fetchState.observations.filter(isQuarantined).length + input.fetchState.failures.length,
    valid_raw_artifact_observations: input.fetchState.observations.filter((entry) => !isQuarantined(entry)).length,
    corpus_version_records: input.buildRecords.length,
    parsed_corpus_versions: input.buildRecords.filter((record) => record.parse_status === "parsed").length,
    parse_failed_corpus_versions: input.buildRecords.filter((record) => record.parse_status !== "parsed").length,
    chunks: input.buildRecords.reduce((sum, record) => sum + record.chunk_count, 0),
  });
  return Object.freeze({
    schema_version: "wave2-corpus-count-reconciliation-v0.4" as const,
    before: snapshot,
    after: snapshot,
    deltas: Object.fromEntries(Object.keys(snapshot).map((key) => [key, 0])),
    one_to_one_source_version_mapping: [...input.sourceVersionIds].sort().map((id) => Object.freeze({ before_source_version_id: id, after_source_version_id: id, mapping: "identity_no_corpus_mutation" as const })),
    staged_acquisition_inventory: Object.freeze({
      working_time_publication_records: input.stagedPublicationCount,
      permit_catalog_records: input.stagedPermitRecordCount,
      permit_unique_artifact_urls: input.stagedPermitArtifactUrlCount,
      counted_as_corpus_versions: false as const,
      reason: "catalog and acquisition inventories remain staged until controlled registration and review",
    }),
    corpus_state_mutated: false as const,
  });
}

async function inspectPermit8753Live(entry: Readonly<{ stable_id: string; catalog_url: string; artifact_links: readonly Readonly<{ official_url: string }>[] }>) {
  const officialUrl = entry.artifact_links[0]?.official_url;
  if (!officialUrl) throw new Error("permit_8753_official_url_missing");
  const parsed = new URL(officialUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.gov.il") throw new Error("permit_8753_url_not_official_allowlisted");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(officialUrl, { redirect: "manual", signal: controller.signal });
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 64 * 1024) throw new Error("permit_8753_diagnostic_response_too_large");
    return Object.freeze({
      ...classifyPermit8753({
        stableId: entry.stable_id,
        exactCatalogUrl: entry.catalog_url,
        exactOfficialArtifactUrl: officialUrl,
        liveHttpStatus: response.status,
        catalogUrlWasGenerated: false,
        explicitOfficialReplacementUrl: null,
        explicitOfficialReplacementEvidence: null,
      }),
      observed_at: new Date().toISOString(),
      response_media_type: response.headers.get("content-type"),
      response_byte_count: body.length,
      response_sha256: sha256(body),
      redirect_location: response.headers.get("location"),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyConvalescenceContainer(pdfPath: string, pdfinfoExecutable: string) {
  const bytes = await readFile(pdfPath);
  const digest = sha256(bytes);
  if (digest !== CONVALESCENCE_2025_SEGMENT.container_artifact_sha256) throw new Error("convalescence_container_hash_mismatch");
  const result = spawnSync(pdfinfoExecutable, [pdfPath], { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" } });
  if (result.status !== 0) throw new Error(`pdfinfo_failed:${result.status}`);
  const pageMatch = `${result.stdout}`.match(/^Pages:\s+(\d+)$/mu);
  if (!pageMatch || Number(pageMatch[1]) !== CONVALESCENCE_2025_SEGMENT.container_page_count) throw new Error("convalescence_container_page_count_mismatch");
  return Object.freeze({
    artifact_sha256: digest,
    byte_count: bytes.length,
    page_count: Number(pageMatch[1]),
    encrypted: /^Encrypted:\s+yes$/mu.test(`${result.stdout}`),
    javascript: /^JavaScript:\s+yes$/mu.test(`${result.stdout}`),
  });
}

export async function generateCorpusHardeningEvidence(input: Readonly<{
  repositoryRoot: string;
  corpusStateRoot: string;
  evidenceDirectory: string;
  convalescencePdfPath: string;
  pdfinfoExecutable: string;
  inspectPermitLive: boolean;
}>) {
  await mkdir(input.evidenceDirectory, { recursive: false });
  const manifestPath = path.join(input.repositoryRoot, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");
  const buildPath = path.join(input.corpusStateRoot, "eval", "legal-knowledge", "manifests", "build-state.json");
  const fetchPath = path.join(input.corpusStateRoot, "eval", "legal-knowledge", "manifests", "fetch-state.json");
  const citationPath = path.join(input.corpusStateRoot, "output", "legal-knowledge", "citation-round-trip-report.json");
  const publicationPath = path.join(input.repositoryRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-publications.v0.3.json");
  const permitPath = path.join(input.repositoryRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-catalog.v0.3.json");
  const [manifestRaw, buildState, fetchState, citationState, publications, permits, container] = await Promise.all([
    readJson<unknown>(manifestPath),
    readJson<Readonly<{ records: readonly BuildRecord[] }>>(buildPath),
    readJson<FetchState>(fetchPath),
    readJson<Readonly<{ records: readonly Readonly<{ source_version_id: string; status: string }>[] }>>(citationPath),
    readJson<Readonly<{ entries: readonly unknown[] }>>(publicationPath),
    readJson<Readonly<{ entries: readonly Readonly<{ stable_id: string; catalog_url: string; artifact_links: readonly Readonly<{ official_url: string }>[] }>[] }>>(permitPath),
    verifyConvalescenceContainer(input.convalescencePdfPath, input.pdfinfoExecutable),
  ]);
  const manifest = legalSourceManifestSchema.parse(manifestRaw);
  const sourceVersionIds = manifest.sources.map((source) => `${source.source_id}@${source.source_version}`);
  const roles = manifest.sources.map(classifyRegisteredSourceRole);
  const nonOperativeProof = proveKnownNonOperativeRoles(manifest.sources);
  const graph = buildUnverifiedAmendmentCandidateGraph(publications.entries as never[]);
  const permitUrls = new Set(permits.entries.flatMap((entry) => entry.artifact_links.map((link) => link.official_url)));
  const counts = reconcileCorpusCounts({
    sourceVersionIds,
    fetchState,
    buildRecords: buildState.records,
    stagedPublicationCount: publications.entries.length,
    stagedPermitRecordCount: permits.entries.length,
    stagedPermitArtifactUrlCount: permitUrls.size,
  });
  const readiness = evaluateStrictRealCorpusReadiness({
    sources: manifest.sources,
    buildRecords: buildState.records.map((record) => ({ source_version_id: `${record.source_id}@${record.source_version}`, parse_status: record.parse_status })),
    citationRecords: citationState.records,
  });
  const permitEntry = permits.entries.find((entry) => entry.stable_id === "GOVIL-WORK-PERMIT:premit-8753");
  if (!permitEntry) throw new Error("permit_8753_catalog_entry_missing");
  const permit = input.inspectPermitLive
    ? await inspectPermit8753Live(permitEntry)
    : classifyPermit8753({
      stableId: permitEntry.stable_id,
      exactCatalogUrl: permitEntry.catalog_url,
      exactOfficialArtifactUrl: permitEntry.artifact_links[0]?.official_url ?? "",
      liveHttpStatus: 404,
      catalogUrlWasGenerated: false,
      explicitOfficialReplacementUrl: null,
      explicitOfficialReplacementEvidence: null,
    });
  const segmentation = Object.freeze({
    schema_version: "wave2-convalescence-2025-container-evidence-v0.4" as const,
    container,
    segment: CONVALESCENCE_2025_SEGMENT,
    included_pages: Object.freeze(Array.from({ length: CONVALESCENCE_2025_SEGMENT.page_to - CONVALESCENCE_2025_SEGMENT.page_from + 1 }, (_, index) => CONVALESCENCE_2025_SEGMENT.page_from + index)),
    excluded_regions: Object.freeze([
      { page_from: 1, page_to: 15, reason: "before Chapter 7 section 24" },
      { page_from: 25, page_to: 25, section_id: "chapter-8.section-25", reason: "mixed boundary page after explicit end locator" },
      { page_from: 26, page_to: 40, reason: "after Chapter 7 section 24" },
    ]),
    retrieval_filter_requires_artifact_page_and_section_match: true as const,
    unrelated_pages_retrievable_for_convalescence: false as const,
    same_contract_applies_to: Object.freeze(["gazette", "amendment_publication", "permit_attachment"]),
    legal_interpretation_performed: false as const,
  });
  const reportValues = [
    ["source-role-proof.json", { schema_version: "wave2-source-role-proof-v0.4", assignments: roles, known_non_operative_proof: nonOperativeProof }],
    ["convalescence-2025-segmentation.json", segmentation],
    ["working-time-amendment-candidate-graph.json", graph],
    ["permit-8753-diagnostic.json", permit],
    ["real-corpus-readiness.json", readiness],
    ["corpus-count-reconciliation.json", counts],
  ] as const;
  const inventory = [];
  for (const [name, value] of reportValues) inventory.push(await writeEvidence(input.evidenceDirectory, name, value));
  const summary = Object.freeze({
    schema_version: "wave2-corpus-hardening-summary-v0.4" as const,
    corpus_state_mutated: false as const,
    reviewed_sources_created: 0,
    active_sources_created: 0,
    numeric_parameters_created: 0,
    legal_rules_created: 0,
    readiness_status: readiness.status,
    all_topics_non_ready: readiness.reports.every((report) => report.status === "not_ready"),
    working_time_publication_nodes: graph.node_count,
    working_time_candidate_edges: graph.edge_count,
    permit_8753_status: permit.status,
    report_inventory: inventory,
  });
  await writeEvidence(input.evidenceDirectory, "summary.json", summary);
  return Object.freeze({ summary, readiness, counts, permit, graph, segmentation, roles, nonOperativeProof });
}
