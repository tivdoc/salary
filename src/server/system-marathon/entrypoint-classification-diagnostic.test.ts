import { describe, expect, it } from "vitest";

import {
  buildEntrypointClassificationDiagnostic,
  ENTRYPOINT_CLASSIFICATION_DIAGNOSTIC_SCHEMA,
} from "./entrypoint-classification-diagnostic.ts";
import { ENTRYPOINT_DISPOSITION_LEDGER } from "./entrypoint-disposition-ledger.v0.10.2.ts";

describe("V0.10.4 entrypoint classification diagnostic", () => {
  const diagnostic = buildEntrypointClassificationDiagnostic();

  it("is explicitly diagnostic and never a canonical result", () => {
    expect(diagnostic.schema_version).toBe(ENTRYPOINT_CLASSIFICATION_DIAGNOSTIC_SCHEMA);
    expect(diagnostic.diagnostic_only).toBe(true);
  });

  it("reports the strict audit count over the canonical denominator unchanged", () => {
    expect(diagnostic.product_stable_denominator)
      .toBe(ENTRYPOINT_DISPOSITION_LEDGER.product_stable_denominator);
    const strict = ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.product_stable
      && ["CAPABILITY_GATED_CANONICAL_SOURCE", "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED"]
        .includes(row.current_status));
    expect(diagnostic.strict_audit_outstanding).toBe(strict.length);
    expect(diagnostic.records).toHaveLength(strict.length);
  });

  it("reports the MC-29 terminal-state count as the strictly smaller reading", () => {
    expect(diagnostic.mc29_terminal_state_outstanding)
      .toBeLessThanOrEqual(diagnostic.strict_audit_outstanding);
    expect(diagnostic.difference)
      .toBe(diagnostic.strict_audit_outstanding - diagnostic.mc29_terminal_state_outstanding);
  });

  it("treats external or human blocked as terminal only under the MC-29 reading", () => {
    for (const record of diagnostic.records) {
      expect(record.counted_by_strict_audit).toBe(true);
      expect(record.counted_by_mc29_terminal_state)
        .toBe(record.current_status !== "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED");
    }
  });

  it("names the exact records and reasons that separate the two counts", () => {
    const divergent = diagnostic.records.filter((record) => !record.counted_by_mc29_terminal_state);
    expect(diagnostic.divergent_record_ids).toEqual(divergent.map((record) => record.entrypoint_id));
    expect(diagnostic.difference).toBe(divergent.length);
    for (const record of divergent) {
      expect(record.current_status).toBe("EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED");
      expect(record.reason_codes.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic and ordered by entrypoint id", () => {
    const again = buildEntrypointClassificationDiagnostic();
    expect(again).toEqual(diagnostic);
    const ids = diagnostic.records.map((record) => record.entrypoint_id);
    expect(ids).toEqual([...ids].sort((left, right) => left.localeCompare(right)));
  });

  it("leaves every canonically wired and CLI row out of both counts", () => {
    const reported = new Set(diagnostic.records.map((record) => record.entrypoint_id));
    for (const row of ENTRYPOINT_DISPOSITION_LEDGER.rows) {
      if (row.current_status === "CANONICALLY_WIRED" || row.current_status === "EVIDENCE_OR_MAINTENANCE_CLI") {
        expect(reported.has(row.entrypoint_id)).toBe(false);
      }
    }
  });
});
