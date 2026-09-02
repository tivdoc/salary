// V0.10.4 entrypoint classification diagnostic.
//
// Two defensible readings of the same ledger disagree, and this run is not
// authorized to pick one. The strict audit counts every product-stable row that
// is not CANONICALLY_WIRED as outstanding. MC-29 says a row passes when it is
// "canonically wired or truthfully external/human-blocked", which makes the
// blocked disposition terminal rather than outstanding.
//
// This module changes neither result. It reports both, with the exact record
// ids and reasons behind the difference, so the owner decision can be made on
// evidence. Nothing here feeds the audit or any acceptance counter.

import {
  ENTRYPOINT_DISPOSITION_LEDGER,
  type EntrypointDispositionRow,
} from "./entrypoint-disposition-ledger.v0.10.2.ts";

export const ENTRYPOINT_CLASSIFICATION_DIAGNOSTIC_SCHEMA =
  "tivdoc-entrypoint-classification-diagnostic-v0.10.4" as const;

/** Statuses the strict audit treats as outstanding for a product-stable row. */
const STRICT_OUTSTANDING = Object.freeze([
  "CAPABILITY_GATED_CANONICAL_SOURCE",
  "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED",
] as const);

/** The single status MC-29 additionally accepts as a truthful terminal state. */
const MC29_TERMINAL = "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED" as const;

export type EntrypointClassificationRecord = Readonly<{
  entrypoint_id: string;
  kind: string;
  current_status: string;
  reason_codes: readonly string[];
  counted_by_strict_audit: boolean;
  counted_by_mc29_terminal_state: boolean;
}>;

export type EntrypointClassificationDiagnostic = Readonly<{
  schema_version: typeof ENTRYPOINT_CLASSIFICATION_DIAGNOSTIC_SCHEMA;
  diagnostic_only: true;
  product_stable_denominator: number;
  strict_audit_outstanding: number;
  mc29_terminal_state_outstanding: number;
  difference: number;
  records: readonly EntrypointClassificationRecord[];
  divergent_record_ids: readonly string[];
}>;

function isStrictOutstanding(row: EntrypointDispositionRow): boolean {
  return row.product_stable
    && (STRICT_OUTSTANDING as readonly string[]).includes(row.current_status);
}

function isMc29Outstanding(row: EntrypointDispositionRow): boolean {
  return isStrictOutstanding(row) && row.current_status !== MC29_TERMINAL;
}

/**
 * Both counts over the same rows, plus the records that separate them. The
 * canonical ledger and the audit are read-only inputs here.
 */
export function buildEntrypointClassificationDiagnostic(): EntrypointClassificationDiagnostic {
  const records = ENTRYPOINT_DISPOSITION_LEDGER.rows
    .filter((row) => isStrictOutstanding(row))
    .map((row) => Object.freeze({
      entrypoint_id: row.entrypoint_id,
      kind: row.kind,
      current_status: row.current_status,
      reason_codes: Object.freeze([...row.reason_codes]),
      counted_by_strict_audit: true,
      counted_by_mc29_terminal_state: isMc29Outstanding(row),
    }))
    .sort((left, right) => left.entrypoint_id.localeCompare(right.entrypoint_id));

  const strict = records.length;
  const mc29 = records.filter((record) => record.counted_by_mc29_terminal_state).length;
  return Object.freeze({
    schema_version: ENTRYPOINT_CLASSIFICATION_DIAGNOSTIC_SCHEMA,
    diagnostic_only: true,
    product_stable_denominator: ENTRYPOINT_DISPOSITION_LEDGER.product_stable_denominator,
    strict_audit_outstanding: strict,
    mc29_terminal_state_outstanding: mc29,
    difference: strict - mc29,
    records: Object.freeze(records),
    divergent_record_ids: Object.freeze(records
      .filter((record) => !record.counted_by_mc29_terminal_state)
      .map((record) => record.entrypoint_id)),
  });
}
