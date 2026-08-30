import { canonicalSha256 } from "../../rule-runtime/canonical.ts";
import type { LegalSource } from "../contracts.ts";
import { evaluateStrictRealCorpusReadiness } from "../corpus-hardening/readiness.ts";
import type { LegalTopic } from "../taxonomy.ts";

export const P3_TOPICS = ["minimum_wage", "working_time", "pension", "travel", "convalescence", "vacation", "sick_leave"] as const satisfies readonly LegalTopic[];

export type BuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  parse_status: string;
  parsed_version_id: string | null;
  normalized_text_sha256: string | null;
  chunk_count: number;
  page_count: number;
  safe_error_code: string | null;
  normalized_path?: string | null;
  chunks_path?: string | null;
  normalized_output_sha256?: string | null;
  chunks_output_sha256?: string | null;
}>;

export type FetchState = Readonly<{
  observations: readonly Readonly<{
    source_id: string;
    source_version: string;
    artifact_sha256: string;
    byte_count: number;
    parse_status: string;
    safe_error_code: string | null;
  }>[];
  failures: readonly unknown[];
}>;

export type CitationState = Readonly<{
  records: readonly Readonly<{
    source_id: string;
    source_version_id: string;
    status: string;
    chunks_checked?: number;
    failures?: readonly unknown[] | number;
    normalized_text_sha256?: string;
    raw_artifact_sha256?: string;
    samples?: readonly Readonly<{ chunk_id: string; locator: unknown }>[];
  }>[];
}>;

export type LifecycleTotals = Readonly<{
  source_count: number;
  technical_parsed_sources: number;
  technical_failed_sources: number;
  parsed_but_instrument_quarantined_sources: number;
  extracted_chunks: number;
  instrument_resolved_chunks: number;
  quarantined_chunk_cardinality: number;
  retrievable_review_chunks: number;
  canonical_binding_candidate_chunks: number;
  explanatory_or_corroborative_chunks: number;
  needs_review_sources: number;
  reviewed_sources: number;
  inactive_sources: number;
  active_sources: number;
  operative_sources: number;
}>;

export type CorpusInventory = ReturnType<typeof recomputeCorpusInventory>;

export function recomputeCorpusInventory(input: Readonly<{
  sources: readonly LegalSource[];
  build_records: readonly BuildRecord[];
  fetch_state: FetchState;
  citation_state: CitationState;
  working_time: Readonly<{
    hours_publications: number;
    permit_catalog_entries: number;
    permit_artifact_links: number;
    acquisition_requested: number;
    acquisition_acquired: number;
    acquisition_failed_403: number;
    acquisition_failed_404: number;
  }>;
  pension_inventory: Readonly<{ pension_2016: Readonly<{
    page_count: number;
    parse_status: string;
    safe_error_code: string;
    review_state: string;
    activation_state: string;
    artifact_sha256?: string;
    native_parser?: unknown;
    renderer?: unknown;
    ocr?: unknown;
  }> }>;
  minimum_wage: Readonly<{
    source_activation_states: readonly string[];
    baseline_sha256: string;
    candidate_sha256s: readonly string[];
  }>;
  lifecycle_totals: LifecycleTotals;
}>) {
  const sourceVersionIds = input.sources.map((source) => `${source.source_id}@${source.source_version}`);
  if (new Set(sourceVersionIds).size !== sourceVersionIds.length) throw new Error("P3_DUPLICATE_SOURCE_VERSION");
  if (input.build_records.length !== input.sources.length || input.citation_state.records.length !== input.sources.length) throw new Error("P3_ONE_TO_ONE_CORPUS_STATE_REQUIRED");
  const buildById = new Map(input.build_records.map((record) => [`${record.source_id}@${record.source_version}`, record]));
  const citationById = new Map(input.citation_state.records.map((record) => [record.source_version_id, record]));
  if (sourceVersionIds.some((id) => !buildById.has(id) || !citationById.has(id))) throw new Error("P3_CORPUS_STATE_IDENTITY_MISMATCH");

  const legacyParsed = input.build_records.filter((record) => record.parse_status === "parsed").length;
  const legacyFailed = input.build_records.length - legacyParsed;
  const legacyChunks = input.build_records.reduce((sum, record) => sum + record.chunk_count, 0);
  if (input.lifecycle_totals.source_count !== input.sources.length || input.lifecycle_totals.instrument_resolved_chunks !== legacyChunks || input.lifecycle_totals.retrievable_review_chunks !== legacyChunks) {
    throw new Error("P3_LIFECYCLE_RECONCILIATION_MISMATCH");
  }
  if (input.lifecycle_totals.extracted_chunks - input.lifecycle_totals.quarantined_chunk_cardinality !== input.lifecycle_totals.instrument_resolved_chunks) {
    throw new Error("P3_QUARANTINE_CARDINALITY_MISMATCH");
  }
  if (input.lifecycle_totals.canonical_binding_candidate_chunks + input.lifecycle_totals.explanatory_or_corroborative_chunks !== input.lifecycle_totals.retrievable_review_chunks) {
    throw new Error("P3_CHUNK_ROLE_RECONCILIATION_MISMATCH");
  }

  const readiness = evaluateStrictRealCorpusReadiness({
    sources: input.sources,
    buildRecords: input.build_records.map((record) => ({ source_version_id: `${record.source_id}@${record.source_version}`, parse_status: record.parse_status })),
    citationRecords: input.citation_state.records.map((record) => ({ source_version_id: record.source_version_id, status: record.status })),
  });
  if (!/^[a-f0-9]{64}$/u.test(input.minimum_wage.baseline_sha256) || input.minimum_wage.candidate_sha256s.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) {
    throw new Error("P3_MINIMUM_WAGE_HASH_INVENTORY_INVALID");
  }
  const topicCoverage = P3_TOPICS.map((topic) => {
    const sources = input.sources.filter((source) => source.topics.includes(topic));
    const report = readiness.reports.find((candidate) => candidate.topic === topic);
    if (!report) throw new Error(`P3_READINESS_TOPIC_MISSING:${topic}`);
    return Object.freeze({
      topic,
      source_version_ids: Object.freeze(sources.map((source) => `${source.source_id}@${source.source_version}`).sort()),
      effective_interval_verified: report.gates.effective_interval.passed,
      sector_verified: report.gates.sector.passed,
      population_verified: report.gates.population.passed,
      review_verified: report.gates.review.passed,
      activation_verified: report.gates.activation.passed,
      status: report.status,
      blocker_codes: report.canonical_decision.reason_codes,
    });
  });
  const inventoryCore = Object.freeze({
    schema_version: "tivdoc-p3-corpus-inventory-v0.7.0" as const,
    registered: Object.freeze({
      source_versions: input.sources.length,
      statuses: Object.freeze(Object.fromEntries([...new Set(input.sources.map((source) => source.status))].sort().map((status) => [status, input.sources.filter((source) => source.status === status).length]))),
      reviewed_sources: input.sources.filter((source) => source.status === "reviewed").length,
      active_sources: input.sources.filter((source) => source.status === "active").length,
    }),
    raw_observations: Object.freeze({
      fetch_observations: input.fetch_state.observations.length,
      fetch_failures: input.fetch_state.failures.length,
      unique_observed_artifact_hashes: new Set(input.fetch_state.observations.map((entry) => entry.artifact_sha256)).size,
      observed_bytes: input.fetch_state.observations.reduce((sum, entry) => sum + entry.byte_count, 0),
    }),
    legacy_build_view: Object.freeze({ build_records: input.build_records.length, parsed: legacyParsed, failed: legacyFailed, chunks: legacyChunks }),
    lifecycle_reconciliation: Object.freeze({ ...input.lifecycle_totals }),
    citations: Object.freeze({
      records: input.citation_state.records.length,
      round_trip_passed: input.citation_state.records.filter((record) => record.status === "round_trip_passed").length,
      not_auditable: input.citation_state.records.filter((record) => record.status !== "round_trip_passed").length,
    }),
    staged_working_time: Object.freeze({
      publications: input.working_time.hours_publications,
      permit_catalog_entries: input.working_time.permit_catalog_entries,
      permit_artifact_links: input.working_time.permit_artifact_links,
      acquisition_requested_historical: input.working_time.acquisition_requested,
      acquired_artifacts_historical: input.working_time.acquisition_acquired,
      missing_http_403_historical: input.working_time.acquisition_failed_403,
      missing_http_404_historical: input.working_time.acquisition_failed_404,
      counted_as_registered_corpus: false,
    }),
    source_specific_gaps: Object.freeze({
      hours_law_parseable_registered_representation: buildById.get("IL_HOURS_WORK_REST_LAW@discovery-v0")?.parse_status === "parsed",
      institutional_consolidated_hours_text_observed: false,
      pension_2016: Object.freeze({ ...input.pension_inventory.pension_2016 }),
      convalescence_history_source_ids: Object.freeze(input.sources.filter((source) => source.source_id.includes("CONVALESCENCE")).map((source) => source.source_id).sort()),
      minimum_wage_byte_candidates: input.minimum_wage.candidate_sha256s.length,
      minimum_wage_candidates_all_inactive: input.minimum_wage.source_activation_states.every((state) => state === "inactive") && input.minimum_wage.candidate_sha256s.every((candidate) => candidate !== input.minimum_wage.baseline_sha256),
    }),
    topic_coverage: Object.freeze(topicCoverage),
    readiness,
    decisions: Object.freeze({ genuine_signatures: 0, reviewed_sources: 0, active_sources: 0, real_parameters: 0, real_rules: 0 }),
    selected_corpus_mutated: false,
  });
  return Object.freeze({ ...inventoryCore, inventory_sha256: canonicalSha256(inventoryCore) });
}
