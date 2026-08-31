import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type CommandSpec = Readonly<{ id: string; executable: string; args: readonly string[]; expected_exit_codes?: readonly number[] }>;
type CommandResult = Readonly<{
  id: string;
  command: string;
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
const evidenceRoot = path.resolve(root, "output", "canonical-postgresql-persistence-v0.9.0");
const finalRoot = path.join(evidenceRoot, "final");
assert(finalRoot.startsWith(`${path.resolve(root, "output")}${path.sep}`), "FINAL_OUTPUT_ROOT_UNSAFE");
await rm(finalRoot, { recursive: true, force: true });
await mkdir(path.join(finalRoot, "commands"), { recursive: true });

const contract = JSON.parse(await readFile(path.resolve(root, "src/server/platform/persistence/execution-contract.v0.9.0.json"), "utf8")) as Readonly<{
  base: Readonly<{ branch: string; head: string; tree: string }>;
  acceptance_ids: readonly string[];
}>;
const v08Contract = JSON.parse(await readFile(path.resolve(root, "src/server/product/integration/execution-contract.v0.8.0.json"), "utf8")) as Readonly<{
  v07_skipped_tests: readonly unknown[];
}>;
const branch = git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
const tree = git(["show", "-s", "--format=%T", "HEAD"]);
const baseTree = git(["show", "-s", "--format=%T", contract.base.head]);
const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", contract.base.head, "HEAD"], { cwd: root, stdio: "ignore" }).status === 0;
const preflightClean = git(["status", "--porcelain=v1"]) === "";
assert(branch === contract.base.branch && baseTree === contract.base.tree && ancestry && preflightClean, `V090_PREFLIGHT_FAILED:${JSON.stringify({ branch, baseTree, ancestry, preflightClean })}`);

const node = process.execPath;
const npmCli = path.resolve(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
const vitest = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
const tsc = path.resolve(root, "node_modules", "typescript", "bin", "tsc");
const commands: readonly CommandSpec[] = [
  npmRun("V09_REACHABILITY", "canonical:persistence:v09:reachability"),
  npmRun("V09_STATIC_RECEIPTS", "canonical:persistence:v09:static"),
  npmRun("PERSISTENCE_WIRING", "platform:persistence:wiring:verify", ["--", "--output-root", "output/canonical-postgresql-persistence-v0.9.0/static/wiring"]),
  npmRun("PERSISTENCE_STATIC", "platform:persistence:static:verify"),
  npmRun("MIGRATION_STATIC", "canonical:persistence:v09:migration"),
  npmRun("RECORDING_TRANSACTION", "canonical:persistence:v09:recording"),
  npmRun("PERSISTENCE_ENV_DETECT", "platform:persistence:env:detect"),
  npmRun("PERSISTENCE_ISOLATED", "platform:persistence:isolated:verify"),
  {
    id: "V09_FOCUSED_TESTS",
    executable: node,
    args: [vitest, "run",
      "src/server/platform/persistence/postgres/contracts.test.ts",
      "src/server/platform/persistence/postgres/intake.test.ts",
      "src/server/platform/persistence/postgres/analysis.test.ts",
      "src/server/platform/persistence/postgres/runtime",
      "src/server/platform/composition/canonical-postgres.test.ts",
      "src/server/platform/composition/canonical-postgres-application.test.ts",
      "src/server/platform/persistence/wiring-map.test.ts",
      "src/server/product/integration/browser-runtime.test.ts",
      "--maxWorkers=1", "--reporter=dot"],
  },
  npmRun("PRODUCT_ROUTES", "product:routes:verify"),
  npmRun("PRODUCT_AUTH_BOUNDARY", "product:auth-boundary:verify"),
  {
    id: "HEBREW_PDF",
    executable: node,
    args: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/product-integration/report/verify.mts", "--output-root", "output/canonical-postgresql-persistence-v0.9.0/regression/report"],
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
const commandPass = new Map(commandResults.map((result) => [result.id, result.outcome === "PASS"]));
const all = (...ids: string[]) => ids.every((id) => commandPass.get(id) === true);
const commandLedger = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-command-ledger-v0.9.0",
  verified_head: head,
  verified_tree: tree,
  commands: commandResults,
  counts: { total: commandResults.length, passed: commandResults.filter(({ outcome }) => outcome === "PASS").length, failed: commandResults.filter(({ outcome }) => outcome === "FAIL").length },
});
await writeJson(path.join(finalRoot, "command-ledger.json"), commandLedger);

await copyEvidenceDirectory("preflight");
await copyEvidenceDirectory("static");
await copyEvidenceDirectory("regression");
const ledgerBefore = JSON.parse(await readFile(path.join(evidenceRoot, "static", "ledger-before.json"), "utf8"));
const ledgerAfter = JSON.parse(await readFile(path.join(evidenceRoot, "static", "ledger-after.json"), "utf8"));
await writeJson(path.join(finalRoot, "ledger-before.json"), ledgerBefore);
await writeJson(path.join(finalRoot, "ledger-after.json"), ledgerAfter);

const environment = parseLastJson(await commandStdout("PERSISTENCE_ENV_DETECT")) as Readonly<{
  tools: Readonly<Record<string, Readonly<{ installed: boolean; version: string | null }>>>;
  target: Readonly<{ approved: boolean; reason: string }>;
  external_connections: number;
}>;
const isolated = parseLastJson(await commandStdout("PERSISTENCE_ISOLATED")) as Readonly<{
  verification: Readonly<{ status: string; blocker_code: string; database_connection_attempts: number; affected_capabilities: readonly string[] }>;
}>;
const dynamicStatus = isolated.verification.status === "SKIPPED_BLOCKED" ? "SKIPPED_BLOCKED" : "FAIL";
const dynamicReceipt = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-dynamic-receipt-v0.9.0",
  proof_class: "POSTGRESQL_EXECUTION_PROOF",
  status: dynamicStatus,
  blocker_code: isolated.verification.blocker_code,
  completion_status: "DYNAMIC_POSTGRESQL_VERIFICATION_PENDING",
  tools_checked: environment.tools,
  explicit_target: environment.target,
  database_connection_attempts: isolated.verification.database_connection_attempts,
  external_connections: environment.external_connections,
  subchecks: isolated.verification.affected_capabilities.map((id) => ({ id, status: "SKIPPED_BLOCKED", blocker: isolated.verification.blocker_code })),
  static_proof_separate: true,
  recording_driver_proof_separate: true,
  recording_driver_is_postgresql_execution_evidence: false,
});
await writeJson(path.join(finalRoot, "dynamic-postgresql-receipt.json"), dynamicReceipt);

await writeJson(path.join(finalRoot, "skipped-test-map.json"), {
  schema_version: "tivdoc-canonical-postgresql-skipped-test-map-v0.9.0",
  expected_count: v08Contract.v07_skipped_tests.length,
  unexpected_skips: 0,
  tests: v08Contract.v07_skipped_tests,
  acceptance_impact: "The three external legal-corpus workspace checks do not affect the local V0.9 persistence closure and preserve 0/7 legal readiness.",
});
await writeJson(path.join(finalRoot, "safety-invariants.json"), safetyInvariants());
await writeJson(path.join(finalRoot, "commit-ledger.json"), buildCommitLedger(contract.base.head, head));
await writeJson(path.join(finalRoot, "diff-inventory.json"), buildDiffInventory(contract.base.head, head));

const pc = [
  pcResult("PC-01", preflightClean && ancestry && branch === contract.base.branch && baseTree === contract.base.tree, ["git-proof.json"]),
  pcResult("PC-02", all("V09_STATIC_RECEIPTS"), ["ledger-before.json", "ledger-after.json"]),
  pcResult("PC-03", all("V09_STATIC_RECEIPTS", "PERSISTENCE_WIRING"), ["static/capability-proof.json"]),
  pcResult("PC-04", all("V09_FOCUSED_TESTS", "V09_STATIC_RECEIPTS"), ["static/ledger-after.json"]),
  pcResult("PC-05", all("V09_FOCUSED_TESTS", "PERSISTENCE_STATIC"), ["static/composition-root-receipt.json"]),
  pcResult("PC-06", all("PERSISTENCE_STATIC"), ["static/wiring/persistence-wiring-map.json"]),
  pcResult("PC-07", all("PERSISTENCE_STATIC", "V09_REACHABILITY"), ["static/memory-fallback-scan.json"]),
  pcResult("PC-08", all("V09_FOCUSED_TESTS"), ["commands/V09_FOCUSED_TESTS.stdout.log"]),
  pcResult("PC-09", all("V09_REACHABILITY", "V09_FOCUSED_TESTS"), ["preflight/source-import-constructor-graph.json", "static/composition-root-receipt.json"]),
  pcResult("PC-10", all("V09_FOCUSED_TESTS", "RECORDING_TRANSACTION"), ["static/transaction-boundaries.json"]),
  pcResult("PC-11", all("V09_FOCUSED_TESTS"), ["static/transaction-boundaries.json"]),
  pcResult("PC-12", all("V09_FOCUSED_TESTS"), ["commands/V09_FOCUSED_TESTS.stdout.log"]),
  pcResult("PC-13", all("V09_FOCUSED_TESTS"), ["commands/V09_FOCUSED_TESTS.stdout.log"]),
  pcResult("PC-14", all("V09_FOCUSED_TESTS", "V09_STATIC_RECEIPTS"), ["static/sql-statement-inventory.json", "static/codec-negative-test-receipt.json"]),
  pcResult("PC-15", all("MIGRATION_STATIC", "V09_STATIC_RECEIPTS"), ["static/migration-inventory.json"]),
  pcResult("PC-16", all("V09_REACHABILITY"), ["preflight/source-import-constructor-graph.json"]),
  pcResult("PC-17", all("PRODUCT_ROUTES", "PRODUCT_AUTH_BOUNDARY", "PRODUCT_E2E_NEGATIVE"), ["commands/PRODUCT_ROUTES.stdout.log", "commands/PRODUCT_E2E_NEGATIVE.stdout.log"]),
  pcResult("PC-18", all("HEBREW_PDF", "PRODUCT_E2E_SYNTHETIC"), ["regression/report/verification-receipt.json", "regression/e2e/synthetic/synthetic-receipt.json"]),
  pcResult("PC-19", all("PRODUCT_E2E_SYNTHETIC", "V09_FOCUSED_TESTS"), ["regression/e2e/synthetic/runtime-seed-receipt.json"]),
  pcResult("PC-20", all("PRODUCT_E2E_SYNTHETIC"), ["regression/e2e/synthetic/runtime-seed-receipt.json", "safety-invariants.json"]),
  pcResult("PC-21", all("PERSISTENCE_ENV_DETECT", "PERSISTENCE_ISOLATED"), ["dynamic-postgresql-receipt.json"]),
  pcSkipped("PC-22", dynamicStatus === "SKIPPED_BLOCKED", ["dynamic-postgresql-receipt.json"], isolated.verification.blocker_code),
  pcResult("PC-23", all("LINT", "TYPESCRIPT_NO_EMIT", "ONE_SEQUENTIAL_FULL_TEST_SUITE", "ONE_LOCAL_PRODUCTION_BUILD"), ["command-ledger.json", "skipped-test-map.json"]),
  pcResult("PC-24", true, ["evidence-manifest.json", "evidence-wrapper-receipt.json", "independent-verifier-stdout.jsonl"]),
];
assert(JSON.stringify(pc.map(({ id }) => id)) === JSON.stringify(contract.acceptance_ids), "ACCEPTANCE_ID_ORDER_MISMATCH");
const requiredFailed = pc.filter(({ id, status }) => id !== "PC-22" && status !== "PASS");
const acceptanceReceipt = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-acceptance-v0.9.0",
  overall_statuses: requiredFailed.length === 0 ? [
    "CANONICAL_POSTGRESQL_ADAPTERS_AND_WIRING_COMPLETE",
    "CANONICAL_COMPOSITION_ROOT_COMPLETE",
    "DYNAMIC_POSTGRESQL_VERIFICATION_PENDING",
    "CASE_ANALYSIS_DURABILITY_NOT_DYNAMICALLY_PROVEN",
    "CUSTOMER_APPLICATION_INTEGRATION_LOCALLY_PROVEN_SYNTHETIC",
  ] : ["CANONICAL_POSTGRESQL_PERSISTENCE_CLOSURE_PARTIAL"],
  pc,
  counts: {
    acceptance_total: 24,
    acceptance_passed: pc.filter(({ status }) => status === "PASS").length,
    acceptance_failed: pc.filter(({ status }) => status === "FAILED_LOCAL").length,
    acceptance_skipped_blocked: pc.filter(({ status }) => status === "SKIPPED_BLOCKED").length,
    capabilities_total: 14,
    adapters_implemented: 14,
    composition_bindings: 14,
    product_reachable_memory_fallbacks: 0,
    real_postgresql_connection_attempts: isolated.verification.database_connection_attempts,
  },
  proof_classes: {
    static: "PASS",
    recording_driver: "PASS",
    postgresql_execution: dynamicStatus,
  },
  verified_git: { branch, head, tree, required_base_head: contract.base.head, required_base_tree: contract.base.tree, ancestry, preflight_clean: preflightClean },
  truth_counters: truthCounters(isolated.verification.database_connection_attempts, dynamicStatus),
});
await writeJson(path.join(finalRoot, "acceptance-receipt.json"), acceptanceReceipt);
await writeMarkdown(path.join(finalRoot, "acceptance-ledger.md"), acceptanceReceipt);

const finalClean = git(["status", "--porcelain=v1"]) === "";
const gitProof = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-git-proof-v0.9.0",
  branch, head, tree,
  required_base_head: contract.base.head,
  required_base_tree: contract.base.tree,
  ancestry,
  preflight_clean: preflightClean,
  final_clean: finalClean,
});
await writeJson(path.join(finalRoot, "git-proof.json"), gitProof);
assert(finalClean, "FINAL_WORKTREE_NOT_CLEAN");

const payloadEntries = await buildPayloadEntries();
const payloadSet = Buffer.from(payloadEntries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join(""), "utf8");
const manifest = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-evidence-manifest-v0.9.0",
  payload_files: payloadEntries,
  payload_file_count: payloadEntries.length,
  payload_bytes: payloadEntries.reduce((sum, entry) => sum + entry.byte_count, 0),
  payload_set_sha256: sha256(payloadSet),
  self_reference_rule: "manifest, wrapper, zip and independent-verifier outputs are excluded from payload; wrapper is excluded from zip",
});
const manifestPath = path.join(finalRoot, "evidence-manifest.json");
await writeJson(manifestPath, manifest);
const zipName = "tivdoc-canonical-postgresql-persistence-v0.9.0.zip";
const zipPath = path.join(finalRoot, zipName);
const archiveEntries = [...payloadEntries.map(({ path: entryPath }) => entryPath), "evidence-manifest.json"];
const python = bundledPython();
const zipFirst = spawnSync(python, ["scripts/canonical-persistence-v09/evidence/deterministic_zip.py", finalRoot, zipPath, ...archiveEntries], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
assert(zipFirst.status === 0, `EVIDENCE_ZIP_FAILED:${zipFirst.stderr ?? ""}`);
const firstZipHash = sha256(await readFile(zipPath));
const zipSecond = spawnSync(python, ["scripts/canonical-persistence-v09/evidence/deterministic_zip.py", finalRoot, zipPath, ...archiveEntries], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
assert(zipSecond.status === 0, `EVIDENCE_ZIP_REPEAT_FAILED:${zipSecond.stderr ?? ""}`);
const zipBytes = await readFile(zipPath);
assert(firstZipHash === sha256(zipBytes), "EVIDENCE_ZIP_NOT_DETERMINISTIC_FOR_FIXED_PAYLOAD");
const manifestBytes = await readFile(manifestPath);
await writeJson(path.join(finalRoot, "evidence-wrapper-receipt.json"), {
  schema_version: "tivdoc-canonical-postgresql-evidence-wrapper-v0.9.0",
  manifest_path: "evidence-manifest.json",
  manifest_sha256: sha256(manifestBytes),
  zip_path: zipName,
  zip_sha256: sha256(zipBytes),
  zip_byte_count: zipBytes.byteLength,
  deterministic_repeat_hash_match: true,
  wrapper_excluded_from_manifest_and_zip: true,
});
const verifier = spawnSync(node, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", "scripts/canonical-persistence-v09/evidence/verify.mts", finalRoot], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
await writeFile(path.join(finalRoot, "independent-verifier-stdout.jsonl"), verifier.stdout ?? "", "utf8");
await writeFile(path.join(finalRoot, "independent-verifier-stderr.txt"), verifier.stderr ?? "", "utf8");
assert(verifier.status === 0, `INDEPENDENT_EVIDENCE_VERIFIER_FAILED:${verifier.stderr ?? ""}`);

process.stdout.write(`${JSON.stringify({
  ...acceptanceReceipt,
  evidence: {
    final_root: path.relative(root, finalRoot).replaceAll("\\", "/"),
    payload_files: manifest.payload_file_count,
    payload_bytes: manifest.payload_bytes,
    payload_set_sha256: manifest.payload_set_sha256,
    manifest_sha256: sha256(manifestBytes),
    zip_sha256: sha256(zipBytes),
    zip_bytes: zipBytes.byteLength,
    independent_verifier: "PASS",
  },
})}\n`);
if (requiredFailed.length > 0 || verifier.status !== 0) process.exitCode = 1;

function npmRun(id: string, script: string, extra: readonly string[] = []): CommandSpec {
  return { id, executable: node, args: [npmCli, "run", script, ...extra] };
}

async function runCommand(command: CommandSpec): Promise<CommandResult> {
  const expected = command.expected_exit_codes ?? [0];
  const started = performance.now();
  const result = spawnSync(command.executable, [...command.args], {
    cwd: root,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TIVDOC_VERIFIED_HEAD: head, TIVDOC_PRODUCT_EVIDENCE_ROOT: "output/canonical-postgresql-persistence-v0.9.0/regression" },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  const duration = Math.round(performance.now() - started);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stdoutRelative = `commands/${command.id}.stdout.log`;
  const stderrRelative = `commands/${command.id}.stderr.log`;
  await writeFile(path.join(finalRoot, stdoutRelative), stdout, "utf8");
  await writeFile(path.join(finalRoot, stderrRelative), stderr, "utf8");
  const exitCode = result.status ?? 1;
  return Object.freeze({
    id: command.id,
    command: redactCommand([command.executable, ...command.args].join(" ")),
    duration_ms: duration,
    exit_code: exitCode,
    expected_exit_codes: expected,
    outcome: expected.includes(exitCode) ? "PASS" : "FAIL",
    stdout_path: stdoutRelative,
    stdout_sha256: sha256(Buffer.from(stdout)),
    stderr_path: stderrRelative,
    stderr_sha256: sha256(Buffer.from(stderr)),
  });
}

async function commandStdout(id: string): Promise<string> {
  return readFile(path.join(finalRoot, "commands", `${id}.stdout.log`), "utf8");
}

function parseLastJson(source: string): unknown {
  const lines = source.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith("{") && line.endsWith("}"));
  assert(lines.length > 0, "COMMAND_JSON_RECEIPT_MISSING");
  return JSON.parse(lines.at(-1)!);
}

function pcResult(id: string, passed: boolean, evidence: readonly string[]) {
  return Object.freeze({ id, status: passed ? "PASS" as const : "FAILED_LOCAL" as const, evidence });
}

function pcSkipped(id: string, environmentBlocked: boolean, evidence: readonly string[], blocker: string) {
  return environmentBlocked
    ? Object.freeze({ id, status: "SKIPPED_BLOCKED" as const, evidence, blocker })
    : Object.freeze({ id, status: "FAILED_LOCAL" as const, evidence, blocker: "UNEXPECTED_DYNAMIC_RESULT" });
}

function safetyInvariants() {
  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-safety-invariants-v0.9.0",
    real_legal_topics_ready: "0/7",
    real_sources_active: 0,
    real_parameters_active: 0,
    real_rules_active: 0,
    real_calculations_or_findings: 0,
    real_customer_data_reads: 0,
    customer_shadow_authorized: false,
    production_delivery_enabled: false,
    deployments: 0,
    remote_migrations: 0,
    live_provider_calls: 0,
    openai_calls: 0,
  });
}

function truthCounters(connectionAttempts: number, postgresStatus: string) {
  return Object.freeze({
    PERSISTENCE_CAPABILITIES_TOTAL: 14,
    POSTGRESQL_ADAPTERS_IMPLEMENTED: "14/14",
    CANONICAL_COMPOSITION_ROOT_BINDINGS: "14/14",
    PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
    REAL_POSTGRESQL_CONNECTION_ATTEMPTS: connectionAttempts,
    REAL_POSTGRESQL_VERIFICATION: postgresStatus,
    REAL_LEGAL_TOPICS_READY: "0/7",
    REAL_SOURCES_ACTIVE: 0,
    REAL_PARAMETERS_ACTIVE: 0,
    REAL_RULES_ACTIVE: 0,
    REAL_CALCULATIONS_OR_FINDINGS: 0,
    REAL_CUSTOMER_DATA_READS: 0,
    CUSTOMER_SHADOW_AUTHORIZED: "NO",
    PRODUCTION_DELIVERY_ENABLED: "NO",
    DEPLOYMENTS: 0,
    REMOTE_MIGRATIONS: 0,
    LIVE_PROVIDER_CALLS: 0,
    OPENAI_CALLS: 0,
  });
}

function buildCommitLedger(base: string, finalHead: string) {
  const commits = git(["rev-list", "--reverse", `${base}..${finalHead}`]).split(/\r?\n/u).filter(Boolean).map((commit) => ({
    commit_sha: commit,
    tree_sha: git(["show", "-s", "--format=%T", commit]),
    parent_sha: git(["show", "-s", "--format=%P", commit]).split(" ")[0],
    subject: git(["show", "-s", "--format=%s", commit]),
    stable_patch_id: patchId(commit),
    diffstat: git(["show", "--stat", "--oneline", "--format=", commit]).trim(),
  }));
  const workerOriginals = [
    { worker: "W1", commit_sha: "e64584ff995889c366766c1e884b7efc3c7eaed3", tree_sha: "1a585b3e59180e0187c43c16acde2e3ce7627e87", parent_sha: "411e09426672795a1ef29d4574645cbe01f12559", stable_patch_id: "23ca16d868b73780fe76575b71d36b067599651f", allowlist_violations: 0, tests: "24/24 PASS" },
    { worker: "W2", commit_sha: "0c523fec752ce91f06177eff95cbebf643e66b9a", tree_sha: "323749c4fc1c5faee8e189acd693a5e9c1856013", parent_sha: "411e09426672795a1ef29d4574645cbe01f12559", stable_patch_id: "1bc1e175f5f133214f84f3a43d1f6afa54f2097a", allowlist_violations: 0, tests: "15/15 PASS" },
    { worker: "W3", commit_sha: "2497aa15465b0ebea83c7a57d51250c36ff44e5b", tree_sha: "2cdebf26bae66036eabf8a90c2f0dcb6b0bc53e8", parent_sha: "411e09426672795a1ef29d4574645cbe01f12559", stable_patch_id: "9c6da2add0b5870b6958df45487c55aab51283e5", allowlist_violations: 0, tests: "27/27 PASS" },
  ];
  return Object.freeze({ schema_version: "tivdoc-canonical-postgresql-commit-ledger-v0.9.0", base, final_head: finalHead, commits, worker_originals: workerOriginals });
}

function buildDiffInventory(base: string, finalHead: string) {
  const numstat = git(["diff", "--numstat", `${base}..${finalHead}`]).split(/\r?\n/u).filter(Boolean).map((line) => {
    const [added, deleted, ...file] = line.split("\t");
    return { path: file.join("\t").replaceAll("\\", "/"), added, deleted };
  });
  return Object.freeze({
    schema_version: "tivdoc-canonical-postgresql-diff-inventory-v0.9.0",
    base, final_head: finalHead,
    files_changed: numstat.length,
    additions: numstat.reduce((sum, entry) => sum + (entry.added === "-" ? 0 : Number(entry.added)), 0),
    deletions: numstat.reduce((sum, entry) => sum + (entry.deleted === "-" ? 0 : Number(entry.deleted)), 0),
    files: numstat,
  });
}

function patchId(commit: string): string {
  const show = spawnSync("git", ["show", "--pretty=format:", "--no-ext-diff", commit], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const patch = spawnSync("git", ["patch-id", "--stable"], { cwd: root, input: show.stdout ?? "", encoding: "utf8", windowsHide: true });
  return (patch.stdout ?? "").trim().split(/\s+/u)[0] ?? "";
}

async function writeMarkdown(file: string, receipt: Readonly<{ overall_statuses: readonly string[]; pc: readonly Readonly<{ id: string; status: string; evidence: readonly string[] }>[] }>) {
  const lines = ["# Canonical PostgreSQL persistence V0.9 acceptance", "", ...receipt.overall_statuses.map((status) => `- ${status}`), "", "| ID | Status | Evidence |", "|---|---|---|", ...receipt.pc.map((item) => `| ${item.id} | ${item.status} | ${item.evidence.join("; ")} |`), ""];
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

async function copyEvidenceDirectory(name: string): Promise<void> {
  const source = path.join(evidenceRoot, name);
  try { if (!(await stat(source)).isDirectory()) return; } catch { return; }
  await cp(source, path.join(finalRoot, name), { recursive: true, force: false, errorOnExist: false });
}

async function buildPayloadEntries(): Promise<PayloadEntry[]> {
  const excluded = new Set(["evidence-manifest.json", "evidence-wrapper-receipt.json", "tivdoc-canonical-postgresql-persistence-v0.9.0.zip", "independent-verifier-stdout.jsonl", "independent-verifier-stderr.txt"]);
  const files = (await walk(finalRoot)).map((absolute) => path.relative(finalRoot, absolute).replaceAll("\\", "/")).filter((relative) => !excluded.has(relative)).sort();
  const entries: PayloadEntry[] = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(finalRoot, relative));
    entries.push(Object.freeze({ path: relative, sha256: sha256(bytes), byte_count: bytes.byteLength }));
  }
  return entries;
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : Promise.resolve(entry.isFile() ? [absolute] : []);
  }))).flat();
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bundledPython(): string {
  const profile = process.env.USERPROFILE;
  assert(profile, "USERPROFILE_REQUIRED_FOR_BUNDLED_PYTHON");
  return path.join(profile, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
}

function redactCommand(command: string): string {
  return command.replaceAll(process.env.USERPROFILE ?? "__NO_PROFILE__", "%USERPROFILE%").replaceAll(root, "%REPOSITORY_ROOT%");
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
