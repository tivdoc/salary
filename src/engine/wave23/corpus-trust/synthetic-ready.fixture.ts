import type { LegalReadinessCandidate, LegalReadinessCase } from "../../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";

export const SYNTHETIC_READY_FIXTURE_CONTROLS = Object.freeze({
  fixture_id: "SYNTHETIC_READY_FIXTURE_V050",
  exposure: "test_and_audit_evidence_only",
  production_manifest_eligible: false,
  external_persistence_allowed: false,
  source_activation_allowed: false,
  product_exposure_allowed: false,
  legally_neutral: true,
});

export const SYNTHETIC_READY_CASE: LegalReadinessCase = Object.freeze({
  case_id: "SYNTHETIC_READINESS_READY_001",
  topic: "SYNTHETIC_TOPIC_V050",
  kind: "synthetic",
  target_date: "2030-06-15",
  as_of: "2030-06-15",
  sector: "SYN_SECTOR_ALPHA",
  population: "SYN_POPULATION_ALPHA",
  contract_version: "v0.5.0",
  use_case: "monetary_rule",
});

export const SYNTHETIC_READY_CANDIDATE: LegalReadinessCandidate = Object.freeze({
  source_id: "SYN_SOURCE_ALPHA",
  source_version_id: "SYN_SOURCE_ALPHA@v1",
  topics: Object.freeze(["SYNTHETIC_TOPIC_V050"]),
  parse_succeeded: true,
  citation_verified: true,
  operative_role_eligible: true,
  human_reviewed: true,
  effective_interval_verified: true,
  verified_sectors: Object.freeze(["SYN_SECTOR_ALPHA"]),
  verified_populations: Object.freeze(["SYN_POPULATION_ALPHA"]),
  active: true,
  acquisition_status: "available",
  technical_parse_status: "parsed",
  instrument_boundary_status: "resolved",
  publication_status: "review_candidate",
  retrieval_visibility: "visible",
  retrieval_surface: "canonical_review",
  source_role: "binding_role_candidate",
  monetary_support_eligibility: "eligible",
  citation: Object.freeze({ citation_id: "SYN_CITATION_ALPHA", verified: true, source_version_id: "SYN_SOURCE_ALPHA@v1" }),
  review_attestation: Object.freeze({ attestation_id: "SYN_REVIEW_ALPHA", status: "reviewed", source_version_id: "SYN_SOURCE_ALPHA@v1", reviewed_at: "2030-06-01" }),
  valid_time: Object.freeze({ from: "2030-01-01", to: "2030-12-31", verified: true }),
  knowledge_time: Object.freeze({ available_from: "2030-01-01", unavailable_from: null }),
  sector_status: "verified",
  population_status: "verified",
  activation_status: "active",
  bound_source_version_id: "SYN_SOURCE_ALPHA@v1",
});
