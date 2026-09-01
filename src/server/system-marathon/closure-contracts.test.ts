import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_WIRING_MAP,
  PERSISTENCE_WIRING_SUMMARY,
} from "../platform/persistence/wiring-map.ts";
import {
  OWNER_ACTION_GROUPS,
  REQUIRED_CANONICAL_CLI_ENTRIES,
  type CanonicalEntrypointInventory,
  type OwnerActionIndex,
  validateCanonicalEntrypointInventory,
  validateOwnerActionIndex,
} from "./closure-contracts.ts";
import { MARATHON_TRUTH_BASELINE } from "./contracts.ts";

const root = process.cwd();

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;
}

const entrypoints = readJson<CanonicalEntrypointInventory>("./canonical-entrypoints.v0.10.0.json");
const ownerActions = readJson<OwnerActionIndex>("./owner-action-index.v0.10.0.json");

describe("V0.10 W9 canonical closure contracts", () => {
  it("validates the exact inventory, canonical authorities and zero invariants", () => {
    expect(validateCanonicalEntrypointInventory(entrypoints)).toEqual([]);
    expect(entrypoints.generated_from_head).toBe("11f8a90c6e88b171fd639a05e60e2d6412de1cce");
    expect(entrypoints.baseline_truth).toEqual(MARATHON_TRUTH_BASELINE);
    expect(entrypoints.authority.asserted_invariants).toEqual({
      unknown_production_reachable_symbols: 0,
      duplicate_canonical_contracts: 0,
      wave_or_version_specific_stable_product_paths: 0,
      direct_repository_construction_outside_composition: 0,
      product_reachable_memory_fallbacks: 0,
    });

    const ids = entrypoints.entries.map((entry) => entry.entrypoint_id);
    expect(ids).toEqual(Array.from({ length: entrypoints.entries.length }, (_, index) => `CEP-${String(index + 1).padStart(3, "0")}`));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(entrypoints.entries.map((entry) => entry.canonical_contract_id)).size).toBe(entrypoints.entries.length);
    expect(entrypoints.entries.some((entry) => !entry.classification)).toBe(false);
  });

  it("inventories every stable Next page, API and metadata route source exactly once", () => {
    const expectedSources = walk(path.resolve(root, "src", "app"))
      .map(relative)
      .filter((file) => /\/(?:page|route)\.(?:ts|tsx)$/u.test(file)
        || /\/app\/(?:robots|sitemap)\.ts$/u.test(file)
        || /\/app\/opengraph-image\.tsx$/u.test(file))
      .sort();
    const inventoriedSources = entrypoints.entries
      .filter((entry) => entry.kind === "app_route" || entry.kind === "api_route")
      .map((entry) => entry.source_path)
      .sort();

    expect(inventoriedSources).toEqual(expectedSources);
    expect(new Set(inventoriedSources).size).toBe(inventoriedSources.length);
    expect(entrypoints.entries.filter((entry) => entry.kind === "api_route").every((entry) => entry.stable_entry.startsWith("/api/"))).toBe(true);
  });

  it("keeps the durable workers, services and canonical CLIs complete and unique", () => {
    expect(entrypoints.entries.filter((entry) => entry.kind === "durable_worker").map((entry) => entry.stable_entry)).toEqual([
      "background-jobs",
      "outbox-publisher",
      "controlled-import-ledger",
      "custody-replication",
      "offline-shadow-runner",
    ]);
    expect(entrypoints.entries.filter((entry) => entry.kind === "application_service").map((entry) => entry.stable_entry)).toEqual([
      "canonical-postgres-composition",
      "canonical-route-runtime",
      "durable-product-application",
      "internal-reviewer-operations",
      "customer-portal-service",
      "cryptographic-identity-verifier",
      "product-identity-boundary",
      "private-blob-provider",
      "controlled-import-repository",
      "controlled-official-import",
      "untrusted-parser-isolation",
      "legal-operations-governance",
      "rulespec-executor",
      "reviewer-trust-store",
      "trusted-ground-truth-workflow",
      "rulespec-authoring-queue",
      "external-evidence-handoff",
      "offline-shadow-control-plane",
      "privacy-storage-reconciliation",
    ]);
    expect(entrypoints.entries.filter((entry) => entry.kind === "cli").map((entry) => entry.stable_entry)).toEqual(REQUIRED_CANONICAL_CLI_ENTRIES);

    const packageScripts = (JSON.parse(readFileSync(path.resolve(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const command of REQUIRED_CANONICAL_CLI_ENTRIES) {
      if (command.startsWith("npm run ")) expect(packageScripts[command.slice("npm run ".length)]).toBeTruthy();
      else expect(existsSync(path.resolve(root, command.split(" ").at(-1)!))).toBe(true);
    }
  });

  it("resolves every source and canonical target and prohibits stable release-path leakage", () => {
    for (const entry of entrypoints.entries) {
      expect(existsSync(path.resolve(root, entry.source_path)), entry.entrypoint_id).toBe(true);
      const [targetFile] = entry.canonical_target.split(":", 1);
      expect(existsSync(path.resolve(root, targetFile)), `${entry.entrypoint_id}:${targetFile}`).toBe(true);
      if (entry.product_stable) {
        expect(entry.stable_entry, entry.entrypoint_id).not.toMatch(/(?:^|[/:._-])(?:v0?\d+|wave\d*|overnight)(?:$|[/:._-])/iu);
      }
    }
  });

  it("reuses the canonical reachability verifier and wiring map without a parallel graph", () => {
    const verifier = readFileSync(path.resolve(root, entrypoints.authority.reachability_verifier), "utf8");
    expect(verifier).toContain("counts.unknown === 0");
    expect(verifier).toContain("counts.duplicate_canonical_contracts === 0");
    expect(verifier).toContain("counts.stable_version_leaks === 0");
    expect(PERSISTENCE_WIRING_SUMMARY).toMatchObject({
      capability_count: 14,
      unknown_count: 0,
      duplicate_canonical_contract_count: 0,
      non_test_memory_fallback_count: 0,
    });
    expect(PERSISTENCE_WIRING_MAP.every((row) => row.status === "WIRED_DURABLE")).toBe(true);
    expect(PERSISTENCE_WIRING_MAP.every((row) => row.composition_root_binding.startsWith("src/server/platform/composition/canonical-postgres-application.ts:"))).toBe(true);
  });

  it("finds no repository construction or automatic memory adapter in inventoried stable product sources", () => {
    const stableRuntimeSources = [...new Set(entrypoints.entries
      .filter((entry) => entry.product_stable && entry.kind !== "cli")
      .map((entry) => entry.source_path))];
    const directRepositoryConstruction: string[] = [];
    const memoryFallbacks: string[] = [];
    for (const source of stableRuntimeSources) {
      const content = readFileSync(path.resolve(root, source), "utf8");
      if (/\bnew\s+[A-Za-z0-9_]*Repository\s*\(/u.test(content) && !source.startsWith("src/server/platform/composition/")) {
        directRepositoryConstruction.push(source);
      }
      if (/from\s+["'][^"']*(?:in-memory|test-fixtures|synthetic-fixtures)[^"']*["']/iu.test(content)
          || /\bnew\s+InMemory[A-Za-z0-9_]*\s*\(/u.test(content)) {
        memoryFallbacks.push(source);
      }
    }
    expect(directRepositoryConstruction).toEqual([]);
    expect(memoryFallbacks).toEqual([]);
  });

  it("keeps the owner index external-only, exact, unique and evidence-bound", () => {
    expect(validateOwnerActionIndex(ownerActions)).toEqual([]);
    expect(ownerActions.groups.map(({ group_id, slug }) => ({ group_id, slug }))).toEqual(OWNER_ACTION_GROUPS);
    expect(ownerActions.baseline_truth).toEqual(MARATHON_TRUTH_BASELINE);
    const actions = ownerActions.groups.flatMap((group) => group.actions);
    expect(new Set(actions.map((action) => action.action_id)).size).toBe(actions.length);
    expect(actions.every((action) => action.status === "BLOCKED_EXTERNAL" && action.locally_solvable_engineering === false)).toBe(true);
    expect(actions.every((action) => action.external_prerequisites.length > 0 && action.evidence_required.length > 0)).toBe(true);
    expect(actions.some((action) => /\b(?:write code|implement code|fix a test|run lint|edit a file|refactor|unit test|update documentation)\b/iu.test(action.summary))).toBe(false);
  });

  it("preserves zero/NO truth and contains no affirmative readiness claim", () => {
    const serialized = JSON.stringify({ entrypoints, ownerActions });
    expect(serialized).not.toMatch(/"(?:CUSTOMER_PROCESSING_ENABLED|CUSTOMER_SHADOW_AUTHORIZED|PRODUCTION_DELIVERY_ENABLED)":"YES"/u);
    expect(serialized).not.toMatch(/\b(?:production[- ]ready|all real legal topics (?:are )?ready|customer shadow (?:is )?authorized|customer processing (?:is )?enabled)\b/iu);

    const documentation = readFileSync(path.resolve(root, "docs/full-local-system-marathon-v0.10.0.md"), "utf8");
    expect(documentation).toContain("## Architecture and restart/degraded-mode runbook");
    expect(documentation).toContain("## Single human/external queue");
    expect(documentation).toContain("REAL_LEGAL_TOPICS_READY: 0/7");
    expect(documentation).toContain("CUSTOMER_SHADOW_AUTHORIZED: NO");
    expect(documentation).toContain("PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0");
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.isFile() ? [absolute] : [];
  });
}

function relative(absolute: string): string {
  return path.relative(root, absolute).replaceAll("\\", "/");
}
