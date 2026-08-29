import { describe, expect, it } from "vitest";
import { compareSourceAuthority, validateMonetaryAuthoritySet } from "./authority.ts";
import { validateApplicabilityOutputCitations, validateCitationIntegrity } from "./citations.ts";
import { canConsumeLegalParameter } from "./parameters.ts";
import { legalCitationSchema, legalParameterSchema, type LegalSource } from "./contracts.ts";
import { syntheticChunk, syntheticSource } from "./synthetic-fixtures.ts";

function activeSource(overrides: Partial<LegalSource> = {}) {
  return syntheticSource({
    status: "active",
    content_sha256: "a".repeat(64),
    retrieved_at: "2026-08-29T00:00:00Z",
    verification: {
      status: "dual_verified",
      method: "synthetic",
      verified_by: ["reviewer-a", "reviewer-b"],
      verified_at: "2026-08-29T00:00:00Z",
      notes: [],
    },
    ...overrides,
  });
}

describe("authority hierarchy", () => {
  it("orders primary binding law ahead of official guidance", () => {
    const primary = activeSource();
    const guidance = syntheticSource({
      source_id: "IL_SYNTHETIC_GUIDANCE",
      authority: {
        ...syntheticSource().authority,
        binding_level: "official_guidance",
        operative: false,
        explanatory: true,
        can_independently_support_monetary_rule: false,
      },
    });
    expect(compareSourceAuthority(primary, guidance, "general")).toBeLessThan(0);
  });

  it("prefers a sector-specific operative source in that sector", () => {
    const general = activeSource();
    const sector = activeSource({
      source_id: "IL_SYNTHETIC_SECURITY_ORDER",
      sectors: ["security"],
      authority: { ...activeSource().authority, scope: "sector_specific" },
    });
    expect(compareSourceAuthority(sector, general, "security")).toBeLessThan(0);
  });

  it("allows an active primary source to support a monetary rule", () => {
    expect(validateMonetaryAuthoritySet([activeSource()]).passed).toBe(true);
  });

  it("rejects secondary-only monetary support", () => {
    const secondary = syntheticSource({
      source_id: "IL_SYNTHETIC_SECONDARY",
      source_type: "secondary_reference",
      authority: {
        kind: "secondary_professional_source",
        issuing_body: "Synthetic secondary publisher",
        binding_level: "secondary_explanatory",
        court_level: null,
        scope: "general",
        operative: false,
        explanatory: true,
        contains_numeric_rate: true,
        can_independently_support_monetary_rule: false,
      },
    });
    expect(validateMonetaryAuthoritySet([secondary]).issues).toEqual(expect.arrayContaining([
      "primary_or_official_operative_source_required",
      "secondary_source_cannot_be_sole_monetary_authority",
    ]));
  });
});

describe("citation integrity and parameter gates", () => {
  const source = activeSource();
  const chunk = syntheticChunk(source, { text: "Exact synthetic supporting excerpt", chunk_text_sha256: "c".repeat(64) });
  const citation = legalCitationSchema.parse({
    source_id: source.source_id,
    source_version: source.source_version,
    source_version_id: `${source.source_id}@${source.source_version}`,
    parsed_version_id: chunk.parsed_version_id,
    raw_artifact_sha256: chunk.artifact_sha256,
    normalized_text_sha256: chunk.normalized_text_sha256,
    parser_version: chunk.parser_version,
    chunk_id: chunk.chunk_id,
    title: source.title,
    authority: source.authority,
    canonical_url: source.canonical_url,
    section_or_clause: "1",
    page: 1,
    effective_period: source.effective_period,
    effective_date_evidence_locator: "synthetic section 1",
    review_status: source.status,
    retrieved_at: source.retrieved_at,
    locator: {
      format: "pdf",
      page: chunk.page_from,
      section: chunk.section_identifier,
      paragraph: null,
      character_from: chunk.character_from,
      character_to: chunk.character_to,
    },
    supporting_chunk_ids: [chunk.chunk_id],
    excerpt: "supporting excerpt",
  });

  it("accepts a citation tied to its exact chunk and source", () => {
    expect(validateCitationIntegrity(citation, [chunk], [source]).passed).toBe(true);
  });

  it("rejects a missing citation chunk", () => {
    expect(validateCitationIntegrity(citation, [], [source]).issues).toContain("citation_chunk_missing");
  });

  it("rejects an excerpt absent from supporting chunks", () => {
    expect(validateCitationIntegrity({ ...citation, excerpt: "absent excerpt" }, [chunk], [source]).issues)
      .toContain("citation_excerpt_not_in_supporting_chunk");
  });

  it("rejects citation metadata that drifts from the referenced source", () => {
    expect(validateCitationIntegrity({ ...citation, canonical_url: "https://www.gov.il/other" }, [chunk], [source]).issues)
      .toContain("citation_source_metadata_mismatch");
  });

  it("rejects an unsupported applicability assertion", () => {
    expect(validateApplicabilityOutputCitations({ assertions: [{ assertion_id: "a1", citation_ids: [] }] }, []).issues)
      .toContain("unsupported_assertion:a1");
  });

  it("rejects an unknown citation reference", () => {
    expect(validateApplicabilityOutputCitations({ assertions: [{ assertion_id: "a1", citation_ids: ["missing"] }] }, []).issues)
      .toContain("unknown_citation:missing");
  });

  it("prevents consumption of an unverified parameter", () => {
    const parameter = legalParameterSchema.parse({
      parameter_id: "synthetic-rate",
      source_id: source.source_id,
      source_version: source.source_version,
      citation,
      effective_period: source.effective_period,
      unit: "ils_per_day",
      value: { normalized_decimal: "1.00", source_representation_hash: "d".repeat(64) },
      sector: "general",
      applicability_conditions: [],
      extraction_method: "manual",
      verification_status: "candidate",
      verified_by: [],
    });
    expect(canConsumeLegalParameter(parameter, source).issues).toEqual(expect.arrayContaining([
      "parameter_not_active",
      "parameter_dual_verification_required",
    ]));
  });

  it("allows only a dual-verified active parameter backed by an active operative source", () => {
    const parameter = legalParameterSchema.parse({
      parameter_id: "synthetic-rate",
      source_id: source.source_id,
      source_version: source.source_version,
      citation,
      effective_period: source.effective_period,
      unit: "ils_per_day",
      value: { normalized_decimal: "1.00", source_representation_hash: "d".repeat(64) },
      sector: "general",
      applicability_conditions: [],
      extraction_method: "manual",
      verification_status: "active",
      verified_by: ["reviewer-a", "reviewer-b"],
    });
    expect(canConsumeLegalParameter(parameter, source).passed).toBe(true);
  });
});
