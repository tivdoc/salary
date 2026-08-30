export const CANONICAL_READINESS_DELEGATES = Object.freeze([
  "diagnostic_cli",
  "strict_cli",
  "corpus_topic_gate",
  "server_resolver_admission",
  "future_activation_adapter",
  "future_shadow_admission_adapter",
] as const);

export type ReadinessSourceFile = Readonly<{ path: string; content: string }>;

const ALLOWED_DIRECT_RUNTIME_IMPORTS = new Set([
  "src/engine/legal-knowledge/canonical-readiness/delegates.ts",
  "src/engine/legal-knowledge/wave1-topic-readiness.ts",
  "scripts/wave22-corpus-readiness/run.mts",
]);

function normalized(path: string) {
  return path.replaceAll("\\", "/");
}

export function auditCanonicalReadinessTopology(files: readonly ReadinessSourceFile[]) {
  const definitions = files
    .filter((file) => !normalized(file.path).endsWith(".test.ts") && /export\s+function\s+evaluateLegalReadiness\s*\(/.test(file.content))
    .map((file) => normalized(file.path))
    .sort();
  const directImports = files
    .filter((file) => file.content.split(/\r?\n/).some((line) => !line.trimStart().startsWith("import type ") && /from\s+["'][^"']*evaluate-legal-readiness\.ts["']/.test(line)))
    .map((file) => normalized(file.path))
    .sort();
  const forbiddenRuntimeDirectImports = directImports.filter((path) => {
    if (path.endsWith(".test.ts") || path.startsWith("src/engine/wave23/corpus-trust/") || path.startsWith("scripts/wave23-corpus-trust/")) return false;
    return !ALLOWED_DIRECT_RUNTIME_IMPORTS.has(path);
  });
  const alternateDecisionSources = files
    .filter((file) => file.content.includes("evaluateLegalReadiness") && /decision_source\s*:\s*["'](?!evaluateLegalReadiness)[^"']+["']/.test(file.content) && !normalized(file.path).endsWith(".test.ts"))
    .map((file) => normalized(file.path))
    .sort();
  const delegateModule = files.find((file) => normalized(file.path) === "src/engine/legal-knowledge/canonical-readiness/delegates.ts");
  const missingDelegates = CANONICAL_READINESS_DELEGATES.filter((delegateName) => !delegateModule?.content.includes(`"${delegateName}"`));
  const violations = [
    ...(definitions.length === 1 && definitions[0] === "src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts" ? [] : ["canonical_definition_count_or_path_invalid"]),
    ...(forbiddenRuntimeDirectImports.length === 0 ? [] : ["forbidden_runtime_direct_import"]),
    ...(alternateDecisionSources.length === 0 ? [] : ["alternate_decision_source"]),
    ...(missingDelegates.length === 0 ? [] : ["delegate_registry_incomplete"]),
  ];
  return Object.freeze({
    schema_version: "tivdoc-canonical-readiness-topology-v0.5.0" as const,
    canonical_definition: definitions[0] ?? null,
    definition_count: definitions.length,
    direct_imports: Object.freeze(directImports),
    allowed_legacy_direct_runtime_imports: Object.freeze([...ALLOWED_DIRECT_RUNTIME_IMPORTS].sort()),
    forbidden_runtime_direct_imports: Object.freeze(forbiddenRuntimeDirectImports),
    alternate_decision_sources: Object.freeze(alternateDecisionSources),
    delegates: CANONICAL_READINESS_DELEGATES,
    missing_delegates: Object.freeze(missingDelegates),
    violations: Object.freeze(violations),
    passed: violations.length === 0,
  });
}

export function auditSyntheticReadyFixtureReachability(files: readonly ReadinessSourceFile[]) {
  const fixturePath = "src/engine/wave23/corpus-trust/synthetic-ready.fixture.ts";
  const filePaths = new Set(files.map((file) => normalized(file.path)));
  const resolveImport = (importer: string, specifier: string) => {
    if (!specifier.startsWith(".")) return null;
    const segments = [...importer.split("/").slice(0, -1), ...specifier.split("/")];
    const resolved: string[] = [];
    for (const segment of segments) {
      if (segment === "." || segment === "") continue;
      if (segment === "..") resolved.pop();
      else resolved.push(segment);
    }
    const candidate = resolved.join("/");
    if (filePaths.has(candidate)) return candidate;
    if (filePaths.has(`${candidate}.ts`)) return `${candidate}.ts`;
    if (filePaths.has(`${candidate}.mts`)) return `${candidate}.mts`;
    return null;
  };
  const graph = new Map<string, readonly string[]>();
  for (const file of files) {
    const importer = normalized(file.path);
    const imports = [...file.content.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => resolveImport(importer, match[1]))
      .filter((entry): entry is string => entry !== null);
    graph.set(importer, Object.freeze(imports));
  }
  const pathToFixture = (start: string) => {
    const queue: Array<readonly string[]> = [[start]];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const chain = queue.shift()!;
      const current = chain[chain.length - 1];
      if (current === fixturePath) return chain;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dependency of graph.get(current) ?? []) queue.push([...chain, dependency]);
    }
    return null;
  };
  const references = files
    .filter((file) => /from\s+["'][^"']*synthetic-ready\.fixture\.ts["']/.test(file.content) && !normalized(file.path).endsWith("synthetic-ready.fixture.ts"))
    .map((file) => normalized(file.path))
    .sort();
  const productionRoots = files.map((file) => normalized(file.path)).filter((filePath) => filePath !== fixturePath && !filePath.endsWith(".test.ts") && !filePath.startsWith("src/engine/wave23/corpus-trust/") && !filePath.startsWith("scripts/wave23-corpus-trust/"));
  const productionReachabilityPaths = productionRoots.map(pathToFixture).filter((entry): entry is readonly string[] => entry !== null);
  const forbiddenReferences = productionReachabilityPaths.map((chain) => chain[0]).sort();
  return Object.freeze({
    schema_version: "tivdoc-synthetic-ready-reachability-guard-v0.5.0" as const,
    fixture_path: fixturePath,
    reference_paths: Object.freeze(references),
    forbidden_reference_paths: Object.freeze(forbiddenReferences),
    production_reachability_paths: Object.freeze(productionReachabilityPaths),
    test_fixture_production_reachable: productionReachabilityPaths.length > 0,
    passed: productionReachabilityPaths.length === 0,
  });
}
