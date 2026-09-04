// B-0. The Wave-1 artifact partition is DERIVED from the recorded ledger, never
// hand-edited to match. Before this module the committed baseline had no writer
// anywhere in the repository — it was authored once by hand, and every
// legitimate corpus change afterwards read as tampering because the only way to
// move it was to edit it, which is exactly what its own tamper test forbids.
//
// This builder closes that loop: it reads the append-only fetch state and the
// byte-diff ledger, restricts them to the frozen Wave-1 scope, and emits the
// document. It deliberately does NOT read the file it produces — a builder that
// consults its own previous output cannot detect that the ledger moved.
import path from "node:path";
import { readJson } from "./common.ts";
import { WAVE1_PARTITION_SCOPE, inWave1PartitionScope, wave1SourceVersionId } from "./wave1-partition-scope.ts";

export const WAVE1_ARTIFACT_PARTITION_RELATIVE_PATH =
  "src/engine/wave2/evidence-audit/wave1-artifact-partition.v0.10.9.json";

export const WAVE1_ARTIFACT_PARTITION_BUILDER_COMMAND =
  "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/wave2-evidence-audit/build-wave1-artifact-partition.mts";

type FetchObservation = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  content_type: string;
  byte_count: number;
  status: string;
}>;

export type Wave1ArtifactPartitionDocument = Readonly<{
  schema_version: string;
  note: string;
  distinct_source_versions: number;
  entries: ReadonlyArray<{ source_version_id: string; disposition: string; artifact_sha256: string | null }>;
  historical_quarantine_observations: ReadonlyArray<{ source_version_id: string; artifact_sha256: string }>;
  unavailable_source_versions: ReadonlyArray<{ source_version_id: string; disposition: string; safe_error_codes: string[] }>;
  diff_ledger_expectation: Readonly<{
    unreviewed_byte_change: number;
    rejected_challenge_observation: number;
    detections_total: number;
  }>;
}>;

// Kept identical to `artifact-reconciliation.ts`'s own predicate on purpose: a
// challenge page is 505 bytes of HTML served for one source. If that ever needs
// to change it must change in both places and both tests must see it.
function isChallengeObservation(observation: FetchObservation) {
  return observation.byte_count === 505
    && observation.content_type.toLowerCase().includes("text/html")
    && observation.source_id === "IL_HOURS_WORK_REST_LAW";
}

// Declared key order, two-space indent, trailing newline — the shape the
// committed file already had. Not `stableJson`, which sorts keys and would
// rewrite every byte of the file for no reason other than the serializer.
export function serializeWave1ArtifactPartition(document: Wave1ArtifactPartitionDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function buildWave1ArtifactPartitionDocument(repoRoot: string): Promise<Wave1ArtifactPartitionDocument> {
  const legalRoot = path.join(path.resolve(repoRoot), "eval", "legal-knowledge");
  const fetchState = await readJson<{ observations: FetchObservation[]; failures: Array<Record<string, unknown>> }>(
    path.join(legalRoot, "manifests", "fetch-state.json"),
  );
  const diffReport = await readJson<{ records: Array<{ candidates: Array<{ technical_classification: string }> }> }>(
    path.join(
      path.resolve(repoRoot),
      "output", "parallel-wave-1", "review-package-v0.3", "central-legal-evidence", "source-byte-diff-report.json",
    ),
  );

  const scoped = fetchState.observations.filter(inWave1PartitionScope);
  // Append-only ledger: the partition is the LATEST observation per source
  // version, in insertion order, which is what makes a re-acquisition a move
  // rather than a duplicate.
  const latest = new Map<string, FetchObservation>();
  for (const observation of scoped) latest.set(wave1SourceVersionId(observation), observation);

  const missing = [...WAVE1_PARTITION_SCOPE].filter((id) => !latest.has(id)).sort();
  if (missing.length > 0) throw new Error(`wave1_scope_source_version_missing_from_ledger:${missing.join(",")}`);

  const entries = [...latest.entries()]
    .map(([sourceVersionId, observation]) => ({
      source_version_id: sourceVersionId,
      disposition: isChallengeObservation(observation)
        ? "quarantined"
        : observation.status === "content_change_review_required"
          ? "pending_change_review"
          : "current_valid",
      artifact_sha256: observation.artifact_sha256 ?? null,
    }))
    .sort((left, right) => left.source_version_id.localeCompare(right.source_version_id));

  // Quarantine is historical evidence: a challenge page stays counted even
  // after a later attempt for the same source version succeeds, so this walks
  // every row rather than the latest one.
  const historicalQuarantine = scoped
    .filter(isChallengeObservation)
    .map((observation) => ({
      source_version_id: wave1SourceVersionId(observation),
      artifact_sha256: observation.artifact_sha256,
    }));

  const failureKeys = [...new Set(fetchState.failures
    .filter((failure) => inWave1PartitionScope(failure as never))
    .map((failure) => wave1SourceVersionId(failure as never)))].sort();
  const unavailable = failureKeys.map((sourceVersionId) => ({
    source_version_id: sourceVersionId,
    disposition: "unavailable",
    safe_error_codes: [...new Set(fetchState.failures
      .filter((failure) => wave1SourceVersionId(failure as never) === sourceVersionId)
      .map((failure) => String(failure.safe_error_code ?? "unknown")))].sort(),
  }));

  const candidates = diffReport.records.flatMap((record) => record.candidates);
  const diffLedgerExpectation = {
    unreviewed_byte_change: candidates.filter((c) => c.technical_classification === "unreviewed_byte_change").length,
    rejected_challenge_observation: candidates.filter((c) => c.technical_classification === "rejected_challenge_observation").length,
    detections_total: candidates.length,
  };

  return {
    schema_version: "tivdoc-wave1-artifact-partition-v0.10.9",
    note: "Derived partition baseline. Built from the append-only fetch state and the byte-diff ledger, restricted to the frozen Wave-1 scope in wave1-partition-scope.ts. Regenerate with the builder; never hand-edit. Legal baselines are not encoded and are never replaced by this file.",
    distinct_source_versions: entries.length,
    entries,
    historical_quarantine_observations: historicalQuarantine,
    unavailable_source_versions: unavailable,
    diff_ledger_expectation: diffLedgerExpectation,
  };
}
