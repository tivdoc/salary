import { describe, expect, it } from "vitest";
import { classifyLegalChangeDetections, detectLegalSourceChange, selectLegalSourceObservation } from "./change-detection.ts";
import { loadProvenanceRegistry } from "./acquisition.ts";
import { loadLegalSourceManifest } from "./manifest.ts";

describe("official source manifest V0.2", () => {
  it("loads seventeen unique official source records", async () => {
    const manifest = await loadLegalSourceManifest();
    expect(manifest.sources).toHaveLength(17);
    expect(new Set(manifest.sources.map((source) => `${source.source_id}@${source.source_version}`)).size).toBe(17);
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

  it("separates instrument issuer, publisher, host and artifact role", async () => {
    const registry = await loadProvenanceRegistry();
    const minimumWage = registry.provenance.find((entry) => entry.source_id === "IL_MIN_WAGE_LAW");
    expect(minimumWage).toMatchObject({
      instrument_issuer: "Israeli legislature",
      artifact_host: "National Insurance Institute",
      artifact_role: "official_consolidated_copy",
      consolidation_as_of: "unknown",
      authority_not_inferred_from_host: true,
    });
    const research = registry.provenance.find((entry) => entry.source_id === "IL_CONVALESCENCE_KNESSET_RESEARCH_2025");
    expect(research).toMatchObject({ legal_force: "non_binding", artifact_role: "officially_published_secondary_research" });
    const hours = registry.provenance.find((entry) => entry.source_id === "IL_HOURS_WORK_REST_LAW");
    expect(hours).toMatchObject({ artifact_host: "Knesset file service", artifact_role: "primary_promulgation", consolidation_as_of: "unknown" });
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
    expect(result.status).toBe("unreviewed_byte_change");
  });

  it("reconciles exactly three unreviewed byte changes and two rejected challenges", () => {
    const detections = classifyLegalChangeDetections([
      ...["rates-1", "rates-2", "rates-3"].map((observation_id, index) => ({
        observation_id,
        source_id: "IL_MIN_WAGE_OFFICIAL_RATES",
        artifact_sha256: String(index + 1).repeat(64),
        disposition: "legal_artifact_candidate" as const,
        safe_error_code: null,
        bytes_changed: true,
      })),
      ...["challenge-1", "challenge-2"].map((observation_id, index) => ({
        observation_id,
        source_id: "IL_HOURS_WORK_REST_LAW",
        artifact_sha256: String(index + 4).repeat(64),
        disposition: "not_a_legal_source_version" as const,
        safe_error_code: "html_challenge_or_error_page",
        bytes_changed: true,
      })),
    ]);
    expect(detections).toHaveLength(5);
    expect(detections.filter((entry) => entry.classification === "unreviewed_byte_change")).toHaveLength(3);
    expect(detections.filter((entry) => entry.classification === "rejected_challenge_observation")).toHaveLength(2);
    expect(detections.every((entry) => !entry.promoted)).toBe(true);
    expect(detections.filter((entry) => entry.source_id === "IL_MIN_WAGE_OFFICIAL_RATES").every((entry) => entry.classification === "unreviewed_byte_change")).toBe(true);
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
