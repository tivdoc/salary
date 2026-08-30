export type SyntheticContainerChunk = Readonly<{
  chunk_id: string;
  instrument_id: string;
  ordinal: number;
  boundary_start: number;
  boundary_end: number;
}>;

const CHUNKS: readonly SyntheticContainerChunk[] = Object.freeze([
  { chunk_id: "SYN_NEIGHBOR_LEFT_001", instrument_id: "SYN_INSTRUMENT_LEFT", ordinal: 1, boundary_start: 1, boundary_end: 2 },
  { chunk_id: "SYN_NEIGHBOR_LEFT_002", instrument_id: "SYN_INSTRUMENT_LEFT", ordinal: 2, boundary_start: 1, boundary_end: 2 },
  { chunk_id: "SYN_TARGET_001", instrument_id: "SYN_INSTRUMENT_TARGET", ordinal: 3, boundary_start: 3, boundary_end: 5 },
  { chunk_id: "SYN_TARGET_002", instrument_id: "SYN_INSTRUMENT_TARGET", ordinal: 4, boundary_start: 3, boundary_end: 5 },
  { chunk_id: "SYN_TARGET_003", instrument_id: "SYN_INSTRUMENT_TARGET", ordinal: 5, boundary_start: 3, boundary_end: 5 },
  { chunk_id: "SYN_NEIGHBOR_RIGHT_001", instrument_id: "SYN_INSTRUMENT_RIGHT", ordinal: 6, boundary_start: 6, boundary_end: 7 },
  { chunk_id: "SYN_NEIGHBOR_RIGHT_002", instrument_id: "SYN_INSTRUMENT_RIGHT", ordinal: 7, boundary_start: 6, boundary_end: 7 },
]);

export function selectSyntheticInstrument(input: Readonly<{ instrument_id: string; boundary_start: number; boundary_end: number }>, chunks: readonly SyntheticContainerChunk[]) {
  const selected = chunks.filter((chunk) => chunk.instrument_id === input.instrument_id && chunk.ordinal >= input.boundary_start && chunk.ordinal <= input.boundary_end);
  const declared = chunks.filter((chunk) => chunk.instrument_id === input.instrument_id);
  const neighborLeakage = selected.filter((chunk) => chunk.instrument_id !== input.instrument_id).length;
  const boundaryConsistent = declared.length > 0 && declared.every((chunk) => chunk.boundary_start === input.boundary_start && chunk.boundary_end === input.boundary_end);
  const complete = selected.length === declared.length && selected.every((chunk, index) => chunk.ordinal === input.boundary_start + index);
  const duplicateOrdinals = new Set(selected.map((chunk) => chunk.ordinal)).size !== selected.length;
  const passed = boundaryConsistent && complete && neighborLeakage === 0 && !duplicateOrdinals;
  return Object.freeze({ status: passed ? "SELECTED" as const : "QUARANTINED" as const, reason: passed ? null : "AMBIGUOUS_OR_INCOMPLETE_INSTRUMENT_SELECTION" as const, selected_chunk_ids: Object.freeze(selected.map((chunk) => chunk.chunk_id).sort()), positive_completeness: complete, neighboring_instrument_leakage_count: neighborLeakage, technical_parse_status: "parsed" as const, permit_identity_authority_status: passed ? "synthetic_declared_identity_matched" as const : "needs_human_review" as const });
}

export function multiInstrumentMatrix() {
  const definitions = Object.freeze([
    { case_id: "MULTI_INSTRUMENT_CASE_001_POSITIVE_SELECTION", input: { instrument_id: "SYN_INSTRUMENT_TARGET", boundary_start: 3, boundary_end: 5 }, chunks: CHUNKS, expected_status: "SELECTED" },
    { case_id: "MULTI_INSTRUMENT_CASE_002_WRONG_BOUNDARY", input: { instrument_id: "SYN_INSTRUMENT_TARGET", boundary_start: 2, boundary_end: 5 }, chunks: CHUNKS, expected_status: "QUARANTINED" },
    { case_id: "MULTI_INSTRUMENT_CASE_003_MISSING_IDENTITY", input: { instrument_id: "SYN_INSTRUMENT_MISSING", boundary_start: 3, boundary_end: 5 }, chunks: CHUNKS, expected_status: "QUARANTINED" },
    { case_id: "MULTI_INSTRUMENT_CASE_004_AMBIGUOUS_DUPLICATE", input: { instrument_id: "SYN_INSTRUMENT_TARGET", boundary_start: 3, boundary_end: 5 }, chunks: [...CHUNKS, { ...CHUNKS[2], chunk_id: "SYN_TARGET_DUPLICATE" }], expected_status: "QUARANTINED" },
    { case_id: "MULTI_INSTRUMENT_CASE_005_PERMIT_IDENTITY_PENDING", input: { instrument_id: "SYN_PERMIT_PENDING", boundary_start: 8, boundary_end: 9 }, chunks: [{ chunk_id: "SYN_PERMIT_001", instrument_id: "SYN_PERMIT_PENDING", ordinal: 8, boundary_start: 8, boundary_end: 10 }], expected_status: "QUARANTINED" },
  ] as const);
  const cases = definitions.map((definition) => {
    const actual = selectSyntheticInstrument(definition.input, definition.chunks);
    return Object.freeze({ case_id: definition.case_id, input: definition.input, expected_status: definition.expected_status, actual, passed: actual.status === definition.expected_status });
  });
  return Object.freeze({ schema_version: "tivdoc-synthetic-multi-instrument-matrix-v0.5.0" as const, cases: Object.freeze(cases), totals: Object.freeze({ case_count: cases.length, passed_count: cases.filter((entry) => entry.passed).length, positive_complete_chunk_count: cases[0].actual.selected_chunk_ids.length, neighbor_leakage_count: cases[0].actual.neighboring_instrument_leakage_count }), passed: cases.every((entry) => entry.passed), legally_neutral: true });
}
