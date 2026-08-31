import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const mapPath = join(repositoryRoot, "scripts/product-integration/routes/route-service-map.json");
const map = JSON.parse(readFileSync(mapPath, "utf8")) as { schema_version?: unknown; routes?: unknown };
const requiredFields = ["legacy_route", "stable_route", "feature_flag", "auth_policy", "required_role", "canonical_use_case", "repository_ports", "storage_ports", "legacy_disposition"] as const;
const dispositions = new Set(["LEGACY_DELEGATE_DEFAULT_OFF", "REMOVED_AFTER_PROOF", "NOT_APPLICABLE"]);
const failures: string[] = [];

if (map.schema_version !== "tivdoc-stable-route-service-map-v1" || !Array.isArray(map.routes) || map.routes.length < 10) failures.push("route_service_map_schema_invalid");
for (const [index, route] of (Array.isArray(map.routes) ? map.routes : []).entries()) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    failures.push(`route_${index}_not_object`);
    continue;
  }
  const record = route as Record<string, unknown>;
  for (const field of requiredFields) if (!(field in record)) failures.push(`route_${index}_missing_${field}`);
  if (!dispositions.has(String(record.legacy_disposition))) failures.push(`route_${index}_legacy_disposition_invalid`);
  if (typeof record.stable_route !== "string" || !record.stable_route.startsWith("/")) failures.push(`route_${index}_stable_route_invalid`);
}

const roots = [
  "src/app/portal/page.tsx",
  "src/app/operations/page.tsx",
  "src/app/api/portal/[[...resource]]/route.ts",
  "src/app/api/portal/session/route.ts",
  "src/app/api/operations/[...segments]/route.ts",
  "src/app/api/operations/session/route.ts",
].map((path) => join(repositoryRoot, path));
const canonicalBoundaries = [
  "src/server/product/customer-portal/contracts.ts",
  "src/server/product/customer-portal/service.ts",
  "src/server/product/internal-ops/contracts.ts",
  "src/server/product/internal-ops/runtime.ts",
  "src/server/product/internal-ops/service.ts",
].map((path) => normalize(join(repositoryRoot, path)));
const graph = new Map<string, readonly string[]>();
const visiting = [...roots];

while (visiting.length > 0) {
  const file = normalize(visiting.pop()!);
  if (graph.has(file)) continue;
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    failures.push(`missing_entrypoint:${relative(repositoryRoot, file)}`);
    continue;
  }
  const imports = localImports(file, source);
  graph.set(file, imports);
  const normalizedRelative = relative(repositoryRoot, file).replaceAll("\\", "/");
  if (/^(src\/app\/(portal|operations)|src\/app\/api\/(portal|operations)|src\/components\/(portal|operations))\//.test(normalizedRelative)) {
    if (/\b(?:v0?7|v0?8|wave|overnight)\b/i.test(source)) failures.push(`versioned_product_surface:${normalizedRelative}`);
    if (/from\s+["']@\/engine\//.test(source)) failures.push(`engine_entrypoint_import:${normalizedRelative}`);
  }
  if (/src\/server\/product\/(auth|routes)\//.test(normalizedRelative) && /from\s+["'](?:@\/|\.\.\/)+engine\//.test(source)) {
    failures.push(`route_boundary_engine_import:${normalizedRelative}`);
  }
  if (!canonicalBoundaries.includes(file)) visiting.push(...imports);
}

for (const file of graph.keys()) {
  const path = relative(repositoryRoot, file).replaceAll("\\", "/");
  if (/src\/(?:app|components)\/(?:internal-ops-v07|portal-v07)\//.test(path)) failures.push(`legacy_surface_reachable:${path}`);
  if (/src\/engine\/(?:wave|overnight)/.test(path)) failures.push(`release_specific_engine_reachable:${path}`);
}

const routeSources = [...graph.keys()].filter((file) => /src\/server\/product\/routes\//.test(relative(repositoryRoot, file).replaceAll("\\", "/")));
for (const file of routeSources) {
  const source = readFileSync(file, "utf8");
  if (/\b(?:Money|RuleSpec|evaluateLegalReadiness|calculateEntitlement|monetarySubtotal)\b/.test(source)) failures.push(`duplicate_business_logic_signal:${relative(repositoryRoot, file)}`);
}

const result = {
  schema_version: "tivdoc-stable-route-import-verifier-v1",
  status: failures.length === 0 ? "PASS" : "FAIL",
  route_map_entries: Array.isArray(map.routes) ? map.routes.length : 0,
  entrypoints: roots.map((file) => relative(repositoryRoot, file).replaceAll("\\", "/")),
  graph_nodes: graph.size,
  graph_edges: [...graph.values()].reduce((sum, edges) => sum + edges.length, 0),
  canonical_boundaries: canonicalBoundaries.map((file) => relative(repositoryRoot, file).replaceAll("\\", "/")),
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;

function localImports(importer: string, source: string): readonly string[] {
  const result: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
    const base = specifier.startsWith("@/") ? join(repositoryRoot, "src", specifier.slice(2)) : resolve(dirname(importer), specifier);
    const resolved = resolveSource(base);
    if (resolved) result.push(resolved);
  }
  return Object.freeze([...new Set(result)].sort());
}

function resolveSource(base: string): string | null {
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.json`, `${base}.css`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const candidate of candidates) {
    try {
      if (isAbsolute(candidate) && statSync(candidate).isFile()) return normalize(candidate);
    } catch {
      // Continue to the next deterministic resolution candidate.
    }
  }
  return null;
}
