// V0.10.11 evidence reference partition.
//
// The registry used to assert a bare "5 recovered". That number was derived
// state: it silently depended on four particular working-tree files never being
// edited, and when one of them was, the assertion became false with no record
// of what had happened. Asserting 5 would now be a lie; quietly changing it to
// 4 would erase the loss.
//
// So every reference lands in exactly one class instead. `recovered` and
// `permanently_lost` still sum to the original five, and a reference may only
// be `permanently_lost` if an immutable loss record explains it. Nothing here
// counts a preserved copy as a recovery.

export const REFERENCE_PARTITION_SCHEMA = "tivdoc-reference-partition-v0.10.11" as const;

export const REFERENCE_CLASSES = Object.freeze([
  "recovered", "unresolved", "permanently_lost",
] as const);

export type ReferenceClass = (typeof REFERENCE_CLASSES)[number];

export type DispositionLedger = Readonly<{
  reference_total: number;
  unique_incident_total: number;
  class_totals: Readonly<Record<string, number>>;
  recovered_plus_permanently_lost: number;
  entries: readonly Readonly<{ reference_id: string; class: string }>[];
}>;

export type LiveReference = Readonly<{ reference_id: string; exact_recovery_status: string }>;

export type LiveSummary = Readonly<{
  reference_count: number;
  unique_path_hash_incident_count: number;
  exact_recovered_reference_count: number;
  unrecoverable_or_unavailable_reference_count: number;
}>;

export type LossRecord = Readonly<Record<string, unknown>> & Readonly<{ reference_id?: unknown }>;

/** Fields a loss record must carry before a reference may be classed lost. */
export const REQUIRED_LOSS_FIELDS = Object.freeze([
  "reference_id", "repository_path", "last_known_sha256", "last_known_byte_count",
  "lost_at", "cause", "attributable_commit", "search_that_established_the_loss",
] as const);

export type PartitionOutcome = Readonly<{
  schema_version: typeof REFERENCE_PARTITION_SCHEMA;
  ok: boolean;
  violations: readonly string[];
}>;

export function evaluateReferencePartition(input: Readonly<{
  ledger: DispositionLedger;
  live: readonly LiveReference[];
  losses: readonly LossRecord[];
  live_summary: LiveSummary;
}>): PartitionOutcome {
  const violations: string[] = [];
  const seen = new Map<string, ReferenceClass>();

  for (const entry of input.ledger.entries) {
    if (seen.has(entry.reference_id)) {
      violations.push(`duplicate_ledger_entry:${entry.reference_id}`);
      continue;
    }
    if (!(REFERENCE_CLASSES as readonly string[]).includes(entry.class)) {
      violations.push(`unknown_class:${entry.reference_id}:${entry.class}`);
      continue;
    }
    seen.set(entry.reference_id, entry.class as ReferenceClass);
  }

  const liveIds = new Set(input.live.map((row) => row.reference_id));
  for (const id of liveIds) if (!seen.has(id)) violations.push(`ledger_missing_reference:${id}`);
  for (const id of seen.keys()) if (!liveIds.has(id)) violations.push(`ledger_extra_reference:${id}`);

  // A class must agree with what the live registry actually observed.
  for (const row of input.live) {
    const classification = seen.get(row.reference_id);
    if (classification === undefined) continue;
    const recovered = row.exact_recovery_status === "exact_recovered";
    if (recovered && classification !== "recovered") {
      violations.push(`class_mismatch:${row.reference_id}:${classification}:exact_recovered`);
    }
    if (!recovered && classification === "recovered") {
      violations.push(`class_mismatch:${row.reference_id}:recovered:${row.exact_recovery_status}`);
    }
  }

  const counted = { recovered: 0, unresolved: 0, permanently_lost: 0 };
  for (const classification of seen.values()) counted[classification] += 1;
  for (const classification of REFERENCE_CLASSES) {
    if ((input.ledger.class_totals[classification] ?? -1) !== counted[classification]) {
      violations.push(`class_total_mismatch:${classification}`);
    }
  }

  const total = counted.recovered + counted.unresolved + counted.permanently_lost;
  if (total !== input.ledger.reference_total) violations.push("reference_total_mismatch");
  if (total !== input.live_summary.reference_count) violations.push("live_reference_total_mismatch");
  if (input.ledger.unique_incident_total !== input.live_summary.unique_path_hash_incident_count) {
    violations.push("incident_total_mismatch");
  }
  if (counted.recovered + counted.permanently_lost !== input.ledger.recovered_plus_permanently_lost) {
    violations.push("recovered_plus_lost_mismatch");
  }
  if (counted.recovered !== input.live_summary.exact_recovered_reference_count) {
    violations.push("live_recovered_count_mismatch");
  }
  if (counted.unresolved + counted.permanently_lost
      !== input.live_summary.unrecoverable_or_unavailable_reference_count) {
    violations.push("live_unrecoverable_count_mismatch");
  }

  // A loss is only a loss if it is recorded, and a record without a lost
  // reference is an orphan that would let a class change hide behind it.
  const lossIds = new Set<string>();
  for (const record of input.losses) {
    const id = typeof record.reference_id === "string" ? record.reference_id : "";
    if (id === "") {
      violations.push("loss_record_without_reference_id");
      continue;
    }
    lossIds.add(id);
    if (seen.get(id) !== "permanently_lost") violations.push(`loss_record_orphan:${id}`);
    for (const field of REQUIRED_LOSS_FIELDS) {
      const value = record[field];
      if (value === undefined || value === null || value === "") {
        violations.push(`loss_record_incomplete:${id}:${field}`);
      }
    }
  }
  for (const [id, classification] of seen) {
    if (classification === "permanently_lost" && !lossIds.has(id)) {
      violations.push(`loss_record_missing:${id}`);
    }
  }

  return Object.freeze({
    schema_version: REFERENCE_PARTITION_SCHEMA,
    ok: violations.length === 0,
    violations: Object.freeze([...violations].sort()),
  });
}
