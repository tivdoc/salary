import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  normalizeRelative,
  readJson,
  requireSafeRelative,
  sha256,
  stableJson,
} from "./common.ts";
import { assertNoProhibitedCustomerPath } from "./runtime-denial.ts";

type PublicationEntry = Readonly<{
  publication_ordinal: number;
  publication_identity: string;
  publication_kind: string;
  official_detail_url: string;
  official_artifact_url: string;
  publication_date: string;
  artifact_status: string;
  discovery_evidence: string;
}>;

type PermitArtifactLink = Readonly<{
  artifact_id: string;
  official_url: string;
  artifact_status: string;
}>;

type PermitEntry = Readonly<{
  catalog_ordinal: number;
  page: number;
  page_item: number;
  stable_id: string;
  catalog_url: string;
  artifact_links: readonly PermitArtifactLink[];
  relevance: string;
  discovery_evidence: string;
}>;

type AcquisitionResult = Readonly<{
  ordinal: number;
  collection: "hours_publications" | "work_permits";
  artifact_id: string;
  official_url: string;
  acquisition_state: string;
  review_state?: string;
  activation_state?: string;
  final_url?: string;
  content_type?: string;
  byte_count?: number;
  artifact_sha256?: string;
  local_path?: string;
  safe_error_code?: string;
}>;

type FetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  final_url: string;
  content_type: string;
  byte_count: number;
  artifact_path: string;
  status: string;
  parse_status: string;
  safe_error_code: string | null;
}>;

type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  parse_status: string;
  chunk_count: number;
}>;

type ManifestSource = Readonly<{
  source_id: string;
  source_version: string;
  status: string;
  content_sha256: string | null;
}>;

type ReconciliationPaths = Readonly<{
  repo_root: string;
  evidence_repo_root: string;
  source_pack_root: string;
}>;

function assertArray<T>(value: unknown, code: string): asserts value is T[] {
  if (!Array.isArray(value)) throw new Error(code);
}

function acquisitionObservationId(result: AcquisitionResult) {
  const digest = createHash("sha256").update(stableJson({
    artifact_id: result.artifact_id,
    collection: result.collection,
    official_url: result.official_url,
    acquisition_state: result.acquisition_state,
    artifact_sha256: result.artifact_sha256 ?? null,
    safe_error_code: result.safe_error_code ?? null,
  })).digest("hex");
  return `ACQOBS:WAVE1:${digest.slice(0, 32)}`;
}

async function ledgerEntryCount(ledgerRoot: string) {
  if (!existsSync(ledgerRoot)) return 0;
  return (await readdir(ledgerRoot)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).length;
}

function isChallengeObservation(observation: FetchObservation) {
  return observation.byte_count === 505
    && observation.content_type.toLowerCase().includes("text/html")
    && observation.source_id === "IL_HOURS_WORK_REST_LAW";
}

function selectedCorpusRegistration(
  result: AcquisitionResult,
  observations: readonly FetchObservation[],
  sources: readonly ManifestSource[],
) {
  if (!result.artifact_sha256) {
    return {
      status: "not_registered",
      reason: `artifact_not_acquired:${result.safe_error_code ?? "unknown"}`,
      source_version_id: null,
    } as const;
  }
  const observation = observations.find((candidate) => (
    candidate.artifact_sha256 === result.artifact_sha256
    && candidate.final_url.toLowerCase() === (result.final_url ?? result.official_url).toLowerCase()
  ));
  const source = observation
    ? sources.find((candidate) => candidate.source_id === observation.source_id && candidate.source_version === observation.source_version)
    : undefined;
  if (observation && source && source.content_sha256 === result.artifact_sha256) {
    return {
      status: "registered_selected_raw_artifact",
      reason: "exact_url_hash_and_manifest_source_version_match",
      source_version_id: `${source.source_id}@${source.source_version}`,
    } as const;
  }
  return {
    status: "not_registered",
    reason: "acquisition_only_staged_pending_source_model_provenance_and_human_review",
    source_version_id: null,
  } as const;
}
async function verifyAcquiredFile(input: Readonly<{
  result: AcquisitionResult;
  source_pack_root: string;
  review_package_root: string;
  observations: readonly FetchObservation[];
  sources: readonly ManifestSource[];
}>) {
  const result = input.result;
  if (
    !result.local_path
    || !result.artifact_sha256
    || typeof result.byte_count !== "number"
    || !result.content_type
    || !result.final_url
  ) throw new Error(`acquired_result_incomplete:${result.artifact_id}`);
  const relative = requireSafeRelative(result.local_path, "source_pack_path_invalid");
  const sourcePath = path.resolve(input.source_pack_root, ...relative.split("/"));
  const packageRelative = `worker-evidence/batch-a-working-time-permits/${relative}`;
  const packagePath = path.resolve(input.review_package_root, ...packageRelative.split("/"));
  const [bytes, packagedBytes] = await Promise.all([readFile(sourcePath), readFile(packagePath)]);
  const mediaValid = bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    && result.content_type.toLowerCase().startsWith("application/pdf");
  const actualHash = sha256(bytes);
  const packageHash = sha256(packagedBytes);
  const byteCount = (await stat(sourcePath)).size;
  if (actualHash !== result.artifact_sha256) throw new Error(`source_pack_hash_mismatch:${result.artifact_id}`);
  if (packageHash !== actualHash || !bytes.equals(packagedBytes)) throw new Error(`review_package_member_mismatch:${result.artifact_id}`);
  if (byteCount !== result.byte_count) throw new Error(`source_pack_size_mismatch:${result.artifact_id}`);
  if (!mediaValid) throw new Error(`source_pack_media_validation_failed:${result.artifact_id}`);
  return {
    artifact_id: result.artifact_id,
    collection: result.collection,
    official_url: result.official_url,
    final_url: result.final_url,
    acquisition_observation_id: acquisitionObservationId(result),
    observation_id_semantics: "deterministic_audit_identifier_derived_from_original_acquisition_record",
    artifact_sha256: actualHash,
    byte_count: byteCount,
    declared_media_type: result.content_type,
    media_validation: { pdf_magic: true, declared_pdf: true, passed: true },
    source_pack_location: normalizeRelative(path.relative(input.source_pack_root, sourcePath)),
    immutable_evidence_location: `review-package-v0.3.zip!/${packageRelative}`,
    review_package_member_sha256: packageHash,
    corpus_registration: selectedCorpusRegistration(result, input.observations, input.sources),
    review_state: result.review_state ?? "needs_review",
    activation_state: result.activation_state ?? "inactive",
  };
}

export async function buildWave1ArtifactReconciliation(paths: ReconciliationPaths) {
  for (const candidate of [paths.repo_root, paths.evidence_repo_root, paths.source_pack_root]) {
    assertNoProhibitedCustomerPath(candidate);
  }
  const repoRoot = path.resolve(paths.repo_root);
  const evidenceRepoRoot = path.resolve(paths.evidence_repo_root);
  const sourcePackRoot = path.resolve(paths.source_pack_root);
  const legalRoot = path.join(evidenceRepoRoot, "eval", "legal-knowledge");
  const wave1PackageRoot = path.join(evidenceRepoRoot, "output", "parallel-wave-1", "review-package-v0.3");
  const v02PackageRoot = path.join(evidenceRepoRoot, "output", "legal-knowledge", "review-package-v0.2");
  const publicationsPath = path.join(repoRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-publications.v0.3.json");
  const permitsPath = path.join(repoRoot, "src", "server", "engine", "legal-knowledge", "wave1-working-time-permits-catalog.v0.3.json");
  const reportPath = path.join(sourcePackRoot, "artifact-acquisition-report.json");
  const ownerHandoffPath = path.join(sourcePackRoot, "owner-handoff.json");
  const manifestPath = path.join(repoRoot, "src", "server", "engine", "legal-knowledge", "legal-sources.v0.json");
  const browserPath = path.join(repoRoot, "src", "server", "engine", "legal-knowledge", "legal-browser-observations.v0.2.json");
  const fetchStatePath = path.join(legalRoot, "manifests", "fetch-state.json");
  const buildStatePath = path.join(legalRoot, "manifests", "build-state.json");
  const diffReportPath = path.join(evidenceRepoRoot, "output", "parallel-wave-1", "review-package-v0.3", "central-legal-evidence", "source-byte-diff-report.json");

  const [
    publicationDocument,
    permitDocument,
    acquisitionDocument,
    ownerHandoff,
    manifest,
    browserDocument,
    fetchState,
    buildState,
    diffReport,
    v02Inventory,
  ] = await Promise.all([
    readJson<{ entries: PublicationEntry[]; snapshot: Record<string, unknown> }>(publicationsPath),
    readJson<{ entries: PermitEntry[]; snapshot: Record<string, unknown> }>(permitsPath),
    readJson<{ results: AcquisitionResult[]; requested_count: number; acquired_count: number; failed_count: number }>(reportPath),
    readJson<{ artifact_failures: Array<{ artifact_id: string; official_url: string; safe_error_code: string }> }>(ownerHandoffPath),
    readJson<{ sources: ManifestSource[] }>(manifestPath),
    readJson<{ observations: Array<{ catalog_observation_id: string; status: string; entries_observed: unknown[] }> }>(browserPath),
    readJson<{ observations: FetchObservation[]; failures: Array<Record<string, unknown>> }>(fetchStatePath),
    readJson<{ records: BuildRecord[] }>(buildStatePath),
    readJson<{ records: Array<{ candidates: Array<{ byte_count: number; raw_sha256: string; technical_classification: string }> }> }>(diffReportPath),
    readJson<{ counts: Record<string, number> }>(path.join(v02PackageRoot, "source-inventory.json")),
  ]);
  for (const [value, code] of [
    [publicationDocument.entries, "publications_not_array"],
    [permitDocument.entries, "permits_not_array"],
    [acquisitionDocument.results, "acquisition_results_not_array"],
    [fetchState.observations, "fetch_observations_not_array"],
    [buildState.records, "build_records_not_array"],
  ] as const) assertArray(value, code);

  const publications = [...publicationDocument.entries].sort((a, b) => a.publication_ordinal - b.publication_ordinal);
  const permits = [...permitDocument.entries].sort((a, b) => a.catalog_ordinal - b.catalog_ordinal);
  const permitLinks = permits.flatMap((entry) => entry.artifact_links.map((artifact) => ({ entry, artifact })));
  const results = [...acquisitionDocument.results].sort((a, b) => (
    a.collection.localeCompare(b.collection) || a.ordinal - b.ordinal
  ));
  const resultByArtifact = new Map(results.map((result) => [result.artifact_id, result]));
  const lawUrls = new Set(publications.map((entry) => entry.official_artifact_url));
  const permitUrls = new Set(permitLinks.map(({ artifact }) => artifact.official_url));
  const combinedUrls = new Set([...lawUrls, ...permitUrls]);
  if (publications.length !== 20 || lawUrls.size !== 20) throw new Error("working_time_publication_reconciliation_failed");
  if (permits.length !== 58 || permitLinks.length !== 68 || permitUrls.size !== 68) throw new Error("permit_catalog_reconciliation_failed");
  if (combinedUrls.size !== 88) throw new Error("combined_url_reconciliation_failed");
  if (results.length !== 88 || acquisitionDocument.requested_count !== 88) throw new Error("acquisition_request_count_mismatch");

  const acquiredResults = results.filter((result) => result.acquisition_state === "acquired_raw_unreviewed");
  const failedResults = results.filter((result) => result.acquisition_state !== "acquired_raw_unreviewed");
  if (acquiredResults.length !== 72 || failedResults.length !== 16) throw new Error("acquisition_partition_mismatch");
  const acquiredFiles = await Promise.all(acquiredResults.map((result) => verifyAcquiredFile({
    result,
    source_pack_root: sourcePackRoot,
    review_package_root: wave1PackageRoot,
    observations: fetchState.observations,
    sources: manifest.sources,
  })));

  const publicationsCrosswalk = publications.map((entry) => {
    const result = resultByArtifact.get(entry.publication_identity);
    if (!result) throw new Error(`publication_acquisition_missing:${entry.publication_identity}`);
    return {
      publication_ordinal: entry.publication_ordinal,
      publication_identity: entry.publication_identity,
      publication_kind: entry.publication_kind,
      publication_date: entry.publication_date,
      official_detail_url: entry.official_detail_url,
      official_artifact_url: entry.official_artifact_url,
      discovery_evidence: entry.discovery_evidence,
      acquisition_observation_id: acquisitionObservationId(result),
      acquisition_state: result.acquisition_state,
      artifact_sha256: result.artifact_sha256 ?? null,
      corpus_registration: selectedCorpusRegistration(result, fetchState.observations, manifest.sources),
    };
  });

  const permitCrosswalk = permits.map((entry) => ({
    catalog_ordinal: entry.catalog_ordinal,
    page: entry.page,
    page_item: entry.page_item,
    stable_id: entry.stable_id,
    catalog_url: entry.catalog_url,
    discovery_evidence: entry.discovery_evidence,
    relevance: entry.relevance,
    artifacts: entry.artifact_links.map((artifact) => {
      const result = resultByArtifact.get(artifact.artifact_id);
      if (!result) throw new Error(`permit_acquisition_missing:${artifact.artifact_id}`);
      return {
        artifact_id: artifact.artifact_id,
        official_url: artifact.official_url,
        acquisition_observation_id: acquisitionObservationId(result),
        acquisition_state: result.acquisition_state,
        safe_error_code: result.safe_error_code ?? null,
        artifact_sha256: result.artifact_sha256 ?? null,
        corpus_registration: selectedCorpusRegistration(result, fetchState.observations, manifest.sources),
      };
    }),
  }));

  const urlMappings = [
    ...publications.map((entry) => ({
      official_url: entry.official_artifact_url,
      collection: "hours_publications",
      logical_record_ids: [entry.publication_identity],
    })),
    ...permitLinks.map(({ entry, artifact }) => ({
      official_url: artifact.official_url,
      collection: "work_permits",
      logical_record_ids: [entry.stable_id, artifact.artifact_id],
    })),
  ].sort((left, right) => left.official_url.localeCompare(right.official_url));

  const gaps = failedResults.map((result) => ({
    artifact_id: result.artifact_id,
    collection: result.collection,
    official_url: result.official_url,
    acquisition_observation_id: acquisitionObservationId(result),
    safe_error_code: result.safe_error_code ?? "unknown",
    corpus_registration: selectedCorpusRegistration(result, fetchState.observations, manifest.sources),
  }));
  const gap403 = gaps.filter((gap) => gap.safe_error_code === "http_status_403");
  const gap404 = gaps.filter((gap) => gap.safe_error_code === "http_status_404");
  if (gap403.length !== 15 || gap404.length !== 1) throw new Error("owner_handoff_gap_partition_mismatch");
  if (ownerHandoff.artifact_failures.length !== 16) throw new Error("owner_handoff_file_count_mismatch");
  const exact404 = gap404[0];
  if (!exact404.artifact_id.includes("premit-8753") || !exact404.official_url.includes("premit-8753")) {
    throw new Error("permit_8753_exact_catalog_value_not_preserved");
  }

  // The fetch state is append-only across acquisition runs, so a raw row count
  // drifts every time a source is legitimately re-acquired. The partition is
  // derived from the latest observation per source version and compared with a
  // committed baseline, which is what makes this reproducible rather than
  // dependent on mutable untracked local state.
  const observationKey = (entry: { source_id: string; source_version: string }) =>
    `${entry.source_id}@${entry.source_version}`;
  const latestObservation = new Map<string, FetchObservation>();
  for (const observation of fetchState.observations) latestObservation.set(observationKey(observation), observation);
  const unavailableKeys = [...new Set(fetchState.failures.map((failure) => observationKey(failure as never)))].sort();
  const unavailable = unavailableKeys.map((sourceVersionId) => ({
    source_version_id: sourceVersionId,
    safe_error_codes: [...new Set(fetchState.failures
      .filter((failure) => observationKey(failure as never) === sourceVersionId)
      .map((failure) => String((failure as Record<string, unknown>).safe_error_code ?? "unknown")))].sort(),
  }));
  // Quarantine is historical evidence: a challenge page stays recorded even
  // after a later attempt succeeds, so it is counted over every row.
  const challenges = fetchState.observations.filter(isChallengeObservation);
  const derivedPartition = [...latestObservation.entries()]
    .map(([sourceVersionId, observation]) => ({
      source_version_id: sourceVersionId,
      disposition: isChallengeObservation(observation)
        ? "quarantined"
        : (observation as unknown as { status?: string }).status === "content_change_review_required"
          ? "pending_change_review"
          : "current_valid",
      artifact_sha256: (observation as unknown as { artifact_sha256?: string }).artifact_sha256 ?? null,
    }))
    .sort((left, right) => left.source_version_id.localeCompare(right.source_version_id));

  const partitionBaseline = await readJson<{
    distinct_source_versions: number;
    entries: Array<{ source_version_id: string; disposition: string; artifact_sha256: string | null }>;
    historical_quarantine_observations: Array<{ source_version_id: string }>;
    unavailable_source_versions: Array<{ source_version_id: string }>;
    diff_ledger_expectation: {
      unreviewed_byte_change: number;
      rejected_challenge_observation: number;
      detections_total: number;
    };
  }>(path.join(repoRoot, "src", "engine", "wave2", "evidence-audit", "wave1-artifact-partition.v0.10.9.json"));

  const baselineKeys = new Set(partitionBaseline.entries.map((entry) => entry.source_version_id));
  const derivedKeys = new Set(derivedPartition.map((entry) => entry.source_version_id));
  const unaccounted = [...derivedKeys].filter((key) => !baselineKeys.has(key));
  const dropped = [...baselineKeys].filter((key) => !derivedKeys.has(key));
  const doubleCounted = derivedPartition.length !== derivedKeys.size;
  const dispositionDrift = derivedPartition.filter((entry) => {
    const expected = partitionBaseline.entries.find((row) => row.source_version_id === entry.source_version_id);
    return !expected
      || expected.disposition !== entry.disposition
      || expected.artifact_sha256 !== entry.artifact_sha256;
  });
  const overlap = unavailableKeys.filter((key) => {
    const observed = latestObservation.get(key);
    if (observed === undefined || isChallengeObservation(observed)) return false;
    return (observed as unknown as { status?: string }).status !== "content_change_review_required";
  });

  const diffCandidates = diffReport.records.flatMap((record) => record.candidates);
  const byteChanges = diffCandidates.filter((candidate) => candidate.technical_classification === "unreviewed_byte_change");
  const rejectedChallenges = diffCandidates.filter((candidate) => candidate.technical_classification === "rejected_challenge_observation");
  const pendingChangeReview = derivedPartition.filter((entry) => entry.disposition === "pending_change_review");

  if (
    unaccounted.length > 0
    || dropped.length > 0
    || doubleCounted
    || dispositionDrift.length > 0
    || derivedPartition.length !== partitionBaseline.distinct_source_versions
    || challenges.length !== partitionBaseline.historical_quarantine_observations.length
    || !challenges.every((entry) => entry.byte_count === 505)
    || unavailable.length !== partitionBaseline.unavailable_source_versions.length
    || overlap.length > 0
    // The diff ledger records what changed; the fetch state must agree with it
    // rather than each side carrying its own hardcoded number.
    || byteChanges.length !== pendingChangeReview.length
    || byteChanges.length !== partitionBaseline.diff_ledger_expectation.unreviewed_byte_change
    || rejectedChallenges.length !== partitionBaseline.diff_ledger_expectation.rejected_challenge_observation
    || diffCandidates.length !== partitionBaseline.diff_ledger_expectation.detections_total
    || diffCandidates.length !== byteChanges.length + rejectedChallenges.length
  ) throw new Error("quarantine_or_change_partition_mismatch");

  const validRawArtifacts = [...latestObservation.values()].filter((observation) => !isChallengeObservation(observation));
  const currentCounts = {
    registry_records: manifest.sources.length,
    fetch_observation_records: latestObservation.size,
    fetch_failure_records: unavailable.length,
    fetch_attempt_records_combined: latestObservation.size + unavailable.length,
    valid_raw_artifact_versions: validRawArtifacts.length,
    quarantined_observations: challenges.length,
    quarantined_or_unavailable: challenges.length + unavailable.length,
    legal_text_versions: buildState.records.length,
    parsed_versions: buildState.records.filter((record) => record.parse_status === "parsed").length,
    parse_failed_versions: buildState.records.filter((record) => record.parse_status !== "parsed").length,
    chunks: buildState.records.reduce((sum, record) => sum + record.chunk_count, 0),
    browser_catalog_observations_runtime: 6,
    persistent_owner_import_ledger_entries: await ledgerEntryCount(path.join(legalRoot, "acquisition", "ledger")),
    test_only_ledger_entries_retained: 0,
    source_pack_acquired_artifacts: acquiredFiles.length,
    source_pack_failed_artifacts: gaps.length,
    change_detections: diffCandidates.length,
    actual_unreviewed_byte_change_candidates: byteChanges.length,
    rejected_challenge_detections: rejectedChallenges.length,
  };
  const expectedCurrent = {
    registry_records: 17,
    fetch_observation_records: 17,
    fetch_failure_records: 1,
    valid_raw_artifact_versions: 17,
    quarantined_or_unavailable: 4,
    legal_text_versions: 17,
    parsed_versions: 14,
    parse_failed_versions: 3,
    chunks: 202,
    persistent_owner_import_ledger_entries: 0,
  };
  for (const [key, expected] of Object.entries(expectedCurrent)) {
    if (currentCounts[key as keyof typeof currentCounts] !== expected) throw new Error(`current_count_mismatch:${key}`);
  }
  const baseCatalogCount = browserDocument.observations.length;
  if (baseCatalogCount !== 6) throw new Error("browser_observation_count_mismatch");

  const beforeAfter = {
    before_v0_2_package: v02Inventory.counts,
    after_wave1_reported_baseline: {
      parsed_versions: 16,
      parse_failed_versions: 1,
      chunks: 274,
    },
    after_wave21_canonical_enforcement: currentCounts,
    explained_deltas: {
      registry_records: { before: v02Inventory.counts.registry_records, after: 17, reason: "one separately registered 2025 convalescence-law discovery record" },
      valid_raw_artifact_versions: { before: v02Inventory.counts.valid_raw_artifact_versions, after: 20, reason: "one exact 2025 official PDF artifact added" },
      legal_text_versions: { before: v02Inventory.counts.legal_text_versions, after: 17, reason: "one separately modeled 2025 legal-text version" },
      parsed_versions: { before: 16, after: 14, reason: "two multi-instrument container sources now fail closed until instrument selectors receive human review; Pension 2016 remains failed closed" },
      parse_failed_versions: { before: 1, after: 3, reason: "the two selector-pending sources moved from parsed to fail-closed without changing the 17 registered legal versions" },
      chunks: { before: 274, after: 202, reason: "the convalescence container changed from 65 to 11 instrument-bound chunks and 18 chunks from two selector-pending sources became ineligible; stable-ID mapping is retained in Wave 2.1 evidence" },
    },
  };

  const reportWithoutHash = {
    schema_version: "tivdoc-wave1-artifact-reconciliation-v0.4.1",
    evidence_inputs: {
      tracked_publication_inventory_sha256: sha256(await readFile(publicationsPath)),
      tracked_permit_inventory_sha256: sha256(await readFile(permitsPath)),
      source_pack_report_sha256: sha256(await readFile(reportPath)),
      owner_handoff_sha256: sha256(await readFile(ownerHandoffPath)),
      fetch_state_sha256: sha256(await readFile(fetchStatePath)),
      build_state_sha256: sha256(await readFile(buildStatePath)),
      source_diff_report_sha256: sha256(await readFile(diffReportPath)),
    },
    count_meaning: {
      law_publication_records: 20,
      permit_catalog_records: 58,
      permit_artifact_urls_only: 68,
      law_publication_artifact_urls: 20,
      combined_distinct_artifact_urls: 88,
      clarification: "The reported 68 unique URLs cover only permit attachments; the 20 law-publication URLs are separate.",
    },
    before_after: beforeAfter,
    category_reconciliation: {
      registered_corpus_raw_artifacts: currentCounts.valid_raw_artifact_versions,
      selected_manifest_source_versions: manifest.sources.length,
      acquisition_source_pack_artifacts: acquiredFiles.length,
      acquisition_source_pack_is_not_corpus_registration: true,
      browser_catalog_observations: currentCounts.browser_catalog_observations_runtime,
      persistent_import_ledger_entries: currentCounts.persistent_owner_import_ledger_entries,
      test_only_ledger_entries_retained: 0,
      test_only_ledger_note: "The Wave 1 E2E test instance was ephemeral and cleaned; it did not enter the persistent owner ledger.",
      quarantine_observations: challenges.length,
      unavailable_fetch_records: unavailable.length,
      change_detections: diffCandidates.length,
      actual_byte_change_candidates: byteChanges.length,
      rejected_challenge_detections: rejectedChallenges.length,
    },
    quarantine_partition: {
      challenge_observations_505_bytes: challenges.map((entry) => ({
        artifact_sha256: entry.artifact_sha256,
        byte_count: entry.byte_count,
        parse_status: entry.parse_status,
        safe_error_code: entry.safe_error_code,
      })),
      unavailable_observations: unavailable,
      total: challenges.length + unavailable.length,
    },
    change_detection_partition: {
      detections_total: diffCandidates.length,
      unreviewed_byte_changes: byteChanges,
      rejected_challenge_observations: rejectedChallenges,
      automatic_promotions: 0,
    },
    working_time_publications: publicationsCrosswalk,
    permit_catalog_records: permitCrosswalk,
    url_mappings: urlMappings,
    acquired_files: acquiredFiles,
    remaining_gaps: {
      total: gaps.length,
      http_403: gap403,
      http_404: gap404,
      exact_404_catalog_value: "premit-8753",
      owner_handoff_required: true,
    },
    invariants: {
      reviewed_sources: manifest.sources.filter((source) => source.status === "reviewed").length,
      active_sources: manifest.sources.filter((source) => source.status === "active").length,
      corpus_meaning_mutated_by_audit: false,
      source_status_mutated_by_audit: false,
    },
  };
  return {
    ...reportWithoutHash,
    report_content_sha256: sha256(stableJson(reportWithoutHash)),
  } as const;
}
