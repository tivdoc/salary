import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "../../src/engine/rule-runtime/canonical.ts";
import { createCanonicalP3Fetcher, loadP3AcquisitionTargets, runBoundedP3Acquisition } from "../../src/server/engine/legal-knowledge/overnight-v07/acquisition.ts";
import { loadCurrentP3Corpus } from "../../src/server/engine/legal-knowledge/overnight-v07/corpus.ts";
import { verifyP3ReviewWorkspace, writeP3ReviewWorkspace } from "../../src/server/engine/legal-knowledge/overnight-v07/workspace.ts";

function flag(name: string, fallback: string) {
  const index = process.argv.indexOf(name);
  return path.resolve(index >= 0 ? process.argv[index + 1] : fallback);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown) {
  return `${canonicalStringify(value)}\n`;
}

async function assertAbsent(target: string) {
  try {
    await access(target);
    throw new Error(`P3_OUTPUT_ALREADY_EXISTS:${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const mode = process.argv[2] ?? "verify";
const repositoryRoot = flag("--repository-root", ".");
const corpusStateRoot = flag("--corpus-state-root", "C:/dev/tivdoc/salary");
const outputRoot = flag("--output", path.join(repositoryRoot, "output", "overnight-v0.7", "p3"));
const allowedOutputRoot = path.join(repositoryRoot, "output", "overnight-v0.7", "p3");
const outputRelative = path.relative(allowedOutputRoot, outputRoot);
if (outputRelative.startsWith("..") || path.isAbsolute(outputRelative)) throw new Error("P3_OUTPUT_OUTSIDE_IGNORED_LANE_ROOT");

async function acquisition() {
  const targets = await loadP3AcquisitionTargets({ repository_root: repositoryRoot, corpus_state_root: corpusStateRoot });
  const candidateRoot = path.join(outputRoot, "acquisition", "inactive-candidates");
  await mkdir(candidateRoot, { recursive: true });
  const report = await runBoundedP3Acquisition({ targets, candidate_root: candidateRoot, fetcher: createCanonicalP3Fetcher(), concurrency: 2 });
  const reportText = stableJson(report);
  const reportPath = path.join(outputRoot, "acquisition", "acquisition-report.json");
  await writeFile(reportPath, reportText, { flag: "wx", encoding: "utf8" });
  return { report, reportPath, artifactSha256: sha256(reportText) };
}

async function buildWorkspace(acquisitionReportSha256: string | null) {
  const corpus = await loadCurrentP3Corpus({ repository_root: repositoryRoot, corpus_state_root: corpusStateRoot });
  return writeP3ReviewWorkspace({ corpus, corpus_state_root: corpusStateRoot, output_root: path.join(outputRoot, "review-workspace"), acquisition_report_sha256: acquisitionReportSha256 });
}

async function verify() {
  const workspace = await verifyP3ReviewWorkspace(path.join(outputRoot, "review-workspace"));
  const acquisitionBytes = await readFile(path.join(outputRoot, "acquisition", "acquisition-report.json"));
  const acquisitionReport = JSON.parse(acquisitionBytes.toString("utf8")) as {
    totals: { selected_corpus_mutations: number; readiness_mutations: number; attempted: number };
    prohibited_actions: Record<string, number>;
    receipts: { attempts: number; status: string }[];
  };
  if (acquisitionReport.totals.attempted !== 25 || acquisitionReport.receipts.length !== 25 || acquisitionReport.receipts.some((receipt) => receipt.attempts !== 1)) throw new Error("P3_ACQUISITION_CARDINALITY_OR_RETRY_INVARIANT_FAILED");
  if (acquisitionReport.totals.selected_corpus_mutations !== 0 || acquisitionReport.totals.readiness_mutations !== 0 || Object.values(acquisitionReport.prohibited_actions).some((count) => count !== 0)) throw new Error("P3_ACQUISITION_ZERO_INVARIANT_FAILED");
  const corpus = await loadCurrentP3Corpus({ repository_root: repositoryRoot, corpus_state_root: corpusStateRoot });
  if (corpus.inventory.decisions.active_sources !== 0 || corpus.inventory.readiness.ready_topic_count !== 0 || corpus.inventory.selected_corpus_mutated) throw new Error("P3_REAL_CORPUS_FAIL_CLOSED_INVARIANT_FAILED");
  return Object.freeze({
    schema_version: "tivdoc-p3-verification-v0.7.0" as const,
    acceptance_ids: Object.freeze({ "V07-P3-CORPUS": true, "V07-P3-ACQUISITION": true, "V07-P3-REVIEW-WORKSPACE": true }),
    workspace,
    corpus_inventory_sha256: corpus.inventory.inventory_sha256,
    acquisition_report_sha256: sha256(acquisitionBytes),
    real_topics_ready: 0,
    real_sources_active: 0,
    real_parameters_active: 0,
    real_rules_active: 0,
    legal_calculations_or_findings: 0,
    selected_corpus_mutations: 0,
    customer_data_reads: 0,
    production_connections: 0,
    deployments: 0,
    openai_calls: 0,
  });
}

if (mode === "all") {
  await assertAbsent(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  const acquired = await acquisition();
  const workspace = await buildWorkspace(acquired.artifactSha256);
  const result = await verify();
  const resultText = stableJson({ ...result, review_workspace_manifest_sha256: workspace.manifest.manifest_sha256 });
  await writeFile(path.join(outputRoot, "verification-result.json"), resultText, { flag: "wx", encoding: "utf8" });
  console.log(resultText.trim());
} else if (mode === "reconcile") {
  const corpus = await loadCurrentP3Corpus({ repository_root: repositoryRoot, corpus_state_root: corpusStateRoot });
  console.log(stableJson(corpus.inventory).trim());
} else if (mode === "attempt-missing") {
  await assertAbsent(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  console.log(stableJson(await acquisition()).trim());
} else if (mode === "build-workspace") {
  await assertAbsent(path.join(outputRoot, "review-workspace"));
  await mkdir(outputRoot, { recursive: true });
  let acquisitionSha: string | null = null;
  try {
    acquisitionSha = sha256(await readFile(path.join(outputRoot, "acquisition", "acquisition-report.json")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(stableJson((await buildWorkspace(acquisitionSha)).manifest).trim());
} else if (mode === "verify") {
  console.log(stableJson(await verify()).trim());
} else {
  throw new Error(`P3_UNKNOWN_MODE:${mode}`);
}
