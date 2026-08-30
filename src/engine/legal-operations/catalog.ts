import type { LegalCatalogSelection, LegalRuleCatalogPort, Wave3Topic } from "../wave3/contracts.ts";
import { evaluateLegalReadiness, type LegalReadinessCandidate, type LegalReadinessCase } from "../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";
import { CORPUS_LIFECYCLE, type CorpusLifecycleEntry } from "../wave23/corpus-trust/lifecycle.ts";
import { frozen, legalOperationsSha256 } from "./canonical.ts";
import {
  SYNTHETIC_CATALOG_DATE,
  SYNTHETIC_CATALOG_TIMESTAMP,
  SYNTHETIC_POPULATION,
  SYNTHETIC_SECTOR,
  SYNTHETIC_SEVEN_TOPIC_FIXTURES,
  type SyntheticLegalFixture,
} from "./synthetic-fixtures.ts";

export const SYNTHETIC_CATALOG_BOUNDARY = frozen({
  catalog_id: "tivdoc.synthetic.reviewed.catalog",
  catalog_version: "1.0.0",
  compile_time_mode: "synthetic_test" as const,
  runtime_allowed_modes: ["synthetic_test"] as const,
  forbidden_environments: ["real", "development", "preview", "production", "shadow"] as const,
  production_manifest_reachable: false as const,
  external_persistence_allowed: false as const,
  legally_neutral: true as const,
});

export const REAL_CATALOG_BOUNDARY = frozen({
  catalog_id: "tivdoc.real.inactive.catalog",
  catalog_version: "1.0.0",
  compile_time_mode: "real" as const,
  active_sources: 0 as const,
  active_parameters: 0 as const,
  active_rules: 0 as const,
});

function realCandidate(entry: CorpusLifecycleEntry): LegalReadinessCandidate {
  return frozen({
    source_id: entry.source_version_id.split("@")[0],
    source_version_id: entry.source_version_id,
    topics: [entry.topic],
    parse_succeeded: entry.technical_parse_status === "parsed",
    citation_verified: false,
    operative_role_eligible: entry.source_role === "binding_role_candidate",
    human_reviewed: false,
    effective_interval_verified: false,
    verified_sectors: [],
    verified_populations: [],
    active: false,
    acquisition_status: entry.acquisition_status,
    technical_parse_status: entry.technical_parse_status,
    instrument_boundary_status: entry.instrument_boundary_status === "resolved" ? "resolved" : entry.instrument_boundary_status === "unresolved" ? "unresolved" : "ambiguous",
    publication_status: entry.publication_status,
    retrieval_visibility: entry.retrieval_visibility,
    retrieval_surface: entry.retrieval_surface,
    source_role: entry.source_role,
    monetary_support_eligibility: "ineligible",
    citation: undefined,
    review_attestation: undefined,
    valid_time: undefined,
    knowledge_time: undefined,
    sector_status: "unverified",
    population_status: "unverified",
    activation_status: "inactive",
    bound_source_version_id: entry.source_version_id,
  });
}

function syntheticReadyCandidate(fixture: SyntheticLegalFixture): LegalReadinessCandidate {
  return frozen({
    source_id: fixture.source_version_id.split("@")[0],
    source_version_id: fixture.source_version_id,
    topics: [fixture.topic],
    parse_succeeded: true,
    citation_verified: true,
    operative_role_eligible: true,
    human_reviewed: true,
    effective_interval_verified: true,
    verified_sectors: [SYNTHETIC_SECTOR],
    verified_populations: [SYNTHETIC_POPULATION],
    active: true,
    acquisition_status: "available",
    technical_parse_status: "parsed",
    instrument_boundary_status: "resolved",
    publication_status: "review_candidate",
    retrieval_visibility: "visible",
    retrieval_surface: "canonical_review",
    source_role: "binding_role_candidate",
    monetary_support_eligibility: "eligible",
    citation: { citation_id: `SYN_CITATION_${fixture.topic.toUpperCase()}`, verified: true, source_version_id: fixture.source_version_id },
    review_attestation: { attestation_id: `SYN_REVIEW_${fixture.topic.toUpperCase()}`, status: "reviewed", source_version_id: fixture.source_version_id, reviewed_at: SYNTHETIC_CATALOG_DATE },
    valid_time: { from: SYNTHETIC_CATALOG_DATE, to: null, verified: true },
    knowledge_time: { available_from: SYNTHETIC_CATALOG_DATE, unavailable_from: null },
    sector_status: "verified",
    population_status: "verified",
    activation_status: "active",
    bound_source_version_id: fixture.source_version_id,
  });
}

function readinessCase(input: Readonly<{ topic: Wave3Topic; target_date: string; as_of: string; sector: string; population: string; mode: "real" | "synthetic_test" }>): LegalReadinessCase {
  return frozen({
    case_id: `${input.mode.toUpperCase()}_CATALOG_${input.topic.toUpperCase()}`,
    topic: input.topic,
    kind: input.mode === "synthetic_test" ? "synthetic" : "current",
    target_date: input.target_date,
    as_of: input.as_of,
    sector: input.sector,
    population: input.population,
    contract_version: "v0.5.0",
    use_case: "monetary_rule",
  });
}

export class LegalOperationsCatalog implements LegalRuleCatalogPort {
  async resolve(input: Readonly<{ topic: Wave3Topic; target_date: string; as_of: string; sector: string; population: string; mode: "real" | "synthetic_test" }>): Promise<LegalCatalogSelection> {
    if (input.mode !== "real" && input.mode !== "synthetic_test") throw new Error("LEGAL_CATALOG_MODE_FORBIDDEN");
    if (input.mode === "synthetic_test") return this.#synthetic({ ...input, mode: "synthetic_test" });
    return this.#real({ ...input, mode: "real" });
  }

  #synthetic(input: Readonly<{ topic: Wave3Topic; target_date: string; as_of: string; sector: string; population: string; mode: "synthetic_test" }>): LegalCatalogSelection {
    const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.topic === input.topic);
    if (!fixture) throw new Error("SYNTHETIC_CATALOG_TOPIC_MISSING");
    const readiness = evaluateLegalReadiness({ readinessCase: readinessCase(input), candidates: [syntheticReadyCandidate(fixture)] });
    const selected = readiness.status === "READY";
    const catalogContent = frozen({ boundary: SYNTHETIC_CATALOG_BOUNDARY, topic: input.topic, rule_sha256: fixture.rule.content_sha256, parameter_sha256: fixture.parameter.candidate_sha256, readiness_sha256: readiness.decision_sha256 });
    return frozen({
      catalog_id: SYNTHETIC_CATALOG_BOUNDARY.catalog_id,
      catalog_version: SYNTHETIC_CATALOG_BOUNDARY.catalog_version,
      catalog_sha256: legalOperationsSha256(catalogContent),
      mode: "synthetic_test",
      topic: input.topic,
      source_version_ids: selected ? [fixture.source_version_id] : [],
      parameter_version_ids: selected ? [`${fixture.parameter.parameter_id}@${fixture.parameter.parameter_version}`] : [],
      rule_spec_id: selected ? fixture.rule.rule_spec_id : null,
      rule_spec_version: selected ? fixture.rule.rule_spec_version : null,
      readiness,
    });
  }

  #real(input: Readonly<{ topic: Wave3Topic; target_date: string; as_of: string; sector: string; population: string; mode: "real" }>): LegalCatalogSelection {
    const candidates = CORPUS_LIFECYCLE.filter((entry) => entry.topic === input.topic).map(realCandidate);
    const readiness = evaluateLegalReadiness({ readinessCase: readinessCase(input), candidates });
    if (readiness.status === "READY") throw new Error("REAL_CATALOG_UNEXPECTED_READY");
    return frozen({
      catalog_id: REAL_CATALOG_BOUNDARY.catalog_id,
      catalog_version: REAL_CATALOG_BOUNDARY.catalog_version,
      catalog_sha256: legalOperationsSha256({ boundary: REAL_CATALOG_BOUNDARY, topic: input.topic, readiness_sha256: readiness.decision_sha256 }),
      mode: "real",
      topic: input.topic,
      source_version_ids: [],
      parameter_version_ids: [],
      rule_spec_id: null,
      rule_spec_version: null,
      readiness,
    });
  }
}

export async function syntheticSevenTopicCatalogMatrix() {
  const catalog = new LegalOperationsCatalog();
  const selections = await Promise.all(SYNTHETIC_SEVEN_TOPIC_FIXTURES.map((fixture) => catalog.resolve({
    topic: fixture.topic,
    target_date: SYNTHETIC_CATALOG_DATE,
    as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
    mode: "synthetic_test",
  })));
  return frozen({
    schema_version: "tivdoc-synthetic-catalog-matrix-v0.6.0",
    evaluated_at: SYNTHETIC_CATALOG_TIMESTAMP,
    topic_count: selections.length,
    ready_count: selections.filter((entry) => entry.readiness.status === "READY").length,
    active_parameter_count: selections.reduce((count, entry) => count + entry.parameter_version_ids.length, 0),
    active_rule_count: selections.filter((entry) => entry.rule_spec_id !== null).length,
    selections,
    passed: selections.length === 7 && selections.every((entry) => entry.readiness.status === "READY" && entry.rule_spec_id !== null && entry.parameter_version_ids.length === 1),
  });
}

export async function realCatalogStatusMatrix() {
  const catalog = new LegalOperationsCatalog();
  const selections = await Promise.all(SYNTHETIC_SEVEN_TOPIC_FIXTURES.map((fixture) => catalog.resolve({
    topic: fixture.topic,
    target_date: SYNTHETIC_CATALOG_DATE,
    as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR,
    population: SYNTHETIC_POPULATION,
    mode: "real",
  })));
  return frozen({
    schema_version: "tivdoc-real-catalog-status-v0.6.0",
    topic_count: selections.length,
    ready_count: selections.filter((entry) => entry.readiness.status === "READY").length,
    active_parameter_count: selections.reduce((count, entry) => count + entry.parameter_version_ids.length, 0),
    active_rule_count: selections.filter((entry) => entry.rule_spec_id !== null).length,
    selections,
    passed: selections.length === 7 && selections.every((entry) => entry.readiness.status === "BLOCKED_NOT_READY" && entry.source_version_ids.length === 0 && entry.parameter_version_ids.length === 0 && entry.rule_spec_id === null),
  });
}
