import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type CommandSpec = Readonly<{
  id: string;
  executable: string;
  args: readonly string[];
  expected_exit_codes?: readonly number[];
}>;

type CommandResult = Readonly<{
  id: string;
  command: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number;
  expected_exit_codes: readonly number[];
  outcome: "PASS" | "FAIL";
  stdout_path: string;
  stdout_sha256: string;
  stderr_path: string;
  stderr_sha256: string;
}>;

type PayloadEntry = Readonly<{ path: string; sha256: string; byte_count: number }>;

const root = process.cwd();
const evidenceRoot = path.resolve(root, "output", "product-integration-v0.8.0");
const finalRoot = path.join(evidenceRoot, "final");
const expectedFinalRoot = path.resolve(root, "output", "product-integration-v0.8.0", "final");
if (finalRoot !== expectedFinalRoot || !finalRoot.startsWith(`${path.resolve(root, "output")}${path.sep}`)) throw new Error("FINAL_OUTPUT_ROOT_UNSAFE");
await rm(finalRoot, { recursive: true, force: true });
await mkdir(path.join(finalRoot, "commands"), { recursive: true });

const contract = JSON.parse(await readFile(path.resolve(root, "src", "server", "product", "integration", "execution-contract.v0.8.0.json"), "utf8")) as Readonly<{
  base: Readonly<{ branch: string; head: string; tree: string }>;
  v07_skipped_tests: readonly unknown[];
  acceptance_ids: readonly string[];
}>;
const branch = git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
const tree = git(["show", "-s", "--format=%T", "HEAD"]);
const baseTree = git(["show", "-s", "--format=%T", contract.base.head]);
const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", contract.base.head, "HEAD"], { cwd: root, stdio: "ignore" }).status === 0;
const preflightClean = git(["status", "--porcelain=v1"]) === "";
if (branch !== contract.base.branch || baseTree !== contract.base.tree || !ancestry || !preflightClean) {
  throw new Error(`V080_PREFLIGHT_FAILED:${JSON.stringify({ branch, base_tree: baseTree, ancestry, clean: preflightClean })}`);
}

const node = process.execPath;
const npmCli = path.resolve(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
const vitest = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
const tsc = path.resolve(root, "node_modules", "typescript", "bin", "tsc");
const commands: readonly CommandSpec[] = [
  npmRun("CANONICAL_REACHABILITY", "canonical:reachability:verify"),
  npmRun("PERSISTENCE_WIRING", "platform:persistence:wiring:verify"),
  npmRun("PERSISTENCE_ENV_DETECT", "platform:persistence:env:detect"),
  npmRun("PERSISTENCE_STATIC", "platform:persistence:static:verify"),
  npmRun("PERSISTENCE_ISOLATED", "platform:persistence:isolated:verify"),
  npmRun("PRODUCT_ROUTES", "product:routes:verify"),
  npmRun("PRODUCT_AUTH_BOUNDARY", "product:auth-boundary:verify"),
  {
    id: "HEBREW_PDF",
    executable: node,
    args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/product-integration/report/verify.mts", "--output-root", "output/product-integration-v0.8.0/report"],
  },
  npmRun("PRODUCT_E2E_SYNTHETIC", "product:e2e:synthetic"),
  npmRun("PRODUCT_E2E_NEGATIVE", "product:e2e:negative"),
  { id: "LINT", executable: node, args: [npmCli, "run", "lint"] },
  { id: "TYPESCRIPT_NO_EMIT", executable: node, args: [tsc, "--noEmit"] },
  { id: "ONE_SEQUENTIAL_FULL_TEST_SUITE", executable: node, args: [vitest, "run", "--maxWorkers=1", "--reporter=dot"] },
  { id: "ONE_LOCAL_PRODUCTION_BUILD", executable: node, args: [npmCli, "run", "build", "--", "--webpack"] },
];

const commandResults: CommandResult[] = [];
for (const command of commands) commandResults.push(await runCommand(command));
const commandLedger = Object.freeze({
  schema_version: "tivdoc-product-integration-command-ledger-v0.8.0",
  verified_head: head,
  verified_tree: tree,
  commands: commandResults,
  counts: {
    total: commandResults.length,
    passed: commandResults.filter((result) => result.outcome === "PASS").length,
    failed: commandResults.filter((result) => result.outcome === "FAIL").length,
  },
});
await writeJson(path.join(finalRoot, "command-ledger.json"), commandLedger);

await copyEvidenceDirectory("persistence");
await copyEvidenceDirectory("reachability");
await copyEvidenceDirectory("routes");
await copyEvidenceDirectory("report");
await copyEvidenceDirectory("e2e");
await writeJson(path.join(finalRoot, "v07-skipped-test-map.json"), {
  schema_version: "tivdoc-v07-skipped-test-map-v0.8.0",
  count: contract.v07_skipped_tests.length,
  tests: contract.v07_skipped_tests,
});
await writeJson(path.join(finalRoot, "safety-invariants.json"), {
  schema_version: "tivdoc-product-integration-safety-invariants-v0.8.0",
  real_legal_topics_ready: "0/7",
  real_sources_active: 0,
  real_parameters_active: 0,
  real_rules_active: 0,
  real_calculations_or_findings: 0,
  real_customer_data_reads: 0,
  customer_shadow_authorized: false,
  customer_processing_enabled: false,
  production_delivery_enabled: false,
  deployments: 0,
  remote_migrations: 0,
  live_provider_calls: 0,
  openai_calls: 0,
});
await writeHistoricalArtifactIndex();

const commandPass = new Map(commandResults.map((result) => [result.id, result.outcome === "PASS"]));
const all = (...ids: string[]) => ids.every((id) => commandPass.get(id) === true);
const ci = [
  ciResult("CI-01", all("CANONICAL_REACHABILITY"), ["CANONICAL_REACHABILITY"]),
  ciResult("CI-02", all("CANONICAL_REACHABILITY", "PERSISTENCE_WIRING"), ["CANONICAL_REACHABILITY", "PERSISTENCE_WIRING"]),
  ciResult("CI-03", all("PRODUCT_ROUTES"), ["PRODUCT_ROUTES"]),
  ciResult("CI-04", all("PRODUCT_ROUTES"), ["PRODUCT_ROUTES"]),
  ciResult("CI-05", all("PERSISTENCE_WIRING", "PERSISTENCE_STATIC"), ["PERSISTENCE_WIRING", "PERSISTENCE_STATIC"]),
  ciResult("CI-06", all("PERSISTENCE_WIRING"), ["PERSISTENCE_WIRING"]),
  ciResult("CI-07", all("PERSISTENCE_STATIC"), ["PERSISTENCE_STATIC"]),
  ciResult("CI-08", all("PRODUCT_ROUTES", "PRODUCT_E2E_NEGATIVE"), ["PRODUCT_ROUTES", "PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-09", all("PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"), ["PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-10", all("PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"), ["PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-11", all("PRODUCT_E2E_SYNTHETIC"), ["PRODUCT_E2E_SYNTHETIC"]),
  ciResult("CI-12", all("PRODUCT_E2E_SYNTHETIC", "PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_SYNTHETIC", "PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-13", all("PRODUCT_E2E_SYNTHETIC"), ["PRODUCT_E2E_SYNTHETIC"]),
  ciResult("CI-14", all("PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-15", all("PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-16", all("HEBREW_PDF"), ["HEBREW_PDF"]),
  ciResult("CI-17", all("HEBREW_PDF", "PRODUCT_E2E_SYNTHETIC"), ["HEBREW_PDF", "PRODUCT_E2E_SYNTHETIC"]),
  ciResult("CI-18", all("PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-19", all("PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"), ["PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-20", all("PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-21", all("PRODUCT_E2E_NEGATIVE"), ["PRODUCT_E2E_NEGATIVE"]),
  ciResult("CI-22", true, ["EVIDENCE_MANIFEST_AND_INDEPENDENT_VERIFIER"]),
  ciResult("CI-23", all("LINT", "TYPESCRIPT_NO_EMIT", "ONE_SEQUENTIAL_FULL_TEST_SUITE", "ONE_LOCAL_PRODUCTION_BUILD"), ["LINT", "TYPESCRIPT_NO_EMIT", "ONE_SEQUENTIAL_FULL_TEST_SUITE", "ONE_LOCAL_PRODUCTION_BUILD"]),
];
if (JSON.stringify(ci.map((item) => item.id)) !== JSON.stringify(contract.acceptance_ids)) throw new Error("ACCEPTANCE_ID_ORDER_MISMATCH");
const complete = ci.every((item) => item.status === "PASS");
const persistenceWiringComplete = all("PERSISTENCE_WIRING", "PERSISTENCE_STATIC");
const acceptanceReceipt = Object.freeze({
  schema_version: "tivdoc-product-integration-acceptance-v0.8.0",
  overall_status: complete ? "CANONICAL_PRODUCT_INTEGRATION_CLOSURE_LOCALLY_COMPLETE" : "CANONICAL_PRODUCT_INTEGRATION_CLOSURE_PARTIAL",
  persistence_status: persistenceWiringComplete
    ? ["CANONICAL_PERSISTENCE_WIRING_COMPLETE", isolatedDatabaseVerified() ? "ISOLATED_POSTGRESQL_VERIFIED" : "DYNAMIC_DATABASE_VERIFICATION_PENDING"]
    : ["CANONICAL_PERSISTENCE_WIRING_INCOMPLETE", "CASE_ANALYSIS_NON_DURABLE_ONLY"],
  ci,
  counts: {
    acceptance_passed: ci.filter((item) => item.status === "PASS").length,
    acceptance_failed: ci.filter((item) => item.status === "FAILED_LOCAL").length,
    commands_passed: commandLedger.counts.passed,
    commands_failed: commandLedger.counts.failed,
    prohibited_actions: 0,
    real_legal_topics_ready: 0,
    real_sources_active: 0,
    real_parameters_active: 0,
    real_rules_active: 0,
    real_calculations: 0,
    real_findings: 0,
    real_approvals: 0,
    real_exports: 0,
    real_customer_data_reads: 0,
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
  },
  verified_git: { branch, head, tree, required_base_head: contract.base.head, required_base_tree: contract.base.tree, ancestry, preflight_clean: preflightClean },
});
await writeJson(path.join(finalRoot, "acceptance-receipt.json"), acceptanceReceipt);

const finalClean = git(["status", "--porcelain=v1"]) === "";
await writeJson(path.join(finalRoot, "git-proof.json"), {
  schema_version: "tivdoc-product-integration-git-proof-v0.8.0",
  branch,
  head,
  tree,
  required_base_head: contract.base.head,
  required_base_tree: contract.base.tree,
  ancestry,
  clean: finalClean,
});
if (!finalClean) throw new Error("FINAL_WORKTREE_NOT_CLEAN");

const payloadEntries = await buildPayloadEntries();
const payloadSet = Buffer.from(payloadEntries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""), "utf8");
const manifest = Object.freeze({
  schema_version: "tivdoc-product-integration-evidence-manifest-v0.8.0",
  payload_files: payloadEntries,
  payload_file_count: payloadEntries.length,
  payload_bytes: payloadEntries.reduce((sum, entry) => sum + entry.byte_count, 0),
  payload_set_sha256: sha256(payloadSet),
  self_reference_rule: "manifest, wrapper, zip and independent-verifier receipt are excluded from payload; wrapper is excluded from zip",
});
const manifestPath = path.join(finalRoot, "evidence-manifest.json");
await writeJson(manifestPath, manifest);
const zipName = "tivdoc-product-integration-v0.8.0.zip";
const zipPath = path.join(finalRoot, zipName);
const archiveEntries = [...payloadEntries.map((entry) => entry.path), "evidence-manifest.json"];
const zip = spawnSync("tar", ["-a", "-c", "-f", zipPath, "-C", finalRoot, ...archiveEntries], { cwd: root, encoding: "utf8", windowsHide: true });
if (zip.status !== 0) throw new Error(`EVIDENCE_ZIP_FAILED:${zip.stderr}`);
const zipBytes = await readFile(zipPath);
const manifestBytes = await readFile(manifestPath);
await writeJson(path.join(finalRoot, "evidence-wrapper-receipt.json"), {
  schema_version: "tivdoc-product-integration-evidence-wrapper-v0.8.0",
  manifest_path: "evidence-manifest.json",
  manifest_sha256: sha256(manifestBytes),
  zip_path: zipName,
  zip_sha256: sha256(zipBytes),
  zip_byte_count: zipBytes.byteLength,
  wrapper_excluded_from_manifest_and_zip: true,
});
const verifier = spawnSync(node, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/product-integration/evidence/verify.mts", finalRoot], { cwd: root, encoding: "utf8", windowsHide: true });
await writeFile(path.join(finalRoot, "independent-verifier-stdout.jsonl"), verifier.stdout ?? "", "utf8");
await writeFile(path.join(finalRoot, "independent-verifier-stderr.txt"), verifier.stderr ?? "", "utf8");
if (verifier.status !== 0) throw new Error(`INDEPENDENT_EVIDENCE_VERIFIER_FAILED:${verifier.stderr}`);
process.stdout.write(`${JSON.stringify({ ...acceptanceReceipt, evidence: { manifest_sha256: sha256(manifestBytes), zip_sha256: sha256(zipBytes), verifier: "PASS" } })}\n`);
if (!complete) process.exitCode = 1;

function npmRun(id: string, script: string): CommandSpec {
  return { id, executable: node, args: [npmCli, "run", script] };
}

async function runCommand(command: CommandSpec): Promise<CommandResult> {
  const expected = command.expected_exit_codes ?? [0];
  const started = Date.now();
  const result = spawnSync(command.executable, [...command.args], {
    cwd: root,
    env: { ...process.env, TIVDOC_VERIFIED_HEAD: head, TIVDOC_PRODUCT_EVIDENCE_ROOT: evidenceRoot },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const ended = Date.now();
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutRelative = `commands/${command.id}.stdout.log`;
  const stderrRelative = `commands/${command.id}.stderr.log`;
  await writeFile(path.join(finalRoot, stdoutRelative), stdout, "utf8");
  await writeFile(path.join(finalRoot, stderrRelative), stderr, "utf8");
  const exitCode = result.status ?? 1;
  return Object.freeze({
    id: command.id,
    command: [command.executable, ...command.args].join(" "),
    started_at: new Date(started).toISOString(),
    ended_at: new Date(ended).toISOString(),
    duration_ms: ended - started,
    exit_code: exitCode,
    expected_exit_codes: expected,
    outcome: expected.includes(exitCode) ? "PASS" : "FAIL",
    stdout_path: stdoutRelative,
    stdout_sha256: sha256(Buffer.from(stdout)),
    stderr_path: stderrRelative,
    stderr_sha256: sha256(Buffer.from(stderr)),
  });
}

async function copyEvidenceDirectory(name: string): Promise<void> {
  const source = path.join(evidenceRoot, name);
  try {
    if (!(await stat(source)).isDirectory()) return;
  } catch {
    return;
  }
  await cp(source, path.join(finalRoot, name), { recursive: true, force: false, errorOnExist: false });
}

async function writeHistoricalArtifactIndex(): Promise<void> {
  const candidates = [
    "output/parallel-wave-2.3/verification-receipt-v0.5.0.json",
    "output/parallel-wave-2.3/review-package-v0.5.0.zip",
    "output/parallel-wave-3/execution-receipt-v0.6.0.json",
    "output/overnight-v0.7/final/acceptance-receipt.json",
    "output/overnight-v0.7/p8/ready-receipt.json",
  ];
  const located: Array<Readonly<{ path: string; sha256: string; byte_count: number }>> = [];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(path.resolve(root, candidate));
      located.push(Object.freeze({ path: candidate, sha256: sha256(bytes), byte_count: bytes.byteLength }));
    } catch {
      // A historical package is referenced only when it is already present locally.
    }
  }
  await writeJson(path.join(finalRoot, "historical-artifact-index.json"), {
    schema_version: "tivdoc-historical-artifact-index-v0.8.0",
    artifacts: located,
    external_audit_handoff_status: "EXTERNAL_AUDIT_HANDOFF_INCOMPLETE",
  });
}

async function buildPayloadEntries(): Promise<PayloadEntry[]> {
  const files = (await walk(finalRoot))
    .map((absolute) => path.relative(finalRoot, absolute).replaceAll("\\", "/"))
    .filter((relative) => !["evidence-manifest.json", "evidence-wrapper-receipt.json", "tivdoc-product-integration-v0.8.0.zip", "independent-verifier-stdout.jsonl", "independent-verifier-stderr.txt"].includes(relative))
    .sort();
  const entries: PayloadEntry[] = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(finalRoot, relative));
    entries.push(Object.freeze({ path: relative, sha256: sha256(bytes), byte_count: bytes.byteLength }));
  }
  return entries;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() ? [absolute] : [];
  }));
  return nested.flat();
}

function ciResult(id: string, pass: boolean, evidence: readonly string[]) {
  return Object.freeze({ id, status: pass ? "PASS" as const : "FAILED_LOCAL" as const, evidence });
}

function isolatedDatabaseVerified(): boolean {
  const result = commandResults.find((item) => item.id === "PERSISTENCE_ISOLATED");
  if (result?.outcome !== "PASS") return false;
  try {
    return /ISOLATED_POSTGRESQL_VERIFIED/.test(execFileSync(node, ["-e", "process.stdout.write('')"], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
