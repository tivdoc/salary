import "./production-refusal.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2.2");
const packageRoot = path.join(outputRoot, "review-package-v0.4.2");
const runA = path.join(outputRoot, "review-package-v0.4.2-run-a");
const runB = path.join(outputRoot, "review-package-v0.4.2-run-b");
const zipA = path.join(outputRoot, "review-package-v0.4.2-run-a.zip");
const zipB = path.join(outputRoot, "review-package-v0.4.2-run-b.zip");
const zipPath = path.join(outputRoot, "review-package-v0.4.2.zip");
const resultPath = path.join(outputRoot, "review-package-v0.4.2-result.json");
const requiredBase = "48be587d5a394e37656e20a1276b4cebb85c60bb";
const contractSha = "acdf75383125fb67187de58dd331577eefb106bb";
const originalWorkerCommits = {
  W1: "8b3931890e90d344ef2238e772322abdb25eb02d",
  W2: "9177100c8dbc2e05d67eda023114d547a03d7e9b",
  W3: "5fc4f1a0f6b64224f906143e7b43388399dcbbc4",
} as const;
const integratedWorkerCommits = {
  W1: "9c04e87dc60c40e43d069542c6e08d336bb68e4e",
  W2: "8c4d63cade45d6a9ad76fdc345c0b971a88e53bf",
  W3: "3f6e241edde39a75c579158cc12a7764ece09fdd",
} as const;
const evidenceRoots = {
  W1: path.join(outputRoot, "workers", "w1-evidence-forensics"),
  W2: path.join(outputRoot, "workers", "w2-corpus-readiness"),
  W3: path.join(outputRoot, "workers", "w3-closure-verification"),
  FINAL: path.join(outputRoot, "final-verification"),
} as const;
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

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("wave22_review_package_requires_offline_canary");
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
function contained(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`wave22_package_path_escape:${target}`);
}
for (const target of [packageRoot, runA, runB, zipA, zipB, zipPath, resultPath]) contained(outputRoot, target);
function normalize(relative: string) {
  const value = relative.replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").includes("..")) throw new Error(`unsafe_relative_path:${relative}`);
  return value;
}
function git(args: readonly string[], input?: string, allowFailure = false) {
  const result = spawnSync("git", [...args], { cwd: repoRoot, input, encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) throw new Error(`wave22_git_failed:${args.join("_")}:${result.stderr.trim()}`);
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
    diff_stat: { files: stats, file_count: stats.length, added_lines: stats.reduce((sum, entry) => sum + (entry.added ?? 0), 0), deleted_lines: stats.reduce((sum, entry) => sum + (entry.deleted ?? 0), 0) },
  };
}
function matchesAllowlist(relative: string, patterns: readonly string[]) {
  return patterns.some((pattern) => pattern.endsWith("/**") ? relative.startsWith(pattern.slice(0, -3)) : relative === pattern);
}
async function listFiles(root: string) {
  const output: string[] = [];
  async function visit(current: string) {
    for (const name of (await readdir(current)).sort()) {
      const absolute = path.join(current, name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`package_symlink_denied:${absolute}`);
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) output.push(normalize(path.relative(root, absolute)));
      else throw new Error(`package_non_regular_denied:${absolute}`);
    }
  }
  await visit(root);
  return output.sort();
}
async function copyTree(source: string, destinationRoot: string, destinationRelative: string) {
  if (!existsSync(source)) throw new Error(`required_evidence_missing:${source}`);
  const copied = [];
  for (const relative of await listFiles(source)) {
    const sourceFile = path.join(source, ...relative.split("/"));
    const targetRelative = normalize(`${destinationRelative}/${relative}`);
    const target = path.join(destinationRoot, ...targetRelative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(sourceFile, target);
    const bytes = await readFile(sourceFile);
    copied.push({ source: normalize(path.relative(repoRoot, sourceFile)), copied_to: targetRelative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  return copied;
}
function pythonCommand() {
  const bundled = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe") : "";
  return bundled && existsSync(bundled) ? { command: bundled, prefix: [] as string[] } : { command: "py", prefix: ["-3"] };
}

const contract = JSON.parse(await readFile(path.join(repoRoot, "src", "engine", "wave22", "execution-contract.v0.4.2.json"), "utf8")) as {
  workers: Array<{ id: keyof typeof originalWorkerCommits; branch: string; worktree: string; allowlist: string[]; evidence_output: string }>;
};
const finalVerification = JSON.parse(await readFile(path.join(evidenceRoots.FINAL, "result.json"), "utf8")) as { engineering_verification_status?: string; final_head?: string };
if (finalVerification.engineering_verification_status !== "WAVE22_ENGINEERING_VERIFICATION_PASSED") throw new Error("wave22_final_verification_not_passed");
const head = git(["rev-parse", "HEAD"]).stdout;
const branch = git(["branch", "--show-current"]).stdout;
if (branch !== "codex/tivdoc-engine-foundation" || finalVerification.final_head !== head) throw new Error("wave22_package_head_or_branch_mismatch");
if (git(["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") throw new Error("wave22_package_requires_clean_tracked_worktree");

const workerAudits = contract.workers.map((worker) => {
  const original = commitRecord(originalWorkerCommits[worker.id]);
  const integrated = commitRecord(integratedWorkerCommits[worker.id]);
  const changedFiles = lines(git(["diff", "--name-only", `${contractSha}..${original.sha}`]).stdout).map(normalize);
  const allowlistViolations = changedFiles.filter((relative) => !matchesAllowlist(relative, worker.allowlist));
  const branchHead = git(["rev-parse", `refs/heads/${worker.branch}`]).stdout;
  return {
    id: worker.id,
    branch: worker.branch,
    worktree: worker.worktree,
    exact_base: original.parents[0],
    branch_head: branchHead,
    allowlist: worker.allowlist,
    allowlist_sha256: sha256(stableJson(worker.allowlist)),
    changed_files: changedFiles,
    allowlist_violations: allowlistViolations,
    one_commit_over_contract: original.parents.length === 1 && original.parents[0] === contractSha,
    original,
    integrated,
    patch_equivalent: original.patch_id === integrated.patch_id,
    original_tree_verified: git(["rev-parse", `${original.sha}^{tree}`]).stdout === original.tree,
    integrated_tree_verified: git(["rev-parse", `${integrated.sha}^{tree}`]).stdout === integrated.tree,
  };
});
if (workerAudits.some((worker) => worker.branch_head !== worker.original.sha || worker.allowlist_violations.length || !worker.one_commit_over_contract || !worker.patch_equivalent || !worker.original_tree_verified || !worker.integrated_tree_verified)) {
  throw new Error("wave22_worker_git_audit_failed");
}

const finalInvariants = {
  customer_files_read: 0,
  openai_calls: 0,
  external_supabase_connections: 0,
  migrations: 0,
  production_preview_deploy_actions: 0,
  persistent_owner_imports: 0,
  reviewed_sources: 0,
  active_sources: 0,
  real_numeric_candidates: 0,
  real_numeric_attestations: 0,
  active_parameters: 0,
  israeli_rules: 0,
  findings: 0,
};

const gitAudit = {
  schema_version: "tivdoc-wave22-git-audit-v0.4.2",
  required_base: requiredBase,
  contract_sha: contractSha,
  final_head: head,
  final_tree: git(["rev-parse", "HEAD^{tree}"]).stdout,
  final_parents: lines(git(["show", "-s", "--format=%P", "HEAD"]).stdout),
  branch,
  integration_order: ["W1", "W2", "W3"],
  workers: workerAudits,
  first_parent_chain: lines(git(["rev-list", "--first-parent", "--reverse", `${requiredBase}^..HEAD`]).stdout),
  tracked_worktree_clean: true,
  conflicts_or_gate_waivers: 0,
};

async function buildPackage(packageDirectory: string) {
  await rm(packageDirectory, { recursive: true, force: true });
  await mkdir(packageDirectory, { recursive: true });
  const copied = [
    ...await copyTree(evidenceRoots.W1, packageDirectory, "worker-evidence/W1"),
    ...await copyTree(evidenceRoots.W2, packageDirectory, "worker-evidence/W2"),
    ...await copyTree(evidenceRoots.W3, packageDirectory, "worker-evidence/W3"),
    ...await copyTree(evidenceRoots.FINAL, packageDirectory, "final-verification"),
  ];
  const docs = [
    "docs/wave22-evidence-forensics-v0.4.2.md",
    "docs/wave22-corpus-readiness-v0.4.2.md",
    "docs/wave22-closure-verification-v0.4.2.md",
    "docs/parallel-development-wave2.2-v0.4.2.md",
  ];
  for (const relative of docs) {
    const target = path.join(packageDirectory, "documentation", path.basename(relative));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repoRoot, relative), target);
  }
  await mkdir(path.join(packageDirectory, "contract"), { recursive: true });
  await copyFile(path.join(repoRoot, "src", "engine", "wave22", "execution-contract.v0.4.2.json"), path.join(packageDirectory, "contract", "execution-contract.v0.4.2.json"));
  await writeJson(path.join(packageDirectory, "git", "wave22-git-audit.json"), gitAudit);
  await writeJson(path.join(packageDirectory, "evidence-input-inventory.json"), { schema_version: "tivdoc-wave22-evidence-input-inventory-v0.4.2", copied });
  await writeJson(path.join(packageDirectory, "final-invariants.json"), {
    schema_version: "tivdoc-wave22-final-zero-invariants-v0.4.2",
    counts: finalInvariants,
    all_zero: Object.values(finalInvariants).every((value) => value === 0),
  });
  await writeJson(path.join(packageDirectory, "readiness-status.json"), {
    schema_version: "tivdoc-wave22-readiness-status-v0.4.2",
    primary_wave_status: "PARALLEL_WAVE_2_2_PARTIAL",
    strict_evidence_gate_exit_code: 6,
    unresolved_v0_4_references: 8,
    independent_readiness_statuses: independentStatuses,
    assurance_labels: [
      "PARSER_APPLICATION_ISOLATION_VERIFIED",
      "PARSER_OS_SANDBOX_NOT_VERIFIED",
      "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
      "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
    ],
  });
  await writeJson(path.join(packageDirectory, "package-count-contract.json"), {
    schema_version: "tivdoc-wave22-package-count-contract-v0.4.2",
    zip_member_count_exclusions: ["outer ZIP itself"],
    manifest_entry_count_exclusions: ["package-manifest.json"],
    secret_pii_scanner_exclusions: ["package-manifest.json", "independent-secret-pii-scan.json"],
    source_reference_scan_rule: "all JSON members except package-manifest.json and files whose basename ends with scan.json; every non-JSON member is explicitly enumerated by the independent verifier",
  });
  await writeFile(path.join(packageDirectory, "index.md"),
    "# Tivdoc Wave 2.2 final foundation closure evidence V0.4.2\n\n" +
    "Primary status: `PARALLEL_WAVE_2_2_PARTIAL`. The immutable V0.4 erratum resolves 3 of 11 byte references; eight remain explicitly non-authoritative and unresolved. V0.4.1 retains four independent evidence-to-Git mismatches. No gate was waived. No source is reviewed or active, and this offline package authorizes no legal rule, numeric parameter, customer processing, owner import, deployment or Shadow Mode.\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const python = pythonCommand();
  const scannerPath = path.join(packageDirectory, "independent-secret-pii-scan.json");
  const scanner = spawnSync(python.command, [...python.prefix, path.join(repoRoot, "scripts", "wave22-closure-verification", "independent_closure_verifier.py"), "scan-staging", "--staging", packageDirectory, "--output", scannerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (scanner.status !== 0) throw new Error(`wave22_package_scanner_failed:${scanner.stderr.trim()}`);
  const scannerReport = JSON.parse(await readFile(scannerPath, "utf8")) as { passed?: boolean; unresolved_findings_count?: number };
  if (scannerReport.passed !== true || scannerReport.unresolved_findings_count !== 0) throw new Error("wave22_package_scanner_unresolved_findings");

  const manifestEntries = [];
  for (const relative of (await listFiles(packageDirectory)).filter((entry) => entry !== "package-manifest.json")) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    manifestEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  await writeJson(path.join(packageDirectory, "package-manifest.json"), {
    schema_version: "tivdoc-parallel-wave22-review-package-manifest-v0.4.2",
    primary_wave_status: "PARALLEL_WAVE_2_2_PARTIAL",
    final_head: head,
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
if (buildA.tree_sha256 !== buildB.tree_sha256 || buildA.file_count !== buildB.file_count) throw new Error("wave22_clean_package_builds_differ");

function buildZip(source: string, destination: string) {
  const python = pythonCommand();
  const result = spawnSync(python.command, [...python.prefix, path.join(repoRoot, "scripts", "parallel-wave22-review-package-zip.py"), source, destination], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`wave22_zip_build_failed:${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim()) as { zip_sha256: string; zip_byte_count: number; package_files: number; manifest_entries: number; manifest_sha256: string; consumer_safe_extraction_verified: boolean; consumer_extracted_files: number };
}
const firstZip = buildZip(runA, zipA);
const secondZip = buildZip(runB, zipB);
if (firstZip.zip_sha256 !== secondZip.zip_sha256 || firstZip.manifest_sha256 !== secondZip.manifest_sha256) throw new Error("wave22_deterministic_zip_mismatch");
await rename(runB, packageRoot);
await rename(zipB, zipPath);
await rm(runA, { recursive: true, force: true });
await rm(zipA, { force: true });

const result = {
  schema_version: "tivdoc-parallel-wave22-review-package-result-v0.4.2",
  package_path: normalize(path.relative(repoRoot, packageRoot)),
  zip_path: normalize(path.relative(repoRoot, zipPath)),
  zip_byte_count: secondZip.zip_byte_count,
  package_file_count: secondZip.package_files,
  manifest_entries: secondZip.manifest_entries,
  manifest_sha256: secondZip.manifest_sha256,
  zip_sha256: secondZip.zip_sha256,
  two_clean_directory_builds_byte_identical: true,
  clean_build_tree_sha256: buildB.tree_sha256,
  consumer_safe_extraction_verified: secondZip.consumer_safe_extraction_verified,
  consumer_extracted_files: secondZip.consumer_extracted_files,
  final_head: head,
  primary_wave_status: "PARALLEL_WAVE_2_2_PARTIAL",
  independent_readiness_statuses: independentStatuses,
};
await writeJson(resultPath, result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
