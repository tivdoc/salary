import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-1");
const packageRoot = path.join(outputRoot, "review-package-v0.3");
const zipPath = path.join(outputRoot, "review-package-v0.3.zip");
const resultPath = path.join(outputRoot, "review-package-v0.3-result.json");
const originalBase = "e978ae5cee4a92f20dcc7db448b275170b8bf724";

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") {
  throw new Error("parallel_wave1_review_package_must_run_offline");
}
if (path.relative(outputRoot, packageRoot).replaceAll("\\", "/") !== "review-package-v0.3") {
  throw new Error("review_package_path_escape");
}

const evidenceRoots = [
  {
    id: "batch-a-pension-convalescence",
    root: path.join(outputRoot, "worker-evidence", "batch-a-pension-convalescence"),
    required: true,
  },
  {
    id: "batch-a-working-time-permits",
    root: "C:\\dev\\tivdoc-wave1-working-time-permits\\output\\legal-knowledge\\wave1-working-time-permits",
    required: true,
  },
  {
    id: "batch-b-persistence-isolated",
    root: "C:\\dev\\tivdoc-wave1-persistence-isolated\\output\\parallel-wave-1\\persistence-isolated",
    required: true,
    expected: {
      "verification.json": "6a185ade7ae8d623d93a15b473583e52f010ec74637399f645085d4c75004982",
    },
  },
] as const;

const centralEvidenceNames = [
  "acquisition-readiness-report.json",
  "artifact-inventory.json",
  "citation-round-trip-report.json",
  "clean-room-reproducibility-report.json",
  "corpus-readiness-report.json",
  "coverage-report.json",
  "legal-source-status.json",
  "source-byte-diff-report.json",
  "temporal-coverage-report.json",
] as const;

function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(root: string, target: string) {
  const relative = path.relative(root, target).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`evidence_path_escape:${relative}`);
  }
  return relative;
}

async function listFiles(root: string) {
  const files: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`evidence_symlink_rejected:${target}`);
      if (info.isDirectory()) await visit(target);
      else if (info.isFile()) files.push(safeRelative(root, target));
    }
  }
  await visit(root);
  return files.sort();
}

async function atomicWrite(target: string, bytes: Uint8Array | string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rm(target, { force: true });
  await rename(temporary, target);
}

async function writeJson(target: string, value: unknown) {
  await atomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git_evidence_failed:${args.join(" ")}`);
  return result.stdout.trim();
}

function pythonExecutable() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  return bundled && existsSync(bundled) ? bundled : "python";
}

await rm(packageRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(packageRoot, { recursive: true });

const inputInventory: Array<{
  evidence_root: string;
  path: string;
  byte_count: number;
  sha256: string;
  copied_to: string;
}> = [];

for (const source of evidenceRoots) {
  if (!existsSync(source.root)) {
    if (source.required) throw new Error(`required_evidence_root_missing:${source.id}`);
    continue;
  }
  for (const relative of await listFiles(source.root)) {
    const input = path.join(source.root, relative);
    const bytes = await readFile(input);
    const expected = "expected" in source
      ? (source.expected as Record<string, string>)[relative]
      : undefined;
    if (expected && expected !== hash(bytes)) throw new Error(`required_evidence_hash_mismatch:${source.id}:${relative}`);
    const copiedTo = `worker-evidence/${source.id}/${relative}`;
    const output = path.join(packageRoot, ...copiedTo.split("/"));
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(input, output);
    inputInventory.push({
      evidence_root: source.id,
      path: relative,
      byte_count: bytes.byteLength,
      sha256: hash(bytes),
      copied_to: copiedTo,
    });
  }
}

const centralEvidence: Array<{ path: string; byte_count: number; sha256: string; copied_to: string }> = [];
const legalOutputRoot = path.join(repoRoot, "output", "legal-knowledge");
for (const name of centralEvidenceNames) {
  const input = path.join(legalOutputRoot, name);
  if (!existsSync(input)) continue;
  const bytes = await readFile(input);
  const copiedTo = `central-legal-evidence/${name}`;
  await atomicWrite(path.join(packageRoot, copiedTo), bytes);
  centralEvidence.push({ path: `output/legal-knowledge/${name}`, byte_count: bytes.byteLength, sha256: hash(bytes), copied_to: copiedTo });
}

const changedFiles = git(["diff", "--name-only", `${originalBase}..HEAD`]).split(/\r?\n/u).filter(Boolean).sort();
const trackedInventory = [];
for (const relative of changedFiles) {
  const target = path.join(repoRoot, relative);
  if (!existsSync(target) || !(await stat(target)).isFile()) continue;
  const bytes = await readFile(target);
  trackedInventory.push({ path: relative.replaceAll("\\", "/"), byte_count: bytes.byteLength, sha256: hash(bytes) });
}

const worktreeLines = git(["worktree", "list", "--porcelain"])
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("worktree ") || line.startsWith("HEAD ") || line.startsWith("branch "));
const gitEvidence = {
  original_base: originalBase,
  branch: git(["branch", "--show-current"]),
  head: git(["rev-parse", "HEAD"]),
  wave_a_integration_sha: "34a4bff98a1ae8771a932916ece4e2a408d7e501",
  worker_commits: {
    batch_a: [
      "aa1697c772c7fc3379a9bdb4edfae92c00b4303b",
      "c950887baeac64b05adf05932eab5518a5694aac",
      "18fa155490ef347aa92611861cbf1e20fbbd70d8",
    ],
    batch_b: [
      "3d0763f72301b69ddd949730e619e0ff9051dddf",
      "4f6667d32f297b74536799c0c0142e21259377cc",
      "215d9bc443ca9119e67034e165ebabaaae246c6e",
    ],
  },
  integration_order: [
    "controlled-import-security",
    "pension-convalescence",
    "working-time-permits",
    "batch-a-integration",
    "temporal-review-governance",
    "persistence-isolated",
    "rule-runtime-synthetic",
    "final-integration",
  ],
  worktrees: worktreeLines,
  clean_status: git(["status", "--porcelain"]) === "",
  base_is_ancestor: spawnSync("git", ["merge-base", "--is-ancestor", originalBase, "HEAD"], { cwd: repoRoot, windowsHide: true }).status === 0,
};

await writeJson(path.join(packageRoot, "git-evidence.json"), gitEvidence);
await writeJson(path.join(packageRoot, "input-output-inventory.json"), {
  schema_version: "parallel-wave1-input-output-inventory-v0.3.1",
  copied_worker_evidence: inputInventory,
  copied_central_evidence: centralEvidence,
  tracked_wave_files: trackedInventory,
});

const reproducibilityPath = path.join(legalOutputRoot, "clean-room-reproducibility-report.json");
const reproducibility = existsSync(reproducibilityPath)
  ? JSON.parse(await readFile(reproducibilityPath, "utf8"))
  : { status: "missing" };
await writeJson(path.join(packageRoot, "reproducibility-and-recovery.json"), {
  schema_version: "parallel-wave1-reproducibility-recovery-v0.3.1",
  legal_clean_room_report: reproducibility,
  clean_directories: [
    "output/legal-knowledge/reproducibility/run-a",
    "output/legal-knowledge/reproducibility/run-b",
  ],
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  controls: {
    stale_output_cleanup: "package directory and prior ZIP removed before every build",
    hash_mismatch: "all copied evidence is hashed; required persistence evidence is pinned",
    interrupted_build: "package files and ZIP use temporary files with atomic rename/replace",
    atomic_recovery: "controlled-import tests prove uncommitted artifacts remain unreachable",
    deterministic_archive: "two independent fixed-timestamp ZIP builds must have identical SHA-256",
  },
});

const scopeSource = path.join(outputRoot, "scope-scan.json");
if (!existsSync(scopeSource)) throw new Error("scope_scan_evidence_missing");
const scopeBytes = await readFile(scopeSource);
const scope = JSON.parse(scopeBytes.toString("utf8"));
if (scope.findings_count !== 0) throw new Error("scope_scan_not_clean");
await atomicWrite(path.join(packageRoot, "scope-scan.json"), scopeBytes);

await atomicWrite(
  path.join(packageRoot, "index.md"),
  "# Tivdoc Parallel Development Wave 1 — Review Package V0.3\n\n" +
    "This offline evidence package contains no customer documents, no owner import simulation, no active source, no legal approval, no numeric legal parameter, and no operative Israeli legal rule. Persistence remains environment-blocked unless a separately approved isolated target is supplied. Corpus status is LEGAL_SOURCE_CORPUS_INCOMPLETE.\n",
);

const textExtensions = new Set([".json", ".md", ".txt", ".ts", ".mts", ".csv"]);
const secretPatterns = [
  { name: "private_key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: "OpenAI_key", expression: /\bsk-[A-Za-z0-9_-]{20,}/u },
  { name: "service_role_secret", expression: /\b(?:SUPABASE_SERVICE_ROLE_KEY|service_role_key)\s*[:=]\s*["'][^"']+/iu },
  { name: "customer_evaluation_identifier", expression: /\bCUSTOMER_EVAL_\d{3}\b/u },
  { name: "personal_home_path", expression: /\bC:\\Users\\[^\\\s]+/iu },
] as const;
const scanFindings: Array<{ path: string; pattern: string }> = [];
let binaryFilesSkipped = 0;
for (const relative of await listFiles(packageRoot)) {
  if (!textExtensions.has(path.extname(relative).toLowerCase())) {
    binaryFilesSkipped += 1;
    continue;
  }
  const text = await readFile(path.join(packageRoot, relative), "utf8");
  for (const pattern of secretPatterns) {
    pattern.expression.lastIndex = 0;
    if (pattern.expression.test(text)) scanFindings.push({ path: relative, pattern: pattern.name });
  }
}
const scanReport = {
  schema_version: "parallel-wave1-pii-secret-scan-v0.3.1",
  patterns: secretPatterns.map((item) => item.name),
  binary_files_skipped: binaryFilesSkipped,
  findings_count: scanFindings.length,
  findings: scanFindings,
  note: "Binary official-source artifacts are hash-inventoried; the scan does not classify public legal-document content as customer PII.",
};
if (scanFindings.length > 0) throw new Error("review_package_pii_secret_scan_failed");
await writeJson(path.join(packageRoot, "pii-secret-scan.json"), scanReport);

const manifestFiles = (await listFiles(packageRoot)).filter((relative) => relative !== "package-manifest.json");
const manifestEntries = [];
for (const relative of manifestFiles) {
  const bytes = await readFile(path.join(packageRoot, relative));
  manifestEntries.push({ path: relative, byte_count: bytes.byteLength, sha256: hash(bytes) });
}
await writeJson(path.join(packageRoot, "package-manifest.json"), {
  schema_version: "parallel-wave1-review-package-manifest-v0.3.1",
  package_status: "PARALLEL_WAVE_1_PARTIAL",
  acquisition_status: "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
  corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
  deterministic_archive_metadata: true,
  manifest_self_excluded_to_avoid_recursive_hash: true,
  files: manifestEntries,
});

const zipHelper = path.join(repoRoot, "scripts", "parallel-wave1-review-package-zip.py");
const zip = spawnSync(pythonExecutable(), [zipHelper, packageRoot, zipPath], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
});
if (zip.status !== 0) throw new Error(`parallel_wave1_zip_failed:${zip.stderr.trim()}`);
const zipResult = JSON.parse(zip.stdout.trim());
const result = {
  schema_version: "parallel-wave1-review-package-result-v0.3.1",
  package_path: path.relative(repoRoot, packageRoot).replaceAll("\\", "/"),
  zip_path: path.relative(repoRoot, zipPath).replaceAll("\\", "/"),
  copied_evidence_files: inputInventory.length + centralEvidence.length,
  package_file_count: zipResult.package_files,
  manifest_entries: zipResult.manifest_entries,
  manifest_sha256: zipResult.manifest_sha256,
  zip_sha256: zipResult.zip_sha256,
  deterministic_second_build_match: zipResult.deterministic_second_build_match,
  consumer_safe_extraction_verified: zipResult.consumer_safe_extraction_verified,
  pii_secret_findings: scanReport.findings_count,
  acquisition_status: "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
  corpus_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
};
await writeJson(resultPath, result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
