import { describe, expect, it } from "vitest";

import {
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101Assessment,
} from "./integration-repair-evidence.ts";

const HASH = "a".repeat(64);

function result(prefix: "MC" | "IR", index: number, status: "PASS" | "FAIL" | "BLOCKED" = "PASS") {
  return {
    id: `${prefix}-${String(index).padStart(2, "0")}`,
    status,
    evidence: ["receipt.json"],
    ...(status === "PASS" ? {} : { reason: "EXACT_BLOCKER_REASON" }),
  };
}

function assessment() {
  const mc = Array.from({ length: 39 }, (_, index) => result("MC", index + 1));
  mc[2] = result("MC", 3, "BLOCKED");
  mc[9] = result("MC", 10, "BLOCKED");
  mc[26] = result("MC", 27, "BLOCKED");
  return {
    schema_version: "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1",
    headline: "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
    verified_head: HASH,
    verified_tree: HASH,
    mc_results: mc,
    ir_results: Array.from({ length: 27 }, (_, index) => result("IR", index + 1)),
    blockers: [
      { id: "MC-03", reason: "SUPABASE_CLI_NOT_FOUND" },
      { id: "MC-10", reason: "PARSER_OS_SANDBOX_NOT_VERIFIED" },
      { id: "MC-27", reason: "OFF_HOST_AUDIT_CUSTODY_PENDING" },
    ],
    run_counts: {
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
    },
    truth: {
      CORE_LOCAL_MC_PASS: "36/36",
      CORE_LOCAL_MC_FAIL: 0,
      REAL_LEGAL_TOPICS_READY: "0/7",
      REAL_SOURCES_ACTIVE: 0,
      REAL_PARAMETERS_ACTIVE: 0,
      REAL_RULES_ACTIVE: 0,
      REAL_CALCULATIONS_OR_FINDINGS: 0,
      HUMAN_GROUND_TRUTH_LOCKED: 0,
      REAL_CUSTOMER_DATA_READS: 0,
      CUSTOMER_PROCESSING_ENABLED: "NO",
      CUSTOMER_SHADOW_AUTHORIZED: "NO",
      PRODUCTION_DELIVERY_ENABLED: "NO",
      DEPLOYMENTS: 0,
      REMOTE_MIGRATIONS: 0,
      LIVE_PROVIDER_CALLS: 0,
      OPENAI_CALLS: 0,
      PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
      FULL_SUITE_RUN_COUNT: 1,
      PRODUCTION_BUILD_RUN_COUNT: 1,
      BROWSER_E2E_FULL_RUN_COUNT: 1,
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
    },
  };
}

describe("V0.10.1 evidence contracts", () => {
  it("hashes a unique portable payload set independent of input order", () => {
    const entries = [
      { path: "receipts/b.json", sha256: HASH, byte_count: 2 },
      { path: "receipts/a.json", sha256: HASH, byte_count: 1 },
    ];
    expect(canonicalPayloadSetHash(entries)).toBe(canonicalPayloadSetHash([...entries].reverse()));
    expect(() => canonicalPayloadSetHash([...entries, { ...entries[0], path: "RECEIPTS/B.JSON" }]))
      .toThrow("V0101_EVIDENCE_PATH_DUPLICATE");
  });

  it("rejects traversal, absolute and reserved evidence paths", () => {
    for (const name of ["../escape.json", "C:/escape.json", "/escape.json", "a//b.json", "con.txt"]) {
      expect(() => assertPortableEvidencePath(name)).toThrow("V0101_EVIDENCE_PATH_UNSAFE");
    }
  });

  it("requires an ordered machine-readable ledger", () => {
    expect(parseOrderedIntegrationLedger('{"event_id":"IRL-0001"}\n{"event_id":"IRL-0002"}')).toHaveLength(2);
    expect(() => parseOrderedIntegrationLedger('{"event_id":"IRL-0002"}')).toThrow("V0101_LEDGER_ORDER_INVALID");
  });

  it("accepts honest counters and rejects blockers labelled PASS", () => {
    expect(() => validateV0101Assessment(assessment())).not.toThrow();
    const contradictory = assessment();
    contradictory.mc_results[2] = result("MC", 3, "PASS");
    expect(() => validateV0101Assessment(contradictory)).toThrow("V0101_BLOCKER_FALSE_PASS");
  });
});
