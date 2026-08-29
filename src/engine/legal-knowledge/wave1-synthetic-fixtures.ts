import type { Wave1BitemporalClaim } from "./wave1-temporal-governance.ts";
import type { Wave1TopicEvidence, Wave1TopicReadinessQuery } from "./wave1-topic-readiness.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

export const wave1SyntheticTemporalClaim: Wave1BitemporalClaim = Object.freeze({
  claim_id: "SYNTHETIC_CLAIM_001",
  source_id: "SYNTHETIC_SOURCE_001",
  source_version_id: "SYNTHETIC_SOURCE_001:v1",
  topic: "synthetic_topic",
  source_role: "operative_instrument",
  sectors: ["synthetic_sector"],
  populations: ["synthetic_population"],
  artifact_sha256: A,
  parsed_sha256: B,
  parser_version: "synthetic-parser-v1",
  citation_id: "SYNTHETIC_CITATION_001",
  interval_claim_id: "SYNTHETIC_INTERVAL_001",
  scope_claim_id: "SYNTHETIC_SCOPE_001",
  temporal: {
    valid_time: {
      signing_date: "2024-01-01",
      publication_date: "2024-01-02",
      commencement_date: "2024-02-01",
      operative_interval: { from: "2024-02-01", to: null },
      payroll_reference_period: { from: "2024-02-01", to: "2024-02-29" },
    },
    knowledge_time: {
      ingested_at: "2024-03-01T00:00:00Z",
      reviewed_at: null,
      activated_at: null,
      invalidated_at: null,
    },
  },
  relationship_claims: [],
});

export const wave1SyntheticReadinessQuery: Wave1TopicReadinessQuery = Object.freeze({
  topic: "synthetic_topic",
  sector: "synthetic_sector",
  population: "synthetic_population",
  from: "2024-02-15",
  as_of: "2024-03-01T00:00:00Z",
  required_source_roles: ["operative_instrument"] as const,
  use_case: "monetary_rule",
});

/** Deliberately incomplete and inactive; the CLI demonstrates a fail-closed result. */
export const wave1SyntheticInactiveEvidence: Wave1TopicEvidence = Object.freeze({
  evidence_ref: {
    source_id: "SYNTHETIC_SOURCE_001",
    source_version_id: "SYNTHETIC_SOURCE_001:v1",
    artifact_sha256: A,
    parsed_version_id: null,
    citation_id: null,
    review_state: "needs_review",
    activation_state: "inactive",
  } as const,
  topic: "synthetic_topic",
  source_role: "operative_instrument",
  catalog_entry_id: "SYNTHETIC_CATALOG_001",
  valid_time: { from: "2024-02-01", to: null },
  sectors: ["synthetic_sector"],
  populations: ["synthetic_population"],
  ingested_at: "2024-03-01T00:00:00Z",
  effective_claim_id: "SYNTHETIC_INTERVAL_001",
  scope_claim_id: "SYNTHETIC_SCOPE_001",
  review_attestation: null,
  current_review_binding: null,
  review_invalidations: [],
});
