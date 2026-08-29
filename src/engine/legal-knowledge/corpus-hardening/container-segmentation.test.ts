import { describe, expect, it } from "vitest";
import {
  CONVALESCENCE_2025_SEGMENT,
  createInstrumentContainerContract,
  selectInstrumentChunks,
} from "./container-segmentation.ts";

describe("container versus instrument segmentation", () => {
  it("binds the 2025 convalescence instrument to chapter 7 section 24 only", () => {
    const chunks = [
      { chunk_id: "before", container_artifact_sha256: CONVALESCENCE_2025_SEGMENT.container_artifact_sha256, page: 15, section_id: "chapter-6", text: "unrelated" },
      { chunk_id: "start", container_artifact_sha256: CONVALESCENCE_2025_SEGMENT.container_artifact_sha256, page: 16, section_id: "chapter-7.section-24", text: "included" },
      { chunk_id: "end", container_artifact_sha256: CONVALESCENCE_2025_SEGMENT.container_artifact_sha256, page: 25, section_id: "chapter-7.section-24", text: "included continuation" },
      { chunk_id: "same-page-unrelated", container_artifact_sha256: CONVALESCENCE_2025_SEGMENT.container_artifact_sha256, page: 25, section_id: "chapter-8.section-25", text: "must be excluded" },
      { chunk_id: "after", container_artifact_sha256: CONVALESCENCE_2025_SEGMENT.container_artifact_sha256, page: 26, section_id: "chapter-8.section-25", text: "unrelated" },
    ];
    expect(selectInstrumentChunks(CONVALESCENCE_2025_SEGMENT, chunks).map((chunk) => chunk.chunk_id)).toEqual(["start", "end"]);
    expect(CONVALESCENCE_2025_SEGMENT).toMatchObject({ page_from: 16, page_to: 25, partial_boundary_pages: [16, 25] });
  });

  it.each(["gazette", "amendment_publication", "permit_attachment"] as const)("uses the same fail-closed contract for %s containers", (kind) => {
    const contract = createInstrumentContainerContract({
      container_kind: kind,
      container_artifact_sha256: "a".repeat(64),
      container_page_count: 3,
      source_version_id: "SYNTHETIC@v1",
      instrument_id: "SYNTHETIC:INSTRUMENT",
      page_from: 2,
      page_to: 2,
      included_section_ids: ["section-1"],
      start_locator: "synthetic start",
      end_locator: "synthetic end",
      partial_boundary_pages: [],
    });
    expect(contract).toMatchObject({ container_kind: kind, instrument_review_state: "needs_review", activation_state: "inactive", unrelated_container_text_retrievable: false });
  });
});
