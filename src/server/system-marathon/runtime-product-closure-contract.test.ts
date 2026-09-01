import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MC_IDS = Object.freeze(Array.from({ length: 39 }, (_, index) => `MC-${String(index + 1).padStart(2, "0")}`));
const IR_IDS = Object.freeze(Array.from({ length: 27 }, (_, index) => `IR-${String(index + 1).padStart(2, "0")}`));
const CR_IDS = Object.freeze(Array.from({ length: 22 }, (_, index) => `CR-${String(index + 1).padStart(2, "0")}`));

function contract(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("./runtime-product-closure-contract.v0.10.2.json", import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("V0.10.2 runtime product closure contract", () => {
  it("freezes the exact base and reconciles every starting denominator", () => {
    const value = contract();
    expect(value.frozen).toBe(true);
    expect(value.base).toEqual({
      branch: "codex/tivdoc-engine-foundation",
      head: "5c1945da425e7049835838923f9b15a32b125e21",
      tree: "79b606104399b547bb1bb86444971010e6850d2c",
      ancestry_required: true,
      clean_required: true,
    });
    expect(value.inventory_baseline).toMatchObject({
      canonical_entries: 95,
      product_stable_entries: 84,
      product_entrypoints: 27,
      api_routes: 14,
      app_routes: 12,
      application_services: 19,
      durable_workers: 5,
      partial: 28,
      implemented_not_wired: 18,
      partial_or_unwired: 46,
      process_local_product_repositories: 4,
      known_staged_source_observations: 71,
      known_staged_source_observations_in_durable_queue: 0,
      product_reachable_memory_fallbacks: 0,
    });
    expect(value.entrypoint_mapping_schema).toHaveLength(10);
  });

  it("maps every MC, IR and CR identifier to a non-empty exact requirement", () => {
    const value = contract();
    const mc = value.acceptance_requirements as Record<string, string>;
    const ir = value.integration_requirements as Record<string, string>;
    const cr = value.closure_map as Record<string, readonly string[]>;
    expect(Object.keys(mc)).toEqual(MC_IDS);
    expect(Object.keys(ir)).toEqual(IR_IDS);
    expect(Object.keys(cr)).toEqual(CR_IDS);
    expect([...Object.values(mc), ...Object.values(ir)].every((requirement) => requirement.length >= 30)).toBe(true);
    expect(Object.values(cr).every((ids) => ids.length > 0)).toBe(true);
  });

  it("corrects human-pending semantics without weakening local workflow gates", () => {
    const corrections = contract().contract_corrections as Record<string, string>;
    expect(corrections["MC-17"]).toContain("not itself a local engineering failure");
    expect(corrections["MC-21"]).toContain("complete synthetic");
    expect(corrections["MC-20_IR-13"]).toContain("MC-29 and IR-17");
    expect(corrections["MC-33"]).toContain("functional repair");
  });

  it("freezes three non-overlapping worker path sets and orchestrator ownership", () => {
    const value = contract();
    const allowlists = value.worker_allowlists as Record<string, readonly string[]>;
    expect(Object.keys(allowlists)).toEqual([
      "W1_TYPESCRIPT_BROWSER_IDENTITY",
      "W2_POSTGRES_PRODUCT_WORKER_STORAGE",
      "W3_DURABLE_GOVERNANCE_HUMAN_LEGAL",
    ]);
    const exactPaths = Object.values(allowlists).flat().filter((path) => !path.includes("*"));
    expect(new Set(exactPaths).size).toBe(exactPaths.length);
    expect(value.orchestrator_owned).toContain("supabase/migrations/**");
  });

  it("keeps exactly three environment blockers and all safety truth at zero or NO", () => {
    const value = contract();
    expect(value.external_blocked_pairs).toEqual({ "MC-03": "IR-22", "MC-10": "IR-23", "MC-27": "IR-24" });
    expect(value.truth_baseline).toMatchObject({
      REAL_LEGAL_TOPICS_READY: "0/7",
      REAL_SOURCES_ACTIVE: 0,
      REAL_PARAMETERS_ACTIVE: 0,
      REAL_RULES_ACTIVE: 0,
      REAL_CALCULATIONS_OR_FINDINGS: 0,
      HUMAN_GROUND_TRUTH_LOCKED: 0,
      GENERATED_HUMAN_DECISIONS: 0,
      GENERATED_HUMAN_SIGNATURES: 0,
      MANUFACTURED_HUMAN_EVIDENCE: 0,
      REAL_ACTIVATIONS: 0,
      REAL_CUSTOMER_DATA_READS: 0,
      CUSTOMER_PROCESSING_ENABLED: "NO",
      CUSTOMER_SHADOW_AUTHORIZED: "NO",
      PRODUCTION_DELIVERY_ENABLED: "NO",
      DEPLOYMENTS: 0,
      REMOTE_MIGRATIONS: 0,
      LIVE_PROVIDER_CALLS: 0,
      OPENAI_CALLS: 0,
      PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
    });
  });
});
