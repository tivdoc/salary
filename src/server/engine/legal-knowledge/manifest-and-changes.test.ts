import { describe, expect, it } from "vitest";
import { detectLegalSourceChange, selectLegalSourceObservation } from "./change-detection.ts";
import { loadLegalSourceManifest } from "./manifest.ts";

describe("official source manifest V0", () => {
  it("loads nine unique official source records", async () => {
    const manifest = await loadLegalSourceManifest();
    expect(manifest.sources).toHaveLength(9);
    expect(new Set(manifest.sources.map((source) => `${source.source_id}@${source.source_version}`)).size).toBe(9);
  });

  it("covers every initial discovery topic", async () => {
    const manifest = await loadLegalSourceManifest();
    for (const topic of ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const) {
      expect(manifest.sources.some((source) => source.topics.includes(topic))).toBe(true);
    }
  });

  it("uses only official allowlisted domains and keeps every source inactive", async () => {
    const manifest = await loadLegalSourceManifest();
    expect(manifest.sources.every((source) => ["www.gov.il", "www.btl.gov.il", "main.knesset.gov.il", "fs.knesset.gov.il"].includes(new URL(source.canonical_url).hostname))).toBe(true);
    expect(manifest.sources.every((source) => source.status === "needs_review")).toBe(true);
    expect(manifest.sources.filter((source) => source.source_type === "statute").every((source) => source.authority.kind === "israeli_legislature")).toBe(true);
  });

  it("does not allow any secondary source to support a monetary rule independently", async () => {
    const manifest = await loadLegalSourceManifest();
    expect(manifest.sources.filter((source) => source.authority.binding_level === "secondary_explanatory").every((source) => !source.authority.can_independently_support_monetary_rule)).toBe(true);
  });
});

describe("source change detection", () => {
  const observation = {
    artifact_sha256: "a".repeat(64),
    normalized_text_sha256: "b".repeat(64),
    final_url: "https://www.gov.il/source.pdf",
    content_type: "application/pdf",
    effective_metadata_hash: "c".repeat(64),
  };

  it("marks an unavailable URL for review", () => {
    expect(detectLegalSourceChange(observation, null)).toMatchObject({ status: "url_unavailable", reviewRequired: true });
  });

  it("marks a first observation as a new version pending review", () => {
    expect(detectLegalSourceChange(null, observation)).toMatchObject({ status: "new_source_version_pending_review", reviewRequired: true });
  });

  it("recognizes an unchanged source", () => {
    expect(detectLegalSourceChange(observation, observation)).toEqual({ status: "source_unchanged", reviewRequired: false, changes: [] });
  });

  it("reports an explicitly superseded source version", () => {
    expect(detectLegalSourceChange(observation, { ...observation, source_status: "superseded" })).toEqual({
      status: "source_version_superseded",
      reviewRequired: false,
      changes: ["source_version_superseded"],
    });
  });

  it.each([
    ["artifact_sha256", "d".repeat(64), "bytes_changed"],
    ["normalized_text_sha256", "d".repeat(64), "normalized_text_changed"],
    ["final_url", "https://www.gov.il/changed.pdf", "redirect_changed"],
    ["content_type", "text/html", "content_type_changed"],
    ["effective_metadata_hash", "d".repeat(64), "metadata_or_effective_date_changed"],
  ] as const)("detects %s changes", (field, value, code) => {
    const result = detectLegalSourceChange(observation, { ...observation, [field]: value });
    expect(result.changes).toContain(code);
    expect(result.reviewRequired).toBe(true);
  });

  it("does not claim a normalized-text change before changed bytes are parsed", () => {
    const result = detectLegalSourceChange(observation, {
      ...observation,
      artifact_sha256: "d".repeat(64),
      normalized_text_sha256: null,
    });
    expect(result.changes).toEqual(["bytes_changed"]);
  });

  it("keeps a content-change observation out of the selected ingestion baseline", () => {
    const observations = [
      { source_id: "IL_TEST", source_version: "v1", artifact_sha256: "a".repeat(64), status: "fetched" as const },
      { source_id: "IL_TEST", source_version: "v1", artifact_sha256: "d".repeat(64), status: "content_change_review_required" as const },
    ];
    expect(selectLegalSourceObservation(observations, { source_id: "IL_TEST", source_version: "v1", content_sha256: null })?.artifact_sha256).toBe("a".repeat(64));
    expect(selectLegalSourceObservation(observations, { source_id: "IL_TEST", source_version: "v1", content_sha256: "d".repeat(64) })?.artifact_sha256).toBe("d".repeat(64));
  });
});
