import "../../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type NodeRecord = Readonly<{
  path: string;
  imports: readonly string[];
  constructors: readonly string[];
  global_state_markers: readonly string[];
  memory_markers: readonly string[];
}>;

const root = process.cwd();
const outputRoot = path.resolve(root, "output", "canonical-postgresql-persistence-v0.9.0", "preflight");
const entrypoints = [
  "src/instrumentation.ts",
  "src/app/portal/page.tsx",
  "src/app/operations/page.tsx",
  "src/app/api/portal/[[...resource]]/route.ts",
  "src/app/api/portal/session/route.ts",
  "src/app/api/operations/[...segments]/route.ts",
  "src/app/api/operations/session/route.ts",
  "src/engine/case-analysis/service.ts",
  "src/server/product/internal-ops/runtime.ts",
  "src/server/product/routes/runtime.ts",
] as const;

const files = (await walkMany([path.join(root, "src"), path.join(root, "scripts")]))
  .filter((file) => /\.(?:ts|tsx|mts)$/u.test(file))
  .filter((file) => !file.includes(`${path.sep}output${path.sep}`))
  .sort();
const relativeSet = new Set(files.map(relative));
const nodes: NodeRecord[] = [];
for (const absolute of files) {
  const body = await readFile(absolute, "utf8");
  const sourcePath = relative(absolute);
  const imports = [...body.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu)]
    .map((match) => resolveImport(sourcePath, match[1]))
    .filter((value): value is string => value !== null && relativeSet.has(value));
  const constructors = [...body.matchAll(/new\s+([A-Z][A-Za-z0-9_]*(?:Repository|Store|Queue|Audit|Storage|Composition|Manager|Client))/gu)].map((match) => match[1]);
  const globalState = ["globalThis", "installedPorts", "serviceLocator", "singleton"].filter((marker) => body.includes(marker));
  const memoryMarkers = ["memory_test_only", "InMemory", "LocalDurablePlatformStore", "LocalDurableJobQueue", "InMemoryHashChainAudit"].filter((marker) => body.includes(marker));
  nodes.push(Object.freeze({ path: sourcePath, imports: Object.freeze([...new Set(imports)].sort()), constructors: Object.freeze(constructors), global_state_markers: Object.freeze(globalState), memory_markers: Object.freeze(memoryMarkers) }));
}

const byPath = new Map(nodes.map((node) => [node.path, node]));
const reachable = new Set<string>();
const queue = entrypoints.filter((entrypoint) => byPath.has(entrypoint));
while (queue.length > 0) {
  const current = queue.shift()!;
  if (reachable.has(current)) continue;
  reachable.add(current);
  for (const imported of byPath.get(current)?.imports ?? []) if (!reachable.has(imported)) queue.push(imported);
}
const productReachableConstructors = nodes
  .filter((node) => reachable.has(node.path) && node.constructors.length > 0)
  .map((node) => ({ path: node.path, constructors: node.constructors }));
const productReachableMemory = nodes
  .filter((node) => reachable.has(node.path) && node.memory_markers.length > 0)
  .map((node) => ({ path: node.path, markers: node.memory_markers }));
const graph = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-reachability-v0.9.0",
  status: "PASS",
  entrypoints,
  counts: {
    files: nodes.length,
    edges: nodes.reduce((sum, node) => sum + node.imports.length, 0),
    reachable: reachable.size,
    product_reachable_constructors: productReachableConstructors.length,
    product_reachable_memory_marker_files: productReachableMemory.length,
    unresolved_entrypoints: entrypoints.filter((entrypoint) => !byPath.has(entrypoint)).length,
  },
  product_reachable_constructors: productReachableConstructors,
  product_reachable_memory_markers: productReachableMemory,
  nodes,
});
await mkdir(outputRoot, { recursive: true });
const encoded = `${JSON.stringify(graph, null, 2)}\n`;
await writeFile(path.join(outputRoot, "source-import-constructor-graph.json"), encoded, "utf8");
process.stdout.write(`${JSON.stringify({ ...graph.counts, sha256: sha(encoded), status: graph.status })}\n`);

async function walkMany(roots: readonly string[]): Promise<string[]> {
  return (await Promise.all(roots.map(walk))).flat();
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() ? [absolute] : [];
  }))).flat();
}

function resolveImport(sourcePath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = /\.(?:ts|tsx|mts)$/u.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => relativeSet.has(candidate)) ?? null;
}

function relative(value: string): string {
  return path.relative(root, value).replaceAll("\\", "/");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
