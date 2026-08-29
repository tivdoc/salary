import { describe, expect, it } from "vitest";
import {
  WAVE1_SOURCE_ROLE_POLICY,
  resolveWave1BitemporalClaims,
  wave1BitemporalClaimSchema,
  wave1RelationshipClaimSchema,
  wave1TemporalQuerySchema,
  type Wave1BitemporalClaim,
} from "./wave1-temporal-governance.ts";
import { wave1SyntheticTemporalClaim } from "./wave1-synthetic-fixtures.ts";

function claim(overrides: Partial<Wave1BitemporalClaim> = {}): Wave1BitemporalClaim {
  return {
    ...wave1SyntheticTemporalClaim,
    temporal: overrides.temporal ?? wave1SyntheticTemporalClaim.temporal,
    ...overrides,
  };
}

const query = {
  topic: "synthetic_topic",
  sector: "synthetic_sector",
  population: "synthetic_population",
  from: "2024-02-15",
  as_of: "2024-03-01T00:00:00Z",
} as const;

describe("Wave 1 explicit bitemporal contracts", () => {
  it("keeps every legal and knowledge timestamp in a separate strict field", () => {
    const parsed = wave1BitemporalClaimSchema.parse(wave1SyntheticTemporalClaim);
    expect(parsed.temporal.valid_time).toEqual({
      signing_date: "2024-01-01",
      publication_date: "2024-01-02",
      commencement_date: "2024-02-01",
      operative_interval: { from: "2024-02-01", to: null },
      payroll_reference_period: { from: "2024-02-01", to: "2024-02-29" },
    });
    expect(parsed.temporal.knowledge_time).toEqual({
      ingested_at: "2024-03-01T00:00:00Z",
      reviewed_at: null,
      activated_at: null,
      invalidated_at: null,
    });
    expect(wave1BitemporalClaimSchema.safeParse({ ...parsed, unexpected: true }).success).toBe(false);
  });

  it("requires canonical UTC for --as-of and never accepts a local offset", () => {
    expect(wave1TemporalQuerySchema.safeParse(query).success).toBe(true);
    expect(wave1TemporalQuerySchema.safeParse({ ...query, as_of: "2024-03-01T02:00:00+02:00" }).success).toBe(false);
  });

  it("separates valid-time from knowledge-time for retroactive discovery", () => {
    const late = claim({
      temporal: {
        ...wave1SyntheticTemporalClaim.temporal,
        knowledge_time: { ...wave1SyntheticTemporalClaim.temporal.knowledge_time, ingested_at: "2024-06-01T00:00:00Z" },
      },
    });
    expect(resolveWave1BitemporalClaims({ claims: [late], query: { ...query, as_of: "2024-05-31T23:59:59Z" } }).reasons)
      .toEqual(["knowledge_time_gap"]);
    expect(resolveWave1BitemporalClaims({ claims: [late], query: { ...query, as_of: "2024-06-01T00:00:00Z" } }).status)
      .toBe("candidate_set");
  });

  it("reports an explicit valid-time gap", () => {
    const result = resolveWave1BitemporalClaims({ claims: [claim()], query: { ...query, from: "2024-01-31" } });
    expect(result.status).toBe("not_resolved");
    expect(result.reasons).toEqual(["valid_time_gap"]);
  });

  it("fails closed on overlapping versions of the same source", () => {
    const second = claim({ claim_id: "SYNTHETIC_CLAIM_002", source_version_id: "SYNTHETIC_SOURCE_001:v2" });
    const result = resolveWave1BitemporalClaims({ claims: [second, claim()], query });
    expect(result.status).toBe("conflict");
    expect(result.reasons).toEqual(["overlapping_claims:SYNTHETIC_SOURCE_001"]);
    expect(result.selected_claim_ids).toEqual(["SYNTHETIC_CLAIM_001", "SYNTHETIC_CLAIM_002"]);
  });

  it("excludes a claim only after its invalidation enters knowledge-time", () => {
    const invalidated = claim({
      temporal: {
        ...wave1SyntheticTemporalClaim.temporal,
        knowledge_time: { ...wave1SyntheticTemporalClaim.temporal.knowledge_time, invalidated_at: "2024-04-01T00:00:00Z" },
      },
    });
    expect(resolveWave1BitemporalClaims({ claims: [invalidated], query }).status).toBe("candidate_set");
    expect(resolveWave1BitemporalClaims({ claims: [invalidated], query: { ...query, as_of: "2024-04-01T00:00:00Z" } }).reasons)
      .toEqual(["knowledge_time_gap"]);
  });

  it("is deterministic under input reordering", () => {
    const other = claim({
      claim_id: "SYNTHETIC_CLAIM_002",
      source_id: "SYNTHETIC_SOURCE_002",
      source_version_id: "SYNTHETIC_SOURCE_002:v1",
    });
    const left = resolveWave1BitemporalClaims({ claims: [other, claim()], query });
    const right = resolveWave1BitemporalClaims({ claims: [claim(), other], query });
    expect(left).toEqual(right);
  });

  it("keeps every relationship claim unverified", () => {
    const relation = {
      relationship_claim_id: "SYNTHETIC_RELATION_001",
      from_source_version_id: "SYNTHETIC_SOURCE_001:v1",
      to_source_version_id: "SYNTHETIC_SOURCE_002:v1",
      relationship_type: "temporarily_overrides",
      verification_status: "unverified",
      recorded_at: "2024-03-01T00:00:00Z",
    } as const;
    expect(wave1RelationshipClaimSchema.parse(relation).verification_status).toBe("unverified");
    expect(wave1RelationshipClaimSchema.safeParse({ ...relation, verification_status: "verified" }).success).toBe(false);
  });

  it("keeps implementation, explanation, and parliamentary research non-operative", () => {
    expect(WAVE1_SOURCE_ROLE_POLICY.operative_instrument.operative).toBe(true);
    expect(WAVE1_SOURCE_ROLE_POLICY.official_implementation_or_corroboration.operative).toBe(false);
    expect(WAVE1_SOURCE_ROLE_POLICY.secondary_explanation.operative).toBe(false);
    expect(WAVE1_SOURCE_ROLE_POLICY.parliamentary_research).toEqual({
      operative: false,
      can_independently_support_monetary_rule: false,
    });
  });
});
