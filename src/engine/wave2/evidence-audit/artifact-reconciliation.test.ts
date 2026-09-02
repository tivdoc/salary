import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWave1ArtifactReconciliation } from "./artifact-reconciliation.ts";

const RECONCILIATION_PATHS = {
  repo_root: path.resolve("."),
  evidence_repo_root: "C:\\dev\\tivdoc\\salary",
  source_pack_root: "C:\\dev\\tivdoc-wave1-working-time-permits\\output\\legal-knowledge\\wave1-working-time-permits",
} as const;

describe("Wave 1 artifact reconciliation", () => {
  it("reconciles source-pack, corpus, quarantine and ledger counts without conflation", async () => {
    const report = await buildWave1ArtifactReconciliation(RECONCILIATION_PATHS);
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
      registered_corpus_raw_artifacts: 17,
      acquisition_source_pack_artifacts: 72,
      persistent_import_ledger_entries: 0,
      test_only_ledger_entries_retained: 0,
    });
    expect(report.invariants).toMatchObject({ reviewed_sources: 0, active_sources: 0 });
  }, 30_000);
  it("fails when an observation is dropped, added or double counted", async () => {
    const baselinePath = path.resolve("src/engine/wave2/evidence-audit/wave1-artifact-partition.v0.10.9.json");
    const original = await readFile(baselinePath, "utf8");
    const baseline = JSON.parse(original) as {
      distinct_source_versions: number;
      entries: Array<{ source_version_id: string; disposition: string; artifact_sha256: string | null }>;
    };
    const build = () => buildWave1ArtifactReconciliation(RECONCILIATION_PATHS);
    const mutations = [
      { name: "dropped", value: { ...baseline, entries: baseline.entries.slice(1) } },
      {
        name: "added",
        value: {
          ...baseline,
          entries: [...baseline.entries, { source_version_id: "IL_INVENTED@v9", disposition: "current_valid", artifact_sha256: null }],
        },
      },
      {
        name: "reclassified",
        value: {
          ...baseline,
          entries: baseline.entries.map((entry, index) => index === 0
            ? { ...entry, disposition: entry.disposition === "current_valid" ? "pending_change_review" : "current_valid" }
            : entry),
        },
      },
    ];
    try {
      for (const mutation of mutations) {
        await writeFile(baselinePath, `${JSON.stringify(mutation.value, null, 2)}
`, "utf8");
        await expect(build(), mutation.name).rejects.toThrow(/quarantine_or_change_partition_mismatch/u);
      }
    } finally {
      await writeFile(baselinePath, original, "utf8");
    }
    await expect(build()).resolves.toBeDefined();
  }, 60_000);
});
