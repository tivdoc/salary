import { describe, expect, it } from "vitest";
import permits from "./wave1-working-time-permits-catalog.v0.3.json";
import publications from "./wave1-working-time-permits-publications.v0.3.json";
import {
  buildWorkingTimePermitOwnerHandoff,
  summarizeWorkingTimePermitInventories,
  validateWorkingTimePermitInventories,
} from "./wave1-working-time-permits.ts";

describe("Wave 1 working-time and permits inventories", () => {
  it("validates the complete visible 20/20 and 58/58 inventories", () => {
    const result = validateWorkingTimePermitInventories({ permits, publications });
    expect(result.publications.entries).toHaveLength(20);
    expect(result.permits.entries).toHaveLength(58);
    expect(result.permitArtifacts).toHaveLength(68);
    expect(result.publicationKinds).toMatchObject({
      original_promulgation: 1,
      direct_amendment_publication: 12,
      indirect_amendment_publication: 6,
      error_correction_publication: 1,
    });
  });

  it("keeps every catalog row unknown, inactive and free of legal inferences", () => {
    const result = validateWorkingTimePermitInventories({ permits, publications });
    for (const entry of result.permits.entries) {
      expect(entry.relevance).toBe("unknown_pending_legal_review");
      expect(entry).toMatchObject({
        applicability_claimed: false,
        expiry_claimed: false,
        revocation_claimed: false,
        sector_coverage_claimed: false,
      });
    }
    for (const entry of result.publications.entries) {
      expect(entry).toMatchObject({
        review_state: "needs_review",
        activation_state: "inactive",
        consolidated_text_created: false,
        applicability_claimed: false,
        effectivity_claimed: false,
        relations_claimed: false,
      });
    }
  });

  it("records stable IDs, all six pages, exact official URLs and known duplicate-title groups", () => {
    const result = validateWorkingTimePermitInventories({ permits, publications });
    expect(new Set(result.permits.entries.map((entry) => entry.stable_id)).size).toBe(58);
    expect(new Set(result.permitArtifacts.map((artifact) => artifact.official_url)).size).toBe(68);
    expect(result.permits.snapshot.pages.map((page) => page.entries_observed)).toEqual([10, 10, 10, 10, 10, 8]);
    expect(result.permits.snapshot.duplicate_catalog_titles).toEqual([
      { title: "העסקה בבתי אירוח במנוחה השבועית ובשעות נוספות", count: 2 },
      { title: "העסקה בעבודות עונתיות בחקלאות בשעות נוספות", count: 2 },
      { title: "היתר כללי להעסקת עובדים בשעות נוספות (הוראת שעה- \"עם כלביא\")", count: 2 },
    ]);
  });

  it("fails closed for missing rows, duplicate identities and non-official artifact hosts", () => {
    const missing = structuredClone(permits) as typeof permits;
    missing.entries.pop();
    expect(() => validateWorkingTimePermitInventories({ permits: missing, publications })).toThrow();

    const duplicate = structuredClone(permits);
    duplicate.entries[1]!.stable_id = duplicate.entries[0]!.stable_id;
    expect(() => validateWorkingTimePermitInventories({ permits: duplicate, publications })).toThrow("duplicate_permit_stable_id");

    const fakeHost = structuredClone(permits);
    fakeHost.entries[0]!.artifact_links[0]!.official_url = "https://gov.il.example.invalid/fake.pdf";
    expect(() => validateWorkingTimePermitInventories({ permits: fakeHost, publications })).toThrow("permit_artifact_host_not_official");
  });

  it("produces a deterministic executable owner handoff only for exact gaps", () => {
    expect(buildWorkingTimePermitOwnerHandoff({})).toMatchObject({ status: "not_required", missing_catalog_ordinals: [], artifact_failures: [] });
    expect(buildWorkingTimePermitOwnerHandoff({
      missingCatalogOrdinals: [58, 12],
      artifactFailures: [{ artifact_id: "B", official_url: "https://www.gov.il/b.pdf", safe_error_code: "http_status_403" }],
    })).toMatchObject({
      status: "owner_action_required",
      missing_catalog_ordinals: [12, 58],
      artifact_failures: [{ artifact_id: "B", official_url: "https://www.gov.il/b.pdf", safe_error_code: "http_status_403" }],
    });
  });

  it("summarizes counts without promoting sources or creating consolidation", () => {
    expect(summarizeWorkingTimePermitInventories(permits, publications)).toEqual({
      hours_publications: 20,
      hours_artifact_links: 20,
      permit_catalog_entries: 58,
      permit_artifact_links: 68,
      permit_pages: 6,
      duplicate_catalog_title_groups: 3,
      review_state: "needs_review",
      activation_state: "inactive",
      applicability_inferred: false,
      consolidated_text_created: false,
    });
  });
});
