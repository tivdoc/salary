export type HistoricalChunkTransition = Readonly<{
  delta_id: string;
  source_transition: string;
  reason: string;
  before_chunk_ids: readonly string[];
  after_chunk_ids: readonly string[];
  cardinality_delta: number;
}>;

function lifecycleReason(record: HistoricalChunkTransition) {
  if (record.source_transition === "overtime_permit_2018") return "instrument_identity_quarantine_after_successful_technical_parse";
  if (record.source_transition === "convalescence_order_2023") return "attachment_boundary_quarantine_after_successful_technical_parse";
  if (record.reason === "boundary_three_to_two_cardinality_delta") return "instrument_boundary_resegmentation_after_successful_technical_parse";
  return "instrument_scope_exclusion_after_successful_technical_parse";
}

export function reconcileStableTransitions(input: readonly HistoricalChunkTransition[]) {
  const records = input.map((record, index) => {
    const expectedId = `CHUNK_TRANSITION_${String(index + 1).padStart(3, "0")}`;
    if (record.delta_id !== expectedId) throw new Error(`stable_transition_id_mismatch:${expectedId}`);
    if (record.cardinality_delta !== record.after_chunk_ids.length - record.before_chunk_ids.length) throw new Error(`stable_transition_cardinality_mismatch:${record.delta_id}`);
    return Object.freeze({
      transition_id: record.delta_id,
      source_transition: record.source_transition,
      before_chunk_ids: Object.freeze([...record.before_chunk_ids]),
      after_chunk_ids: Object.freeze([...record.after_chunk_ids]),
      cardinality_delta: record.cardinality_delta,
      legacy_reason: record.reason,
      corrected_lifecycle_reason: lifecycleReason(record),
      technical_parse_status: "parsed" as const,
      legal_review_status: "needs_review" as const,
      activation_status: "inactive" as const,
    });
  });
  const beforeIds = records.flatMap((record) => record.before_chunk_ids);
  const totalDelta = records.reduce((total, record) => total + record.cardinality_delta, 0);
  if (records.length !== 72) throw new Error(`stable_transition_count_mismatch:${records.length}`);
  if (new Set(beforeIds).size !== beforeIds.length) throw new Error("stable_transition_duplicate_before_chunk_id");
  if (totalDelta !== -72) throw new Error(`stable_transition_total_delta_mismatch:${totalDelta}`);
  return Object.freeze({
    schema_version: "tivdoc-stable-chunk-transition-ledger-v0.5.0" as const,
    records: Object.freeze(records),
    totals: Object.freeze({ record_count: records.length, cardinality_delta: totalDelta, corrected_reason_count: new Set(records.map((record) => record.corrected_lifecycle_reason)).size }),
  });
}
