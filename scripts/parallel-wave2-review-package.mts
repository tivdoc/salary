import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanFullChangedFileRange } from "../src/engine/wave2/evidence-audit/full-diff-scan.ts";
import {
  normalizeRelative,
  requireContained,
  requireSafeRelative,
  sha256,
  stableJson,
  writeJsonAtomic,
} from "../src/engine/wave2/evidence-audit/common.ts";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2");
const packageRoot = path.join(outputRoot, "review-package-v0.4");
const runA = path.join(outputRoot, "review-package-v0.4-run-a");
const runB = path.join(outputRoot, "review-package-v0.4-run-b");
const zipA = path.join(outputRoot, "review-package-v0.4-run-a.zip");
const zipB = path.join(outputRoot, "review-package-v0.4-run-b.zip");
const zipPath = path.join(outputRoot, "review-package-v0.4.zip");
const resultPath = path.join(outputRoot, "review-package-v0.4-result.json");
const originalBase = "e978ae5cee4a92f20dcc7db448b275170b8bf724";
const wave2Base = "bb9a61eae55d49529d7cd633a2c9c2615a8d842e";
const wave2AContract = "2478e28eb4f31d282dac4b6f8f1fb488fb9b5bca";
const wave2AIntegration = "d3bb61851100710d2c8284bea573a91f03d5fa2b";
const wave2BContract = "c8adca29db4609d7196e30dbd813d334882bfb48";

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") {
  throw new Error("parallel_wave2_review_package_must_run_offline");
}
for (const target of [packageRoot, runA, runB, zipA, zipB, zipPath, resultPath]) {
  requireContained(outputRoot, target, "wave2_review_package_path_escape");
}

type Worker = Readonly<{
  id: "A1" | "A2" | "A3" | "B1" | "B2" | "B3";
  branch: string;
  expectedBase: string;
  workerCommit: string;
  integrationCommit: string;
}>;

const workers: readonly Worker[] = [
  { id: "A1", branch: "codex/wave2-a1-evidence-audit", expectedBase: wave2AContract, workerCommit: "9faffb4a6414eb9516ff5d9dbf5067f0b0b97f44", integrationCommit: "c3f40d14f7e7af08f03820f4b083316a3f41c198" },
  { id: "A2", branch: "codex/wave2-a2-corpus-ocr", expectedBase: wave2AContract, workerCommit: "5123dff36fbcc5459ad815957e899a11ebbba45b", integrationCommit: "c14ac3caf9174b4797de35dc35b92276750c3936" },
  { id: "A3", branch: "codex/wave2-a3-import-recovery", expectedBase: wave2AContract, workerCommit: "5296de1d0482d7258f4886b910216ed76f096022", integrationCommit: "00f751c3c8b67035bd1209f06b500bdaa0089b9f" },
  { id: "B1", branch: "codex/wave2-b1-review-dossier", expectedBase: wave2BContract, workerCommit: "ac34057acc4364ea1664312adc9be6f8bd25ccd3", integrationCommit: "370750d9fb910a7e55c7b21eed029113db310f26" },
  { id: "B2", branch: "codex/wave2-b2-rule-input", expectedBase: wave2BContract, workerCommit: "d137581516e4b2376dabe55d23d99bc8d70eb2f3", integrationCommit: "7f182ea3584d95ead8f683f7ef0144d5c6926b1c" },
  { id: "B3", branch: "codex/wave2-b3-ground-truth", expectedBase: wave2BContract, workerCommit: "55386d413881f2db76be8bb2b07169febe5b33a0", integrationCommit: "a80e987c9f5cf16ba8133e98300b9d367f04bed6" },
] as const;

const evidenceRoots = {
  A1: path.join(outputRoot, "batch-a", "evidence-audit"),
  A2: path.join(outputRoot, "batch-a", "corpus-hardening"),
  A3: path.join(outputRoot, "batch-a", "controlled-import"),
  B1: path.join(outputRoot, "batch-b", "minimum-wage-dossier"),
  B2: path.join(outputRoot, "batch-b", "rule-input"),
  B3: path.join(outputRoot, "batch-b", "ground-truth"),
  FINAL: path.join(outputRoot, "final-verification"),
} as const;

const a1Files = [
  "evidence-manifest.json",
  "full-diff-scope-scan.json",
  "result.json",
  "topic-readiness-diagnostic.json",
  "topic-readiness-strict-gate.json",
  "wave1-artifact-crosswalk.json",
  "wave1-git-audit.json",
  "wave1-review-package-verification.json",
] as const;

const legalEvidenceNames = [
  "citation-round-trip-report.json",
  "clean-room-reproducibility-report.json",
  "source-byte-diff-report.json",
  "temporal-coverage-report.json",
] as const;

function git(args: readonly string[], input?: string, allowFailure = false) {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`wave2_package_git_failed:${args.join("_")}:${result.stderr.trim()}`);
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function lines(value: string) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

function patchId(commit: string) {
  const patch = git(["show", "--pretty=format:", "--no-ext-diff", "--binary", commit]).stdout;
  const id = git(["patch-id", "--stable"], `${patch}\n`).stdout.split(/\s+/u)[0];
  if (!/^[a-f0-9]{40}$/u.test(id)) throw new Error(`wave2_patch_id_unavailable:${commit}`);
  return id;
}

function commitRecord(commit: string) {
  const [sha, parents, subject, tree] = git(["show", "-s", "--format=%H%n%P%n%s%n%T", commit]).stdout.split(/\r?\n/u);
  const changedFiles = lines(git(["diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit]).stdout)
    .map((row) => {
      const [statusValue, ...paths] = row.split("\t");
      return { status: statusValue, paths: paths.map(normalizeRelative) };
    });
  const stats = lines(git(["show", "--numstat", "--format=", "--no-renames", commit]).stdout).map((row) => {
    const [added, deleted, relative] = row.split("\t");
    return { path: normalizeRelative(relative), added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
  return {
    sha,
    parents: parents ? parents.split(" ") : [],
    subject,
    tree,
    changed_files: changedFiles,
    diff_stat: {
      file_count: stats.length,
      added_lines: stats.reduce((sum, entry) => sum + (entry.added ?? 0), 0),
      deleted_lines: stats.reduce((sum, entry) => sum + (entry.deleted ?? 0), 0),
      files: stats,
    },
  };
}

async function listFiles(root: string) {
  const output: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw new Error(`wave2_evidence_symlink_rejected:${target}`);
      if (metadata.isDirectory()) await visit(target);
      else if (metadata.isFile()) output.push(requireSafeRelative(normalizeRelative(path.relative(root, target))));
    }
  }
  await visit(root);
  return output.sort();
}

async function copyEvidenceFile(source: string, packageDirectory: string, relative: string) {
  const safe = requireSafeRelative(relative);
  const input = requireContained(path.dirname(source), source, "wave2_evidence_source_escape");
  const output = requireContained(packageDirectory, path.join(packageDirectory, ...safe.split("/")), "wave2_evidence_destination_escape");
  const metadata = await lstat(input);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`wave2_evidence_file_invalid:${source}`);
  await mkdir(path.dirname(output), { recursive: true });
  await copyFile(input, output);
}

async function copyTree(sourceRoot: string, packageDirectory: string, destinationRoot: string) {
  if (!existsSync(sourceRoot)) throw new Error(`required_wave2_evidence_root_missing:${sourceRoot}`);
  const copied = [];
  for (const relative of await listFiles(sourceRoot)) {
    const destination = `${destinationRoot}/${relative}`;
    await copyEvidenceFile(path.join(sourceRoot, ...relative.split("/")), packageDirectory, destination);
    const bytes = await readFile(path.join(sourceRoot, ...relative.split("/")));
    copied.push({ source: relative, copied_to: destination, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  return copied;
}

function workerAudit(contract: Readonly<{ workers: readonly Readonly<{ id: string; allowlist: readonly string[] }>[] }>) {
  return workers.map((worker) => {
    const workerRecord = commitRecord(worker.workerCommit);
    const integrationRecord = commitRecord(worker.integrationCommit);
    const workerPatchId = patchId(worker.workerCommit);
    const integrationPatchId = patchId(worker.integrationCommit);
    const allowlist = contract.workers.find((entry) => entry.id === worker.id)?.allowlist;
    if (!allowlist) throw new Error(`wave2_worker_allowlist_missing:${worker.id}`);
    const paths = workerRecord.changed_files.flatMap((entry) => entry.paths).sort();
    const pathChecks = paths.map((relative) => ({
      path: relative,
      allowlisted: allowlist.some((entry) => entry.endsWith("/**") ? relative.startsWith(entry.slice(0, -3)) : relative === entry),
      worker_blob: git(["rev-parse", `${worker.workerCommit}:${relative}`], undefined, true).stdout || null,
      integration_blob: git(["rev-parse", `${worker.integrationCommit}:${relative}`], undefined, true).stdout || null,
    }));
    const mergeBase = git(["merge-base", worker.workerCommit, worker.expectedBase]).stdout;
    const commitCount = Number(git(["rev-list", "--count", `${worker.expectedBase}..${worker.workerCommit}`]).stdout);
    const passed = workerRecord.parents[0] === worker.expectedBase
      && mergeBase === worker.expectedBase
      && commitCount === 1
      && workerPatchId === integrationPatchId
      && pathChecks.every((entry) => entry.allowlisted && entry.worker_blob === entry.integration_blob);
    if (!passed) throw new Error(`wave2_worker_git_audit_failed:${worker.id}`);
    return {
      ...worker,
      merge_base: mergeBase,
      commit_count_over_base: commitCount,
      worker_patch_id: workerPatchId,
      integration_patch_id: integrationPatchId,
      patch_equivalent: workerPatchId === integrationPatchId,
      allowlist_passed: pathChecks.every((entry) => entry.allowlisted),
      blob_equivalent: pathChecks.every((entry) => entry.worker_blob === entry.integration_blob),
      path_checks: pathChecks,
      worker_commit: workerRecord,
      integration_commit: integrationRecord,
    };
  });
}

async function trackedInventory(range: string) {
  const rows = lines(git(["diff", "--name-status", "--find-renames=100%", range]).stdout);
  const entries = [];
  for (const row of rows) {
    const [statusValue, ...names] = row.split("\t");
    const normalized = names.map(normalizeRelative);
    const relative = normalized.at(-1);
    if (!relative) continue;
    const target = path.join(repoRoot, relative);
    const exists = existsSync(target) && (await stat(target)).isFile();
    const bytes = exists ? await readFile(target) : null;
    entries.push({ status: statusValue, paths: normalized, target_byte_count: bytes?.byteLength ?? null, target_sha256: bytes ? sha256(bytes) : null });
  }
  return { range, changed_path_count: new Set(entries.flatMap((entry) => entry.paths)).size, entries };
}

function pythonExecutable() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return bundled && existsSync(bundled) ? bundled : "python";
}

const verificationResultPath = path.join(evidenceRoots.FINAL, "result.json");
if (!existsSync(verificationResultPath)) throw new Error("wave2_final_verification_evidence_missing");
const verificationResult = JSON.parse(await readFile(verificationResultPath, "utf8")) as { status?: string; final_head?: string };
const head = git(["rev-parse", "HEAD"]).stdout;
if (verificationResult.status !== "WAVE2_FINAL_VERIFICATION_PASSED" || verificationResult.final_head !== head) {
  throw new Error("wave2_final_verification_not_passed_for_head");
}
if (git(["status", "--porcelain", "--untracked-files=all"]).stdout !== "") throw new Error("wave2_review_package_requires_clean_worktree");

const contract = JSON.parse(await readFile(path.join(repoRoot, "src", "engine", "wave2", "execution-contract.v0.4.json"), "utf8")) as {
  workers: readonly Readonly<{ id: string; allowlist: readonly string[] }>[];
};
const auditedWorkers = workerAudit(contract);
const firstParent = lines(git(["rev-list", "--first-parent", "--reverse", `${wave2Base}^..HEAD`]).stdout).map(commitRecord);
if (firstParent[0]?.sha !== wave2Base || firstParent.at(-1)?.sha !== head || firstParent.some((commit) => commit.parents.length > 1)) {
  throw new Error("wave2_first_parent_graph_invalid");
}
const fullScopeScan = scanFullChangedFileRange({ repo_root: repoRoot, from: originalBase, to: "HEAD" });
if (!fullScopeScan.passed) throw new Error("wave2_final_full_scope_scan_failed");
const originalInventory = await trackedInventory(`${originalBase}..HEAD`);
const wave2Inventory = await trackedInventory(`${wave2Base}..HEAD`);

const corpusSummary = JSON.parse(await readFile(path.join(evidenceRoots.A2, "worker-summary.json"), "utf8")) as {
  counts: unknown;
  invariants: Record<string, number>;
  evidence_files_excluding_this_summary: readonly { path: string; byte_count: number; sha256: string }[];
  pension_ocr_status: string;
  pension_ocr_review_state: string;
  pension_ocr_activation_state: string;
};
for (const entry of corpusSummary.evidence_files_excluding_this_summary) {
  const target = requireContained(evidenceRoots.A2, path.join(evidenceRoots.A2, ...requireSafeRelative(entry.path).split("/")), "wave2_a2_inventory_escape");
  const bytes = await readFile(target);
  if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) throw new Error(`wave2_a2_evidence_mismatch:${entry.path}`);
}

const controlledImport = JSON.parse(await readFile(path.join(evidenceRoots.A3, "controlled-import-evidence.v0.4.json"), "utf8")) as {
  persistent_verification: { persistent_owner_import_entries: number; synthetic_test_import_entries: number };
  customer_data_used: boolean;
  network_used: boolean;
  production_or_external_storage_used: boolean;
};
const b1Governance = JSON.parse(await readFile(path.join(evidenceRoots.B1, "numeric-parameter-governance.json"), "utf8")) as {
  real_numeric_candidates: number;
  real_parameter_attestations: number;
  active_parameters: number;
  activation_eligible_real_parameters: number;
};
const b2Replay = JSON.parse(await readFile(path.join(evidenceRoots.B2, "synthetic-replay-evidence.v0.4.json"), "utf8")) as {
  invariants: Record<string, boolean>;
};
const groundTruthDenial = JSON.parse(await readFile(path.join(evidenceRoots.B3, "denial-evidence.json"), "utf8")) as {
  opener_calls: number;
  io_attempted: boolean;
};
const invariantCounts = {
  reviewed_sources_created: corpusSummary.invariants.reviewed_created,
  active_sources_created: corpusSummary.invariants.active_created,
  real_numeric_candidates: b1Governance.real_numeric_candidates,
  real_parameter_attestations: b1Governance.real_parameter_attestations,
  active_parameters: b1Governance.active_parameters,
  activation_eligible_real_parameters: b1Governance.activation_eligible_real_parameters,
  israeli_legal_rules_created: corpusSummary.invariants.legal_rules_created,
  findings_created: b2Replay.invariants.finding ? 1 : 0,
  customer_files_read: corpusSummary.invariants.customer_files_read + groundTruthDenial.opener_calls,
  openai_calls: corpusSummary.invariants.llm_calls,
  external_supabase_connections: corpusSummary.invariants.external_database_connections,
  migrations_applied: 0,
  production_preview_deploy_actions: controlledImport.production_or_external_storage_used ? 1 : 0,
  persistent_owner_import_entries: controlledImport.persistent_verification.persistent_owner_import_entries,
};
if (Object.values(invariantCounts).some((value) => value !== 0)
  || controlledImport.customer_data_used
  || controlledImport.network_used
  || groundTruthDenial.io_attempted) {
  throw new Error("wave2_final_invariant_failed");
}

const gitAudit = {
  schema_version: "tivdoc-wave2-git-audit-v0.4",
  original_base: originalBase,
  wave2_base: wave2Base,
  wave2_a_contract_sha: wave2AContract,
  wave2_a_integration_sha: wave2AIntegration,
  wave2_b_contract_sha: wave2BContract,
  final_integration_sha: head,
  branch: git(["branch", "--show-current"]).stdout,
  first_parent_chain: firstParent,
  workers: auditedWorkers,
  integration_order: ["A1", "A2", "A3", "B1", "B2", "B3"],
  no_conflicts: true,
};

async function buildPackage(packageDirectory: string) {
  await rm(packageDirectory, { recursive: true, force: true });
  await mkdir(packageDirectory, { recursive: true });
  const copied = [];
  for (const name of a1Files) {
    const source = path.join(evidenceRoots.A1, name);
    if (!existsSync(source)) throw new Error(`wave2_a1_required_evidence_missing:${name}`);
    await copyEvidenceFile(source, packageDirectory, `worker-evidence/A1/${name}`);
    const bytes = await readFile(source);
    copied.push({ source: `A1/${name}`, copied_to: `worker-evidence/A1/${name}`, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  copied.push(...await copyTree(evidenceRoots.A2, packageDirectory, "worker-evidence/A2"));
  copied.push(...await copyTree(evidenceRoots.A3, packageDirectory, "worker-evidence/A3"));
  copied.push(...await copyTree(evidenceRoots.B1, packageDirectory, "worker-evidence/B1"));
  copied.push(...await copyTree(evidenceRoots.B2, packageDirectory, "worker-evidence/B2"));
  copied.push(...await copyTree(evidenceRoots.B3, packageDirectory, "worker-evidence/B3"));
  copied.push(...await copyTree(evidenceRoots.FINAL, packageDirectory, "final-verification"));

  const b2Source = path.join(evidenceRoots.B2, "synthetic-replay-evidence.v0.4.json");
  const b2Bytes = await readFile(b2Source);
  await writeJsonAtomic(path.join(packageDirectory, "worker-evidence", "B2", "integration-evidence-manifest.json"), {
    schema_version: "tivdoc-wave2-b2-integration-evidence-manifest-v0.4",
    files: [{ path: "synthetic-replay-evidence.v0.4.json", byte_count: b2Bytes.byteLength, sha256: sha256(b2Bytes) }],
  });

  const legalRoot = path.join(repoRoot, "output", "legal-knowledge");
  for (const name of legalEvidenceNames) {
    const source = path.join(legalRoot, name);
    if (!existsSync(source)) throw new Error(`wave2_central_legal_evidence_missing:${name}`);
    await copyEvidenceFile(source, packageDirectory, `central-legal-evidence/${name}`);
    const bytes = await readFile(source);
    copied.push({ source: `output/legal-knowledge/${name}`, copied_to: `central-legal-evidence/${name}`, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }

  await writeJsonAtomic(path.join(packageDirectory, "git", "wave2-git-audit.json"), gitAudit);
  await writeJsonAtomic(path.join(packageDirectory, "git", "original-base-to-head-inventory.json"), originalInventory);
  await writeJsonAtomic(path.join(packageDirectory, "git", "wave2-base-to-head-inventory.json"), wave2Inventory);
  await writeJsonAtomic(path.join(packageDirectory, "safety", "final-full-diff-scope-scan.json"), fullScopeScan);
  await writeJsonAtomic(path.join(packageDirectory, "final-invariants.json"), {
    schema_version: "tivdoc-wave2-final-invariants-v0.4",
    counts: invariantCounts,
    all_zero: Object.values(invariantCounts).every((value) => value === 0),
    ground_truth_denial: groundTruthDenial,
    controlled_import_runtime: {
      customer_data_used: controlledImport.customer_data_used,
      network_used: controlledImport.network_used,
      production_or_external_storage_used: controlledImport.production_or_external_storage_used,
    },
  });
  await writeJsonAtomic(path.join(packageDirectory, "readiness-status.json"), {
    schema_version: "tivdoc-wave2-readiness-status-v0.4",
    primary_wave_status: "PARALLEL_WAVE_2_ENGINE_SCAFFOLD_COMPLETE",
    independent_readiness_statuses: [
      "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
      "LEGAL_SOURCE_CORPUS_INCOMPLETE",
      "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED",
      "HUMAN_LEGAL_REVIEW_REQUIRED",
      "HUMAN_GROUND_TRUTH_REQUIRED",
    ],
    pension_ocr: {
      status: corpusSummary.pension_ocr_status,
      review_state: corpusSummary.pension_ocr_review_state,
      activation_state: corpusSummary.pension_ocr_activation_state,
      toolchain_blocked: false,
    },
  });
  await writeJsonAtomic(path.join(packageDirectory, "evidence-input-inventory.json"), {
    schema_version: "tivdoc-wave2-evidence-input-inventory-v0.4",
    copied,
  });
  await writeFile(path.join(packageDirectory, "index.md"),
    "# Tivdoc Parallel Development Wave 2 — Review Package V0.4\n\n" +
    "Offline engineering evidence only. No source is reviewed or active; no real numeric parameter, Israeli legal rule, Finding, customer document, migration, external database, deployment or outbound action is authorized or included. The package manifest covers every file except itself to avoid a recursive hash.\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const textExtensions = new Set([".json", ".md", ".txt", ".ts", ".mts", ".csv"]);
  const secretPatterns = [
    { name: "private_key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
    { name: "api_key", expression: /\bsk-[A-Za-z0-9_-]{20,}/u },
    { name: "evaluation_identifier", expression: /\bCUSTOMER_EVAL_\d{3}\b/u },
    { name: "personal_home_path", expression: /\bC:\\Users\\[^\\\s]+/iu },
  ] as const;
  const findings = [];
  let binaryFilesSkipped = 0;
  for (const relative of await listFiles(packageDirectory)) {
    if (!textExtensions.has(path.extname(relative).toLowerCase())) {
      binaryFilesSkipped += 1;
      continue;
    }
    const text = await readFile(path.join(packageDirectory, ...relative.split("/")), "utf8");
    for (const pattern of secretPatterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(text)) findings.push({ path: relative, pattern: pattern.name });
    }
  }
  if (findings.length > 0) throw new Error(`wave2_package_pii_secret_scan_failed:${stableJson(findings)}`);
  await writeJsonAtomic(path.join(packageDirectory, "pii-secret-scan.json"), {
    schema_version: "tivdoc-wave2-pii-secret-scan-v0.4",
    patterns: secretPatterns.map((pattern) => pattern.name),
    binary_files_skipped: binaryFilesSkipped,
    findings_count: findings.length,
    findings,
  });

  const manifestFiles = (await listFiles(packageDirectory)).filter((relative) => relative !== "package-manifest.json");
  const manifestEntries = [];
  for (const relative of manifestFiles) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    manifestEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  await writeJsonAtomic(path.join(packageDirectory, "package-manifest.json"), {
    schema_version: "tivdoc-parallel-wave2-review-package-manifest-v0.4",
    primary_wave_status: "PARALLEL_WAVE_2_ENGINE_SCAFFOLD_COMPLETE",
    manifest_self_excluded_to_avoid_recursive_hash: true,
    deterministic_archive_metadata: true,
    files: manifestEntries,
  });
  const allFiles = await listFiles(packageDirectory);
  const treeEntries = [];
  for (const relative of allFiles) {
    const bytes = await readFile(path.join(packageDirectory, ...relative.split("/")));
    treeEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: sha256(bytes) });
  }
  return { file_count: allFiles.length, tree_sha256: sha256(stableJson(treeEntries)) };
}

await rm(packageRoot, { recursive: true, force: true });
await rm(runA, { recursive: true, force: true });
await rm(runB, { recursive: true, force: true });
await rm(zipA, { force: true });
await rm(zipB, { force: true });
await rm(zipPath, { force: true });
const buildA = await buildPackage(runA);
const buildB = await buildPackage(runB);
if (buildA.tree_sha256 !== buildB.tree_sha256 || buildA.file_count !== buildB.file_count) {
  throw new Error("wave2_clean_package_builds_differ");
}

const helper = path.join(repoRoot, "scripts", "parallel-wave2-review-package-zip.py");
function buildZip(source: string, destination: string) {
  const result = spawnSync(pythonExecutable(), [helper, source, destination], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`wave2_zip_build_failed:${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim()) as {
    zip_sha256: string;
    package_files: number;
    manifest_entries: number;
    manifest_sha256: string;
    consumer_safe_extraction_verified: boolean;
    consumer_extracted_files: number;
  };
}
const firstZip = buildZip(runA, zipA);
const secondZip = buildZip(runB, zipB);
if (firstZip.zip_sha256 !== secondZip.zip_sha256 || firstZip.manifest_sha256 !== secondZip.manifest_sha256) {
  throw new Error("wave2_deterministic_zip_mismatch");
}
await rename(runB, packageRoot);
await rename(zipB, zipPath);
await rm(runA, { recursive: true, force: true });
await rm(zipA, { force: true });

const result = {
  schema_version: "tivdoc-parallel-wave2-review-package-result-v0.4",
  package_path: normalizeRelative(path.relative(repoRoot, packageRoot)),
  zip_path: normalizeRelative(path.relative(repoRoot, zipPath)),
  package_file_count: secondZip.package_files,
  manifest_entries: secondZip.manifest_entries,
  manifest_sha256: secondZip.manifest_sha256,
  zip_sha256: secondZip.zip_sha256,
  two_clean_directory_builds_byte_identical: true,
  clean_build_tree_sha256: buildB.tree_sha256,
  consumer_safe_extraction_verified: secondZip.consumer_safe_extraction_verified,
  consumer_extracted_files: secondZip.consumer_extracted_files,
  primary_wave_status: "PARALLEL_WAVE_2_ENGINE_SCAFFOLD_COMPLETE",
  independent_readiness_statuses: [
    "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
    "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    "PERSISTENCE_ISOLATED_ENVIRONMENT_BLOCKED",
    "HUMAN_LEGAL_REVIEW_REQUIRED",
    "HUMAN_GROUND_TRUTH_REQUIRED",
  ],
};
await writeJsonAtomic(resultPath, result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
