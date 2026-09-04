// B-0 scope decision, recorded in code rather than implied by a stale count.
//
// `wave1-artifact-partition.v0.10.9.json` is a **frozen Wave-1 invariant over a
// named source-version list**, not a live-corpus invariant. Three things in the
// reconciliation itself say so and none of them is ambiguous: the artifact is
// named for Wave 1 and pinned to V0.10.9; the builder is
// `buildWave1ArtifactReconciliation`; and the surrounding assertions are
// Wave-1-era absolutes (20 publications, 58 permits, 68 permit artifact urls,
// 72 acquired files, 15x403 + 1x404) that no later corpus growth is supposed to
// move. Its second test case is a tamper detector — drop, add or reclassify one
// observation and the build must refuse — which is a statement about a closed
// historical accounting, not about how large the corpus is today.
//
// So when Session A's Pool D grew the corpus from 17 to 23 sources, the six new
// source versions were never in this invariant's subject matter. Before this
// file existed the scope was implicit in a hardcoded `17`, and growth therefore
// read as tampering. Naming the seventeen makes the six out of scope **by
// construction**: a new source cannot break the Wave-1 partition, and a Wave-1
// source that silently disappears or is reclassified still can.
//
// What is deliberately NOT frozen here is the artifact hash of each entry. The
// fetch state is append-only and a Wave-1 source may legitimately be
// re-acquired; the partition derives the latest observation per source version
// and the committed baseline is regenerated through the builder when it moves.
// That is a recorded derivation, never a hand edit — see
// `wave1-artifact-partition-builder.ts` and the drift guard beside it.
export const WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS = Object.freeze([
  "IL_ANNUAL_VACATION_LAW@discovery-v0",
  "IL_CONVALESCENCE_EXTENSION_ORDER_1988@discovery-v0",
  "IL_CONVALESCENCE_EXTENSION_ORDER_2016@discovery-v0.1",
  "IL_CONVALESCENCE_EXTENSION_ORDER_2023@discovery-v0.2",
  "IL_CONVALESCENCE_EXTENSION_ORDER_2026@discovery-v0.2",
  "IL_CONVALESCENCE_KNESSET_RESEARCH_2025@discovery-v0",
  "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2024@discovery-v0.2",
  "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025@discovery-v0.3.1",
  "IL_GENERAL_OVERTIME_PERMIT_2018@discovery-v0.1",
  "IL_GENERAL_PENSION_EXTENSION_ORDER_2011@discovery-v0",
  "IL_GENERAL_PENSION_INCREASE_EXTENSION_ORDER_2016@discovery-v0.2",
  "IL_GENERAL_TRAVEL_EXTENSION_ORDER_2016@discovery-v0",
  "IL_HOURS_WORK_REST_LAW@discovery-v0",
  "IL_MIN_WAGE_LAW@discovery-v0",
  "IL_MIN_WAGE_OFFICIAL_RATES@discovery-v0",
  "IL_SHORT_WORK_WEEK_EXTENSION_ORDER_2018@discovery-v0.1",
  "IL_SICK_PAY_LAW@discovery-v0",
] as const);

export const WAVE1_PARTITION_SCOPE = new Set<string>(WAVE1_PARTITION_SCOPE_SOURCE_VERSION_IDS);

export function wave1SourceVersionId(entry: { source_id: string; source_version: string }) {
  return `${entry.source_id}@${entry.source_version}`;
}

export function inWave1PartitionScope(entry: { source_id: string; source_version: string }) {
  return WAVE1_PARTITION_SCOPE.has(wave1SourceVersionId(entry));
}
