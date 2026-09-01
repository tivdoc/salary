import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MARATHON_ACCEPTANCE_IDS,
  MARATHON_ACCEPTANCE_STATUSES,
  MARATHON_CAPABILITY_IDS,
  MARATHON_CLASSIFICATIONS,
  MARATHON_REQUIRED_BASE,
  MARATHON_TRUTH_BASELINE,
  MARATHON_WORKER_LANES,
} from "./contracts.ts";

type ExecutionContract = Readonly<{
  frozen: boolean;
  base: typeof MARATHON_REQUIRED_BASE;
  acceptance_ids: readonly string[];
  worker_capacity: number;
  worker_allowlists: Readonly<Record<string, readonly string[]>>;
  orchestrator_owned: readonly string[];
}>;

type Inventory = Readonly<{
  generated_from_head: string;
  items: readonly Readonly<{ id: string; classification: string; gap: string | null }>[];
  baseline_truth: typeof MARATHON_TRUTH_BASELINE;
}>;

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;
}

describe("V0.10 Marathon frozen contracts", () => {
  it("freezes exact base, stable IDs, lanes and acceptance vocabulary", () => {
    expect(MARATHON_REQUIRED_BASE).toEqual({
      branch: "codex/tivdoc-engine-foundation",
      head: "28d18da69108913252736f4b8a39c4ef614984a3",
      tree: "2a9859470003a095521a13e21474a45e1f69620e",
    });
    expect(MARATHON_CAPABILITY_IDS).toHaveLength(30);
    expect(new Set(MARATHON_CAPABILITY_IDS).size).toBe(30);
    expect(MARATHON_ACCEPTANCE_IDS).toEqual(
      Array.from({ length: 39 }, (_, index) => `MC-${String(index + 1).padStart(2, "0")}`),
    );
    expect(new Set(MARATHON_CLASSIFICATIONS).size).toBe(8);
    expect(MARATHON_ACCEPTANCE_STATUSES).toEqual(["PASS", "FAIL", "BLOCKED", "SKIPPED_DEPENDENCY", "NOT_APPLICABLE"]);
    expect(new Set(MARATHON_WORKER_LANES).size).toBe(MARATHON_WORKER_LANES.length);
  });

  it("binds allowlists, inventory and baseline truth to the frozen contract", () => {
    const contract = readJson<ExecutionContract>("./execution-contract.v0.10.0.json");
    const inventory = readJson<Inventory>("./inventory.v0.10.0.json");
    expect(contract.frozen).toBe(true);
    expect(contract.base).toMatchObject(MARATHON_REQUIRED_BASE);
    expect(contract.worker_capacity).toBe(3);
    expect(contract.acceptance_ids).toEqual(MARATHON_ACCEPTANCE_IDS);
    expect(Object.keys(contract.worker_allowlists).sort()).toEqual([...MARATHON_WORKER_LANES].sort());
    expect(contract.orchestrator_owned).toContain("supabase/migrations/**");
    expect(inventory.generated_from_head).toBe(MARATHON_REQUIRED_BASE.head);
    expect(inventory.items.map((item) => item.id)).toEqual(MARATHON_ACCEPTANCE_IDS);
    expect(inventory.items.every((item) => MARATHON_CLASSIFICATIONS.includes(item.classification as never))).toBe(true);
    expect(inventory.baseline_truth).toEqual(MARATHON_TRUTH_BASELINE);
  });

  it("keeps the Marathon ledger append-only, unique and machine-readable", () => {
    const lines = readFileSync(new URL("./marathon-ledger.v0.10.0.ndjson", import.meta.url), "utf8").trim().split(/\r?\n/u);
    const entries = lines.map((line) => JSON.parse(line) as Readonly<{ event_id: string; status: string }>);
    expect(entries.map((entry) => entry.event_id)).toEqual(["MCL-0001", "MCL-0002", "MCL-0003"]);
    expect(new Set(entries.map((entry) => entry.event_id)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.status === "PASS")).toBe(true);
  });
});
