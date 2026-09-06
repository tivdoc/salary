import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import inventoryJson from "./canonical-entrypoints.v0.10.0.json" with { type: "json" };
import {
  ENTRYPOINT_DISPOSITION_LEDGER,
  validateEntrypointDispositionLedger,
} from "./entrypoint-disposition-ledger.v0.10.2.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("V0.10.2 entrypoint before/after disposition ledger", () => {
  it("preserves all 101 rows, every identity and the starting denominator", () => {
    expect(validateEntrypointDispositionLedger()).toEqual([]);
    expect(ENTRYPOINT_DISPOSITION_LEDGER.rows).toHaveLength(105);
    expect(ENTRYPOINT_DISPOSITION_LEDGER.product_stable_denominator).toBe(94);
    expect(ENTRYPOINT_DISPOSITION_LEDGER.before_counts).toEqual({
      partial: 31,
      implemented_not_wired: 21,
      partial_or_unwired: 52,
    });
    expect(ENTRYPOINT_DISPOSITION_LEDGER.rows.map((row) => row.entrypoint_id)).toEqual(
      inventoryJson.entries.map((entry) => entry.entrypoint_id),
    );
  });

  it("recomputes the exact source roots without deleting or changing any kind", () => {
    expect(ENTRYPOINT_DISPOSITION_LEDGER.source_disposition_counts).toEqual({
      product_stable_partial_or_unwired: 0,
      app_routes: 18,
      api_routes: 18,
      durable_workers: 5,
      application_services: 19,
      clis: 45,
    });
    for (const row of ENTRYPOINT_DISPOSITION_LEDGER.rows) {
      expect(existsSync(`${repositoryRoot}/${row.source_path}`), row.entrypoint_id).toBe(true);
      expect(existsSync(`${repositoryRoot}/${row.canonical_target.split(":")[0]}`), row.entrypoint_id).toBe(true);
      expect(row.replacement_proof, row.entrypoint_id).toBeNull();
    }

    const actualNextRoots = walk(join(repositoryRoot, "src/app"))
      .map((path) => relative(repositoryRoot, path).replaceAll("\\", "/"))
      .filter((path) => /(?:^|\/)(?:page\.tsx|route\.ts|robots\.ts|sitemap\.ts|opengraph-image\.tsx)$/u.test(path))
      .sort();
    const inventoriedNextRoots = inventoryJson.entries
      .filter((entry) => entry.kind === "app_route" || entry.kind === "api_route")
      .map((entry) => entry.source_path)
      .sort();
    expect(actualNextRoots).toEqual(inventoriedNextRoots);

    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const entry of inventoryJson.entries.filter((candidate) => candidate.kind === "cli" && candidate.stable_entry.startsWith("npm run "))) {
      expect(packageJson.scripts, entry.entrypoint_id).toHaveProperty(entry.stable_entry.slice("npm run ".length));
    }
  });

  it("classifies every CLI separately and never changes its product-stable denominator membership", () => {
    const cliRows = ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.kind === "cli");
    expect(cliRows).toHaveLength(45);
    expect(cliRows.every((row) => row.current_status === "EVIDENCE_OR_MAINTENANCE_CLI")).toBe(true);
    expect(cliRows.filter((row) => row.product_stable)).toHaveLength(
      inventoryJson.entries.filter((entry) => entry.kind === "cli" && entry.product_stable).length,
    );
    expect(new Set(cliRows.map((row) => row.stable_product_evidence_external_classification))).toEqual(
      new Set(["evidence_cli", "maintenance_cli"]),
    );
  });

  it("requires reason codes and two local fail-closed evidence anchors for every external disposition", () => {
    const blocked = ENTRYPOINT_DISPOSITION_LEDGER.rows.filter(
      (row) => row.current_status === "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED",
    );
    expect(blocked.length).toBeGreaterThan(0);
    for (const row of blocked) {
      expect(row.reason_codes.length, row.entrypoint_id).toBeGreaterThan(0);
      expect(row.local_fail_closed_evidence, row.entrypoint_id).toContain(row.source_path);
      expect(row.local_fail_closed_evidence, row.entrypoint_id).toContain(
        "src/server/platform/capabilities/stable-entrypoint-runtime.ts",
      );
    }
  });

  it("fills all ten required contract mapping fields and carries an explicit runtime non-claim", () => {
    const fields = [
      "entrypoint",
      "kind",
      "stable_product_evidence_external_classification",
      "identity_boundary",
      "capability_gate",
      "application_service",
      "transaction_context",
      "repository",
      "storage",
      "current_status",
    ] as const;
    for (const row of ENTRYPOINT_DISPOSITION_LEDGER.rows) {
      for (const field of fields) expect(String(row[field]).length, `${row.entrypoint_id}:${field}`).toBeGreaterThan(0);
    }
    expect(ENTRYPOINT_DISPOSITION_LEDGER.runtime_integration_non_claim).toContain("does not itself prove");
    expect(ENTRYPOINT_DISPOSITION_LEDGER.runtime_integration_non_claim).toContain("exact final tree");
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
