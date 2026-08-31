import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PERSISTENCE_CAPABILITIES } from "../wiring-map.ts";
import { statement } from "./contracts.ts";

describe("V0.9 frozen PostgreSQL closure contract", () => {
  it("reconciles the exact V0.8 capability denominator without rename, split or drop", () => {
    const ledger = JSON.parse(readFileSync(path.resolve(process.cwd(), "src/server/platform/persistence/closure-ledger.v0.9.0.json"), "utf8")) as {
      source: { baseline_count: number; independent_count: number; discrepancy: unknown };
      capabilities: readonly { capability: string; worker: string }[];
    };
    expect(ledger.source).toMatchObject({ baseline_count: 14, independent_count: 14, discrepancy: null });
    expect(ledger.capabilities.map((entry) => entry.capability)).toEqual(PERSISTENCE_CAPABILITIES);
    expect(new Set(ledger.capabilities.map((entry) => entry.capability)).size).toBe(14);
    expect(ledger.capabilities.every((entry) => ["W1", "W2", "W3"].includes(entry.worker))).toBe(true);
  });

  it("accepts only parameter-counted non-interpolated PostgreSQL statements", () => {
    expect(statement("case_insert", "insert into engine_case_state(case_id) values ($1)", ["case-01"])).toMatchObject({
      name: "case_insert",
      values: ["case-01"],
    });
    expect(() => statement("case_insert", "select $1, $2", ["one"])).toThrow("POSTGRES_PARAMETER_COUNT_MISMATCH");
    expect(() => statement("case_insert", "select ${unsafe}", [])).toThrow("POSTGRES_INTERPOLATED_SQL_FORBIDDEN");
  });
});
