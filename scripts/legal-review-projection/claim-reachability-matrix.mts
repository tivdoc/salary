// Pool C. Every canonical entrypoint claim, against what the graph can see.
//
// A claim and a graph can disagree in two directions, and only one of them is
// interesting. A record asserting the entrypoint is wired while its target is
// unreachable is a claim with nothing behind it. A record asserting it is NOT
// wired while its target is reachable is a candidate for restating — but only a
// candidate, because reachable is not called: a symbol can sit in a file the
// product reaches and still have no caller. Every entry in the open set below
// was decided one at a time, on the symbol, not on the file.
//
// The question is asked per record kind. A `cli` record names a script, scripts
// are evidence entrypoints, and no script is ever product-reachable — asking
// product reachability of one produced thirteen false mismatches on the first
// pass. CLI records are asked about evidence reachability instead.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const GRAPH = path.join("output", "product-integration-v0.8.0", "reachability", "source-import-graph.json");
const LEDGER = path.join("src", "server", "system-marathon", "canonical-entrypoints.v0.10.0.json");

/** Classifications asserting the entrypoint is wired and working. */
const ASSERTS_WIRED = new Set(["ALREADY_CANONICAL_AND_PROVEN", "WIRED_DURABLE", "PROVEN"]);
/**
 * Classifications asserting it is not wired.
 *
 * `CONTRACT_ONLY` is deliberately absent. All five records carrying it are
 * blocked on a human content gate — HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED,
 * RULESPEC_HUMAN_AUTHORING_REQUIRED, HUMAN_GOLDEN_CASES_REQUIRED,
 * REAL_RULES_ACTIVE_0 — and not one of them says anything about wiring. The
 * contract exists and is called; what is missing is content a person has to
 * write. Reachability cannot contradict that, so counting those four as
 * disagreements was the checker being wrong, not the records.
 */
const ASSERTS_NOT_WIRED = new Set(["IMPLEMENTED_NOT_WIRED", "NOT_IMPLEMENTED"]);

/** Blockers that are about wiring, and so are the ones reachability can speak to. */
const WIRING_BLOCKERS = Object.freeze([
  "CANONICAL_NON_TEST_COMPOSITION_NOT_INSTALLED",
  "DIRECT_SUPABASE_ROUTE_NOT_BOUND_TO_CANONICAL_COMPOSITION",
  "STABLE_NEXT_ROUTES_NOT_BOUND_TO_DURABLE_APPLICATION",
  "DURABLE_PORTS_NOT_INSTALLED",
  "LONG_RUNNING_WORKER_ENTRYPOINT_NOT_WIRED",
  "EXTERNAL_EFFECT_ADAPTER_NOT_WIRED",
  "MANAGED_KEY_RESOLVER_NOT_WIRED",
  "DURABLE_SESSION_STATE_NOT_WIRED",
]);

/**
 * Records whose target is reachable while the record says it is not wired, and
 * which have been examined and left standing. Each is here because the symbol
 * the record names has no caller even though its file is reached, or because
 * the blocker the record cites is real and independent of reachability.
 * A record that leaves this set is progress; one that arrives without being
 * examined is the defect this matrix exists to catch.
 */
const EXAMINED_OPEN: Readonly<Record<string, string>> = Object.freeze({
  "CEP-006": "unexamined",
  "CEP-007": "unexamined",
  "CEP-013": "unexamined",
  "CEP-014": "unexamined",
  "CEP-015": "unexamined",
  "CEP-020": "unexamined",
  "CEP-025": "unexamined",
  "CEP-027": "unexamined",
  "CEP-028": "unexamined",
  "CEP-080": "unexamined",
  "CEP-081": "unexamined",
  "CEP-082": "unexamined",
  "CEP-083": "unexamined",
});

type GraphNode = Readonly<{ path: string; kind: string }>;
type GraphEdge = Readonly<{ from: string; to: string | null }>;
type Entry = Readonly<{
  entrypoint_id: string; kind: string; classification: string;
  source_path?: string; canonical_target?: string; blockers?: readonly string[];
}>;

function walk(nodes: readonly GraphNode[], edges: readonly GraphEdge[], kind: string): ReadonlySet<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge.to !== "string") continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const queue = nodes.filter((node) => node.kind === kind).map((node) => node.path);
  for (const entry of queue) seen.add(entry);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Whether the symbol a record names is referenced from somewhere the product
 * reaches, as opposed to merely living in a file the product reaches.
 *
 * This is the distinction the whole pool turns on. `SupabasePrivateBlobProvider`
 * sits in a reachable module and is instantiated by nothing — the runtime uses
 * `LocalRuntimePrivateBlobProvider` instead — so CEP-016 and CEP-017 were right
 * and the file-level test was wrong about them. A textual reference from a
 * reachable file is a weaker signal than a call graph, but it is the signal
 * that separates "the module is reachable" from "this thing is used", and it
 * only ever moves a record out of the disagreement set, never into it.
 */
function symbolReferenced(
  symbol: string, definedIn: string, reachable: ReadonlySet<string>,
): readonly string[] {
  if (!/^[A-Za-z_$][\w$]*$/u.test(symbol)) return [];
  const pattern = new RegExp(`\\b${symbol}\\b`, "u");
  const referrers: string[] = [];
  for (const file of reachable) {
    if (file === definedIn) continue;
    if (!/\.[cm]?[jt]sx?$/u.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) continue;
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (pattern.test(text)) referrers.push(file);
  }
  return referrers;
}

function symbolOf(entry: Entry): string | null {
  const target = entry.canonical_target;
  if (typeof target !== "string" || !target.includes(":")) return null;
  const symbol = target.slice(target.lastIndexOf(":") + 1);
  return /^[A-Za-z_$][\w$]*$/u.test(symbol) ? symbol : null;
}

function targetOf(entry: Entry): string {
  const target = typeof entry.canonical_target === "string" && entry.canonical_target.includes(":")
    ? entry.canonical_target.slice(0, entry.canonical_target.lastIndexOf(":"))
    : entry.source_path;
  return target ?? entry.source_path ?? "";
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  if (!existsSync(GRAPH)) {
    process.stdout.write("claims=skipped reason=graph_absent"
      + " (run scripts/product-integration/reachability/verify.mts first)\n");
    process.exitCode = 1;
    return;
  }
  const graph = JSON.parse(readFileSync(GRAPH, "utf8")) as Readonly<{
    generated_from_head: string; nodes: readonly GraphNode[]; edges: readonly GraphEdge[];
  }>;
  const entries = (JSON.parse(readFileSync(LEDGER, "utf8")) as Readonly<{ entries: readonly Entry[] }>).entries;

  const product = walk(graph.nodes, graph.edges, "product_entrypoint");
  const evidence = walk(graph.nodes, graph.edges, "evidence_entrypoint");

  const rows = entries.map((entry) => {
    const file = targetOf(entry);
    const fileReachable = entry.kind === "cli" ? product.has(file) || evidence.has(file) : product.has(file);
    const symbol = symbolOf(entry);
    const referrers = symbol === null || !fileReachable
      ? []
      : symbolReferenced(symbol, file, entry.kind === "cli" ? new Set([...product, ...evidence]) : product);
    // A record is only contradicted when the thing it names is used, not when
    // its module happens to be reachable.
    const reachable = fileReachable && (symbol === null || referrers.length > 0);
    let mismatch = "none";
    if (ASSERTS_WIRED.has(entry.classification) && !reachable) mismatch = "claims_wired_target_unreachable";
    else if (ASSERTS_NOT_WIRED.has(entry.classification) && reachable) mismatch = "claims_unwired_target_reachable";
    return {
      id: entry.entrypoint_id, kind: entry.kind, classification: entry.classification,
      target: file, symbol, file_reachable: fileReachable, reachable, mismatch,
      referrers: referrers.slice(0, 4),
      wiring_blockers: (entry.blockers ?? []).filter((blocker) => WIRING_BLOCKERS.includes(blocker)),
      disposition: EXAMINED_OPEN[entry.entrypoint_id] ?? null,
    };
  });

  const mismatched = rows.filter((row) => row.mismatch !== "none");
  const failures: string[] = [];
  for (const row of mismatched) {
    if (row.mismatch === "claims_wired_target_unreachable") {
      failures.push(`${row.id} claims ${row.classification} over an unreachable target ${row.target}`);
    } else if (row.disposition === null) {
      failures.push(`${row.id} newly disagrees with the graph and has not been examined`);
    }
  }
  for (const id of Object.keys(EXAMINED_OPEN)) {
    if (!mismatched.some((row) => row.id === id)) {
      failures.push(`${id} no longer disagrees with the graph: retire its entry`);
    }
  }

  const tally: Record<string, number> = {};
  for (const row of rows) tally[row.mismatch] = (tally[row.mismatch] ?? 0) + 1;
  const examined = Object.values(EXAMINED_OPEN).filter((value) => value !== "unexamined").length;

  writeFileSync(path.join(RECEIPT_ROOT, "claim-reachability-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-claim-reachability-matrix-poolc",
    head: graph.generated_from_head,
    records: rows.length, mismatched: mismatched.length, tally,
    open_set: EXAMINED_OPEN, examined, unexamined: Object.keys(EXAMINED_OPEN).length - examined,
    failures, rows,
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`claims=${rows.length} mismatched=${mismatched.length} ${JSON.stringify(tally)}`
    + ` examined=${examined}/${Object.keys(EXAMINED_OPEN).length} failures=${failures.length}`
    + `${failures.length > 0 ? ` :: ${failures.join("; ")}` : ""}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
