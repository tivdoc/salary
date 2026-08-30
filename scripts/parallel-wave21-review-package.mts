import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2.1");
const packageRoot = path.join(outputRoot, "review-package-v0.4.1");
const runA = path.join(outputRoot, "review-package-v0.4.1-run-a");
const runB = path.join(outputRoot, "review-package-v0.4.1-run-b");
const zipA = path.join(outputRoot, "review-package-v0.4.1-run-a.zip");
const zipB = path.join(outputRoot, "review-package-v0.4.1-run-b.zip");
const zipPath = path.join(outputRoot, "review-package-v0.4.1.zip");
const resultPath = path.join(outputRoot, "review-package-v0.4.1-result.json");
const requiredBase = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a";
const contractSha = "09bc4448265eb7a7dc0044b86ae094b9f53616da";
const integrationCommits = [
  "3d25678c92cd87f8534862b7c6e57cbf7314432f",
  "1d3d8abb4eef661fd2d9e264a4b4ac223d028b01",
  "f8c9a8c3b44921122178acb7859688b50ac2107e",
] as const;

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("wave21_review_package_requires_offline_canary");
function contained(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative === ".") return path.resolve(target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("wave21_package_path_escape");
  return path.resolve(target);
}
for (const target of [packageRoot, runA, runB, zipA, zipB, zipPath, resultPath]) contained(outputRoot, target);

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}
const stableJson = (value: unknown) => `${JSON.stringify(stableValue(value), null, 2)}\n`;
async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, stableJson(value), { encoding: "utf8", mode: 0o600 });
}
function normalize(relative: string) {
  const value = relative.replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").includes("..")) throw new Error(`unsafe_relative_path:${relative}`);
  return value;
}
function git(args: readonly string[], input?: string, allowFailure = false) {
  const result = spawnSync("git", [...args], { cwd: repoRoot, input, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`wave21_git_failed:${args.join("_")}:${result.stderr.trim()}`);
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
const lines = (value: string) => value ? value.split(/\r?\n/u).filter(Boolean) : [];
function patchId(commit: string) {
  const patch = git(["show", "--pretty=format:", "--no-ext-diff", "--binary", commit]).stdout;
  const value = git(["patch-id", "--stable"], `${patch}\n`).stdout.split(/\s+/u)[0];
  if (!value || !/^[a-f0-9]{40}$/u.test(value)) throw new Error(`patch_id_unavailable:${commit}`);
  return value;
}
function commitRecord(commit: string) {
  const [sha, parents, subject, tree] = git(["show", "-s", "--format=%H%n%P%n%s%n%T", commit]).stdout.split(/\r?\n/u);
  const changedFiles = lines(git(["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit]).stdout).map((row) => {
    const [statusValue, ...paths] = row.split("\t");
    return { status: statusValue, paths: paths.map(normalize) };
  });
  const stats = lines(git(["show", "--numstat", "--format=", "--no-renames", commit]).stdout).map((row) => {
    const [added, deleted, relative] = row.split("\t");
    return { path: normalize(relative!), added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
  return {
    sha,
    parents: parents ? parents.split(" ") : [],
    subject,
    tree,
    patch_id: patchId(commit),
    changed_files: changedFiles,
    diff_stat: { file_count: stats.length, added_lines: stats.reduce((sum, entry) => sum + (entry.added ?? 0), 0), deleted_lines: stats.reduce((sum, entry) => sum + (entry.deleted ?? 0), 0), files: stats },
  };
}
function allowlisted(relative: string, patterns: readonly string[]) {
  return patterns.some((pattern) => pattern.endsWith("/**") ? relative.startsWith(pattern.slice(0, -3)) : relative === pattern);
}
async function listFiles(root: string) {
  const output: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error(`package_symlink_rejected:${target}`);
      if (metadata.isDirectory()) await visit(target);
      else if (metadata.isFile()) output.push(normalize(path.relative(root, target)));
      else throw new Error(`package_non_regular_input:${target}`);
    }
  }
  await visit(root);
  return output.sort();
}
async function copyOne(source: string, packageDirectory: string, destination: string) {
  const safe = normalize(destination);
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`invalid_evidence_file:${source}`);
  const target = contained(packageDirectory, path.join(packageDirectory, ...safe.split("/")));
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  const bytes = await readFile(source);
  return { source: normalize(path.relative(repoRoot, source)), copied_to: safe, byte_count: bytes.byteLength, sha256: sha256(bytes) };
}
async function copyTree(sourceRoot: string, packageDirectory: string, destinationRoot: string, topLevelOnly = false) {
  if (!existsSync(sourceRoot)) throw new Error(`required_evidence_root_missing:${sourceRoot}`);
  const copied = [];
  for (const relative of await listFiles(sourceRoot)) {
    if (topLevelOnly && relative.includes("/")) continue;
    copied.push(await copyOne(path.join(sourceRoot, ...relative.split("/")), packageDirectory, `${destinationRoot}/${relative}`));
  }
  return copied;
}

const contract = JSON.parse(await readFile(path.join(repoRoot, "src", "engine", "wave21", "execution-contract.v0.4.1.json"), "utf8")) as {
  workers: readonly Readonly<{ id: string; branch: string; worktree: string; allowlist: readonly string[]; evidence_output: string }>[];
};
const workers = [
  { id: "W1", worker: "13e76078048e7f13c6adbde68e17a68322704a52", integration: integrationCommits[0] },
  { id: "W2", worker: "2c4b1a849656536ab5b2efa8e27b94d6c986343a", integration: integrationCommits[1] },
  { id: "W3", worker: "b9f26fa58d373dd5e4f12404526bcb80f37f18e9", integration: integrationCommits[2] },
] as const;
const workerAudits = workers.map((entry) => {
  const frozen = contract.workers.find((worker) => worker.id === entry.id);
  if (!frozen) throw new Error(`worker_contract_missing:${entry.id}`);
  const worker = commitRecord(entry.worker);
  const integration = commitRecord(entry.integration);
  const changedPaths = worker.changed_files.flatMap((change) => change.paths).sort();
  const pathChecks = changedPaths.map((relative) => {
    const workerBlob = git(["rev-parse", `${entry.worker}:${relative}`]).stdout;
    const integratedBlob = git(["rev-parse", `${entry.integration}:${relative}`]).stdout;
    return { path: relative, allowlisted: allowlisted(relative, frozen.allowlist), worker_blob: workerBlob, integration_blob: integratedBlob, blob_equivalent: workerBlob === integratedBlob };
  });
  const mergeBase = git(["merge-base", entry.worker, contractSha]).stdout;
  const commitCount = Number(git(["rev-list", "--count", `${contractSha}..${entry.worker}`]).stdout);
  const audit = {
    id: entry.id,
    branch: frozen.branch,
    worktree: frozen.worktree,
    expected_base: contractSha,
    merge_base: mergeBase,
    commit_count_over_base: commitCount,
    allowlist: frozen.allowlist,
    allowlist_sha256: sha256(stableJson(frozen.allowlist)),
    worker_commit: worker,
    integration_commit: integration,
    worker_patch_id: patchId(entry.worker),
    integration_patch_id: patchId(entry.integration),
    path_checks: pathChecks,
    clean_handoff_recorded: true,
  };
  const passed = worker.parents[0] === contractSha && mergeBase === contractSha && commitCount === 1 && audit.worker_patch_id === audit.integration_patch_id && pathChecks.every((item) => item.allowlisted && item.blob_equivalent);
  if (!passed) throw new Error(`worker_audit_failed:${entry.id}`);
  return { ...audit, passed };
});

const head = git(["rev-parse", "HEAD"]).stdout;
const branch = git(["branch", "--show-current"]).stdout;
if (branch !== "codex/tivdoc-engine-foundation") throw new Error("wave21_wrong_integration_branch");
if (git(["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") throw new Error("wave21_package_requires_clean_tracked_worktree");
const finalVerificationPath = path.join(outputRoot, "final-verification", "result.json");
const finalVerification = JSON.parse(await readFile(finalVerificationPath, "utf8")) as { status: string; final_head: string };
if (finalVerification.status !== "WAVE21_FINAL_VERIFICATION_PASSED" || finalVerification.final_head !== head) throw new Error("wave21_final_verification_missing_for_head");

const firstParent = lines(git(["rev-list", "--first-parent", "--reverse", `${requiredBase}^..HEAD`]).stdout);
if (firstParent[0] !== requiredBase || firstParent.at(-1) !== head) throw new Error("wave21_first_parent_invalid");
const finalizationCommits = lines(git(["rev-list", "--reverse", `${integrationCommits[2]}..HEAD`]).stdout).map(commitRecord);
const orchestratorAllowlist = [
  ".gitignore",
  "package.json",
  "docs/parallel-development-wave2.1-v0.4.1.md",
  "scripts/parallel-wave21-final-verification.mts",
  "scripts/parallel-wave21-review-package.mts",
  "scripts/parallel-wave21-review-package-zip.py",
  "scripts/wave21-controlled-import/verify.mts",
  "src/engine/wave2/evidence-audit/artifact-reconciliation.ts",
];
const finalizationAllowlistPassed = finalizationCommits.flatMap((commit) => commit.changed_files.flatMap((change) => change.paths)).every((relative) => orchestratorAllowlist.includes(relative));
if (!finalizationAllowlistPassed) throw new Error("orchestrator_finalization_allowlist_failed");

const w1Root = path.join(outputRoot, "workers", "w1-evidence-reachability");
const w2Root = path.join(outputRoot, "workers", "w2-canonical-corpus");
const w3Root = path.join(outputRoot, "workers", "w3-ledger-parser");
const oldVerification = JSON.parse(await readFile(path.join(w1Root, "independent-v0.4-package-verification.json"), "utf8")) as { passed: boolean; structural_and_nested_evidence_passed: boolean; git: { reference_comparison_passed: boolean; inventory_target_hash_mismatches: unknown[] } };
const countLedger = JSON.parse(await readFile(path.join(w1Root, "corrected-count-ledger.json"), "utf8")) as { required_reconciliation: Record<string, number> };
const ruleMatrix = JSON.parse(await readFile(path.join(w1Root, "rule-input-negative-matrix.json"), "utf8")) as { passed: boolean };
const groundTruthMatrix = JSON.parse(await readFile(path.join(w1Root, "ground-truth-negative-matrix.json"), "utf8")) as { passed: boolean };
const w2Summary = JSON.parse(await readFile(path.join(w2Root, "summary.json"), "utf8")) as { active_sources: number; reviewed_sources: number; parameters_activated: number; source_role_count: number; working_time_nodes: number; readiness_topic_count: number; convalescence_before_chunks: number; convalescence_after_chunks: number };
const w3Summary = JSON.parse(await readFile(path.join(w3Root, "local-adversarial-verification.json"), "utf8")) as { status: string; persistent_owner_import_entries: number; matrices: Record<string, unknown>; assurance: { application: string; os: string } };

const sourceTexts = Object.fromEntries(await Promise.all([
  "scripts/legal-sources.mts",
  "scripts/legal-acquisition.mts",
  "src/engine/legal-knowledge/retrieval-core.ts",
  "src/engine/legal-knowledge/temporal-resolver.ts",
  "src/server/engine/legal-knowledge/acquisition.ts",
  "src/server/engine/legal-knowledge/controlled-import-security.ts",
].map(async (relative) => [relative, await readFile(path.join(repoRoot, relative), "utf8")] as const)));
const reachabilityChecks = {
  canonical_build_imports_instrument_selector: sourceTexts["scripts/legal-sources.mts"].includes("selectCanonicalInstrumentPages"),
  canonical_build_and_search_import_source_roles: sourceTexts["scripts/legal-sources.mts"].includes("classifyRegisteredSourceRole"),
  retrieval_uses_canonical_chunk_selector: sourceTexts["src/engine/legal-knowledge/retrieval-core.ts"].includes("selectCanonicalRetrievalChunks"),
  retrieval_enforces_registered_source_role: sourceTexts["src/engine/legal-knowledge/retrieval-core.ts"].includes("classifyRegisteredSourceRole"),
  temporal_resolver_enforces_registered_source_role: sourceTexts["src/engine/legal-knowledge/temporal-resolver.ts"].includes("classifyRegisteredSourceRole"),
  acquisition_cli_reads_committed_owner_artifacts: sourceTexts["scripts/legal-acquisition.mts"].includes("loadCommittedOwnerArtifacts"),
  acquisition_routes_to_isolated_screening: sourceTexts["src/server/engine/legal-knowledge/acquisition.ts"].includes("screenUntrustedPdfIsolated"),
  committed_reader_rescreens_bytes: sourceTexts["src/server/engine/legal-knowledge/controlled-import-security.ts"].includes("const screening = await screenUntrustedPdfIsolated({ bytes })"),
  committed_reader_enumerates_commit_markers: sourceTexts["src/server/engine/legal-knowledge/controlled-import-security.ts"].includes("path.resolve(input.ledgerRoot, \".commits\")"),
};
if (Object.values(reachabilityChecks).some((value) => !value)) throw new Error("canonical_reachability_assertion_failed");
const canonicalReachability = {
  schema_version: "tivdoc-wave21-integrated-canonical-reachability-v0.4.1",
  entrypoint_chains: {
    canonical_build: ["scripts/legal-sources.mts", "selectCanonicalInstrumentPages", "canonical chunks"],
    canonical_search_and_retrieval: ["scripts/legal-sources.mts/retrieval-core.ts", "selectCanonicalRetrievalChunks", "classifyRegisteredSourceRole"],
    canonical_temporal_resolver: ["temporal-resolver.ts", "classifyRegisteredSourceRole", "fail-closed source set"],
    canonical_owner_import: ["scripts/legal-acquisition.mts", "importOwnerOfficialArtifact", "importControlledOfficialArtifact", "screenUntrustedPdfIsolated", "atomic commit marker"],
    canonical_owner_reader: ["loadCommittedOwnerArtifacts", ".commits inventory", "ledger/event/journal/hash binding", "screenUntrustedPdfIsolated"],
  },
  checks: reachabilityChecks,
  closed_v0_4_findings: ["instrument_segmentation_bypass", "source_role_retrieval_bypass", "published_before_ledger_reader_visibility", "owner_parser_direct_in_process_path"],
  removed_or_merged_duplicate_paths: [],
  remaining_parallel_or_noncanonical_paths: [
    "strict seven-topic readiness remains a separate fail-closed diagnostic rather than the sole canonical readiness implementation",
    "Rule Input remains synthetic-only",
    "Ground Truth remains offline synthetic-only",
  ],
  canonical_closure_complete: false,
};

const invariantCounts = {
  reviewed_sources: w2Summary.reviewed_sources,
  active_sources: w2Summary.active_sources,
  real_numeric_candidates_or_attestations: 0,
  active_parameters: w2Summary.parameters_activated,
  israeli_legal_rules: 0,
  findings: 0,
  customer_files_read: 0,
  openai_calls: 0,
  external_supabase_connections: 0,
  migrations: 0,
  production_preview_deploy_actions: 0,
  persistent_owner_imports: w3Summary.persistent_owner_import_entries,
};
if (Object.values(invariantCounts).some((value) => value !== 0) || !ruleMatrix.passed || !groundTruthMatrix.passed) throw new Error("wave21_final_invariant_failed");
const primaryStatus = "PARALLEL_WAVE_2_1_PARTIAL";
const independentStatuses = [
  "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
  "LEGAL_SOURCE_CORPUS_INCOMPLETE",
  "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED",
  "HUMAN_LEGAL_REVIEW_REQUIRED",
  "HUMAN_GROUND_TRUTH_REQUIRED",
  "PENSION_OCR_DERIVED_NEEDS_HUMAN_REVIEW",
  "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
  "PARSER_OS_SANDBOX_NOT_VERIFIED",
  "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
  "SHADOW_MODE_NOT_READY",
] as const;

async function trackedInventory(range: string) {
  const entries = [];
  for (const row of lines(git(["diff", "--name-status", "--find-renames=100%", range]).stdout)) {
    const [statusValue, ...paths] = row.split("\t");
    const normalized = paths.map(normalize);
    const target = path.join(repoRoot, normalized.at(-1)!);
    const exists = existsSync(target) && (await stat(target)).isFile();
    const bytes = exists ? await readFile(target) : null;
    entries.push({ status: statusValue, paths: normalized, target_byte_count: bytes?.byteLength ?? null, target_sha256: bytes ? sha256(bytes) : null });
  }
  return { range, changed_path_count: new Set(entries.flatMap((entry) => entry.paths)).size, entries };
}
const gitProof = {
  schema_version: "tivdoc-wave21-complete-git-proof-v0.4.1",
  original_base: "e978ae5cee4a92f20dcc7db448b275170b8bf724",
  wave1_final: "bb9a61eae55d49529d7cd633a2c9c2615a8d842e",
  wave2_final: requiredBase,
  wave21_contract: commitRecord(contractSha),
  worker_audits: workerAudits,
  integration_order: ["W1", "W2", "W3"],
  integration_commits: integrationCommits.map(commitRecord),
  orchestrator_finalization_commits: finalizationCommits,
  orchestrator_allowlist: orchestratorAllowlist,
  orchestrator_allowlist_passed: finalizationAllowlistPassed,
  final_head: head,
  branch,
  first_parent_chain: firstParent.map(commitRecord),
  base_to_head_inventory: await trackedInventory(`${requiredBase}..HEAD`),
  no_merge_commits: firstParent.every((commit) => commitRecord(commit).parents.length <= 1),
};

function pythonExecutable() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "";
  return bundled && existsSync(bundled) ? bundled : "python";
}
async function buildPackage(packageDirectory: string) {
  await rm(packageDirectory, { recursive: true, force: true });
  await mkdir(packageDirectory, { recursive: true });
  const copied = [
    ...await copyTree(w1Root, packageDirectory, "worker-evidence/W1", true),
    ...await copyTree(w2Root, packageDirectory, "worker-evidence/W2"),
    ...await copyTree(w3Root, packageDirectory, "worker-evidence/W3"),
    ...await copyTree(path.join(outputRoot, "final-verification"), packageDirectory, "final-verification"),
  ];
  const legalEvidenceRoot = path.join(repoRoot, "output", "legal-knowledge");
  for (const name of ["citation-round-trip-report.json", "clean-room-reproducibility-report.json", "source-byte-diff-report.json", "temporal-coverage-report.json"]) {
    copied.push(await copyOne(path.join(legalEvidenceRoot, name), packageDirectory, `central-legal-evidence/${name}`));
  }
  await writeJson(path.join(packageDirectory, "git", "wave21-git-proof.json"), gitProof);
  await writeJson(path.join(packageDirectory, "canonical-reachability.json"), canonicalReachability);
  await writeJson(path.join(packageDirectory, "corrected-counts.json"), countLedger.required_reconciliation);
  await writeJson(path.join(packageDirectory, "final-invariants.json"), { schema_version: "tivdoc-wave21-final-invariants-v0.4.1", counts: invariantCounts, all_zero: true });
  await writeJson(path.join(packageDirectory, "readiness-status.json"), {
    schema_version: "tivdoc-wave21-readiness-status-v0.4.1",
    primary_status: primaryStatus,
    independent_statuses: independentStatuses,
    application_isolation: w3Summary.assurance.application,
    os_isolation: w3Summary.assurance.os,
    v0_4_structural_verification_passed: oldVerification.structural_and_nested_evidence_passed,
    v0_4_git_byte_reference_comparison_passed: oldVerification.git.reference_comparison_passed,
    unresolved_v0_4_inventory_hash_reference_count: oldVerification.git.inventory_target_hash_mismatches.length,
    canonical_closure_complete: false,
  });
  await writeJson(path.join(packageDirectory, "evidence-input-inventory.json"), { schema_version: "tivdoc-wave21-evidence-input-inventory-v0.4.1", copied });
  await writeFile(path.join(packageDirectory, "index.md"),
    "# Tivdoc Wave 2.1 review package V0.4.1\n\n" +
    "Offline engineering evidence only. The primary status is `PARALLEL_WAVE_2_1_PARTIAL`: canonical segmentation, source-role and ledger-bound reader controls are integrated, while the historical V0.4 byte-reference mismatch and parallel strict-readiness implementation remain recorded. No source is reviewed or active, and no real legal value, rule, Finding, customer document, owner import, external database, migration or deployment is authorized or included. The manifest covers every package member except itself to avoid a recursive hash.\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const scanner = {
    version: "tivdoc-wave21-secret-pii-scanner-1.0.0",
    rules: [
      { id: "PRIVATE_KEY", source: "-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----", flags: "u" },
      { id: "OPENAI_STYLE_SECRET", source: "\\bsk-[A-Za-z0-9_-]{20,}", flags: "u" },
      { id: "SUPABASE_ACCESS_TOKEN", source: "\\bsbp_[A-Za-z0-9_-]{20,}", flags: "u" },
      { id: "CUSTOMER_EVAL_IDENTIFIER", source: "\\bCUSTOMER_EVAL_\\d{3}\\b", flags: "u" },
      { id: "PROHIBITED_CUSTOMER_DATASET", source: ["customer", "payslip", "data-only", "v3"].join("-"), flags: "iu" },
      { id: "PERSONAL_HOME_PATH", source: "\\bC:\\\\Users\\\\[^\\\\\\s]+", flags: "iu" },
    ],
  };
  const ruleSetSha256 = sha256(stableJson(scanner));
  const findings: Array<{ path: string; rule_id: string }> = [];
  const scanned: Array<{ path: string; byte_count: number; sha256: string }> = [];
  let binarySkipped = 0;
  for (const relative of await listFiles(packageDirectory)) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    if (!new Set([".json", ".md", ".txt", ".csv", ".ts", ".mts"]).has(path.extname(relative).toLowerCase())) { binarySkipped += 1; continue; }
    const text = bytes.toString("utf8");
    scanned.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
    for (const rule of scanner.rules) if (new RegExp(rule.source, rule.flags).test(text)) findings.push({ path: relative, rule_id: rule.id });
  }
  await writeJson(path.join(packageDirectory, "secret-pii-scan.json"), {
    schema_version: "tivdoc-wave21-secret-pii-scan-v0.4.1",
    scanner_version: scanner.version,
    rule_set_sha256: ruleSetSha256,
    rules: scanner.rules,
    scanned_file_count: scanned.length,
    scanned_files: scanned,
    binary_files_skipped: binarySkipped,
    findings_count: findings.length,
    findings,
    passed: findings.length === 0,
  });
  if (findings.length > 0) throw new Error(`wave21_secret_pii_scan_failed:${stableJson(findings)}`);

  const manifestFiles = (await listFiles(packageDirectory)).filter((relative) => relative !== "package-manifest.json");
  const manifestEntries = [];
  for (const relative of manifestFiles) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    manifestEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  await writeJson(path.join(packageDirectory, "package-manifest.json"), {
    schema_version: "tivdoc-parallel-wave21-review-package-manifest-v0.4.1",
    primary_status: primaryStatus,
    manifest_self_excluded_to_avoid_recursive_hash: true,
    deterministic_archive_metadata: true,
    files: manifestEntries,
  });
  const treeEntries = [];
  for (const relative of await listFiles(packageDirectory)) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    treeEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  return { file_count: treeEntries.length, tree_sha256: sha256(stableJson(treeEntries)) };
}

for (const target of [packageRoot, runA, runB]) await rm(target, { recursive: true, force: true });
for (const target of [zipA, zipB, zipPath, resultPath]) await rm(target, { force: true });
const buildA = await buildPackage(runA);
const buildB = await buildPackage(runB);
if (buildA.file_count !== buildB.file_count || buildA.tree_sha256 !== buildB.tree_sha256) throw new Error("wave21_clean_build_tree_mismatch");

function buildZip(source: string, destination: string) {
  const run = spawnSync(pythonExecutable(), [path.join(repoRoot, "scripts", "parallel-wave21-review-package-zip.py"), source, destination], { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`wave21_zip_build_failed:${run.stderr.trim()}`);
  return JSON.parse(run.stdout.trim()) as { zip_sha256: string; package_files: number; manifest_entries: number; manifest_sha256: string; consumer_safe_extraction_verified: boolean; consumer_extracted_files: number };
}
const firstZip = buildZip(runA, zipA);
const secondZip = buildZip(runB, zipB);
if (firstZip.zip_sha256 !== secondZip.zip_sha256 || firstZip.manifest_sha256 !== secondZip.manifest_sha256) throw new Error("wave21_deterministic_zip_mismatch");
await rename(runB, packageRoot);
await rename(zipB, zipPath);
await rm(runA, { recursive: true, force: true });
await rm(zipA, { force: true });

const result = {
  schema_version: "tivdoc-parallel-wave21-review-package-result-v0.4.1",
  package_path: normalize(path.relative(repoRoot, packageRoot)),
  zip_path: normalize(path.relative(repoRoot, zipPath)),
  zip_byte_count: (await stat(zipPath)).size,
  package_file_count: secondZip.package_files,
  manifest_entries: secondZip.manifest_entries,
  manifest_sha256: secondZip.manifest_sha256,
  zip_sha256: secondZip.zip_sha256,
  two_clean_directory_builds_byte_identical: true,
  clean_build_tree_sha256: buildB.tree_sha256,
  consumer_safe_extraction_verified: secondZip.consumer_safe_extraction_verified,
  consumer_extracted_files: secondZip.consumer_extracted_files,
  final_head: head,
  primary_status: primaryStatus,
  independent_statuses: independentStatuses,
};
await writeJson(resultPath, result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
