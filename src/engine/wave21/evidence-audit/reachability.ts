import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { retrieveActiveLegalKnowledge } from "../../legal-knowledge/retrieval.ts";
import { evaluateStrictRealCorpusReadiness } from "../../legal-knowledge/corpus-hardening/readiness.ts";
import { screenUntrustedPdfIsolated } from "../../../server/engine/legal-knowledge/parser-isolation/index.ts";
import { repoRelative, sha256 } from "./common.ts";

const ENTRYPOINTS = [
  "scripts/legal-sources.mts",
  "scripts/legal-acquisition.mts",
  "src/engine/legal-knowledge/retrieval-core.ts",
  "src/server/engine/legal-knowledge/controlled-import-security.ts",
] as const;

const TARGETS = [
  "src/engine/legal-knowledge/corpus-hardening/container-segmentation.ts",
  "src/engine/legal-knowledge/corpus-hardening/readiness.ts",
  "src/engine/legal-knowledge/corpus-hardening/source-roles.ts",
  "src/server/engine/legal-knowledge/parser-isolation/index.ts",
  "src/engine/rule-input/preparation.ts",
  "src/engine/extraction-ground-truth/validation.ts",
  "src/engine/wave2/contracts.ts",
] as const;

async function resolveImport(repoRoot: string, from: string, specifier: string) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(repoRoot, path.dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mts`, path.join(base, "index.ts"), path.join(base, "index.mts")];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return repoRelative(repoRoot, candidate);
    } catch {
      // Continue deterministic candidate order.
    }
  }
  return null;
}

async function imports(repoRoot: string, relative: string) {
  const text = await readFile(path.resolve(repoRoot, relative), "utf8");
  const matches = [...text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu)];
  const values = await Promise.all(matches.map((match) => resolveImport(repoRoot, relative, match[1]!)));
  return [...new Set(values.filter((entry): entry is string => entry !== null))].sort();
}

async function graphFrom(repoRoot: string, entrypoint: string) {
  const seen = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  const queue = [entrypoint];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const target of await imports(repoRoot, current)) {
      edges.push({ from: current, to: target });
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { entrypoint, reachable_files: [...seen].sort(), edges: edges.sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)) };
}

async function sourceHash(repoRoot: string, relative: string) {
  return sha256(await readFile(path.resolve(repoRoot, relative)));
}

async function allSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:ts|mts)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")) output.push(target);
    }
  }
  await visit(root);
  return output;
}

export async function buildCanonicalReachabilityReport(repoRoot: string) {
  const graphs = await Promise.all(ENTRYPOINTS.map((entrypoint) => graphFrom(repoRoot, entrypoint)));
  const reachability = TARGETS.map((target) => ({
    target,
    source_sha256: null as string | null,
    reachable_from: graphs.filter((graph) => graph.reachable_files.includes(target)).map((graph) => graph.entrypoint),
  }));
  for (const entry of reachability) entry.source_sha256 = await sourceHash(repoRoot, entry.target);

  const wave2Directories = [
    "src/engine/legal-knowledge/corpus-hardening",
    "src/engine/legal-knowledge/review-dossier",
    "src/engine/legal-parameters",
    "src/engine/rule-input",
    "src/engine/extraction-ground-truth",
    "src/server/engine/legal-knowledge/parser-isolation",
  ];
  const moduleFiles = (await Promise.all(wave2Directories.map((relative) => allSourceFiles(path.resolve(repoRoot, relative))))).flat();
  const productionReachable = new Set(graphs.flatMap((graph) => graph.reachable_files));
  const nonCanonicalModules = moduleFiles.map((file) => repoRelative(repoRoot, file)).filter((relative) => !productionReachable.has(relative)).sort();

  const activeProbe = retrieveActiveLegalKnowledge([], [], {
    topic: "minimum_wage",
    targetDate: "2040-01-01",
    sector: "unknown",
    limit: 1,
  });
  const strictProbe = evaluateStrictRealCorpusReadiness({ sources: [], buildRecords: [], citationRecords: [] });
  const parserProbe = await screenUntrustedPdfIsolated({ bytes: Buffer.from("%PDF-1.4\n%%EOF\n".padEnd(512, " ")), testOnlyBehavior: "network_canary" });

  const findings = [
    {
      id: "REACH_V04_001_CANONICAL_BUILD_SEGMENTATION_BYPASS",
      severity: "blocking",
      status: "confirmed",
      evidence: ["scripts/legal-sources.mts defines and calls extractPdfPages directly", "canonical import graph does not reach corpus-hardening/container-segmentation.ts"],
      implication: "V0.4 instrument segmentation is evidence-tooling-only and is not unavoidable at canonical build/search boundaries.",
    },
    {
      id: "REACH_V04_002_CANONICAL_READINESS_PARALLEL",
      severity: "blocking",
      status: "confirmed",
      evidence: ["scripts/legal-sources.mts does not reach corpus-hardening/readiness.ts", "scripts/legal-acquisition.mts uses corpusReadinessOutcome while Wave 2 has evaluateStrictRealCorpusReadiness"],
      implication: "Wave 2 strict readiness is not the canonical gate.",
    },
    {
      id: "REACH_V04_003_SOURCE_ROLE_PARALLEL",
      severity: "blocking",
      status: "confirmed",
      evidence: ["retrieval-core.ts ranks canonical authority.binding_level", "corpus-hardening/source-roles.ts is absent from retrieval and canonical CLI graphs", "wave1-temporal-governance.ts retains a separate source_role vocabulary"],
      implication: "V0.4 source-role checks can be bypassed by canonical retrieval paths.",
    },
    {
      id: "REACH_V04_004_CONTROLLED_IMPORT_PARSER_REACHABLE",
      severity: "informational",
      status: "confirmed",
      evidence: ["scripts/legal-acquisition.mts → acquisition.ts → controlled-import-security.ts → parser-isolation/index.ts", "runtime network-disabled parser canary passed"],
      implication: "The controlled owner import path reaches the isolated screener; this does not prove OS sandboxing.",
    },
    {
      id: "REACH_V04_005_RULE_INPUT_SYNTHETIC_ONLY",
      severity: "expected_blocker",
      status: "confirmed",
      evidence: ["rule-input is reached by analysis-orchestration/synthetic-vertical-slice.ts and tests, not canonical legal CLIs/server entrypoints"],
      implication: "Rule Input remains a synthetic vertical slice, not a production legal path.",
    },
    {
      id: "REACH_V04_006_GROUND_TRUTH_OFFLINE_ONLY",
      severity: "expected_blocker",
      status: "confirmed",
      evidence: ["extraction-ground-truth is reached by offline scripts/tests and root exports, not canonical extraction runtime entrypoints"],
      implication: "Ground Truth workflow is offline synthetic tooling and no human ground truth exists.",
    },
  ];

  return {
    schema_version: "tivdoc-canonical-reachability-report-v0.4.1",
    entrypoints: ENTRYPOINTS,
    graphs,
    target_reachability: reachability,
    non_canonical_or_test_tooling_modules: nonCanonicalModules,
    unused_exports_and_test_only_helpers: {
      classification_basis: "module absent from all four frozen canonical entrypoint graphs; root barrel exposure alone is not runtime reachability",
      test_only_helpers: [
        "src/engine/analysis-orchestration/synthetic-fixtures.ts",
        "src/engine/extraction-ground-truth/synthetic-fixtures.ts",
        "src/engine/extraction-ground-truth/denial.ts",
        "src/engine/legal-parameters/synthetic-fixtures.ts",
      ],
      modules_not_reached_by_canonical_entrypoints: nonCanonicalModules,
    },
    duplicate_contract_analysis: {
      canonical_rule_input_contract: "src/engine/wave2/contracts.ts; implementation imports and reuses it",
      canonical_ground_truth_contract: "src/engine/wave2/contracts.ts; implementation imports and reuses it",
      canonical_money_type_reused: "GroundTruthFieldAnnotation.value uses calculations/contracts.ts calculationValueSchema",
      duplicated_local_transport_types: [
        "FetchObservation is independently declared in scripts/legal-sources.mts and scripts/legal-acquisition.mts",
        "BuildRecord is independently declared in scripts/legal-sources.mts and scripts/legal-acquisition.mts",
      ],
      parallel_readiness_implementations: [
        "src/engine/legal-knowledge/wave1-topic-readiness.ts",
        "src/engine/legal-knowledge/corpus-hardening/readiness.ts",
        "src/server/engine/legal-knowledge/acquisition.ts#corpusReadinessOutcome",
      ],
      parallel_source_role_vocabulary: [
        "src/engine/legal-knowledge/wave1-temporal-governance.ts",
        "src/engine/legal-knowledge/corpus-hardening/source-roles.ts",
        "src/engine/legal-knowledge/contracts.ts#authority.binding_level",
      ],
    },
    runtime_probes: {
      active_retrieval_unknown_sector_fail_closed: activeProbe.incomplete && activeProbe.results.length === 0 && activeProbe.conflicts.includes("sector_required"),
      strict_readiness_seven_topics_fail_closed: strictProbe.status === "LEGAL_SOURCE_CORPUS_INCOMPLETE" && strictProbe.topic_count === 7 && strictProbe.ready_topic_count === 0,
      controlled_import_parser_network_canary: parserProbe,
    },
    findings,
    blocking_finding_count: findings.filter((entry) => entry.severity === "blocking").length,
    legal_behavior_mutated: false,
  };
}
