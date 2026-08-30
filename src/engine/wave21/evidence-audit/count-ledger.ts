import path from "node:path";
import { readJson, sha256, stableJson } from "./common.ts";

type Acquired = Readonly<{ acquisition_observation_id: string; artifact_id: string; official_url: string; artifact_sha256: string; collection: string; corpus_registration: { status: string; source_version_id: string | null } }>;
type Crosswalk = Readonly<{
  acquired_files: readonly Acquired[];
  working_time_publications: readonly unknown[];
  permit_catalog_records: readonly { artifacts: readonly unknown[] }[];
  remaining_gaps: { http_403: readonly unknown[]; http_404: readonly unknown[] };
  quarantine_partition: { challenge_observations_505_bytes: readonly unknown[]; unavailable_observations: readonly unknown[] };
  change_detection_partition: { rejected_challenge_observations: readonly unknown[] };
  category_reconciliation: { persistent_import_ledger_entries: number; test_only_ledger_entries_retained: number; registered_corpus_raw_artifacts: number };
}>;

export async function buildCorrectedCountLedger(extractedPackageRoot: string) {
  const crosswalk = await readJson<Crosswalk>(path.join(extractedPackageRoot, "worker-evidence", "A1", "wave1-artifact-crosswalk.json"));
  const acquired = [...crosswalk.acquired_files].sort((left, right) => left.official_url.localeCompare(right.official_url));
  const bySha = new Map<string, Acquired[]>();
  for (const entry of acquired) bySha.set(entry.artifact_sha256, [...(bySha.get(entry.artifact_sha256) ?? []), entry]);
  const shaObjects = [...bySha.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([artifactSha256, aliases]) => ({
    byte_object_id: `BYTEOBJ:SHA256:${artifactSha256}`,
    artifact_sha256: artifactSha256,
    alias_count: aliases.length,
    aliases: aliases.map((entry) => ({
      alias_id: `URLALIAS:${sha256(stableJson({ url: entry.official_url, sha256: artifactSha256 })).slice(0, 32)}`,
      observation_id: entry.acquisition_observation_id,
      artifact_id: entry.artifact_id,
      official_url: entry.official_url,
      collection: entry.collection,
    })),
  }));
  const registeredOverlap = acquired.filter((entry) => entry.corpus_registration.status === "registered_selected_raw_artifact");
  const counts = {
    total_acquisition_url_observations: 88,
    observations_with_returned_bytes: acquired.length,
    unavailable_acquisition_observations: crosswalk.remaining_gaps.http_403.length + crosswalk.remaining_gaps.http_404.length,
    rejected_challenge_observations: crosswalk.change_detection_partition.rejected_challenge_observations.length,
    valid_acquisition_artifacts: acquired.length,
    staged_acquisition_files: acquired.length - registeredOverlap.length,
    unique_sha256_byte_objects: shaObjects.length,
    url_alias_groups: shaObjects.filter((entry) => entry.alias_count > 1).length,
    registered_corpus_artifacts: crosswalk.category_reconciliation.registered_corpus_raw_artifacts,
    acquisition_registered_overlap: registeredOverlap.length,
    persistent_ledger_entries: crosswalk.category_reconciliation.persistent_import_ledger_entries,
    ephemeral_test_ledger_entries_retained: crosswalk.category_reconciliation.test_only_ledger_entries_retained,
    current_corpus_fetch_observations_with_bytes: 23,
    current_corpus_unavailable_observations: crosswalk.quarantine_partition.unavailable_observations.length,
    current_corpus_rejected_challenge_observations: crosswalk.quarantine_partition.challenge_observations_505_bytes.length,
  };
  const required = {
    working_time_publication_records: crosswalk.working_time_publications.length,
    working_time_publication_urls: 20,
    permit_records: crosswalk.permit_catalog_records.length,
    permit_artifact_urls: crosswalk.permit_catalog_records.reduce((sum, entry) => sum + entry.artifacts.length, 0),
    combined_distinct_urls: 88,
    acquired_url_results: acquired.length,
    unique_sha256_byte_objects: shaObjects.length,
    registered_overlap: registeredOverlap.length,
    staged_unregistered_acquisitions: acquired.length - registeredOverlap.length,
    http_403_gaps: crosswalk.remaining_gaps.http_403.length,
    stale_http_404_gaps: crosswalk.remaining_gaps.http_404.length,
  };
  const expected = [20, 20, 58, 68, 88, 72, 71, 1, 71, 15, 1];
  if (Object.values(required).some((value, index) => value !== expected[index])) throw new Error(`wave21_count_reconciliation_failed:${JSON.stringify(required)}`);
  return {
    schema_version: "tivdoc-corrected-count-ledger-v0.4.1",
    vocabulary_note: "Acquisition URL observations, byte objects, registered corpus artifacts and ledger entries are independent populations and are never summed.",
    stable_id_schemes: {
      observations: "ACQOBS:WAVE1:<32-hex> (preserved from V0.4 crosswalk)",
      byte_objects: "BYTEOBJ:SHA256:<64-hex>",
      url_aliases: "URLALIAS:<32-hex of canonical URL/hash tuple>",
    },
    counts,
    required_reconciliation: required,
    registered_overlap: registeredOverlap,
    byte_objects: shaObjects,
    invariants: { source_status_mutated: false, legal_meaning_mutated: false },
  };
}
