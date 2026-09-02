// Wave 3 (C3). What the scanner's findings are permitted on, computed.
//
// The prohibited-operation scan reports findings and says nothing about their
// exposure. Two of them have been carried as acceptable — a credential URL in a
// fixture "because it is test-only", and a fixture import "because nothing
// reaches it" — and neither claim was computed anywhere. The module that would
// have computed it, `scanner-finding-diagnostic.mts`, has no caller at all, so
// the classification existed as a type and never as a fact.
//
// This runs the scanner unchanged, takes its findings verbatim, and walks the
// canonical import graph from all 27 product entrypoints to decide what each
// finding's path actually is at the current head.
//
// The graph's own `classifications` list is not that answer. It covers 549 of
// 934 files, because it only classifies files whose path or content matches
// terms like "fixture", "wave" or "v07" — a different question, asked for a
// different reason. Two of the four findings sit in the other 385, so reading
// their status off that list would have produced silence, not an answer. The
// walk over `nodes` and `edges` covers every file.
//
// Nothing is suppressed, renamed, or excluded. A path the graph does not
// contain, or a graph generated at a different head, yields
// `permission_unverified` — a worse status than the one the finding was
// carrying, not a better one, because reachability computed against a
// different tree is an answer about a different tree.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { productReachablePathsFromGraph } from "./scanner-finding-diagnostic.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave3";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const GRAPH_PATH = path.join("output", "product-integration-v0.8.0", "reachability", "source-import-graph.json");
const SCANNER = path.join("scripts", "full-local-system-marathon", "security-scan.mts");

export type FindingPermission =
  | "product_reachable"
  | "test_only"
  | "evidence_only"
  | "legacy_delegate"
  | "unreachable"
  | "permission_unverified";

const FROM_GRAPH: Readonly<Record<string, FindingPermission>> = Object.freeze({
  PRODUCT_REACHABLE: "product_reachable",
  TEST_ONLY: "test_only",
  EVIDENCE_ONLY: "evidence_only",
  LEGACY_DELEGATE: "legacy_delegate",
  UNREACHABLE: "unreachable",
});

/** Permissions that leave a finding unexplained and therefore unpermitted. */
const NOT_PERMITTED: readonly FindingPermission[] = Object.freeze([
  "product_reachable", "permission_unverified",
]);

function currentHead(): string {
  return process.env.TIVDOC_VERIFIED_HEAD
    ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function runScanner(): Readonly<{ status: string; findings: readonly { kind: string; path: string }[] }> {
  // The scanner exits non-zero when it finds anything, which is its job; the
  // report on stdout is what matters and is read either way.
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", SCANNER],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  if (!line) throw new Error("SCANNER_PRODUCED_NO_REPORT");
  return JSON.parse(line);
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const head = currentHead();
  const report = runScanner();

  let graphHead: string | null = null;
  let reachable = new Set<string>();
  let known = new Set<string>();
  let kinds = new Map<string, string>();
  let classified = new Map<string, string>();
  try {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, "utf8")) as Readonly<{
      generated_from_head?: string;
      nodes?: readonly { path: string; kind: string }[];
      classifications?: readonly { path: string; classification: string }[];
    }>;
    graphHead = graph.generated_from_head ?? null;
    reachable = new Set(productReachablePathsFromGraph(graph));
    known = new Set((graph.nodes ?? []).map((node) => node.path));
    kinds = new Map((graph.nodes ?? []).map((node) => [node.path, node.kind]));
    classified = new Map((graph.classifications ?? []).map((row) => [row.path, row.classification]));
  } catch {
    graphHead = null;
  }
  const graphIsCurrent = graphHead === head;

  const records = report.findings.map((finding) => {
    let permission: FindingPermission;
    let reason: string;
    if (!graphIsCurrent) {
      permission = "permission_unverified";
      reason = `reachability graph was generated at ${graphHead ?? "(missing)"} and the tree is at ${head}`;
    } else if (!known.has(finding.path)) {
      permission = "permission_unverified";
      reason = "the canonical import graph contains no node for this file, so nothing permits it";
    } else if (reachable.has(finding.path)) {
      permission = "product_reachable";
      reason = `reached from a product entrypoint by walking the import graph at ${head}`;
    } else {
      // The graph's own classification is corroboration where it has one; the
      // walk is what decides, because it covers every file and the list does not.
      const raw = classified.get(finding.path);
      permission = kinds.get(finding.path) === "test" ? "test_only" : (raw ? FROM_GRAPH[raw] ?? "unreachable" : "unreachable");
      reason = `no path from any of the 27 product entrypoints reaches this file at ${head}`
        + ` (graph node kind ${kinds.get(finding.path)}${raw ? `, list classification ${raw}` : ""})`;
    }
    return Object.freeze({ kind: finding.kind, path: finding.path, permission, reason });
  });

  const counts: Record<string, number> = {};
  for (const record of records) counts[record.permission] = (counts[record.permission] ?? 0) + 1;
  const unpermitted = records.filter((record) => NOT_PERMITTED.includes(record.permission));

  writeFileSync(path.join(RECEIPT_ROOT, "scanner-finding-reachability.json"), `${JSON.stringify({
    schema_version: "tivdoc-scanner-finding-reachability-wave3",
    head, graph_head: graphHead, graph_is_current: graphIsCurrent,
    scanner_status: report.status,
    finding_count: records.length,
    counts, unpermitted: unpermitted.map((record) => `${record.kind} ${record.path}`),
    records,
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`scanner=${report.status} findings=${records.length} ${JSON.stringify(counts)}`
    + ` unpermitted=${unpermitted.length}\n`);
  if (unpermitted.length > 0) process.exitCode = 1;
}

main();
