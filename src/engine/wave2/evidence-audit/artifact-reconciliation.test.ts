import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWave1ArtifactReconciliation } from "./artifact-reconciliation.ts";

describe("Wave 1 artifact reconciliation", () => {
  it("reconciles source-pack, corpus, quarantine and ledger counts without conflation", async () => {
    const report = await buildWave1ArtifactReconciliation({
      repo_root: path.resolve("."),
      evidence_repo_root: "C:\\dev\\tivdoc\\salary",
      source_pack_root: "C:\\dev\\tivdoc-wave1-working-time-permits\\output\\legal-knowledge\\wave1-working-time-permits",
    });
    expect(report.count_meaning).toMatchObject({
      law_publication_records: 20,
      permit_catalog_records: 58,
      permit_artifact_urls_only: 68,
      combined_distinct_artifact_urls: 88,
    });
    expect(report.acquired_files).toHaveLength(72);
    expect(report.remaining_gaps.http_403).toHaveLength(15);
    expect(report.remaining_gaps.http_404).toHaveLength(1);
    expect(report.remaining_gaps.http_404[0].artifact_id).toContain("premit-8753");
    expect(report.quarantine_partition.challenge_observations_505_bytes).toHaveLength(3);
    expect(report.quarantine_partition.unavailable_observations).toHaveLength(1);
    expect(report.change_detection_partition).toMatchObject({
      detections_total: 5,
      automatic_promotions: 0,
    });
    expect(report.change_detection_partition.unreviewed_byte_changes).toHaveLength(3);
    expect(report.change_detection_partition.rejected_challenge_observations).toHaveLength(2);
    expect(report.category_reconciliation).toMatchObject({
      registered_corpus_raw_artifacts: 20,
      acquisition_source_pack_artifacts: 72,
      persistent_import_ledger_entries: 0,
      test_only_ledger_entries_retained: 0,
    });
    expect(report.invariants).toMatchObject({ reviewed_sources: 0, active_sources: 0 });
  }, 30_000);
});
