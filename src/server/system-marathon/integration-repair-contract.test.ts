import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CLASSIFICATIONS = Object.freeze([
  "CANONICAL_AND_PROVEN_ON_CURRENT_HEAD",
  "IMPLEMENTED_NOT_WIRED",
  "PROCESS_LOCAL_ONLY",
  "PARTIAL",
  "CONTRACT_ONLY",
  "SCHEMA_ONLY",
  "REGRESSION_FAILED",
  "EXTERNAL_OR_HUMAN_BLOCKED",
]);
const MC_IDS = Object.freeze(Array.from({ length: 39 }, (_, index) => `MC-${String(index + 1).padStart(2, "0")}`));
const IR_IDS = Object.freeze(Array.from({ length: 27 }, (_, index) => `IR-${String(index + 1).padStart(2, "0")}`));

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("V0.10.1 integration-repair contract", () => {
  it("freezes the exact base, three disjoint worker lanes and acceptance IDs", () => {
    const contract = readJson("./integration-repair-contract.v0.10.1.json");
    expect(contract.frozen).toBe(true);
    expect(contract.base).toEqual({
      branch: "codex/tivdoc-engine-foundation",
      head: "3b1740d63bb6978d990d1a6127730f3cec3574cc",
      tree: "fd72158f74130005a7eec781e00e8e41a5157d7b",
      ancestry_required: true,
      clean_required: true,
    });
    expect(contract.acceptance_ids).toEqual(MC_IDS);
    expect(contract.integration_repair_ids).toEqual(IR_IDS);
    const allowlists = contract.worker_allowlists as Record<string, readonly string[]>;
    expect(Object.keys(allowlists)).toEqual([
      "W1_BROWSER_IDENTITY_PRODUCT_PATH",
      "W2_POSTGRES_REPORT_TIMELINE",
      "W3_DURABLE_HUMAN_LEGAL_WORKFLOWS",
    ]);
    expect(new Set(Object.values(allowlists).flat()).size).toBe(Object.values(allowlists).flat().length);
  });

  it("maps all MC IDs, reopens MC-13/MC-15 and attributes the report regression honestly", () => {
    const audit = readJson("./integration-repair-audit.v0.10.1.json");
    expect(audit.classification_values).toEqual(CLASSIFICATIONS);
    const items = audit.items as readonly Record<string, unknown>[];
    expect(items.map((entry) => entry.id)).toEqual(MC_IDS);
    expect(items.every((entry) => CLASSIFICATIONS.includes(String(entry.classification)))).toBe(true);
    expect(items.find((entry) => entry.id === "MC-13")?.classification).toBe("PROCESS_LOCAL_ONLY");
    expect(items.find((entry) => entry.id === "MC-15")?.classification).toBe("PROCESS_LOCAL_ONLY");
    const attribution = audit.report_binding_regression_attribution as Record<string, unknown>;
    expect(attribution.direct_acceptance_ids).toEqual(["MC-08", "MC-34"]);
    expect(attribution.contributing_acceptance_ids).toEqual(["MC-29"]);
    expect(attribution.not_the_failing_component).toEqual(["MC-11"]);
  });

  it("keeps the V0.10.1 ledger ordered and machine-readable", () => {
    const lines = readFileSync(new URL("./integration-repair-ledger.v0.10.1.ndjson", import.meta.url), "utf8").trim().split(/\r?\n/u);
    const entries = lines.map((line) => JSON.parse(line) as { event_id: string });
    expect(entries.map((entry) => entry.event_id)).toEqual(
      Array.from({ length: entries.length }, (_, index) => `IRL-${String(index + 1).padStart(4, "0")}`),
    );
  });
});
