import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildScannerFindingDiagnostic,
  productReachablePathsFromGraph,
  SCANNER_FINDING_DIAGNOSTIC_SCHEMA,
} from "./scanner-finding-diagnostic.mts";

const GRAPH_PATH = "output/product-integration-v0.8.0/reachability/source-import-graph.json";

describe("V0.10.5 scanner finding diagnostic", () => {
  it("is diagnostic only and closes nothing", () => {
    const diagnostic = buildScannerFindingDiagnostic([], []);
    expect(diagnostic.schema_version).toBe(SCANNER_FINDING_DIAGNOSTIC_SCHEMA);
    expect(diagnostic.diagnostic_only).toBe(true);
    expect(diagnostic.finding_count).toBe(0);
  });

  it("classifies a product-reachable finding as a product defect", () => {
    const diagnostic = buildScannerFindingDiagnostic(
      [{ kind: "production_fixture_import", path: "src/server/product/reachable.ts" }],
      ["src/server/product/reachable.ts"],
    );
    expect(diagnostic.records[0].classification).toBe("PRODUCT_REACHABLE");
    expect(diagnostic.records[0].product_reachable).toBe(true);
    expect(diagnostic.counts.PRODUCT_REACHABLE).toBe(1);
  });

  it("classifies an unreachable test file as test-only", () => {
    const diagnostic = buildScannerFindingDiagnostic(
      [{ kind: "credential_url", path: "scripts/marathon/durable.test.mjs" }],
      [],
    );
    expect(diagnostic.records[0].classification).toBe("TEST_ONLY");
    expect(diagnostic.records[0].test_path).toBe(true);
    expect(diagnostic.counts.TEST_ONLY).toBe(1);
  });

  it("escalates an unreachable non-test file to an owner decision", () => {
    const diagnostic = buildScannerFindingDiagnostic(
      [{ kind: "production_fixture_import", path: "src/engine/legal-quality/synthetic-property-suite.ts" }],
      [],
    );
    expect(diagnostic.records[0].classification).toBe("OWNER_POLICY_REQUIRED");
    expect(diagnostic.records[0].rationale).toContain("owner decision");
    expect(diagnostic.counts.OWNER_POLICY_REQUIRED).toBe(1);
  });

  it("prefers product reachability over the test-path heuristic", () => {
    const diagnostic = buildScannerFindingDiagnostic(
      [{ kind: "credential_url", path: "src/thing.test.ts" }],
      ["src/thing.test.ts"],
    );
    expect(diagnostic.records[0].classification).toBe("PRODUCT_REACHABLE");
  });

  it("is deterministic and ordered by kind then path", () => {
    const findings = [
      { kind: "production_fixture_import", path: "src/b.ts" },
      { kind: "credential_url", path: "src/a.test.ts" },
      { kind: "production_fixture_import", path: "src/a.ts" },
    ];
    const first = buildScannerFindingDiagnostic(findings, []);
    const second = buildScannerFindingDiagnostic([...findings].reverse(), []);
    expect(first).toEqual(second);
    expect(first.records.map((record) => `${record.kind}:${record.path}`)).toEqual([
      "credential_url:src/a.test.ts",
      "production_fixture_import:src/a.ts",
      "production_fixture_import:src/b.ts",
    ]);
  });

  it("derives product reachability by walking the graph from product entrypoints", () => {
    const graph = {
      nodes: [
        { path: "entry.ts", kind: "product_entrypoint" },
        { path: "reached.ts", kind: "module" },
        { path: "deep.ts", kind: "module" },
        { path: "orphan.ts", kind: "module" },
        { path: "evidence.ts", kind: "evidence_entrypoint" },
      ],
      edges: [
        { from: "entry.ts", to: "reached.ts" },
        { from: "reached.ts", to: "deep.ts" },
        { from: "evidence.ts", to: "orphan.ts" },
      ],
    };
    expect(productReachablePathsFromGraph(graph)).toEqual(["deep.ts", "entry.ts", "reached.ts"]);
  });

  it("tolerates a cycle and a malformed graph without hanging or throwing", () => {
    const cyclic = {
      nodes: [{ path: "a.ts", kind: "product_entrypoint" }, { path: "b.ts", kind: "module" }],
      edges: [{ from: "a.ts", to: "b.ts" }, { from: "b.ts", to: "a.ts" }],
    };
    expect(productReachablePathsFromGraph(cyclic)).toEqual(["a.ts", "b.ts"]);
    expect(productReachablePathsFromGraph(null)).toEqual([]);
    expect(productReachablePathsFromGraph({ nodes: "bad", edges: 7 })).toEqual([]);
  });

  it("classifies the two live findings against the real canonical graph", () => {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, "utf8"));
    const reachable = productReachablePathsFromGraph(graph);
    expect(reachable.length).toBeGreaterThan(0);
    const diagnostic = buildScannerFindingDiagnostic([
      { kind: "credential_url", path: "scripts/full-local-system-marathon/durable-browser-e2e-runtime.test.mjs" },
      { kind: "production_fixture_import", path: "src/engine/legal-quality/synthetic-property-suite.ts" },
    ], reachable);
    expect(diagnostic.counts.PRODUCT_REACHABLE).toBe(0);
    const byPath = Object.fromEntries(diagnostic.records.map((record) => [record.path, record.classification]));
    expect(byPath["scripts/full-local-system-marathon/durable-browser-e2e-runtime.test.mjs"]).toBe("TEST_ONLY");
    expect(byPath["src/engine/legal-quality/synthetic-property-suite.ts"]).toBe("OWNER_POLICY_REQUIRED");
  });
});
