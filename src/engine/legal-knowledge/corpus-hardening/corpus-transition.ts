import type { CorpusRoleAssignment } from "./source-roles.ts";

export type CorpusBuildRecord = Readonly<{
  source_id: string;
  source_version: string;
  artifact_sha256: string;
  acquisition_status: "acquired" | "missing";
  parse_status: "parsed" | "parse_failed";
  safe_error_code: string | null;
  chunk_count: number;
  chunk_ids: readonly string[];
  citation_status: "verified" | "unverified" | "missing";
  interval_status: "verified" | "unverified" | "missing";
  sector_status: "verified" | "unverified" | "missing";
  population_status: "verified" | "unverified" | "missing";
  review_status: string;
  activation_status: "inactive" | "active";
  role: CorpusRoleAssignment;
}>;

const byVersionId = (record: Pick<CorpusBuildRecord, "source_id" | "source_version">) => `${record.source_id}@${record.source_version}`;

/** Produces the frozen 17-source transition without collapsing lifecycle dimensions. */
export function buildCorpusSourceTransitionLedger(before: readonly CorpusBuildRecord[], after: readonly CorpusBuildRecord[]) {
  if (before.length !== 17 || after.length !== 17) throw new Error("transition_requires_exactly_17_sources");
  const beforeById = new Map(before.map((record) => [byVersionId(record), record]));
  const afterById = new Map(after.map((record) => [byVersionId(record), record]));
  if (beforeById.size !== 17 || afterById.size !== 17 || [...beforeById.keys()].some((id) => !afterById.has(id))) throw new Error("source_transition_identity_mismatch");
  const beforeParsed = before.filter((record) => record.parse_status === "parsed").length;
  const afterParsed = after.filter((record) => record.parse_status === "parsed").length;
  const beforeChunks = before.reduce((sum, record) => sum + record.chunk_count, 0);
  const afterChunks = after.reduce((sum, record) => sum + record.chunk_count, 0);
  if (beforeParsed !== 16 || before.length - beforeParsed !== 1 || beforeChunks !== 274) throw new Error("before_corpus_counts_not_16_1_274");
  if (afterParsed !== 14 || after.length - afterParsed !== 3 || afterChunks !== 202) throw new Error("after_corpus_counts_not_14_3_202");
  if ([...before, ...after].some((record) => record.chunk_ids.length !== record.chunk_count || new Set(record.chunk_ids).size !== record.chunk_ids.length)) throw new Error("source_transition_chunk_ids_do_not_match_counts");
  const entries = [...beforeById.keys()].sort().map((sourceVersionId, index) => {
    const oldRecord = beforeById.get(sourceVersionId)!;
    const newRecord = afterById.get(sourceVersionId)!;
    return Object.freeze({
      transition_id: `SOURCE_TRANSITION_${String(index + 1).padStart(3, "0")}`,
      source_version_id: sourceVersionId,
      role_candidate: newRecord.role.role,
      acquisition: Object.freeze({ before: oldRecord.acquisition_status, after: newRecord.acquisition_status, before_artifact_sha256: oldRecord.artifact_sha256, after_artifact_sha256: newRecord.artifact_sha256, artifact_sha256_unchanged: oldRecord.artifact_sha256 === newRecord.artifact_sha256 }),
      parse: Object.freeze({ before: oldRecord.parse_status, after: newRecord.parse_status, after_safe_error_code: newRecord.safe_error_code }),
      segmentation: Object.freeze({ before_chunk_count: oldRecord.chunk_count, after_chunk_count: newRecord.chunk_count, before_chunk_ids: Object.freeze([...oldRecord.chunk_ids]), after_chunk_ids: Object.freeze([...newRecord.chunk_ids]), net_chunk_delta: newRecord.chunk_count - oldRecord.chunk_count }),
      source_role: Object.freeze({ before: oldRecord.role.role, after: newRecord.role.role }),
      explanatory_or_corroborative_retrieval: Object.freeze({
        before: oldRecord.parse_status === "parsed" && !oldRecord.role.eligible_for_operative_resolution && oldRecord.role.role !== "role_pending_human_legal_review",
        after: newRecord.parse_status === "parsed" && !newRecord.role.eligible_for_operative_resolution && newRecord.role.role !== "role_pending_human_legal_review",
      }),
      operative_resolution: Object.freeze({ before: oldRecord.role.eligible_for_operative_resolution, after: newRecord.role.eligible_for_operative_resolution }),
      citation: Object.freeze({ before: oldRecord.citation_status, after: newRecord.citation_status }),
      effective_interval: Object.freeze({ before: oldRecord.interval_status, after: newRecord.interval_status }),
      sector: Object.freeze({ before: oldRecord.sector_status, after: newRecord.sector_status }),
      population: Object.freeze({ before: oldRecord.population_status, after: newRecord.population_status }),
      review: Object.freeze({ before: oldRecord.review_status, after: newRecord.review_status }),
      activation: Object.freeze({ before: oldRecord.activation_status, after: newRecord.activation_status }),
      transition_reason_codes: Object.freeze([
        oldRecord.parse_status === newRecord.parse_status ? "parse_state_unchanged" : "instrument_selector_fail_closed",
        oldRecord.chunk_count === newRecord.chunk_count ? "segmentation_unchanged" : "instrument_segmentation_changed",
        oldRecord.role.role === newRecord.role.role ? "source_role_unchanged" : "source_role_changed",
        "legal_readiness_dimensions_not_inferred_from_parse",
      ]),
    });
  });
  return Object.freeze({
    schema_version: "legal-corpus-source-transition-v0.4.2" as const,
    entries: Object.freeze(entries),
    counts: Object.freeze({ before: { parsed: 16, failed: 1, chunks: 274 }, after: { parsed: 14, failed: 3, chunks: 202 }, chunk_delta: -72 }),
  });
}

export type TransitionChunk = Readonly<{
  chunk_id: string;
  chunk_text_sha256: string;
  page_from: number;
  page_to: number;
}>;

/** Complete old-65 to new-11 mechanical convalescence segmentation reconciliation. */
export function buildConvalescenceChunkTransition(oldChunks: readonly TransitionChunk[], newChunks: readonly TransitionChunk[]) {
  if (oldChunks.length !== 65 || newChunks.length !== 11) throw new Error("convalescence_transition_requires_65_to_11");
  const newByHash = new Map(newChunks.map((chunk) => [chunk.chunk_text_sha256, chunk]));
  const newByPage = new Map<number, TransitionChunk[]>();
  for (const chunk of newChunks) newByPage.set(chunk.page_from, [...(newByPage.get(chunk.page_from) ?? []), chunk]);
  const mappings = oldChunks.map((chunk, index) => {
    const exact = newByHash.get(chunk.chunk_text_sha256);
    if (exact) return Object.freeze({ mapping_id: `CONVALESCENCE_MAP_${String(index + 1).padStart(3, "0")}`, old_chunk_id: chunk.chunk_id, old_page: chunk.page_from, new_chunk_ids: Object.freeze([exact.chunk_id]), reason: "stable_text_reindexed", review_state: "mechanically_verified" as const });
    if (chunk.page_from < 16 || chunk.page_to > 25) return Object.freeze({ mapping_id: `CONVALESCENCE_MAP_${String(index + 1).padStart(3, "0")}`, old_chunk_id: chunk.chunk_id, old_page: chunk.page_from, new_chunk_ids: Object.freeze([] as string[]), reason: "outside_selected_instrument_pages_16_25", review_state: "mechanically_verified" as const });
    if (chunk.page_from === 16 || chunk.page_from === 25) return Object.freeze({ mapping_id: `CONVALESCENCE_MAP_${String(index + 1).padStart(3, "0")}`, old_chunk_id: chunk.chunk_id, old_page: chunk.page_from, new_chunk_ids: Object.freeze((newByPage.get(chunk.page_from) ?? []).map((entry) => entry.chunk_id).sort()), reason: chunk.page_from === 16 ? "instrument_boundary_start_trim" : "instrument_boundary_end_two_to_one_merge", review_state: "needs_review" as const });
    throw new Error(`unreconciled_convalescence_chunk:${chunk.chunk_id}`);
  });
  const exactCount = mappings.filter((mapping) => mapping.reason === "stable_text_reindexed").length;
  const excluded = mappings.filter((mapping) => mapping.reason === "outside_selected_instrument_pages_16_25");
  const boundary = mappings.filter((mapping) => mapping.reason.startsWith("instrument_boundary_"));
  if (exactCount !== 9 || excluded.length !== 53 || boundary.length !== 3) throw new Error("convalescence_mapping_reason_counts_mismatch");
  const mappedNewIds = new Set(mappings.flatMap((mapping) => mapping.new_chunk_ids));
  if (newChunks.some((chunk) => !mappedNewIds.has(chunk.chunk_id))) throw new Error("positive_provision_coverage_incomplete");
  const newIds = new Set(newChunks.map((chunk) => chunk.chunk_id));
  const oldById = new Map(oldChunks.map((chunk) => [chunk.chunk_id, chunk]));
  const newHashes = new Set(newChunks.map((chunk) => chunk.chunk_text_sha256));
  if (excluded.some((mapping) => newIds.has(mapping.old_chunk_id) || newHashes.has(oldById.get(mapping.old_chunk_id)!.chunk_text_sha256))) throw new Error("negative_leakage_detected");
  if (![16, 25].every((page) => boundary.some((mapping) => mapping.old_page === page && mapping.review_state === "needs_review"))) throw new Error("boundary_review_evidence_incomplete");
  return Object.freeze({
    schema_version: "convalescence-chunk-transition-v0.4.2" as const,
    mappings: Object.freeze(mappings),
    counts: Object.freeze({ old: 65, new: 11, stable_text: 9, excluded_outside_instrument: 53, boundary_old_chunks: 3, boundary_new_chunks: 2, net_delta: -54 }),
    positive_provision_completeness: Object.freeze({ passed: true, coverage_records: Object.freeze(newChunks.map((chunk) => Object.freeze({ chunk_id: chunk.chunk_id, page_from: chunk.page_from, page_to: chunk.page_to, chunk_text_sha256: chunk.chunk_text_sha256, coverage: "selected_technical_span_covered" as const })).sort((left, right) => left.chunk_id.localeCompare(right.chunk_id))), covered_new_chunk_ids: Object.freeze([...mappedNewIds].sort()) }),
    negative_leakage: Object.freeze({ passed: true, excluded_old_chunks: Object.freeze(excluded.map((mapping) => { const chunk = oldById.get(mapping.old_chunk_id)!; return Object.freeze({ chunk_id: chunk.chunk_id, page_from: chunk.page_from, page_to: chunk.page_to, chunk_text_sha256: chunk.chunk_text_sha256 }); }).sort((left, right) => left.chunk_id.localeCompare(right.chunk_id))), excluded_old_chunk_ids: Object.freeze(excluded.map((mapping) => mapping.old_chunk_id).sort()) }),
    boundary_evidence: Object.freeze(boundary),
  });
}

/** 72 stable delta records: 54 convalescence, 12 permit, and 6 attachment/instrument-selector deltas. */
export function buildNetChunkDeltaLedger(input: Readonly<{
  convalescence: ReturnType<typeof buildConvalescenceChunkTransition>;
  permitOldChunks: readonly TransitionChunk[];
  attachmentOldChunks: readonly TransitionChunk[];
}>) {
  if (input.permitOldChunks.length !== 12 || input.attachmentOldChunks.length !== 6) throw new Error("extra_18_chunk_inputs_required");
  const excludedConvalescence = input.convalescence.mappings.filter((mapping) => mapping.reason === "outside_selected_instrument_pages_16_25");
  const records = [
    ...excludedConvalescence.map((mapping) => ({ source_transition: "convalescence_2025", before_chunk_ids: [mapping.old_chunk_id], after_chunk_ids: [] as string[], reason: mapping.reason })),
    { source_transition: "convalescence_2025", before_chunk_ids: input.convalescence.boundary_evidence.map((mapping) => mapping.old_chunk_id).sort(), after_chunk_ids: [...new Set(input.convalescence.boundary_evidence.flatMap((mapping) => mapping.new_chunk_ids))].sort(), reason: "boundary_three_to_two_cardinality_delta" },
    ...input.permitOldChunks.map((chunk) => ({ source_transition: "overtime_permit_2018", before_chunk_ids: [chunk.chunk_id], after_chunk_ids: [] as string[], reason: "multi_instrument_selector_pending_human_review" })),
    ...input.attachmentOldChunks.map((chunk) => ({ source_transition: "convalescence_order_2023", before_chunk_ids: [chunk.chunk_id], after_chunk_ids: [] as string[], reason: "permit_or_attachment_boundary_pending_human_review" })),
  ].map((record, index) => Object.freeze({ delta_id: `CHUNK_TRANSITION_${String(index + 1).padStart(3, "0")}`, ...record, cardinality_delta: record.after_chunk_ids.length - record.before_chunk_ids.length }));
  if (records.length !== 72 || records.reduce((sum, record) => sum + record.cardinality_delta, 0) !== -72) throw new Error("net_chunk_delta_ledger_not_exactly_72");
  return Object.freeze({ schema_version: "legal-corpus-chunk-delta-ledger-v0.4.2" as const, records: Object.freeze(records), total_delta: -72, extra_selector_delta: -18 });
}
