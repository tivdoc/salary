import { describe, expect, it } from "vitest";
import { reconcileCorpusCounts } from "./corpus-hardening-evidence.ts";

describe("corpus count reconciliation", () => {
  it("keeps registered and staged inventories distinct with identity mapping", () => {
    const report = reconcileCorpusCounts({
      sourceVersionIds: ["SYN_A@v1", "SYN_B@v1"],
      fetchState: {
        observations: [
          { source_id: "SYN_A", source_version: "v1", artifact_sha256: "a".repeat(64), content_type: "application/pdf", byte_count: 100, parse_status: "parsed", safe_error_code: null },
          { source_id: "SYN_B", source_version: "v1", artifact_sha256: "b".repeat(64), content_type: "text/html", byte_count: 505, parse_status: "parse_failed", safe_error_code: "html_challenge_or_error_page" },
        ],
        failures: [{}],
      },
      buildRecords: [{ source_id: "SYN_A", source_version: "v1", artifact_sha256: "a".repeat(64), parsed_version_id: "SYN_A@v1#parsed", parse_status: "parsed", chunk_count: 2 }],
      stagedPublicationCount: 20,
      stagedPermitRecordCount: 58,
      stagedPermitArtifactUrlCount: 68,
    });
    expect(report.before).toEqual(report.after);
    expect(report.before).toMatchObject({ observations_including_unavailable: 3, quarantined_or_unavailable_observations: 2, valid_raw_artifact_observations: 1, corpus_version_records: 1, chunks: 2 });
    expect(report.staged_acquisition_inventory).toMatchObject({ working_time_publication_records: 20, permit_catalog_records: 58, permit_unique_artifact_urls: 68, counted_as_corpus_versions: false });
    expect(report.one_to_one_source_version_mapping).toHaveLength(2);
  });
});
