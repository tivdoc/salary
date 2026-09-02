// V0.10.4/V0.10.5 scanner finding diagnostic.
//
// The prohibited-operation scan reports findings; it does not say what to do
// about them, and suppressing one to make a gate green would defeat the point.
// This classifies each finding against the canonical reachability graph so the
// difference between "test-only", "product-reachable" and "needs an owner
// decision" is evidence rather than opinion. It changes no scanner rule and
// closes nothing.

export const SCANNER_FINDING_DIAGNOSTIC_SCHEMA =
  "tivdoc-scanner-finding-diagnostic-v0.10.5" as const;

export type ScannerFinding = Readonly<{ kind: string; path: string }>;

export type ScannerFindingClassification =
  | "TEST_ONLY"
  | "PRODUCT_REACHABLE"
  | "OWNER_POLICY_REQUIRED";

export type ScannerFindingRecord = Readonly<{
  kind: string;
  path: string;
  classification: ScannerFindingClassification;
  product_reachable: boolean;
  test_path: boolean;
  rationale: string;
}>;

export type ScannerFindingDiagnostic = Readonly<{
  schema_version: typeof SCANNER_FINDING_DIAGNOSTIC_SCHEMA;
  diagnostic_only: true;
  finding_count: number;
  records: readonly ScannerFindingRecord[];
  counts: Readonly<Record<ScannerFindingClassification, number>>;
}>;

const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

/**
 * A finding on a file the product can actually reach is a product defect. One
 * on a test file is test-only. Anything else is a placement or policy question
 * that belongs to an owner, not to this scan.
 */
function classify(
  finding: ScannerFinding,
  productReachable: ReadonlySet<string>,
): ScannerFindingRecord {
  const reachable = productReachable.has(finding.path);
  const isTest = TEST_PATH.test(finding.path);
  const classification: ScannerFindingClassification = reachable
    ? "PRODUCT_REACHABLE"
    : isTest ? "TEST_ONLY" : "OWNER_POLICY_REQUIRED";
  const rationale = reachable
    ? "reachable from a product entrypoint in the canonical graph; fix in product code"
    : isTest
      ? "a test file, unreachable from any product entrypoint; no product exposure"
      : "not product-reachable and not a test file; placement or policy needs an owner decision";
  return Object.freeze({
    kind: finding.kind,
    path: finding.path,
    classification,
    product_reachable: reachable,
    test_path: isTest,
    rationale,
  });
}

export function buildScannerFindingDiagnostic(
  findings: readonly ScannerFinding[],
  productReachablePaths: readonly string[],
): ScannerFindingDiagnostic {
  const reachable = new Set(productReachablePaths);
  const records = [...findings]
    .map((finding) => classify(finding, reachable))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path));
  const counts = { TEST_ONLY: 0, PRODUCT_REACHABLE: 0, OWNER_POLICY_REQUIRED: 0 };
  for (const record of records) counts[record.classification] += 1;
  return Object.freeze({
    schema_version: SCANNER_FINDING_DIAGNOSTIC_SCHEMA,
    diagnostic_only: true,
    finding_count: records.length,
    records: Object.freeze(records),
    counts: Object.freeze(counts),
  });
}

type GraphNode = Readonly<{ path?: unknown; kind?: unknown }>;
type GraphEdge = Readonly<{ from?: unknown; to?: unknown }>;

/**
 * Product-reachable paths, computed the same way the canonical audit computes
 * them: a breadth-first walk of the import graph from every product entrypoint.
 * The graph records no precomputed reachability, so deriving it here keeps this
 * diagnostic consistent with the audit rather than guessing from file paths.
 */
export function productReachablePathsFromGraph(graph: unknown): readonly string[] {
  const source = graph as Readonly<{ nodes?: readonly GraphNode[]; edges?: readonly GraphEdge[] }>;
  const nodes = Array.isArray(source?.nodes) ? source.nodes : [];
  const edges = Array.isArray(source?.edges) ? source.edges : [];

  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (typeof edge?.from !== "string" || typeof edge?.to !== "string") continue;
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }

  const reached = new Set<string>();
  const queue = nodes
    .filter((node) => typeof node?.path === "string" && node.kind === "product_entrypoint")
    .map((node) => node.path as string);
  for (const entry of queue) reached.add(entry);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return Object.freeze([...reached].sort());
}
