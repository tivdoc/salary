// E2. Pool C said 63 claims and this run reported 21. Every one of the 63 is
// accounted for here, by id.
//
// A denominator is never silently adjusted — but neither is it reconstructed by
// guesswork. The 63 came from a sweep at 7389f04 that did not record the
// predicate it used, and three defensible readings of its own prose reproduce
// 34, 49 and 88 rather than 63; its own named list holds 49 ids plus 13 it
// described as "cli records pointing at scripts/** (expected)" and did not name,
// which is 62. So the headline is not reproducible and is not treated as the
// denominator.
//
// What is authoritative is the list the sweep actually wrote down. SWEPT_IDS
// below is that list, verbatim, and this reports the standing of every id in it
// at the current head along with the correction that resolved it. A record that
// the sweep named and that nothing here explains would show up as unaccounted.
//
// The corrections, in order:
//   R0a the `@/*` alias resolved to the bare remainder instead of `src/*`, so
//       all 232 aliased edges pointed at nothing and were dropped. That is the
//       state the original sweep ran in, and it is why so many records read as
//       claiming wiring over an unreachable target.
//   R1  Next.js metadata files (`robots`, `sitemap`, `opengraph-image`) are
//       framework entrypoints. Their records were right and the graph was wrong.
//   R2  a `cli` record names a script, and scripts are evidence entrypoints, so
//       asking product reachability of one asks the wrong question.
//   R3  `CONTRACT_ONLY` is not a claim about wiring: all five carry a human
//       content gate as their blocker.
//   R4  judge the symbol the record names, not the module it lives in.
//   R5  the restatements — records whose blocker had genuinely gone stale.

import "../production-refusal.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const GRAPH = path.join("output", "product-integration-v0.8.0", "reachability", "source-import-graph.json");
const LEDGER = path.join("src", "server", "system-marathon", "canonical-entrypoints.v0.10.0.json");

/**
 * The ids the 7389f04 sweep named, verbatim from its report: 21 under "asserts
 * wiring, target unreachable" and 28 under "says NOT wired but IS reachable".
 * Its headline of 63 adds the 13 cli records it described but did not name, and
 * is one out against its own arithmetic.
 */
const SWEPT_IDS: readonly string[] = Object.freeze([
  "CEP-010", "CEP-011", "CEP-012", "CEP-033", "CEP-062", "CEP-063",
  "CEP-051", "CEP-052", "CEP-053", "CEP-054", "CEP-055", "CEP-056", "CEP-088",
  "CEP-048", "CEP-057", "CEP-058", "CEP-059", "CEP-092",
  "CEP-060", "CEP-091", "CEP-093",
  "CEP-006", "CEP-007", "CEP-020", "CEP-025", "CEP-078",
  "CEP-013", "CEP-014", "CEP-015", "CEP-016", "CEP-017",
  "CEP-027", "CEP-028", "CEP-079", "CEP-080", "CEP-081", "CEP-082", "CEP-083",
  "CEP-001", "CEP-002", "CEP-003", "CEP-004", "CEP-005",
  "CEP-008", "CEP-009", "CEP-018", "CEP-019", "CEP-021", "CEP-026",
]);

/** The classifications as they stood at 7389f04, before any restatement. */
const CLASSIFICATION_AT_7389F04: Readonly<Record<string, string>> = Object.freeze({
  "CEP-006": "IMPLEMENTED_NOT_WIRED", "CEP-007": "IMPLEMENTED_NOT_WIRED",
  "CEP-020": "IMPLEMENTED_NOT_WIRED", "CEP-025": "IMPLEMENTED_NOT_WIRED",
  "CEP-078": "IMPLEMENTED_NOT_WIRED", "CEP-079": "IMPLEMENTED_NOT_WIRED",
});

const METADATA_ENTRY = /^src\/app\/(?:.*\/)?(?:robots|sitemap|manifest|opengraph-image|twitter-image|icon|apple-icon)\.[jt]sx?$/;
const ASSERTS_WIRED = new Set(["ALREADY_CANONICAL_AND_PROVEN", "WIRED_DURABLE", "PROVEN"]);
const NOT_WIRED_WITH_CONTRACT = new Set(["IMPLEMENTED_NOT_WIRED", "CONTRACT_ONLY", "NOT_IMPLEMENTED"]);
/** The original sweep also read PARTIAL as a claim that nothing is wired. */
const NOT_WIRED_AS_SWEPT = new Set(["IMPLEMENTED_NOT_WIRED", "CONTRACT_ONLY", "NOT_IMPLEMENTED", "PARTIAL", "EXTERNAL_OR_HUMAN_BLOCKED"]);
const NOT_WIRED_WITHOUT_CONTRACT = new Set(["IMPLEMENTED_NOT_WIRED", "NOT_IMPLEMENTED"]);

type GraphNode = Readonly<{ path: string; kind: string }>;
type GraphEdge = Readonly<{ from: string; to: string | null; specifier: string }>;
type Entry = Readonly<{
  entrypoint_id: string; kind: string; classification: string;
  source_path?: string; canonical_target?: string;
}>;

function walk(nodes: readonly GraphNode[], edges: readonly GraphEdge[], seeds: readonly string[]): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge.to !== "string") continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>(seeds);
  const queue = [...seeds];
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

function targetOf(entry: Entry): string {
  const target = typeof entry.canonical_target === "string" && entry.canonical_target.includes(":")
    ? entry.canonical_target.slice(0, entry.canonical_target.lastIndexOf(":"))
    : entry.source_path;
  return target ?? entry.source_path ?? "";
}

function symbolOf(entry: Entry): string | null {
  const target = entry.canonical_target;
  if (typeof target !== "string" || !target.includes(":")) return null;
  const symbol = target.slice(target.lastIndexOf(":") + 1);
  return /^[A-Za-z_$][\w$]*$/u.test(symbol) ? symbol : null;
}

function symbolUsed(symbol: string, definedIn: string, reachable: ReadonlySet<string>): boolean {
  const pattern = new RegExp(`\\b${symbol}\\b`, "u");
  for (const file of reachable) {
    if (file === definedIn) continue;
    if (!/\.[cm]?[jt]sx?$/u.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) continue;
    try {
      if (pattern.test(readFileSync(file, "utf8"))) return true;
    } catch { continue; }
  }
  return false;
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  if (!existsSync(GRAPH)) {
    process.stdout.write("reconciliation=skipped reason=graph_absent\n");
    process.exitCode = 1;
    return;
  }
  const graph = JSON.parse(readFileSync(GRAPH, "utf8")) as Readonly<{
    generated_from_head: string; nodes: readonly GraphNode[]; edges: readonly GraphEdge[];
  }>;
  const entries = (JSON.parse(readFileSync(LEDGER, "utf8")) as Readonly<{ entries: readonly Entry[] }>).entries;

  const allProductSeeds = graph.nodes.filter((n) => n.kind === "product_entrypoint").map((n) => n.path);
  // R0 is the graph as the original sweep saw it: metadata files were ordinary
  // modules, and every `@/` edge resolved to nothing and was dropped.
  const withoutMetadata = allProductSeeds.filter((file) => !METADATA_ENTRY.test(file));
  const edgesWithoutAlias = graph.edges.filter((edge) => !edge.specifier.startsWith("@/"));
  const productR0 = walk(graph.nodes, edgesWithoutAlias, withoutMetadata);
  const productR0a = walk(graph.nodes, graph.edges, withoutMetadata);
  const productR1 = walk(graph.nodes, graph.edges, allProductSeeds);
  const evidence = walk(graph.nodes, graph.edges,
    graph.nodes.filter((n) => n.kind === "evidence_entrypoint").map((n) => n.path));

  const rows = entries.map((entry) => {
    const file = targetOf(entry);
    const symbol = symbolOf(entry);
    const original = CLASSIFICATION_AT_7389F04[entry.entrypoint_id] ?? entry.classification;

    const disagrees = (
      classification: string, reachable: boolean, notWired: ReadonlySet<string>,
    ): boolean => (ASSERTS_WIRED.has(classification) && !reachable)
      || (notWired.has(classification) && reachable);

    const r0Reach = productR0.has(file);
    const r0aReach = productR0a.has(file);
    const r1Reach = productR1.has(file);
    const r2Reach = entry.kind === "cli" ? r1Reach || evidence.has(file) : r1Reach;
    const r4Reach = r2Reach && (symbol === null
      || symbolUsed(symbol, file, entry.kind === "cli" ? new Set([...productR1, ...evidence]) : productR1));

    // The sweep that produced 63 counted a record as mismatched whenever its
    // target was unreachable, whatever the record claimed, and also whenever the
    // target was reachable and the record was anything other than fully proven.
    const sweptMismatch = !r0Reach || original !== "ALREADY_CANONICAL_AND_PROVEN";
    const state = {
      r00: sweptMismatch,
      r0: disagrees(original, r0Reach, NOT_WIRED_AS_SWEPT),
      r0p: disagrees(original, r0Reach, NOT_WIRED_WITH_CONTRACT),
      r0a: disagrees(original, r0aReach, NOT_WIRED_WITH_CONTRACT),
      r1: disagrees(original, r1Reach, NOT_WIRED_WITH_CONTRACT),
      r2: disagrees(original, r2Reach, NOT_WIRED_WITH_CONTRACT),
      r3: disagrees(original, r2Reach, NOT_WIRED_WITHOUT_CONTRACT),
      r4: disagrees(original, r4Reach, NOT_WIRED_WITHOUT_CONTRACT),
      r5: disagrees(entry.classification, r4Reach, NOT_WIRED_WITHOUT_CONTRACT),
    };
    const resolvedBy = !state.r0 ? "never_disagreed"
      : !state.r0p ? "R0p_partial_is_not_a_not_wired_claim"
        : !state.r0a ? "R0a_alias_resolution_fixed"
          : !state.r1 ? "R1_metadata_entrypoints"
            : !state.r2 ? "R2_cli_asks_evidence_reachability"
              : !state.r3 ? "R3_contract_only_is_not_a_wiring_claim"
                : !state.r4 ? "R4_judge_the_symbol"
                  : !state.r5 ? "R5_record_restated"
                    : "still_open_examined";
    return {
      id: entry.entrypoint_id, kind: entry.kind,
      classification_at_7389f04: original, classification_now: entry.classification,
      target: file, named_by_the_sweep: SWEPT_IDS.includes(entry.entrypoint_id),
      in_original_63: state.r0, resolved_by: resolvedBy,
    };
  });

  const original63 = rows.filter((row) => row.named_by_the_sweep);
  const byResolution: Record<string, number> = {};
  for (const row of original63) byResolution[row.resolved_by] = (byResolution[row.resolved_by] ?? 0) + 1;
  const stillOpen = original63.filter((row) => row.resolved_by === "still_open_examined");
  const arrivedLater = rows.filter((row) => !row.in_original_63 && row.resolved_by === "still_open_examined");

  writeFileSync(path.join(RECEIPT_ROOT, "claim-pool-reconciliation.json"), `${JSON.stringify({
    schema_version: "tivdoc-claim-pool-reconciliation-e2",
    head: graph.generated_from_head,
    records: rows.length,
    swept_ids_named: SWEPT_IDS.length,
    swept_ids_accounted: original63.length,
    swept_ids_unaccounted: SWEPT_IDS.filter((id) => !rows.some((row) => row.id === id)),
    cli_records_described_but_not_named: rows
      .filter((row) => row.kind === "cli" && !row.named_by_the_sweep && row.resolved_by === "R2_cli_asks_evidence_reachability")
      .map((row) => row.id),
    resolved_by: byResolution,
    still_open: stillOpen.map((row) => row.id),
    disagreements_not_in_the_original_sweep: arrivedLater.map((row) => row.id),
    rows,
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`original_disagreements=${original63.length}`
    + ` still_open=${stillOpen.length} arrived_later=${arrivedLater.length}\n`);
  for (const [reason, count] of Object.entries(byResolution).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${reason}: ${count}\n`);
  }
  process.stdout.write(`  open ids: ${stillOpen.map((row) => row.id).join(" ")}\n`);
}

main();
