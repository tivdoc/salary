import { describe, expect, it } from "vitest";
import { topicReadinessResultSchema, type LegalEvidenceRef } from "../wave1/contracts.ts";
import type { Wave1ReviewAttestation, Wave1ReviewBinding } from "./wave1-review-governance.ts";
import { evaluateWave1TopicReadiness, type Wave1TopicEvidence } from "./wave1-topic-readiness.ts";
import { wave1SyntheticInactiveEvidence, wave1SyntheticReadinessQuery } from "./wave1-synthetic-fixtures.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const reviewedRef: LegalEvidenceRef = {
  ...wave1SyntheticInactiveEvidence.evidence_ref,
  parsed_version_id: "SYNTHETIC_PARSED_001",
  citation_id: "SYNTHETIC_CITATION_001",
  review_state: "reviewed",
  activation_state: "inactive",
};

const currentBinding: Wave1ReviewBinding = {
  artifact_sha256: A,
  parsed_sha256: B,
  parser_version: "synthetic-parser-v1",
  source_set_version: "synthetic-set-v1",
  interval_claim_id: "SYNTHETIC_INTERVAL_001",
  interval_claim_sha256: A,
  scope_claim_id: "SYNTHETIC_SCOPE_001",
  scope_claim_sha256: B,
};

const validAttestation: Wave1ReviewAttestation = {
  ref: {
    attestation_id: "SYNTHETIC_ATTESTATION_001",
    artifact_sha256: A,
    parsed_sha256: B,
    source_set_version: "synthetic-set-v1",
    interval_claim_id: "SYNTHETIC_INTERVAL_001",
    scope_claim_id: "SYNTHETIC_SCOPE_001",
    reviewer_id: "synthetic-reviewer-1",
    reviewer_role: "synthetic-review-role",
    reviewed_at: "2024-03-01T00:00:00Z",
    status: "valid",
  },
  parser_version: "synthetic-parser-v1",
  interval_claim_sha256: A,
  scope_claim_sha256: B,
};

function completeEvidence(overrides: Partial<Wave1TopicEvidence> = {}): Wave1TopicEvidence {
  return {
    ...wave1SyntheticInactiveEvidence,
    evidence_ref: reviewedRef,
    effective_claim_id: "SYNTHETIC_INTERVAL_001",
    scope_claim_id: "SYNTHETIC_SCOPE_001",
    review_attestation: validAttestation,
    current_review_binding: currentBinding,
    ...overrides,
  };
}

describe("Wave 1 topic readiness", () => {
  it("emits the frozen TopicReadinessResult contract", () => {
    const result = evaluateWave1TopicReadiness({ query: wave1SyntheticReadinessQuery, evidence: [wave1SyntheticInactiveEvidence] });
    expect(topicReadinessResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe("not_ready");
    expect(result.usable_for_rules).toBe(false);
  });

  it.each([
    ["catalog", { catalog_entry_id: null }, "catalog_missing:SYNTHETIC_SOURCE_001:v1"],
    ["parse", { evidence_ref: { ...reviewedRef, parsed_version_id: null } }, "parse_missing:SYNTHETIC_SOURCE_001:v1"],
    ["citation", { evidence_ref: { ...reviewedRef, citation_id: null } }, "citation_missing:SYNTHETIC_SOURCE_001:v1"],
    ["effective claim", { effective_claim_id: null }, "effective_claim_missing:SYNTHETIC_SOURCE_001:v1"],
    ["scope claim", { scope_claim_id: null }, "scope_claim_missing:SYNTHETIC_SOURCE_001:v1"],
    ["review", { evidence_ref: { ...reviewedRef, review_state: "needs_review" }, review_attestation: null, current_review_binding: null }, "review_missing:SYNTHETIC_SOURCE_001:v1"],
  ])("fails closed when %s is missing", (_label, override, gate) => {
    const result = evaluateWave1TopicReadiness({ query: wave1SyntheticReadinessQuery, evidence: [completeEvidence(override as Partial<Wave1TopicEvidence>)] });
    expect(result.status).toBe("not_ready");
    expect(result.missing_gates).toContain(gate);
  });

  it("fails closed when a required source role is absent", () => {
    const result = evaluateWave1TopicReadiness({
      query: { ...wave1SyntheticReadinessQuery, required_source_roles: ["operative_instrument", "official_implementation_or_corroboration"] },
      evidence: [completeEvidence()],
    });
    expect(result.missing_gates).toContain("source_role_missing:official_implementation_or_corroboration");
  });

  it("never permits parliamentary research to support a monetary rule alone", () => {
    const research = completeEvidence({ source_role: "parliamentary_research" });
    const result = evaluateWave1TopicReadiness({
      query: { ...wave1SyntheticReadinessQuery, required_source_roles: ["parliamentary_research"] },
      evidence: [research],
    });
    expect(result.missing_gates).toEqual(expect.arrayContaining([
      "operative_instrument_required_for_monetary_rule",
      "parliamentary_research_cannot_independently_support_monetary_rule",
    ]));
  });

  it("does not expose evidence discovered after the knowledge cutoff", () => {
    const later = completeEvidence({ ingested_at: "2024-03-02T00:00:00Z" });
    const result = evaluateWave1TopicReadiness({ query: wave1SyntheticReadinessQuery, evidence: [later] });
    expect(result.evidence_refs).toEqual([]);
    expect(result.missing_gates).toContain("catalog_missing:topic");
  });

  it("invalidates readiness when a dependent review binding changes", () => {
    const result = evaluateWave1TopicReadiness({
      query: wave1SyntheticReadinessQuery,
      evidence: [completeEvidence({
        current_review_binding: { ...currentBinding, parser_version: "synthetic-parser-v2" },
      })],
    });
    expect(result.status).toBe("not_ready");
    expect(result.missing_gates).toContain("review_missing:SYNTHETIC_SOURCE_001:v1");
  });

  it("keeps fully bound reviewed evidence unusable while activation remains absent", () => {
    const result = evaluateWave1TopicReadiness({ query: wave1SyntheticReadinessQuery, evidence: [completeEvidence()] });
    expect(result).toMatchObject({ status: "not_ready", usable_for_rules: false });
    expect(result.missing_gates).toEqual(["activation_missing:SYNTHETIC_SOURCE_001:v1"]);
  });
});
