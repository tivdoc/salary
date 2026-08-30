export const CORPUS_LIFECYCLE_SCHEMA = "tivdoc-corpus-lifecycle-v0.5.0" as const;

export type CorpusLifecycleEntry = Readonly<{
  lifecycle_id: string;
  source_version_id: string;
  topic: string;
  acquisition_status: "available";
  technical_parse_status: "parsed" | "failed";
  instrument_boundary_status: "resolved" | "resolved_with_review_pending" | "ambiguous" | "unresolved";
  publication_status: "review_candidate" | "quarantined";
  retrieval_visibility: "visible" | "hidden";
  retrieval_surface: "canonical_review" | "corroborative_review" | "explanatory_review" | "none";
  source_role: "binding_role_candidate" | "corroborative" | "secondary_explanatory" | "role_pending";
  monetary_support_eligibility: "ineligible_pending_review";
  human_review_status: "needs_review";
  effective_interval_status: "unverified";
  sector_status: "unverified";
  population_status: "unverified";
  activation_status: "inactive";
  binding_role_candidate: boolean;
  operative: false;
  extracted_chunks: number;
  instrument_resolved_chunks: number;
  quarantined_chunks: number;
  retrievable_review_chunks: number;
  canonical_candidate_chunks: number;
  explanatory_only_chunks: number;
}>;

type EntrySeed = Readonly<{
  source_version_id: string;
  topic: string;
  extracted: number;
  resolved: number;
  parse?: "failed";
  boundary?: CorpusLifecycleEntry["instrument_boundary_status"];
  role?: CorpusLifecycleEntry["source_role"];
  surface?: CorpusLifecycleEntry["retrieval_surface"];
}>;

const SEEDS: readonly EntrySeed[] = Object.freeze([
  { source_version_id: "IL_ANNUAL_VACATION_LAW@discovery-v0", topic: "vacation", extracted: 6, resolved: 6 },
  { source_version_id: "IL_CONVALESCENCE_EXTENSION_ORDER_1988@discovery-v0", topic: "convalescence", extracted: 4, resolved: 4 },
  { source_version_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2016@discovery-v0.1", topic: "convalescence", extracted: 3, resolved: 3 },
  { source_version_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2", topic: "convalescence", extracted: 6, resolved: 0, boundary: "ambiguous" },
  { source_version_id: "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2", topic: "convalescence", extracted: 14, resolved: 14 },
  { source_version_id: "IL_CONVALESCENCE_KNESSET_RESEARCH_2025@discovery-v0", topic: "convalescence", extracted: 9, resolved: 9, role: "secondary_explanatory", surface: "explanatory_review" },
  { source_version_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2024@discovery-v0.2", topic: "convalescence", extracted: 11, resolved: 11 },
  { source_version_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025@discovery-v0.3.1", topic: "convalescence", extracted: 65, resolved: 11, boundary: "resolved_with_review_pending" },
  { source_version_id: "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1", topic: "working_time", extracted: 12, resolved: 0, boundary: "ambiguous", role: "role_pending" },
  { source_version_id: "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0", topic: "pension", extracted: 12, resolved: 12 },
  { source_version_id: "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2", topic: "pension", extracted: 0, resolved: 0, parse: "failed", boundary: "unresolved" },
  { source_version_id: "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0", topic: "travel", extracted: 1, resolved: 1 },
  { source_version_id: "IL_HOURS_WORK_REST_LAW@discovery-v0", topic: "working_time", extracted: 9, resolved: 9 },
  { source_version_id: "IL_MIN_WAGE_LAW@discovery-v0", topic: "minimum_wage", extracted: 8, resolved: 8 },
  { source_version_id: "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0", topic: "minimum_wage", extracted: 107, resolved: 107, role: "corroborative", surface: "corroborative_review" },
  { source_version_id: "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1", topic: "working_time", extracted: 2, resolved: 2 },
  { source_version_id: "IL_SICK_PAY_LAW@discovery-v0", topic: "sick_leave", extracted: 5, resolved: 5 },
]);

export const CORPUS_LIFECYCLE: readonly CorpusLifecycleEntry[] = Object.freeze(SEEDS.map((seed, index) => {
  const sourceRole = seed.role ?? "binding_role_candidate";
  const hidden = seed.resolved === 0;
  const explanatory = sourceRole === "corroborative" || sourceRole === "secondary_explanatory";
  return Object.freeze({
    lifecycle_id: `SOURCE_LIFECYCLE_${String(index + 1).padStart(3, "0")}`,
    source_version_id: seed.source_version_id,
    topic: seed.topic,
    acquisition_status: "available",
    technical_parse_status: seed.parse ?? "parsed",
    instrument_boundary_status: seed.boundary ?? "resolved",
    publication_status: hidden ? "quarantined" : "review_candidate",
    retrieval_visibility: hidden ? "hidden" : "visible",
    retrieval_surface: hidden ? "none" : seed.surface ?? "canonical_review",
    source_role: sourceRole,
    monetary_support_eligibility: "ineligible_pending_review",
    human_review_status: "needs_review",
    effective_interval_status: "unverified",
    sector_status: "unverified",
    population_status: "unverified",
    activation_status: "inactive",
    binding_role_candidate: sourceRole === "binding_role_candidate",
    operative: false,
    extracted_chunks: seed.extracted,
    instrument_resolved_chunks: seed.resolved,
    quarantined_chunks: seed.extracted - seed.resolved,
    retrievable_review_chunks: seed.resolved,
    canonical_candidate_chunks: explanatory ? 0 : seed.resolved,
    explanatory_only_chunks: explanatory ? seed.resolved : 0,
  });
}));

function sum(field: keyof Pick<CorpusLifecycleEntry, "extracted_chunks" | "instrument_resolved_chunks" | "quarantined_chunks" | "retrievable_review_chunks" | "canonical_candidate_chunks" | "explanatory_only_chunks">) {
  return CORPUS_LIFECYCLE.reduce((total, entry) => total + entry[field], 0);
}

export function corpusLifecycleReconciliation() {
  const totals = Object.freeze({
    source_count: CORPUS_LIFECYCLE.length,
    technical_parsed_sources: CORPUS_LIFECYCLE.filter((entry) => entry.technical_parse_status === "parsed").length,
    technical_failed_sources: CORPUS_LIFECYCLE.filter((entry) => entry.technical_parse_status === "failed").length,
    parsed_but_instrument_quarantined_sources: CORPUS_LIFECYCLE.filter((entry) => entry.technical_parse_status === "parsed" && entry.retrieval_visibility === "hidden").length,
    extracted_chunks: sum("extracted_chunks"),
    instrument_resolved_chunks: sum("instrument_resolved_chunks"),
    quarantined_chunk_cardinality: sum("quarantined_chunks"),
    retrievable_review_chunks: sum("retrievable_review_chunks"),
    canonical_binding_candidate_chunks: sum("canonical_candidate_chunks"),
    explanatory_or_corroborative_chunks: sum("explanatory_only_chunks"),
    needs_review_sources: CORPUS_LIFECYCLE.filter((entry) => entry.human_review_status === "needs_review").length,
    reviewed_sources: 0,
    inactive_sources: CORPUS_LIFECYCLE.filter((entry) => entry.activation_status === "inactive").length,
    active_sources: 0,
    operative_sources: 0,
  });
  const invariants = Object.freeze({
    sources_17: totals.source_count === 17,
    corrected_parse_16_1: totals.technical_parsed_sources === 16 && totals.technical_failed_sources === 1,
    parsed_quarantine_2: totals.parsed_but_instrument_quarantined_sources === 2,
    arithmetic_274_to_202: totals.extracted_chunks === 274 && totals.instrument_resolved_chunks === 202 && totals.quarantined_chunk_cardinality === 72,
    retrieval_surface_partition: totals.canonical_binding_candidate_chunks + totals.explanatory_or_corroborative_chunks === totals.retrievable_review_chunks,
    all_unreviewed_inactive_nonoperative: totals.needs_review_sources === 17 && totals.reviewed_sources === 0 && totals.active_sources === 0 && totals.operative_sources === 0,
  });
  return Object.freeze({
    schema_version: CORPUS_LIFECYCLE_SCHEMA,
    sources: CORPUS_LIFECYCLE,
    totals,
    old_label_crosswalk: Object.freeze({
      old_conflated_label: "14 parsed / 3 fail-closed",
      corrected_technical_label: "16 technically parsed / 1 technical parse failure",
      corrected_orthogonal_quarantine_label: "2 technically parsed but instrument-boundary quarantined",
      technical_parse_failure_source_version_id: "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2",
      parsed_instrument_quarantine_source_version_ids: Object.freeze([
        "IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2",
        "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1",
      ]),
    }),
    invariants,
    passed: Object.values(invariants).every(Boolean),
  });
}
