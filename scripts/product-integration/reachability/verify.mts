import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Classification =
  | "PRODUCT_REACHABLE"
  | "TEST_ONLY"
  | "EVIDENCE_ONLY"
  | "LEGACY_DELEGATE"
  | "UNREACHABLE"
  | "DUPLICATE_CANONICAL_CONTRACT";

type GraphNode = Readonly<{
  path: string;
  kind: "product_entrypoint" | "legacy_entrypoint" | "evidence_entrypoint" | "test" | "module";
}>;

type GraphEdge = Readonly<{
  from: string;
  specifier: string;
  to: string | null;
  external: boolean;
}>;

const root = process.cwd();
const outputRoot = path.resolve(root, "output", "product-integration-v0.8.0", "reachability");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const importPattern = /(?:\bimport\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?|\bexport\s+(?:type\s+)?[^"']*?\s+from\s+|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;
const declaredSymbolPattern = /\b(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$-]*)/g;
const terms = ["v07", "v08", "wave", "overnight", "fixture", "synthetic", "in-memory", "inmemory"] as const;

const files = (await Promise.all([walk(path.resolve(root, "src")), walk(path.resolve(root, "scripts"))]))
  .flat()
  .filter((file) => sourceExtensions.has(path.extname(file).toLowerCase()))
  .map(relative)
  .sort();
const fileSet = new Set(files);
const contents = new Map<string, string>();
for (const file of files) contents.set(file, await readFile(path.resolve(root, file), "utf8"));

const nodes: GraphNode[] = files.map((file) => ({ path: file, kind: nodeKind(file) }));
const edges: GraphEdge[] = [];
for (const file of files) {
  const content = contents.get(file)!;
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1];
    const target = resolveImport(file, specifier, fileSet);
    edges.push(Object.freeze({ from: file, specifier, to: target, external: target === null && !specifier.startsWith(".") && !specifier.startsWith("@/") }));
  }
}
edges.sort((left, right) => `${left.from}:${left.specifier}`.localeCompare(`${right.from}:${right.specifier}`));

const productEntrypoints = nodes.filter((node) => node.kind === "product_entrypoint").map((node) => node.path);
const legacyEntrypoints = nodes.filter((node) => node.kind === "legacy_entrypoint").map((node) => node.path);
const evidenceEntrypoints = nodes.filter((node) => node.kind === "evidence_entrypoint").map((node) => node.path);
const productReachable = reachable(productEntrypoints, edges);
const legacyReachable = reachable(legacyEntrypoints, edges);
const evidenceReachable = reachable(evidenceEntrypoints, edges);

const classifications: ReadonlyArray<Readonly<{
  path: string;
  matched_terms: readonly string[];
  classification: Classification;
  reason: string;
}>> = files.flatMap((file) => {
  const lowerPath = file.toLowerCase();
  const content = contents.get(file)!.toLowerCase();
  const matchedTerms = terms.filter((term) => lowerPath.includes(term) || content.includes(term));
  if (matchedTerms.length === 0) return [];
  const [classification, reason] = classify(file, productReachable, legacyReachable, evidenceReachable);
  return [Object.freeze({ path: file, matched_terms: matchedTerms, classification, reason })];
});

const symbolClassifications: ReadonlyArray<Readonly<{
  path: string;
  symbol: string;
  matched_terms: readonly string[];
  classification: Classification;
}>> = files.flatMap((file) => {
  const symbols = [...contents.get(file)!.matchAll(declaredSymbolPattern)].map((match) => match[1]);
  const fileClassification = classifications.find((item) => item.path === file)?.classification ?? classify(file, productReachable, legacyReachable, evidenceReachable)[0];
  return symbols.flatMap((symbol) => {
    const lower = symbol.toLowerCase();
    const matchedTerms = terms.filter((term) => lower.includes(term.replace("-", "")) || lower.includes(term));
    return matchedTerms.length > 0 ? [Object.freeze({ path: file, symbol, matched_terms: matchedTerms, classification: fileClassification })] : [];
  });
});

// Two defects of the same shape cost this graph 188 product-reachable files
// between them: `src/instrumentation.ts` was not an entrypoint, so everything
// only it reaches looked dead; and `@/*` resolved to the bare remainder instead
// of `src/*`, so all 232 aliased edges pointed at nothing and were dropped.
// Both were silent — the graph reported `pass: true` throughout. These two
// counts make that class loud.
const FRAMEWORK_ENTRY = /^src\/(?:instrumentation|middleware)\.[jt]sx?$|^src\/app\/(?:.*\/)?(?:page|layout|route|error|not-found|global-error|template|default)\.[jt]sx?$/;
const frameworkEntriesNotClassified = files
  .filter((file) => FRAMEWORK_ENTRY.test(file))
  .filter((file) => nodes.find((node) => node.path === file)?.kind !== "product_entrypoint");
// An alias specifier always names a file in this tree; one that resolves to
// nothing is a resolver bug, never a legitimate external dependency.
const unresolvedAliasImports = edges.filter((edge) => edge.to === null && edge.specifier.startsWith("@/"));

const duplicateCanonicalContracts = classifications.filter((item) => item.classification === "DUPLICATE_CANONICAL_CONTRACT");
const unknown = classifications.filter((item) => !item.classification);
const stableProductFiles = files.filter((file) => /^(src\/app\/(?:api\/)?(?:portal|operations)\/|src\/components\/(?:portal|operations)\/)/.test(file));
const stableVersionLeaks = stableProductFiles.flatMap((file) => {
  const content = contents.get(file)!.toLowerCase();
  const leaks = ["v07", "v08", "wave", "overnight"].filter((term) => content.includes(term));
  return leaks.length > 0 ? [{ path: file, terms: leaks }] : [];
});

const counts = Object.freeze({
  files: files.length,
  nodes: nodes.length,
  edges: edges.length,
  product_entrypoints: productEntrypoints.length,
  legacy_entrypoints: legacyEntrypoints.length,
  evidence_entrypoints: evidenceEntrypoints.length,
  product_reachable: productReachable.size,
  legacy_reachable: legacyReachable.size,
  evidence_reachable: evidenceReachable.size,
  classified_paths: classifications.length,
  classified_symbols: symbolClassifications.length,
  unknown: unknown.length,
  duplicate_canonical_contracts: duplicateCanonicalContracts.length,
  stable_version_leaks: stableVersionLeaks.length,
  framework_entries_not_classified: frameworkEntriesNotClassified.length,
  unresolved_alias_imports: unresolvedAliasImports.length,
});
const payload = {
  schema_version: "tivdoc-canonical-reachability-v0.8.0",
  generated_from_head: gitHeadFromEnvironment(),
  graph_scope: ["src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}", "scripts/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}"],
  counts,
  nodes,
  edges,
  classifications,
  symbol_classifications: symbolClassifications,
  stable_version_leaks: stableVersionLeaks,
  duplicate_canonical_contracts: duplicateCanonicalContracts,
  framework_entries_not_classified: frameworkEntriesNotClassified,
  unresolved_alias_imports: unresolvedAliasImports.map((edge) => `${edge.from} -> ${edge.specifier}`),
};
const canonical = `${JSON.stringify(payload, null, 2)}\n`;
const manifest = Object.freeze({
  schema_version: "tivdoc-canonical-reachability-manifest-v0.8.0",
  payload_sha256: sha256(canonical),
  pass: counts.unknown === 0 && counts.duplicate_canonical_contracts === 0 && counts.stable_version_leaks === 0
    && counts.framework_entries_not_classified === 0 && counts.unresolved_alias_imports === 0,
  counts,
});
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, "source-import-graph.json"), canonical, "utf8");
await writeFile(path.join(outputRoot, "source-import-graph-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(manifest)}\n`);
if (!manifest.pass) process.exitCode = 1;

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() ? [absolute] : [];
  }));
  return nested.flat();
}

function relative(absolute: string): string {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function nodeKind(file: string): GraphNode["kind"] {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) return "test";
  if (file.startsWith("scripts/")) return "evidence_entrypoint";
  if (/^(src\/app\/(?:api\/)?(?:internal-ops-v07|portal-v07)\/|src\/components\/(?:internal-ops-v07|portal-v07)\/)/.test(file)) return "legacy_entrypoint";
  if (/^src\/app\/.*\/(?:page|layout|route|error|not-found|global-error|template|default)\.[jt]sx?$/.test(file)
    || /^src\/app\/(?:page|layout|error|not-found|global-error|template|default)\.[jt]sx?$/.test(file)) return "product_entrypoint";
  // The framework loads these itself and nothing in the tree imports them, so
  // leaving them as plain modules made everything they reach look unreachable.
  // `instrumentation.ts` is the server startup hook: it runs on every boot, and
  // its dynamic import of the durable local runtime is how the product reaches
  // the dependency-invalidation port at all.
  if (/^src\/(?:instrumentation|middleware)\.[jt]sx?$/.test(file)) return "product_entrypoint";
  if (["src/server/product/internal-ops/runtime.ts", "src/server/product/customer-portal/api.ts"].includes(file)) return "product_entrypoint";
  return "module";
}

function resolveImport(from: string, specifier: string, candidates: ReadonlySet<string>): string | null {
  let base: string;
  // `@/*` maps to `./src/*` (tsconfig.json paths). Resolving it to the bare
  // remainder produced 232 edges that matched no file and were silently dropped
  // — every aliased import in the tree — so anything imported only through the
  // alias looked unreachable. `src/app/operations/page.tsx` reached nothing at
  // all, which is why the journey subset computed as 0 against a recorded 8.
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else return null;
  const withoutExtension = base.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/, "");
  const probes = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((extension) => `${withoutExtension}${extension}`),
    ...["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"].map((index) => `${withoutExtension}/${index}`),
  ];
  return probes.find((probe) => candidates.has(probe)) ?? null;
}

function reachable(entrypoints: readonly string[], graphEdges: readonly GraphEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graphEdges) if (edge.to) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const visited = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) if (!visited.has(next)) queue.push(next);
  }
  return visited;
}

function classify(
  file: string,
  product: ReadonlySet<string>,
  legacy: ReadonlySet<string>,
  evidence: ReadonlySet<string>,
): readonly [Classification, string] {
  if (legacy.has(file) && /(?:v07|overnight-v07)/i.test(file)) return ["LEGACY_DELEGATE", "reachable only from a release-specific legacy entrypoint"];
  if (product.has(file)) return ["PRODUCT_REACHABLE", "reachable from a stable non-test product entrypoint"];
  if (/\.test\.[cm]?[jt]sx?$|(?:^|\/)(?:test-fixtures?|fixtures?|synthetic-fixtures?|in-memory)(?:\.|\/|-)/i.test(file)) return ["TEST_ONLY", "test or hermetic fixture module not reachable from a stable product entrypoint"];
  if (evidence.has(file) || file.startsWith("scripts/") || /(?:^|\/)(?:wave\d*|wave\d+-[^/]*|overnight-v07)(?:\/|\.)/i.test(file)) return ["EVIDENCE_ONLY", "verification, historical wave, or evidence entrypoint"];
  return ["UNREACHABLE", "not reachable from stable product, legacy, test, or evidence entrypoints"];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitHeadFromEnvironment(): string {
  return process.env.TIVDOC_VERIFIED_HEAD ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
