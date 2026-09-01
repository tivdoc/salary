import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalReadinessJson,
  evaluateLegalReadiness,
  type LegalReadinessCandidate,
} from "../../../../../engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness";
import { decodeSelection, validateTopicResult } from "./validation";

const HASH = "a".repeat(64);
const TOPIC = "minimum_wage" as const;

function candidate(): LegalReadinessCandidate {
  const sourceVersionId = "synthetic-source-version:minimum-wage:1.0.0";
  return Object.freeze({
    source_version_id: sourceVersionId,
    source_id: "synthetic-source:minimum-wage",
    topics: [TOPIC],
    parse_succeeded: true,
    citation_verified: true,
    operative_role_eligible: true,
    human_reviewed: true,
    effective_interval_verified: true,
    verified_sectors: ["synthetic_sector"],
    verified_populations: ["synthetic_population"],
    active: true,
    acquisition_status: "available",
    technical_parse_status: "parsed",
    instrument_boundary_status: "resolved",
    publication_status: "review_candidate",
    retrieval_visibility: "visible",
    retrieval_surface: "canonical_review",
    source_role: "binding_role_candidate",
    monetary_support_eligibility: "eligible",
    citation: Object.freeze({ citation_id: "synthetic-citation:minimum-wage", verified: true, source_version_id: sourceVersionId }),
    review_attestation: Object.freeze({
      attestation_id: "synthetic-review:minimum-wage",
      status: "reviewed",
      source_version_id: sourceVersionId,
      reviewed_at: "2025-01-15",
    }),
    valid_time: Object.freeze({ from: "2025-01-01", to: null, verified: true }),
    knowledge_time: Object.freeze({ available_from: "2025-01-01", unavailable_from: null }),
    sector_status: "verified",
    population_status: "verified",
    activation_status: "active",
    bound_source_version_id: sourceVersionId,
  });
}

function canonicalDecision() {
  return evaluateLegalReadiness({
    readinessCase: Object.freeze({
      case_id: "synthetic-readiness:minimum-wage",
      topic: TOPIC,
      kind: "synthetic",
      target_date: "2025-01-31",
      as_of: "2025-02-01",
      sector: "synthetic_sector",
      population: "synthetic_population",
      contract_version: "v0.5.0",
      use_case: "monetary_rule",
    }),
    candidates: [candidate()],
  });
}

function selection(readiness: unknown = canonicalDecision(), mode: "real" | "synthetic_test" = "synthetic_test") {
  return {
    catalog_id: "synthetic-catalog",
    catalog_version: "1.0.0",
    catalog_sha256: HASH,
    mode,
    topic: TOPIC,
    source_version_ids: ["synthetic-source-version:minimum-wage:1.0.0"],
    parameter_version_ids: ["synthetic-parameter:minimum-wage:1.0.0"],
    rule_spec_id: "synthetic.minimum_wage.identity",
    rule_spec_version: "1.0.0",
    readiness,
  };
}

function topicResult(readiness: unknown) {
  return {
    topic: TOPIC,
    status: "blocked_legal_readiness",
    blockers: ["SYNTHETIC_ONLY"],
    rule_input_sha256: HASH,
    amount: null,
    trace: null,
    legal_readiness: readiness,
  };
}

function mutableCanonicalDecision(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(canonicalDecision())) as Record<string, unknown>;
}

function readinessHash(value: unknown): string {
  return createHash("sha256").update(canonicalReadinessJson(value)).digest("hex");
}

const LEGACY_SYNTHETIC = Object.freeze({
  schema_version: "tivdoc-legal-readiness-v0.5.0",
  decision_source: "evaluateLegalReadiness",
  status: "BLOCKED_NOT_READY",
  reason_codes: Object.freeze(["SYNTHETIC_DYNAMIC_VERIFICATION_ONLY"]),
  decision_sha256: "b".repeat(64),
  usable_for_rules: false,
  operative_candidate_source_version_ids: Object.freeze([]),
  normalized_input_sha256: null,
});

describe("canonical PostgreSQL readiness decoding", () => {
  it("accepts the exact canonical V0.5 evaluator decision for selections and topic results", () => {
    const decision = canonicalDecision();
    const decoded = decodeSelection(selection(decision));

    expect(decoded.readiness).toEqual(decision);
    expect(validateTopicResult(topicResult(decision)).legal_readiness).toEqual(decision);
  });

  it("preserves the narrow legacy synthetic selection contract but rejects it for real mode", () => {
    expect(decodeSelection(selection(LEGACY_SYNTHETIC)).readiness).toEqual(LEGACY_SYNTHETIC);
    expect(() => decodeSelection(selection(LEGACY_SYNTHETIC, "real"))).toThrow("ANALYSIS_ROW_MALFORMED");
    expect(validateTopicResult(topicResult(LEGACY_SYNTHETIC)).legal_readiness).toEqual(LEGACY_SYNTHETIC);
  });

  it("rejects unknown schema and evaluator versions plus non-exact canonical fields", () => {
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), schema_version: "unknown" })))
      .toThrow("ANALYSIS_ROW_VERSION_UNSUPPORTED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), evaluator_version: "evaluateLegalReadiness@v0.5.1" })))
      .toThrow("ANALYSIS_ROW_VERSION_UNSUPPORTED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), unexpected: true })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
  });

  it("fails closed on arrays, booleans, normalized-input hashes, and decision hashes", () => {
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), considered_source_version_ids: "not-an-array" })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), operative_candidate_source_version_ids: ["duplicate", "duplicate"] })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), usable_for_rules: "true" })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), normalized_input_sha256: "0".repeat(64) })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
    expect(() => decodeSelection(selection({ ...mutableCanonicalDecision(), decision_sha256: "0".repeat(64) })))
      .toThrow("ANALYSIS_ROW_MALFORMED");
  });

  it("rejects a semantically forged decision even when its direct hash is recomputed", () => {
    const forged: Record<string, unknown> = { ...mutableCanonicalDecision(), test_only_synthetic: false };
    const seed = Object.fromEntries(Object.entries(forged).filter(([key]) => key !== "decision_sha256"));
    forged.decision_sha256 = readinessHash(seed);

    expect(() => decodeSelection(selection(forged))).toThrow("ANALYSIS_ROW_MALFORMED");
  });
});
