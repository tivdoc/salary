import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isEffectOutcome } from "./global-invalidation.ts";

// Wave 2 (B1 step 4 / §3.9). `approval_invalidated` was reported as `true`
// while the count that decided it was discarded, and three siblings had no
// computation behind them at all. The guard below is deliberately a source
// assertion as well as a behavioural one: a behavioural test can be satisfied
// by a literal that happens to match, and the point is that no effect field is
// permitted to be a literal in the first place.

const PORT = readFileSync(path.resolve(
  "src", "server", "product", "dependency-invalidation", "postgres-port.ts",
), "utf8");

const CONTRACT = readFileSync(path.resolve(
  "src", "server", "product", "dependency-invalidation", "global-invalidation.ts",
), "utf8");

/** Every field in the applied receipt that describes an effect having happened. */
const EFFECT_FIELDS = Object.freeze([
  "historical_evidence_preserved",
  "approval_invalidated",
  "stale_execution_blocked",
  "stale_approval_blocked",
  "stale_download_blocked",
  "cache_versioned",
] as const);

describe("Wave 2 effect honesty", () => {
  it("assigns no effect field a hardcoded true or false in the port", () => {
    for (const field of EFFECT_FIELDS) {
      const assignment = new RegExp(`^\\s*${field}:\\s*(.+?),\\s*$`, "mu").exec(PORT);
      expect(assignment, field).not.toBeNull();
      const value = (assignment?.[1] ?? "").trim();
      expect(value, field).not.toBe("true");
      expect(value, field).not.toBe("false");
      expect(value, field).not.toBe("true as const");
      expect(value, field).not.toBe("false as const");
    }
  });

  it("permits an explicit unknown, because that is the honest uncomputed value", () => {
    // The three the transaction genuinely does not measure. `"unknown"` is not
    // a hardcoded result — it is the statement that no result exists.
    for (const field of ["stale_execution_blocked", "stale_approval_blocked", "stale_download_blocked"] as const) {
      expect(PORT, field).toContain(`${field}: "unknown" as const`);
    }
  });

  it("derives the two it can measure from values computed in the same operation", () => {
    expect(PORT).toContain("approval_invalidated: approvalsInvalidated > 0");
    expect(PORT).toContain("cache_versioned: epochRowsUpdated === 1");
    expect(PORT).toContain("historical_evidence_preserved: historicalVersionsDeleted === 0");
    // The count that decides `approval_invalidated` must not be discarded again.
    expect(PORT).not.toContain("void approvalsInvalidated");
  });

  it("carries the measured values into the receipt instead of re-asserting them", () => {
    for (const field of EFFECT_FIELDS) {
      expect(CONTRACT, field).toContain(`${field}: applied.${field},`);
    }
  });

  it("never lets the contract pin an effect field to a literal type", () => {
    for (const field of EFFECT_FIELDS) {
      expect(CONTRACT, field).not.toContain(`${field}: true;`);
      expect(CONTRACT, field).not.toContain(`${field}: false;`);
    }
  });

  it("verifies the shape of an outcome rather than demanding a particular one", () => {
    // The old assertions required `=== true`, so the validator certified the
    // producer's own literal back to it and would have rejected the truth.
    for (const field of EFFECT_FIELDS) {
      expect(CONTRACT, field).not.toContain(`applied.${field} !== true`);
      expect(CONTRACT, field).not.toContain(`receipt.${field} !== true`);
    }
    expect(CONTRACT).toContain("isEffectOutcome(applied.approval_invalidated)");
    expect(CONTRACT).toContain("isEffectOutcome(receipt.approval_invalidated)");
  });

  it("accepts only the three honest outcomes", () => {
    for (const value of [true, false, "unknown"]) expect(isEffectOutcome(value)).toBe(true);
    for (const value of ["true", "yes", 1, 0, null, undefined, {}, ""]) {
      expect(isEffectOutcome(value), String(value)).toBe(false);
    }
  });
});
