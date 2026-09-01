import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { PERSISTENCE_WIRING_SUMMARY } from "../../src/server/platform/persistence/wiring-map.ts";
import { offHostCustodyCapability } from "../../src/server/platform/custody/replication.ts";
import { detectLocalParserSandboxPlatform, localParserSandboxCapability } from "../../src/server/platform/security/parser-sandbox.ts";
import {
  ENTRYPOINT_DISPOSITION_LEDGER,
  validateEntrypointDispositionLedger,
} from "../../src/server/system-marathon/entrypoint-disposition-ledger.v0.10.2.ts";
import { trustedGitText } from "../canonical-persistence-v091/foundation/trusted-git.mts";

const ROOT = path.resolve(process.cwd());
const OUTPUT = resolveOutput(process.argv.slice(2));
const STRIP_TYPES = Object.freeze(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"]);
const REACHABILITY_GRAPH = path.join(
  ROOT, "output", "product-integration-v0.8.0", "reachability", "source-import-graph.json",
);
const DURABLE_ROOT = "src/server/product/runtime/durable-local-runtime.ts";
const INSTRUMENTATION_ROOT = "src/instrumentation.ts";
const GOVERNANCE_ROUTE = "src/server/product/internal-ops/durable-governance/application.ts";
const GOVERNANCE_FACTORY = "src/server/platform/persistence/postgres/governance/application.ts";
const GOVERNANCE_REPOSITORIES = "src/server/platform/persistence/postgres/governance/repositories.ts";
const HERMETIC_COORDINATOR = "src/server/product/runtime/durable-synthetic-report-pipeline.ts";

type GraphNode = Readonly<{
  path: string;
  kind: "product_entrypoint" | "legacy_entrypoint" | "evidence_entrypoint" | "test" | "module";
}>;
type GraphEdge = Readonly<{ from: string; specifier: string; to: string | null; external: boolean }>;
type ReachabilityGraph = Readonly<{
  schema_version: string;
  generated_from_head: string;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
}>;
type SourceProof = Readonly<{ path: string; sha256: string; byte_count: number }>;
type GovernanceReplacementSpec = Readonly<{
  replacement_id: string;
  legacy_path: string;
  legacy_symbols: readonly string[];
  legacy_state_patterns: readonly RegExp[];
  durable_symbols: readonly string[];
}>;

const GOVERNANCE_REPLACEMENTS: readonly GovernanceReplacementSpec[] = Object.freeze([
  Object.freeze({
    replacement_id: "reviewer_trust_store",
    legacy_path: "src/server/platform/trust/reviewer-trust-store.ts",
    legacy_symbols: Object.freeze(["InMemoryReviewerTrustStore"]),
    legacy_state_patterns: Object.freeze([/#organizations\s*=\s*new Map/u, /#keys\s*=\s*new Map/u]),
    durable_symbols: Object.freeze(["PostgresReviewerTrustRepository"]),
  }),
  Object.freeze({
    replacement_id: "append_only_legal_operations_store",
    legacy_path: "src/engine/legal-operations/state-machine.ts",
    legacy_symbols: Object.freeze(["AppendOnlyLegalOperationsStore"]),
    legacy_state_patterns: Object.freeze([/#records\s*=\s*new Map/u, /#goldenCaseHashes\s*=\s*new Map/u]),
    durable_symbols: Object.freeze([
      "PostgresLegalReconciliationRepository",
      "PostgresParameterApprovalRepository",
      "PostgresRuleSpecApprovalRepository",
    ]),
  }),
  Object.freeze({
    replacement_id: "legal_operations_service_trusted_and_golden_maps",
    legacy_path: "src/server/engine/legal-operations/service.ts",
    legacy_symbols: Object.freeze(["LegalOperationsApplicationService"]),
    legacy_state_patterns: Object.freeze([
      /#goldenCases\s*=\s*new Map/u,
      /#goldenIdempotency\s*=\s*new Map/u,
      /#trustedDecisions\s*=\s*new Map/u,
      /#verifiedEnvelopes\s*=\s*new Map/u,
    ]),
    durable_symbols: Object.freeze([
      "PostgresLegalReconciliationRepository",
      "PostgresRuleSpecApprovalRepository",
    ]),
  }),
  Object.freeze({
    replacement_id: "trusted_ground_truth_workflow",
    legacy_path: "src/engine/extraction-ground-truth/trusted-workflow.ts",
    legacy_symbols: Object.freeze(["TrustedGroundTruthWorkflow"]),
    legacy_state_patterns: Object.freeze([/#eligibility\s*=\s*new Map/u, /#manifests\s*=\s*new Map/u]),
    durable_symbols: Object.freeze(["PostgresGroundTruthRepository"]),
  }),
]);

const GOVERNANCE_REPOSITORY_SYMBOLS = Object.freeze([
  "PostgresReviewerTrustRepository",
  "PostgresGovernanceWorkRepository",
  "PostgresGroundTruthRepository",
  "PostgresLegalReconciliationRepository",
  "PostgresParameterApprovalRepository",
  "PostgresRuleSpecApprovalRepository",
] as const);
const EXPLICIT_MEMORY_FALLBACK_SYMBOLS = Object.freeze([
  "InMemoryReviewerTrustStore",
  "AppendOnlyLegalOperationsStore",
  "LegalOperationsApplicationService",
  "TrustedGroundTruthWorkflow",
  "InMemoryCaseAnalysisRepository",
  "InMemoryCaseOperationsService",
  "InMemoryCaseReviewService",
  "InMemoryVerifiedPaymentEvidenceStore",
  "InMemoryHashChainAudit",
  "InMemoryStoredSnapshotPort",
  "FixtureCaseReviewPort",
  "StrictRecordingPostgresDriver",
] as const);
const FORBIDDEN_SYNTHETIC_RUNTIME_PATHS = Object.freeze([
  "src/server/product/integration/browser-runtime.ts",
  "src/server/product/integration/dependency-seams.ts",
  "src/server/product/integration/ready-integration.ts",
  "src/server/product/internal-ops/synthetic-test-fixture.ts",
  "src/server/platform/persistence/postgres/runtime/recording-driver.ts",
] as const);

const head = trustedGitText(ROOT, ["rev-parse", "HEAD"]);
const tree = trustedGitText(ROOT, ["rev-parse", "HEAD^{tree}"]);
const reachability = runNode("scripts/product-integration/reachability/verify.mts");
const wiring = runNode("scripts/product-integration/persistence/wiring-map.mts", [
  "--output-root", path.join(OUTPUT, "wiring"),
]);
const prohibited = runNode("scripts/full-local-system-marathon/security-scan.mts");
const supabase = runNode("scripts/platform/supabase/detect.mts");
const parserDetection = detectLocalParserSandboxPlatform();
const parser = localParserSandboxCapability(parserDetection);
const custody = offHostCustodyCapability();
const dispositionIssues = validateEntrypointDispositionLedger();
const auditIssues: string[] = [];

const graphProof = await loadReachabilityGraph(reachability.receipt, head, auditIssues);
const graph = graphProof.graph;
const sources = new Map<string, Readonly<{ content: string; proof: SourceProof }>>();
for (const file of new Set([
  INSTRUMENTATION_ROOT,
  DURABLE_ROOT,
  GOVERNANCE_ROUTE,
  GOVERNANCE_FACTORY,
  GOVERNANCE_REPOSITORIES,
  HERMETIC_COORDINATOR,
  "src/server/product/runtime/durable-local-config.ts",
  ...GOVERNANCE_REPLACEMENTS.map((row) => row.legacy_path),
])) {
  const content = await readFile(path.join(ROOT, ...file.split("/")), "utf8");
  sources.set(file, Object.freeze({
    content,
    proof: Object.freeze({ path: file, sha256: sha256(content), byte_count: Buffer.byteLength(content) }),
  }));
}

const stableRoots = graph?.nodes.filter((node) => node.kind === "product_entrypoint").map((node) => node.path) ?? [];
const productRoots = Object.freeze([...new Set([...stableRoots, DURABLE_ROOT])].sort(compare));
const fullProductReachable = graph ? reachable(productRoots, graph.edges) : new Set<string>();
const ordinaryProductReachable = graph
  ? reachable(productRoots, graph.edges, new Set([HERMETIC_COORDINATOR]))
  : new Set<string>();
const bootstrapProof = deriveBootstrapProof(graph, sources, fullProductReachable);
if (bootstrapProof.status !== "PASS") auditIssues.push("DURABLE_PRODUCT_BOOTSTRAP_COMPOSITION_PROOF_MISSING");

const governanceReplacementRows = GOVERNANCE_REPLACEMENTS.map((spec) => {
  const legacy = requiredSource(sources, spec.legacy_path);
  const repositories = requiredSource(sources, GOVERNANCE_REPOSITORIES);
  const factory = requiredSource(sources, GOVERNANCE_FACTORY);
  const route = requiredSource(sources, GOVERNANCE_ROUTE);
  const runtime = requiredSource(sources, DURABLE_ROOT);
  const legacySymbolDeclarations = spec.legacy_symbols.map((symbol) => ({
    symbol,
    declared: declaration(legacy.content, symbol),
  }));
  const legacyStateProof = spec.legacy_state_patterns.map((pattern) => pattern.test(legacy.content));
  const durableSymbolProof = spec.durable_symbols.map((symbol) => Object.freeze({
    symbol,
    declared: declaration(repositories.content, symbol),
    constructed_in_governance_factory: new RegExp(`\\bnew\\s+${escapeRegExp(symbol)}\\s*\\(`, "u").test(factory.content)
      || new RegExp(`\\bnew\\s+${escapeRegExp(symbol)}\\s*\\(`, "u").test(repositories.content),
  }));
  const legacyProductReachable = ordinaryProductReachable.has(spec.legacy_path);
  const routeTransactionScoped = route.content.includes("this.#context.session_context.transaction({")
    && route.content.includes("createDurableGovernanceApplication(bundle.context, tenantId)")
    && route.content.includes("application.transaction_id !== bundle.context.transaction_id");
  const durableCompositionReachable = ordinaryProductReachable.has(GOVERNANCE_ROUTE)
    && ordinaryProductReachable.has(GOVERNANCE_FACTORY)
    && ordinaryProductReachable.has(GOVERNANCE_REPOSITORIES)
    && runtime.content.includes("createDurableGovernanceOperationsRouteAdapter({ context, base })")
    && routeTransactionScoped;
  const wired = legacySymbolDeclarations.every((item) => item.declared)
    && legacyStateProof.every(Boolean)
    && durableSymbolProof.every((item) => item.declared && item.constructed_in_governance_factory)
    && !legacyProductReachable
    && durableCompositionReachable;
  return Object.freeze({
    replacement_id: spec.replacement_id,
    status: wired ? "PASS" as const : "FAIL" as const,
    legacy: Object.freeze({
      source: legacy.proof,
      symbols: Object.freeze(legacySymbolDeclarations),
      process_local_state_patterns_proven: legacyStateProof.filter(Boolean).length,
      process_local_state_pattern_count: legacyStateProof.length,
      product_reachable: legacyProductReachable,
    }),
    durable: Object.freeze({
      symbols: Object.freeze(durableSymbolProof),
      repository_source: repositories.proof,
      factory_source: factory.proof,
      route_source: route.proof,
      runtime_source: runtime.proof,
      transaction_scoped: routeTransactionScoped,
      product_reachable: durableCompositionReachable,
      import_chain: graph ? importPath(DURABLE_ROOT, GOVERNANCE_REPOSITORIES, graph.edges) : [],
    }),
  });
});
for (const row of governanceReplacementRows) {
  if (row.status !== "PASS") auditIssues.push(`GOVERNANCE_REPLACEMENT_PROOF_FAILED:${row.replacement_id}`);
}

const processLocalReferenceFindings = governanceReplacementRows.filter((row) => row.legacy.product_reachable)
  .map((row) => Object.freeze({
    replacement_id: row.replacement_id,
    path: row.legacy.source.path,
    symbols: row.legacy.symbols.map((item) => item.symbol),
    reason: "PROCESS_LOCAL_GOVERNANCE_IMPLEMENTATION_REACHABLE_FROM_PRODUCT_ROOT",
  }));

const repositoryConstructionSites = graph
  ? await scanRepositoryConstructionSites(ordinaryProductReachable)
  : [];
if (repositoryConstructionSites.length === 0) {
  auditIssues.push("GOVERNANCE_REPOSITORY_CONSTRUCTION_PROOF_MISSING");
}
const directRepositoryConstructionFindings = repositoryConstructionSites.filter((site) => !site.allowed_composition_site);
if (directRepositoryConstructionFindings.length > 0) {
  auditIssues.push("DIRECT_GOVERNANCE_REPOSITORY_CONSTRUCTION_OUTSIDE_COMPOSITION");
}

const memoryFallbackFindings = graph ? await scanDeclaredSymbols(
  ordinaryProductReachable,
  EXPLICIT_MEMORY_FALLBACK_SYMBOLS,
  "PRODUCT_REACHABLE_PROCESS_LOCAL_OR_RECORDING_IMPLEMENTATION",
) : [];
if (memoryFallbackFindings.length > 0) auditIssues.push("PRODUCT_REACHABLE_MEMORY_FALLBACK_FOUND");

const hermeticCoordinatorProof = deriveHermeticCoordinatorProof(
  prohibited.receipt,
  requiredSource(sources, HERMETIC_COORDINATOR),
  requiredSource(sources, "src/server/product/runtime/durable-local-config.ts"),
  fullProductReachable,
  ordinaryProductReachable,
  graph,
);
const syntheticRuntimeFindings: Array<Readonly<{ path: string; reason: string }>> = FORBIDDEN_SYNTHETIC_RUNTIME_PATHS
  .filter((file) => ordinaryProductReachable.has(file))
  .map((file) => Object.freeze({ path: file, reason: "FORBIDDEN_SYNTHETIC_OR_RECORDING_RUNTIME_PRODUCT_REACHABLE" }));
if (hermeticCoordinatorProof.status !== "PASS") {
  syntheticRuntimeFindings.push(Object.freeze({
    path: HERMETIC_COORDINATOR,
    reason: "HERMETIC_SYNTHETIC_COORDINATOR_EXCEPTION_NOT_PROVEN",
  }));
  auditIssues.push("HERMETIC_SYNTHETIC_COORDINATOR_PROOF_FAILED");
}
if (syntheticRuntimeFindings.length > 0) auditIssues.push("SYNTHETIC_RUNTIME_PRODUCT_LEAK_FOUND");

const partialOrUnwiredRows = ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.product_stable
  && ![
    "CANONICALLY_WIRED",
    "CAPABILITY_GATED_CANONICAL_SOURCE",
    "EXTERNAL_OR_HUMAN_BLOCKED_LOCAL_FAIL_CLOSED",
  ].includes(row.current_status));
const dispositionPassed = dispositionIssues.length === 0
  && ENTRYPOINT_DISPOSITION_LEDGER.denominator === ENTRYPOINT_DISPOSITION_LEDGER.rows.length
  && ENTRYPOINT_DISPOSITION_LEDGER.product_stable_denominator
    === ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.product_stable).length
  && partialOrUnwiredRows.length === 0;
if (!dispositionPassed) auditIssues.push("ENTRYPOINT_DISPOSITION_PROOF_FAILED");

const reachabilityPassed = reachability.status === 0 && reachability.receipt?.pass === true
  && graphProof.status === "PASS";
const wiringPassed = wiring.status === 0
  && wiring.receipt?.generator_status === "PASS_WIRING_MAP_GENERATED"
  && PERSISTENCE_WIRING_SUMMARY.unknown_count === 0
  && PERSISTENCE_WIRING_SUMMARY.duplicate_canonical_contract_count === 0
  && PERSISTENCE_WIRING_SUMMARY.non_test_memory_fallback_count === memoryFallbackFindings.length;
const prohibitedPassed = prohibited.status === 0 && prohibited.receipt?.status === "PASS";
if (!reachabilityPassed) auditIssues.push("CANONICAL_REACHABILITY_PROOF_FAILED");
if (!wiringPassed) auditIssues.push("PERSISTENCE_WIRING_PROOF_FAILED");
if (!prohibitedPassed) auditIssues.push("PROHIBITED_OPERATION_AUDIT_FAILED");

const externalGates = Object.freeze({
  schema_version: "tivdoc-runtime-product-closure-external-gates-v0.10.2",
  status: "BLOCKED" as const,
  verified_head: head,
  verified_tree: tree,
  detector_run_count: 1,
  detectors_are_read_only: true,
  gates: Object.freeze([
    Object.freeze({
      mc_id: "MC-03",
      ir_id: "IR-22",
      status: "BLOCKED" as const,
      reason_codes: Object.freeze([
        "ISOLATED_SUPABASE_PLATFORM_PROOF_BLOCKED",
        ...(Array.isArray(supabase.receipt?.reason_codes) ? supabase.receipt.reason_codes.map(String) : []),
      ]),
      detector_receipt: supabase.receipt,
      isolated_platform_proof_performed: false,
      plain_postgresql_substitution_allowed: false,
      external_mutations: 0,
    }),
    Object.freeze({
      mc_id: "MC-10",
      ir_id: "IR-23",
      status: "BLOCKED" as const,
      reason_codes: Object.freeze([
        "PARSER_OS_SANDBOX_NOT_VERIFIED",
        parserDetection.blocker_reason,
      ]),
      detector_receipt: parserDetection,
      capability: parser,
      persistent_owner_import_enabled: false,
      external_mutations: 0,
    }),
    Object.freeze({
      mc_id: "MC-27",
      ir_id: "IR-24",
      status: "BLOCKED" as const,
      reason_codes: custody.blocker_codes,
      detector_receipt: custody,
      off_host_transfer_performed: false,
      external_mutations: 0,
    }),
  ]),
  managed_identity_provider_verified: false,
  managed_private_storage_verified: false,
  deployments: 0,
  remote_migrations: 0,
  live_provider_calls: 0,
  openai_calls: 0,
});

const currentHead = trustedGitText(ROOT, ["rev-parse", "HEAD"]);
const currentTree = trustedGitText(ROOT, ["rev-parse", "HEAD^{tree}"]);
const status = auditIssues.length === 0 && supabase.status === 0
  && currentHead === head && currentTree === tree ? "PASS" as const : "FAIL" as const;
const receipt = Object.freeze({
  schema_version: "tivdoc-runtime-product-reachability-wiring-capability-audit-v0.10.2",
  status,
  verified_head: head,
  verified_tree: tree,
  head_tree_stable: currentHead === head && currentTree === tree,
  audit_issues: Object.freeze([...new Set(auditIssues)].sort(compare)),
  reachability: reachability.receipt,
  reachability_graph_proof: graphProof.receipt,
  composition_bootstrap_proof: bootstrapProof,
  persistence_wiring: wiring.receipt,
  prohibited_operation_audit: prohibited.receipt,
  entrypoint_disposition: Object.freeze({
    denominator: ENTRYPOINT_DISPOSITION_LEDGER.rows.length,
    product_stable_denominator: ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.product_stable).length,
    before: ENTRYPOINT_DISPOSITION_LEDGER.before_counts,
    after_product_stable_partial_or_unwired: partialOrUnwiredRows.length,
    app_routes: ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.kind === "app_route").length,
    api_routes: ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.kind === "api_route").length,
    application_services: ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.kind === "application_service").length,
    durable_workers: ENTRYPOINT_DISPOSITION_LEDGER.rows.filter((row) => row.kind === "durable_worker").length,
    issues: dispositionIssues,
  }),
  governance_replacement_rows: Object.freeze(governanceReplacementRows),
  repository_construction_sites: Object.freeze(repositoryConstructionSites),
  direct_repository_construction_findings: Object.freeze(directRepositoryConstructionFindings),
  memory_fallback_findings: Object.freeze(memoryFallbackFindings),
  hermetic_synthetic_coordinator_proof: hermeticCoordinatorProof,
  synthetic_runtime_findings: Object.freeze(syntheticRuntimeFindings),
  runtime_product_counters: Object.freeze({
    process_local_product_repositories: processLocalReferenceFindings.length,
    durable_governance_replacements_wired: governanceReplacementRows.filter((row) => row.status === "PASS").length,
    durable_governance_replacement_denominator: governanceReplacementRows.length,
    partial_or_unwired_product_stable_entrypoints: partialOrUnwiredRows.length,
    product_reachable_memory_fallbacks: memoryFallbackFindings.length,
    direct_repository_construction_outside_composition: directRepositoryConstructionFindings.length,
    duplicate_canonical_contracts: PERSISTENCE_WIRING_SUMMARY.duplicate_canonical_contract_count,
    synthetic_runtime_product_leaks: syntheticRuntimeFindings.length,
  }),
  process_local_reference_findings: Object.freeze(processLocalReferenceFindings),
  external_gates_file: "external-gates.json",
  truth_counters: Object.freeze({
    customer_data_reads: 0,
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
    real_activations: 0,
    manufactured_human_evidence: 0,
  }),
});

await mkdir(OUTPUT, { recursive: true });
await Promise.all([
  writeFile(path.join(OUTPUT, "reachability-wiring-capability-audit.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  }),
  writeFile(path.join(OUTPUT, "external-gates.json"), `${JSON.stringify(externalGates, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  }),
]);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type ChildReceipt = Readonly<{ status: number; receipt: Record<string, unknown> | null }>;

function runNode(script: string, args: readonly string[] = []): ChildReceipt {
  const result = spawnSync(process.execPath, [...STRIP_TYPES, path.join(ROOT, ...script.split("/")), ...args], {
    cwd: ROOT,
    env: safeEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return Object.freeze({ status: result.status ?? 1, receipt: jsonReceipt(stdout) });
}

async function loadReachabilityGraph(
  manifest: Record<string, unknown> | null,
  expectedHead: string,
  issues: string[],
): Promise<Readonly<{
  status: "PASS" | "FAIL";
  graph: ReachabilityGraph | null;
  receipt: Readonly<Record<string, unknown>>;
}>> {
  try {
    const bytes = await readFile(REACHABILITY_GRAPH);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || parsed.schema_version !== "tivdoc-canonical-reachability-v0.8.0"
        || parsed.generated_from_head !== expectedHead || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)
        || manifest?.payload_sha256 !== sha256(bytes)) {
      throw new Error("REACHABILITY_GRAPH_IDENTITY_INVALID");
    }
    const nodes = parsed.nodes.map((value) => graphNode(value));
    const edges = parsed.edges.map((value) => graphEdge(value));
    const graph: ReachabilityGraph = Object.freeze({
      schema_version: String(parsed.schema_version),
      generated_from_head: String(parsed.generated_from_head),
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
    });
    return Object.freeze({
      status: "PASS" as const,
      graph,
      receipt: Object.freeze({
        status: "PASS",
        path: "output/product-integration-v0.8.0/reachability/source-import-graph.json",
        sha256: sha256(bytes),
        byte_count: bytes.byteLength,
        node_count: nodes.length,
        edge_count: edges.length,
      }),
    });
  } catch (error) {
    issues.push("REACHABILITY_GRAPH_PROOF_MISSING");
    return Object.freeze({
      status: "FAIL" as const,
      graph: null,
      receipt: Object.freeze({ status: "FAIL", reason: safeError(error) }),
    });
  }
}

function deriveBootstrapProof(
  graph: ReachabilityGraph | null,
  sourceMap: ReadonlyMap<string, Readonly<{ content: string; proof: SourceProof }>>,
  fullReachable: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  const instrumentation = requiredSource(sourceMap, INSTRUMENTATION_ROOT);
  const runtime = requiredSource(sourceMap, DURABLE_ROOT);
  const edge = graph?.edges.some((candidate) => candidate.from === INSTRUMENTATION_ROOT
    && candidate.to === DURABLE_ROOT) === true;
  const guardedDynamicImport = instrumentation.content.includes("if (durableRequested) {")
    && instrumentation.content.includes('"./server/product/runtime/durable-local-runtime"')
    && instrumentation.content.includes("await initializeDurableLocalProductRuntime();")
    && instrumentation.content.includes("PRODUCT_RUNTIME_BOOTSTRAP_MODE_CONFLICT");
  const failClosedRuntime = runtime.content.includes("readDurableLocalProductRuntimeConfig()")
    && runtime.content.includes("startCanonicalApplicationPostgres({")
    && runtime.content.includes("createDurableGovernanceOperationsRouteAdapter({ context, base })")
    && runtime.content.includes("installCanonicalProductApplicationComposition(");
  const status = edge && guardedDynamicImport && failClosedRuntime && fullReachable.has(DURABLE_ROOT)
    ? "PASS" as const : "FAIL" as const;
  return Object.freeze({
    status,
    instrumentation: instrumentation.proof,
    runtime: runtime.proof,
    dynamic_import_edge_present: edge,
    guarded_dynamic_import: guardedDynamicImport,
    durable_fail_closed_composition: failClosedRuntime,
    durable_root_reachable: fullReachable.has(DURABLE_ROOT),
  });
}

function deriveHermeticCoordinatorProof(
  securityReceipt: Record<string, unknown> | null,
  coordinator: Readonly<{ content: string; proof: SourceProof }>,
  config: Readonly<{ content: string; proof: SourceProof }>,
  fullReachable: ReadonlySet<string>,
  ordinaryReachable: ReadonlySet<string>,
  graph: ReachabilityGraph | null,
): Readonly<Record<string, unknown>> {
  const fixtureImports = graph?.edges.filter((edge) => edge.from === HERMETIC_COORDINATOR && edge.to !== null
    && /(?:synthetic-fixtures|fixture-ports)\.ts$/u.test(edge.to)).map((edge) => edge.to!).sort(compare) ?? [];
  const sourceFailClosed = coordinator.content.includes("ordinary_runtime_reachable: false")
    && coordinator.content.includes("real_legal_activations: 0")
    && coordinator.content.includes("product_reachable_memory_repositories: 0")
    && coordinator.content.includes('import "../routes/server-boundary.ts"');
  const localOnlyGate = config.content.includes("DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN")
    && config.content.includes('environment.TIVDOC_RUNTIME_TARGET !== "local_only"')
    && config.content.includes('environment.TIVDOC_OPENAI_LIVE_TESTS !== "0"');
  const securityAuthorized = securityReceipt?.hermetic_coordinator_fail_closed_proof === true
    && securityReceipt?.authorized_hermetic_fixture_import_count === fixtureImports.length;
  const status = sourceFailClosed && localOnlyGate && securityAuthorized && fullReachable.has(HERMETIC_COORDINATOR)
    && !ordinaryReachable.has(HERMETIC_COORDINATOR) && fixtureImports.length > 0 ? "PASS" as const : "FAIL" as const;
  return Object.freeze({
    status,
    coordinator_source: coordinator.proof,
    config_source: config.proof,
    full_local_proof_lane_reachable: fullReachable.has(HERMETIC_COORDINATOR),
    ordinary_runtime_graph_excluded: !ordinaryReachable.has(HERMETIC_COORDINATOR),
    fixture_imports: Object.freeze(fixtureImports),
    fixture_import_count: fixtureImports.length,
    source_fail_closed_proof: sourceFailClosed,
    local_only_gate_proof: localOnlyGate,
    security_audit_authorized_exact_import_count: securityAuthorized,
  });
}

async function scanRepositoryConstructionSites(reachableFiles: ReadonlySet<string>): Promise<readonly Readonly<{
  path: string;
  line: number;
  symbol: string;
  allowed_composition_site: boolean;
  source_sha256: string;
}>[]> {
  const symbols = [...GOVERNANCE_REPOSITORY_SYMBOLS, ...GOVERNANCE_REPLACEMENTS.flatMap((row) => row.legacy_symbols)];
  const pattern = new RegExp(`\\bnew\\s+(${symbols.map(escapeRegExp).join("|")})\\s*\\(`, "gu");
  const sites: Array<Readonly<{
    path: string; line: number; symbol: string; allowed_composition_site: boolean; source_sha256: string;
  }>> = [];
  for (const file of [...reachableFiles].sort(compare)) {
    if (!file.startsWith("src/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) continue;
    const content = await readFile(path.join(ROOT, ...file.split("/")), "utf8");
    for (const match of content.matchAll(pattern)) {
      const symbol = match[1]!;
      const allowed = (file === GOVERNANCE_FACTORY && GOVERNANCE_REPOSITORY_SYMBOLS.includes(
        symbol as (typeof GOVERNANCE_REPOSITORY_SYMBOLS)[number],
      )) || (file === GOVERNANCE_REPOSITORIES && symbol === "PostgresReviewerTrustRepository");
      sites.push(Object.freeze({
        path: file,
        line: lineNumber(content, match.index),
        symbol,
        allowed_composition_site: allowed,
        source_sha256: sha256(content),
      }));
    }
  }
  return Object.freeze(sites.sort((left, right) => left.path.localeCompare(right.path)
    || left.line - right.line || left.symbol.localeCompare(right.symbol)));
}

async function scanDeclaredSymbols(
  reachableFiles: ReadonlySet<string>,
  symbols: readonly string[],
  reason: string,
): Promise<readonly Readonly<{ path: string; symbol: string; line: number; reason: string; source_sha256: string }>[]> {
  const findings: Array<Readonly<{
    path: string; symbol: string; line: number; reason: string; source_sha256: string;
  }>> = [];
  for (const file of [...reachableFiles].sort(compare)) {
    if (!file.startsWith("src/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)) continue;
    const content = await readFile(path.join(ROOT, ...file.split("/")), "utf8");
    for (const symbol of symbols) {
      const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(symbol)}\\b`, "u");
      const match = pattern.exec(content);
      if (match) findings.push(Object.freeze({
        path: file,
        symbol,
        line: lineNumber(content, match.index),
        reason,
        source_sha256: sha256(content),
      }));
    }
  }
  return Object.freeze(findings);
}

function reachable(
  roots: readonly string[],
  edges: readonly GraphEdge[],
  excluded: ReadonlySet<string> = new Set(),
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.to || excluded.has(edge.to)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const visited = new Set<string>();
  const queue = roots.filter((root) => !excluded.has(root));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) if (!visited.has(next)) queue.push(next);
  }
  return visited;
}

function importPath(from: string, to: string, edges: readonly GraphEdge[]): readonly string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) if (edge.to) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const queue: string[][] = [[from]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const tail = current.at(-1)!;
    if (tail === to) return Object.freeze(current);
    if (visited.has(tail)) continue;
    visited.add(tail);
    for (const next of adjacency.get(tail) ?? []) if (!visited.has(next)) queue.push([...current, next]);
  }
  return Object.freeze([]);
}

function graphNode(value: unknown): GraphNode {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.kind !== "string"
      || !["product_entrypoint", "legacy_entrypoint", "evidence_entrypoint", "test", "module"].includes(value.kind)) {
    throw new Error("REACHABILITY_GRAPH_NODE_INVALID");
  }
  return Object.freeze({ path: value.path, kind: value.kind as GraphNode["kind"] });
}

function graphEdge(value: unknown): GraphEdge {
  if (!isRecord(value) || typeof value.from !== "string" || typeof value.specifier !== "string"
      || (value.to !== null && typeof value.to !== "string") || typeof value.external !== "boolean") {
    throw new Error("REACHABILITY_GRAPH_EDGE_INVALID");
  }
  return Object.freeze({ from: value.from, specifier: value.specifier, to: value.to as string | null,
    external: value.external });
}

function requiredSource(
  sources: ReadonlyMap<string, Readonly<{ content: string; proof: SourceProof }>>,
  file: string,
): Readonly<{ content: string; proof: SourceProof }> {
  const value = sources.get(file);
  if (!value) throw new Error(`RUNTIME_PRODUCT_AUDIT_SOURCE_MISSING:${file}`);
  return value;
}

function declaration(source: string, symbol: string): boolean {
  return new RegExp(`\\b(?:class|function|const)\\s+${escapeRegExp(symbol)}\\b`, "u").test(source);
}

function jsonReceipt(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    for (const line of trimmed.split(/\r?\n/u).reverse()) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Non-JSON diagnostic lines are not receipts.
      }
    }
    return null;
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ",
    "USERPROFILE", "windir",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    CI: "1",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

function resolveOutput(args: readonly string[]): string {
  const index = args.indexOf("--output-root");
  if (index < 0) return path.join(ROOT, "output", "runtime-product-closure-v0.10.2", "working");
  const value = args[index + 1];
  if (!value) throw new Error("V0102_AUDIT_OUTPUT_ROOT_REQUIRED");
  return path.resolve(ROOT, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lineNumber(source: string, index: number | undefined): number {
  if (index === undefined) return 0;
  return source.slice(0, index).split("\n").length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeError(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_:.-]+$/u.test(error.message)
    ? error.message : "RUNTIME_PRODUCT_AUDIT_PROOF_ERROR";
}
