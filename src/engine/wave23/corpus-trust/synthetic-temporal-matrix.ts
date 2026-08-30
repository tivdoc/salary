export type SyntheticTemporalRecord = Readonly<{
  record_id: string;
  effective_from: string;
  effective_to: string | null;
  knowledge_from: string;
  knowledge_to: string | null;
  sector: "SYN_GENERAL" | "SYN_SECTOR_ALPHA";
  populations: readonly string[];
  precedence: number;
  supersedes: string | null;
}>;

export type SyntheticTemporalQuery = Readonly<{
  target_date: string;
  as_of: string;
  sector: string | null;
  population: string;
}>;

export function selectSyntheticTemporalRecord(query: SyntheticTemporalQuery, records: readonly SyntheticTemporalRecord[]) {
  if (query.sector === null) return Object.freeze({ status: "BLOCKED" as const, reason: "SECTOR_MISSING" as const, selected_record_id: null });
  if (query.sector === "SYN_UNKNOWN") return Object.freeze({ status: "BLOCKED" as const, reason: "SECTOR_UNKNOWN" as const, selected_record_id: null });
  const eligible = records.filter((record) =>
    query.target_date >= record.effective_from
    && (record.effective_to === null || query.target_date <= record.effective_to)
    && query.as_of >= record.knowledge_from
    && (record.knowledge_to === null || query.as_of < record.knowledge_to)
    && (record.sector === "SYN_GENERAL" || record.sector === query.sector)
    && record.populations.includes(query.population),
  ).map((record) => ({ record, sectorRank: record.sector === query.sector ? 2 : 1 }));
  eligible.sort((a, b) => b.sectorRank - a.sectorRank || b.record.precedence - a.record.precedence || b.record.effective_from.localeCompare(a.record.effective_from, "en") || a.record.record_id.localeCompare(b.record.record_id, "en"));
  if (eligible.length === 0) return Object.freeze({ status: "BLOCKED" as const, reason: "NO_APPLICABLE_VERIFIED_RECORD" as const, selected_record_id: null });
  if (eligible.length > 1 && eligible[0].sectorRank === eligible[1].sectorRank && eligible[0].record.precedence === eligible[1].record.precedence && eligible[0].record.effective_from === eligible[1].record.effective_from) return Object.freeze({ status: "BLOCKED" as const, reason: "OVERLAP_AMBIGUOUS" as const, selected_record_id: null });
  return Object.freeze({ status: "READY" as const, reason: null, selected_record_id: eligible[0].record.record_id });
}

const RECORDS: readonly SyntheticTemporalRecord[] = Object.freeze([
  { record_id: "SYN_RECORD_CLOSED", effective_from: "2030-01-01", effective_to: "2030-12-31", knowledge_from: "2029-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_OPEN", effective_from: "2031-01-01", effective_to: null, knowledge_from: "2030-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_GAP_LEFT", effective_from: "2032-01-01", effective_to: "2032-04-30", knowledge_from: "2031-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_GAP_RIGHT", effective_from: "2032-06-01", effective_to: "2032-12-31", knowledge_from: "2031-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_OVERLAP_A", effective_from: "2033-01-01", effective_to: "2033-12-31", knowledge_from: "2032-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_OVERLAP_B", effective_from: "2033-01-01", effective_to: "2033-12-31", knowledge_from: "2032-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_AMENDMENT_BASE", effective_from: "2034-01-01", effective_to: "2034-12-31", knowledge_from: "2033-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_AMENDMENT_NEW", effective_from: "2034-07-01", effective_to: "2034-12-31", knowledge_from: "2034-06-15", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 2, supersedes: "SYN_RECORD_AMENDMENT_BASE" },
  { record_id: "SYN_RECORD_SECTOR_GENERAL", effective_from: "2035-01-01", effective_to: "2035-12-31", knowledge_from: "2034-12-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_SECTOR_EXACT", effective_from: "2035-01-01", effective_to: "2035-12-31", knowledge_from: "2034-12-01", knowledge_to: "2035-06-01", sector: "SYN_SECTOR_ALPHA", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
  { record_id: "SYN_RECORD_KNOWLEDGE", effective_from: "2036-01-01", effective_to: "2036-12-31", knowledge_from: "2036-06-01", knowledge_to: null, sector: "SYN_GENERAL", populations: ["SYN_POP_ALPHA"], precedence: 1, supersedes: null },
]);

type TemporalCase = Readonly<{
  case_id: string;
  purpose: string;
  record_ids: readonly string[];
  query: SyntheticTemporalQuery;
  expected_status: "READY" | "BLOCKED";
  expected_reason: "SECTOR_MISSING" | "SECTOR_UNKNOWN" | "NO_APPLICABLE_VERIFIED_RECORD" | "OVERLAP_AMBIGUOUS" | null;
  expected_record_id: string | null;
}>;

const CASES: readonly TemporalCase[] = Object.freeze([
  { case_id: "TEMPORAL_CASE_001_DAY_BEFORE", purpose: "day_before_start", record_ids: ["SYN_RECORD_CLOSED"], query: { target_date: "2029-12-31", as_of: "2030-06-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "NO_APPLICABLE_VERIFIED_RECORD", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_002_EXACT_START", purpose: "exact_start_inclusive", record_ids: ["SYN_RECORD_CLOSED"], query: { target_date: "2030-01-01", as_of: "2030-06-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_CLOSED" },
  { case_id: "TEMPORAL_CASE_003_EXACT_END", purpose: "exact_end_inclusive", record_ids: ["SYN_RECORD_CLOSED"], query: { target_date: "2030-12-31", as_of: "2030-12-31", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_CLOSED" },
  { case_id: "TEMPORAL_CASE_004_DAY_AFTER", purpose: "day_after_end", record_ids: ["SYN_RECORD_CLOSED"], query: { target_date: "2031-01-01", as_of: "2031-01-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "NO_APPLICABLE_VERIFIED_RECORD", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_005_OPEN_ENDED", purpose: "open_ended_interval", record_ids: ["SYN_RECORD_OPEN"], query: { target_date: "2040-01-01", as_of: "2040-01-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_OPEN" },
  { case_id: "TEMPORAL_CASE_006_GAP", purpose: "interval_gap", record_ids: ["SYN_RECORD_GAP_LEFT", "SYN_RECORD_GAP_RIGHT"], query: { target_date: "2032-05-15", as_of: "2032-05-15", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "NO_APPLICABLE_VERIFIED_RECORD", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_007_OVERLAP", purpose: "unresolved_overlap", record_ids: ["SYN_RECORD_OVERLAP_A", "SYN_RECORD_OVERLAP_B"], query: { target_date: "2033-06-01", as_of: "2033-06-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "OVERLAP_AMBIGUOUS", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_008_BEFORE_AMENDMENT", purpose: "base_before_amendment", record_ids: ["SYN_RECORD_AMENDMENT_BASE", "SYN_RECORD_AMENDMENT_NEW"], query: { target_date: "2034-06-30", as_of: "2034-07-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_AMENDMENT_BASE" },
  { case_id: "TEMPORAL_CASE_009_AMENDMENT_PRECEDENCE", purpose: "superseding_amendment_precedence", record_ids: ["SYN_RECORD_AMENDMENT_BASE", "SYN_RECORD_AMENDMENT_NEW"], query: { target_date: "2034-07-01", as_of: "2034-07-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_AMENDMENT_NEW" },
  { case_id: "TEMPORAL_CASE_010_SECTOR_PRECEDENCE", purpose: "sector_specific_over_general", record_ids: ["SYN_RECORD_SECTOR_GENERAL", "SYN_RECORD_SECTOR_EXACT"], query: { target_date: "2035-05-01", as_of: "2035-05-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_SECTOR_EXACT" },
  { case_id: "TEMPORAL_CASE_011_GENERAL_FALLBACK", purpose: "general_fallback_when_specific_unavailable", record_ids: ["SYN_RECORD_SECTOR_GENERAL", "SYN_RECORD_SECTOR_EXACT"], query: { target_date: "2035-07-01", as_of: "2035-07-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_SECTOR_GENERAL" },
  { case_id: "TEMPORAL_CASE_012_MISSING_SECTOR", purpose: "missing_sector", record_ids: ["SYN_RECORD_SECTOR_GENERAL"], query: { target_date: "2035-05-01", as_of: "2035-05-01", sector: null, population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "SECTOR_MISSING", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_013_UNKNOWN_SECTOR", purpose: "unknown_sector", record_ids: ["SYN_RECORD_SECTOR_GENERAL"], query: { target_date: "2035-05-01", as_of: "2035-05-01", sector: "SYN_UNKNOWN", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "SECTOR_UNKNOWN", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_014_POPULATION_INCLUDE", purpose: "population_included", record_ids: ["SYN_RECORD_SECTOR_GENERAL"], query: { target_date: "2035-05-01", as_of: "2035-05-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_SECTOR_GENERAL" },
  { case_id: "TEMPORAL_CASE_015_POPULATION_EXCLUDE", purpose: "population_excluded", record_ids: ["SYN_RECORD_SECTOR_GENERAL"], query: { target_date: "2035-05-01", as_of: "2035-05-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_BETA" }, expected_status: "BLOCKED", expected_reason: "NO_APPLICABLE_VERIFIED_RECORD", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_016_KNOWLEDGE_BEFORE", purpose: "valid_time_true_knowledge_time_false", record_ids: ["SYN_RECORD_KNOWLEDGE"], query: { target_date: "2036-03-01", as_of: "2036-05-31", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "BLOCKED", expected_reason: "NO_APPLICABLE_VERIFIED_RECORD", expected_record_id: null },
  { case_id: "TEMPORAL_CASE_017_KNOWLEDGE_AFTER", purpose: "valid_time_and_knowledge_time_true", record_ids: ["SYN_RECORD_KNOWLEDGE"], query: { target_date: "2036-03-01", as_of: "2036-06-01", sector: "SYN_SECTOR_ALPHA", population: "SYN_POP_ALPHA" }, expected_status: "READY", expected_reason: null, expected_record_id: "SYN_RECORD_KNOWLEDGE" },
]);

export function syntheticTemporalMatrix() {
  const cases = CASES.map((entry) => {
    const records = RECORDS.filter((record) => entry.record_ids.includes(record.record_id));
    const actual = selectSyntheticTemporalRecord(entry.query, records);
    const passed = actual.status === entry.expected_status && actual.reason === entry.expected_reason && actual.selected_record_id === entry.expected_record_id;
    return Object.freeze({ ...entry, actual_status: actual.status, actual_reason: actual.reason, actual_record_id: actual.selected_record_id, passed });
  });
  return Object.freeze({ schema_version: "tivdoc-synthetic-temporal-sector-population-matrix-v0.5.0" as const, records: RECORDS, cases: Object.freeze(cases), totals: Object.freeze({ case_count: cases.length, passed_count: cases.filter((entry) => entry.passed).length }), passed: cases.every((entry) => entry.passed), legally_neutral: true });
}
