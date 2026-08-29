import { describe, expect, it } from "vitest";
import {
  acquisitionReceiptSchema,
  artifactVersionSchema,
  catalogObservationSchema,
  fetchObservationSchema,
  legalInstrumentSchema,
  legalTextVersionSchema,
} from "./acquisition-contracts.ts";

describe("V0.2 acquisition entity contracts", () => {
  it("keeps instrument, legal text, artifact and observation identities separate and strict", () => {
    expect(legalInstrumentSchema.parse({
      instrument_id: "INSTRUMENT:IL:TEST",
      source_id: "IL_TEST_SOURCE",
      jurisdiction: "IL",
      instrument_type: "statute",
      title: "Test statute",
      legal_force: "binding",
      instrument_issuer: "Israeli legislature",
    }).instrument_id).toBe("INSTRUMENT:IL:TEST");
    expect(() => legalTextVersionSchema.parse({
      legal_text_version_id: "LEGALTEXT:IL:TEST:1",
      instrument_id: "INSTRUMENT:IL:TEST",
      legacy_ingestion_revision: "discovery-v0.2",
      publication_reference: null,
      publication_date: null,
      consolidation_as_of: "unknown",
      legal_claim_ids: [],
      evidence_state: "incomplete",
      review_state: "needs_review",
      activation_state: "inactive",
      unexpected: true,
    })).toThrow();
  });

  it("cannot treat a challenge observation as a legal source version", () => {
    const invalid = {
      observation_id: "OBS:IL:TEST:1",
      source_id: "IL_TEST_SOURCE",
      requested_url: "https://www.gov.il/test.pdf",
      final_url: "https://www.gov.il/test.pdf",
      observed_at: "2026-08-29T00:00:00Z",
      http_status: 200,
      declared_media_type: "text/html",
      byte_count: 505,
      response_sha256: "a".repeat(64),
      acquisition_state: "quarantined",
      parse_state: "failed",
      evidence_state: "incomplete",
      disposition: "not_a_legal_source_version",
      safe_error_code: "html_challenge_or_error_page",
    } as const;
    expect(fetchObservationSchema.parse(invalid).acquisition_state).toBe("quarantined");
    expect(() => fetchObservationSchema.parse({ ...invalid, acquisition_state: "acquired" })).toThrow("invalid_observation_must_be_quarantined_or_unavailable");
  });

  it("keeps owner-attested imports inactive and needing review", () => {
    const record = artifactVersionSchema.parse({
      artifact_version_id: `artifact:IL_TEST_SOURCE:${"a".repeat(64)}`,
      source_id: "IL_TEST_SOURCE",
      legal_text_version_id: null,
      acquisition_request_id: "ACQ-V02-TEST",
      artifact_sha256: "a".repeat(64),
      byte_count: 1024,
      media_type: "application/pdf",
      original_filename: "official.pdf",
      landing_url: "https://www.gov.il/test",
      artifact_url: "https://www.gov.il/test.pdf",
      final_url: "https://www.gov.il/test.pdf",
      acquired_at: "2026-08-29T00:00:00Z",
      acquisition_state: "acquired",
      parse_state: "not_attempted",
      evidence_state: "incomplete",
      review_state: "needs_review",
      activation_state: "inactive",
      provenance: {
        promulgation_publisher: "unknown_pending_provenance_review",
        artifact_host: "www.gov.il",
        artifact_role: "official_institutional_copy",
        canonicality_status: "official_copy_not_primary_promulgation",
        acquisition_method: "owner_attested_official_download",
      },
    });
    expect(record).toMatchObject({ review_state: "needs_review", activation_state: "inactive" });
  });

  it("rejects missing, tampered and unknown receipt fields", () => {
    const receipt = {
      acquisition_request_id: "ACQ-V02-TEST",
      source_id: "IL_TEST_SOURCE",
      original_filename: "official.pdf",
      landing_url: "https://www.gov.il/test",
      artifact_url: "https://www.gov.il/test.pdf",
      final_url: "https://www.gov.il/test.pdf",
      artifact_sha256: "a".repeat(64),
      expected_media_type: "application/pdf",
      expected_document_title: "Test official PDF",
      acquired_at: "2026-08-29T00:00:00Z",
      attestation_type: "owner_attestation",
      actor_type: "owner",
      acquisition_method: "owner_attested_official_download",
      unchanged_original: true,
      used_print_to_pdf: false,
    } as const;
    expect(acquisitionReceiptSchema.parse(receipt).unchanged_original).toBe(true);
    expect(() => acquisitionReceiptSchema.parse({ ...receipt, used_print_to_pdf: true })).toThrow();
    expect(() => acquisitionReceiptSchema.parse({ ...receipt, claimed_hash: "a".repeat(64) })).toThrow();
    expect(acquisitionReceiptSchema.parse({
      ...receipt,
      attestation_type: "synthetic_test_attestation",
      actor_type: "system_test",
      acquisition_method: "synthetic_test_copy_existing_public_official_artifact",
      test_only_notice: "TEST COPY OF EXISTING PUBLIC OFFICIAL ARTIFACT; NOT AN OWNER IMPORT",
    }).attestation_type).toBe("synthetic_test_attestation");
  });

  it("does not let a partial catalog masquerade as complete", () => {
    const observation = {
      catalog_observation_id: "CATOBS:TEST:1",
      catalog_id: "CATALOG:TEST",
      canonical_url: "https://www.gov.il/catalog",
      observed_at: "2026-08-29T00:00:00Z",
      acquisition_method: "public_browser_visible_navigation",
      status: "complete",
      query: {},
      result_count_reported: 2,
      entries_observed: [{ entry_id: "ENTRY:TEST:1", title: "Visible entry", artifact_url: "https://www.gov.il/one.pdf" }],
      pagination: { pages_observed: 1, pages_reported: 2 },
      safe_error_code: null,
      discovery_only: true,
    } as const;
    expect(() => catalogObservationSchema.parse(observation)).toThrow("complete_catalog_count_mismatch");
    expect(catalogObservationSchema.parse({ ...observation, status: "partial" }).status).toBe("partial");
  });
});
