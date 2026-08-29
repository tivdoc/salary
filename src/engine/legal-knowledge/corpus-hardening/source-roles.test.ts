import { describe, expect, it } from "vitest";
import { legalSourceSchema } from "../contracts.ts";
import {
  classifyRegisteredSourceRole,
  classifyStagedArtifact,
  proveKnownNonOperativeRoles,
  selectOperativeResolutionCandidates,
} from "./source-roles.ts";

function source(input: Readonly<{ id: string; binding: "primary_binding" | "official_implementation" | "official_guidance" | "secondary_explanatory"; operative: boolean }>) {
  return legalSourceSchema.parse({
    source_id: input.id,
    source_version: "fixture-v1",
    source_type: input.binding === "secondary_explanatory" ? "secondary_reference" : input.binding === "official_implementation" ? "official_rate_table" : "statute",
    authority: {
      kind: input.binding === "secondary_explanatory" ? "secondary_professional_source" : input.binding === "official_implementation" ? "national_insurance_institute" : "israeli_legislature",
      issuing_body: "Synthetic public authority fixture",
      binding_level: input.binding,
      court_level: null,
      scope: "general",
      operative: input.operative,
      explanatory: !input.operative,
      contains_numeric_rate: input.binding === "official_implementation",
      can_independently_support_monetary_rule: input.binding === "primary_binding",
    },
    jurisdiction: "IL",
    title: "Synthetic source role fixture",
    canonical_url: "https://example.gov.il/synthetic",
    publication_reference: null,
    published_at: null,
    effective_from: null,
    effective_to: null,
    retrieved_at: null,
    language: "he",
    topics: ["minimum_wage"],
    sectors: ["general"],
    status: "needs_review",
    content_sha256: null,
    artifact_format: "pdf",
    supersedes_source_version: null,
    notes: [],
    verification: { status: "unverified", method: "synthetic", verified_by: [], verified_at: null, notes: [] },
    effective_period: { effective_from: null, effective_to: null, retroactive: false, retroactive_basis: null, applicability_basis: "requires_historical_version_review" },
    discovery: { method: "official_registry", found_at: "2026-08-30", included_reason: "Synthetic role test." },
  });
}

describe("corpus source-role hardening", () => {
  it("keeps implementation, guidance, secondary and staged material out of operative candidates", () => {
    const assignments = [
      classifyRegisteredSourceRole(source({ id: "SYN_BINDING", binding: "primary_binding", operative: true })),
      classifyRegisteredSourceRole(source({ id: "SYN_IMPLEMENTATION", binding: "official_implementation", operative: false })),
      classifyRegisteredSourceRole(source({ id: "SYN_GUIDANCE", binding: "official_guidance", operative: false })),
      classifyRegisteredSourceRole(source({ id: "SYN_SECONDARY", binding: "secondary_explanatory", operative: false })),
      classifyStagedArtifact({ sourceVersionId: "SYN_STAGED@fixture-v1", artifactId: `artifact:${"a".repeat(64)}` }),
    ];
    expect(selectOperativeResolutionCandidates(assignments).map((entry) => entry.source_version_id)).toEqual(["SYN_BINDING@fixture-v1"]);
    expect(assignments.slice(1).every((entry) => !entry.eligible_to_independently_support_monetary_parameter)).toBe(true);
  });

  it("proves the Knesset research and BTL role boundaries", () => {
    const proof = proveKnownNonOperativeRoles([
      source({ id: "IL_CONVALESCENCE_KNESSET_RESEARCH_2025", binding: "secondary_explanatory", operative: false }),
      source({ id: "IL_MIN_WAGE_OFFICIAL_RATES", binding: "official_implementation", operative: false }),
    ]);
    expect(proof.assertions).toEqual({
      knesset_research_excluded_from_operative_candidates: true,
      btl_rates_cannot_independently_support_monetary_parameter: true,
    });
    expect(proof.operative_candidate_ids).toEqual([]);
  });
});
