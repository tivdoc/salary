import { describe, expect, it } from "vitest";
import {
  caseLawRecordSchema,
  legalChunkSchema,
  legalCitationSchema,
  legalParameterSchema,
} from "./contracts.ts";
import { canTransitionLegalSourceStatus, validateLegalSourceActivation } from "./lifecycle.ts";
import { syntheticSource } from "./synthetic-fixtures.ts";

describe("legal source contracts", () => {
  it("accepts a strict synthetic draft source", () => {
    expect(syntheticSource().source_id).toBe("IL_SYNTHETIC_LAW");
  });

  it("rejects non-HTTPS canonical URLs", () => {
    expect(() => syntheticSource({ canonical_url: "http://main.knesset.gov.il/synthetic" })).toThrow();
  });

  it("rejects an inverted effective period", () => {
    expect(() => syntheticSource({
      effective_from: "2021-01-01",
      effective_to: "2020-01-01",
      effective_period: {
        effective_from: "2021-01-01",
        effective_to: "2020-01-01",
        retroactive: false,
        retroactive_basis: null,
        applicability_basis: "work_date",
      },
    })).toThrow();
  });

  it("rejects a syntactically valid but impossible calendar date", () => {
    expect(() => syntheticSource({ published_at: "2026-02-30" })).toThrow();
  });

  it("rejects retroactive treatment without a basis", () => {
    expect(() => syntheticSource({
      effective_period: {
        effective_from: "2020-01-01",
        effective_to: null,
        retroactive: true,
        retroactive_basis: null,
        applicability_basis: "work_date",
      },
    })).toThrow();
  });

  it("rejects conflicting duplicate effective fields", () => {
    expect(() => syntheticSource({ effective_from: "2022-01-01" })).toThrow();
  });

  it("rejects inverted chunk offsets", () => {
    expect(() => legalChunkSchema.parse({
      chunk_id: "synthetic",
      source_id: "IL_SYNTHETIC_LAW",
      source_version: "v1",
      artifact_sha256: "a".repeat(64),
      section_identifier: "1",
      heading_path: [],
      page_from: 1,
      page_to: 1,
      character_from: 10,
      character_to: 1,
      text: "synthetic",
      chunk_text_sha256: "b".repeat(64),
      topics: ["minimum_wage"],
      sectors: ["general"],
      effective_period: syntheticSource().effective_period,
      authority: syntheticSource().authority,
    })).toThrow();
  });

  it("prevents activation without a content hash and retrieval timestamp", () => {
    expect(validateLegalSourceActivation(syntheticSource()).issues).toEqual(expect.arrayContaining([
      "active_source_content_hash_required",
      "active_source_retrieval_timestamp_required",
      "active_source_content_verification_required",
    ]));
  });

  it("allows an explanatory active source without an artificial effective date", () => {
    const source = syntheticSource({
      status: "verified",
      authority: {
        ...syntheticSource().authority,
        operative: false,
        explanatory: true,
        binding_level: "official_guidance",
        can_independently_support_monetary_rule: false,
      },
      effective_from: null,
      effective_period: {
        effective_from: null,
        effective_to: null,
        retroactive: false,
        retroactive_basis: null,
        applicability_basis: "explanatory_as_of",
      },
      content_sha256: "a".repeat(64),
      retrieved_at: "2026-08-29T00:00:00Z",
      verification: {
        status: "content_verified",
        method: "synthetic dual check",
        verified_by: ["reviewer-a"],
        verified_at: "2026-08-29T00:00:00Z",
        notes: [],
      },
    });
    expect(validateLegalSourceActivation(source).passed).toBe(true);
  });

  it("rejects activation of an operative source with no effective date", () => {
    const source = syntheticSource({
      status: "verified",
      effective_from: null,
      effective_period: {
        effective_from: null,
        effective_to: null,
        retroactive: false,
        retroactive_basis: null,
        applicability_basis: "publication_only",
      },
      content_sha256: "a".repeat(64),
      retrieved_at: "2026-08-29T00:00:00Z",
      verification: {
        status: "content_verified",
        method: "synthetic check",
        verified_by: ["reviewer-a"],
        verified_at: "2026-08-29T00:00:00Z",
        notes: [],
      },
    });
    expect(validateLegalSourceActivation(source).issues).toContain("active_operative_source_effective_date_required");
  });

  it("rejects secondary authority claiming independent monetary support", () => {
    expect(() => syntheticSource({
      authority: {
        ...syntheticSource().authority,
        kind: "secondary_professional_source",
        binding_level: "secondary_explanatory",
        can_independently_support_monetary_rule: true,
      },
    })).toThrow();
  });

  it("requires case-law sources to identify judicial authority and court level", () => {
    expect(() => syntheticSource({ source_type: "case_law" })).toThrow();
  });

  it.each([
    ["draft", "verified", true],
    ["verified", "active", true],
    ["active", "superseded", true],
    ["needs_review", "verified", true],
    ["rejected", "active", false],
    ["active", "draft", false],
  ] as const)("source lifecycle %s -> %s", (from, to, expected) => {
    expect(canTransitionLegalSourceStatus(from, to)).toBe(expected);
  });
});

describe("parameter and case-law schemas", () => {
  const citation = legalCitationSchema.parse({
    source_id: "IL_SYNTHETIC_LAW",
    source_version: "v1",
    title: "Synthetic law",
    authority: syntheticSource().authority,
    canonical_url: "https://main.knesset.gov.il/synthetic",
    section_or_clause: "1",
    page: null,
    effective_period: syntheticSource().effective_period,
    retrieved_at: "2026-08-29T00:00:00Z",
    supporting_chunk_ids: ["chunk-1"],
    excerpt: null,
  });

  it("accepts a non-active parameter candidate", () => {
    expect(legalParameterSchema.parse({
      parameter_id: "synthetic-rate",
      source_id: "IL_SYNTHETIC_LAW",
      source_version: "v1",
      citation,
      effective_period: syntheticSource().effective_period,
      unit: "ils_per_hour",
      value: { normalized_decimal: "1.23", source_representation_hash: "b".repeat(64) },
      sector: "general",
      applicability_conditions: [],
      extraction_method: "deterministic_text",
      verification_status: "candidate",
      verified_by: [],
    }).verification_status).toBe("candidate");
  });

  it("rejects an AI candidate as a verified holding", () => {
    expect(() => caseLawRecordSchema.parse({
      case_identifier: "SYNTHETIC-1",
      court: "Synthetic court",
      court_level: "national_labor_court",
      decided_at: "2020-01-01",
      parties: null,
      topics: ["minimum_wage"],
      facts_summary: "Synthetic facts",
      legal_question: "Synthetic question",
      holding: "Synthetic holding",
      reasoning: "Synthetic reasoning",
      cited_source_ids: ["IL_SYNTHETIC_LAW"],
      precedential_weight: "binding",
      source_url: "https://main.knesset.gov.il/synthetic-case",
      judgment_sha256: "c".repeat(64),
      verification_status: "verified",
      summary_method: "ai_candidate",
    })).toThrow();
  });
});
