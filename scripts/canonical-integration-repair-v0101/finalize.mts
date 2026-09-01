import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const OUTPUT_ROOT = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1");
const WORKING = path.join(OUTPUT_ROOT, "working");
const LOGS = path.join(WORKING, "final-logs");
const JOURNAL = path.join(WORKING, "final-command-journal.ndjson");
const RECEIPT = path.join(WORKING, "final-verification.json");
const NODE = process.execPath;
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

const git = verifyGit();
await initializeFreshWorkingDirectory();

const focusedTests = Object.freeze([
  "src/server/system-marathon/integration-repair-contract.test.ts",
  "src/server/system-marathon/integration-repair-evidence.test.ts",
  "src/server/product/auth/identity-session.test.ts",
  "src/server/product/auth/hermetic-session.test.ts",
  "src/server/product/auth/durable-session-boundary.test.ts",
  "src/server/product/auth/runtime.test.ts",
  "src/server/product/routes/flags.test.ts",
  "src/server/product/routes/runtime.test.ts",
  "src/server/product/integration/browser-runtime.test.ts",
  "src/server/platform/persistence/postgres/governance/governance.test.ts",
  "src/server/platform/persistence/postgres/governance/migration-contract.test.ts",
  "src/server/product/durable-postgres/report-identity.test.ts",
  "scripts/canonical-persistence-v091/matrix/marathon-v010.test.mjs",
]);
const stripTypes = Object.freeze(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"]);
const specifications = Object.freeze([
  spec("focused_acceptance", NODE, [VITEST, "run", ...focusedTests, "--maxWorkers=1"], 10 * 60_000),
  spec("full_suite", NODE, [VITEST, "run", "--maxWorkers=1"], 30 * 60_000),
  spec("eslint", NODE, [ESLINT, "."], 15 * 60_000),
  spec("typescript", NODE, [TSC, "--noEmit"], 15 * 60_000),
  spec("production_build", NODE, [NEXT, "build", "--webpack"], 20 * 60_000, {
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(ROOT, "scripts", "canonical-persistence-v091", "foundation", "next-font-google-mock.cjs"),
    TIVDOC_V091_FONT_MOCK_ALLOWED: "1",
  }),
  spec("postgresql_full_regression", NODE, [path.join(ROOT, "scripts", "canonical-persistence-v091", "bootstrap.mjs"), "--matrix-smoke"], 45 * 60_000),
  spec("browser_e2e_full", NODE, [...stripTypes, path.join(ROOT, "scripts", "full-local-system-marathon", "browser-e2e.mts")], 10 * 60_000,
    {}, "browser_durable_product"),
  spec("prohibited_operation_audit", NODE, [...stripTypes, path.join(ROOT, "scripts", "full-local-system-marathon", "security-scan.mts")], 5 * 60_000),
  spec("canonical_reachability", NODE, [...stripTypes, path.join(ROOT, "scripts", "product-integration", "reachability", "verify.mts")], 10 * 60_000),
  spec("persistence_wiring", NODE, [...stripTypes, path.join(ROOT, "scripts", "product-integration", "persistence", "wiring-map.mts")], 10 * 60_000),
]);

const attempts: string[] = [];
const completed = new Set<string>();
let journalSequence = 0;
const commands: Readonly<Record<string, unknown>>[] = [];
for (const specification of specifications) commands.push(await execute(specification));
for (const specification of specifications) {
  if (attempts.filter((id) => id === specification.command_id).length !== 1 || !completed.has(specification.command_id)) {
    throw new Error(`V0101_FINAL_EXACT_ONCE_INVARIANT_FAILED:${specification.command_id}`);
  }
}
const runCounts = Object.freeze({
  FULL_SUITE_RUN_COUNT: attemptCount("full_suite"),
  PRODUCTION_BUILD_RUN_COUNT: attemptCount("production_build"),
  BROWSER_E2E_FULL_RUN_COUNT: attemptCount("browser_e2e_full"),
  POSTGRESQL_FULL_REGRESSION_RUN_COUNT: attemptCount("postgresql_full_regression"),
});
const journalBytes = await readFile(JOURNAL);
const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1",
  status: commands.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
  verified_branch: git.branch,
  verified_head: git.head,
  verified_tree: git.tree,
  command_count: commands.length,
  execution_order: Object.freeze(specifications.map((entry) => entry.command_id)),
  commands,
  run_counts: runCounts,
  exact_once: true,
  working_preflight: "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND",
  journal_log: "final-command-journal.ndjson",
  journal_sha256: sha256(journalBytes),
  journal_byte_count: journalBytes.byteLength,
});
await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type ProofKind = "process_exit" | "browser_durable_product";
type Specification = Readonly<{
  command_id: string;
  executable: string;
  args: readonly string[];
  timeout_ms: number;
  extra_environment: Readonly<Record<string, string>>;
  proof_kind: ProofKind;
}>;

function spec(
  commandId: string,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
  proofKind: ProofKind = "process_exit",
): Specification {
  return Object.freeze({ command_id: commandId, executable, args: Object.freeze(args), timeout_ms: timeoutMs,
    extra_environment: Object.freeze(extraEnvironment), proof_kind: proofKind });
}

async function execute(specification: Specification): Promise<Readonly<Record<string, unknown>>> {
  if (attempts.includes(specification.command_id)) throw new Error(`V0101_FINAL_DUPLICATE_ATTEMPT:${specification.command_id}`);
  const attemptOrdinal = attempts.push(specification.command_id);
  const startedEpochMs = Date.now();
  const startedAt = new Date(startedEpochMs).toISOString();
  await journal("COMMAND_STARTED", specification.command_id, {
    attempt_ordinal: 1,
    execution_ordinal: attemptOrdinal,
    started_at: startedAt,
    started_epoch_ms: startedEpochMs,
    verified_head: git.head,
    verified_tree: git.tree,
  });
  const started = performance.now();
  const result = spawnSync(specification.executable, specification.args, {
    cwd: ROOT,
    env: safeEnvironment(specification.extra_environment),
    encoding: "utf8",
    windowsHide: true,
    timeout: specification.timeout_ms,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  const stdoutName = `final-logs/${specification.command_id}.stdout.log`;
  const stderrName = `final-logs/${specification.command_id}.stderr.log`;
  await writeFile(path.join(WORKING, ...stdoutName.split("/")), stdout, { flag: "wx", encoding: "utf8" });
  await writeFile(path.join(WORKING, ...stderrName.split("/")), stderr, { flag: "wx", encoding: "utf8" });
  const exitCode = result.status ?? (result.error ? 124 : 1);
  const executionPassed = exitCode === 0 && result.signal === null;
  const proof = evaluateProof(specification, executionPassed, stdout);
  const finishedEpochMs = Date.now();
  const finishedAt = new Date(finishedEpochMs).toISOString();
  const commandReceipt = Object.freeze({
    command_id: specification.command_id,
    status: proof.status,
    execution_status: executionPassed ? "PASS" : "FAIL",
    proof_kind: specification.proof_kind,
    proof_contract_status: proof.proof_contract_status,
    ...(proof.failure_code ? { failure_code: proof.failure_code } : {}),
    attempt_ordinal: 1,
    execution_ordinal: attemptOrdinal,
    verified_head: git.head,
    verified_tree: git.tree,
    started_at: startedAt,
    finished_at: finishedAt,
    started_epoch_ms: startedEpochMs,
    finished_epoch_ms: finishedEpochMs,
    exit_code: exitCode,
    signal: result.signal,
    elapsed_ms: Math.round(performance.now() - started),
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout_byte_count: Buffer.byteLength(stdout),
    stderr_byte_count: Buffer.byteLength(stderr),
    stdout_log: stdoutName,
    stderr_log: stderrName,
  });
  await journal("COMMAND_COMPLETED", specification.command_id, commandReceipt);
  completed.add(specification.command_id);
  return commandReceipt;
}

function evaluateProof(
  specification: Specification,
  executionPassed: boolean,
  stdout: string,
): Readonly<{ status: "PASS" | "FAIL"; proof_contract_status: "PASS" | "FAIL"; failure_code?: string }> {
  if (!executionPassed) return Object.freeze({ status: "FAIL", proof_contract_status: "FAIL", failure_code: "COMMAND_PROCESS_FAILED" });
  if (specification.proof_kind !== "browser_durable_product") {
    return Object.freeze({ status: "PASS", proof_contract_status: "PASS" });
  }
  const browserReceipt = lastJsonRecord(stdout);
  const durableProof = browserReceipt?.status === "PASS"
    && browserReceipt.run_class === "FULL_RENDERED_BROWSER_DURABLE_PRODUCT_MATRIX"
    && browserReceipt.verified_head === git.head
    && browserReceipt.verified_tree === git.tree
    && browserReceipt.durable_identity_postgres_private_storage_proven === true
    && browserReceipt.signed_session_verified === true
    && browserReceipt.real_postgresql_transaction_verified === true
    && browserReceipt.private_storage_exact_bytes_verified === true;
  return durableProof
    ? Object.freeze({ status: "PASS", proof_contract_status: "PASS" })
    : Object.freeze({ status: "FAIL", proof_contract_status: "FAIL",
      failure_code: "BROWSER_DIAGNOSTIC_EXIT_ZERO_WITHOUT_DURABLE_PRODUCT_PROOF" });
}

function lastJsonRecord(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Non-JSON command output is not proof.
    }
  }
  return null;
}

async function journal(eventType: "COMMAND_STARTED" | "COMMAND_COMPLETED", commandId: string,
  details: Readonly<Record<string, unknown>>): Promise<void> {
  journalSequence += 1;
  const entry = Object.freeze({
    event_id: `V0101-FINAL-${String(journalSequence).padStart(4, "0")}`,
    event_type: eventType,
    command_id: commandId,
    ...details,
  });
  await appendFile(JOURNAL, `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf8" });
}

function attemptCount(commandId: string): number {
  return attempts.filter((id) => id === commandId).length;
}

async function initializeFreshWorkingDirectory(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const outputMetadata = await lstat(OUTPUT_ROOT);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) throw new Error("V0101_FINAL_OUTPUT_ROOT_INVALID");
  try {
    await mkdir(WORKING);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("V0101_FINAL_WORKING_ALREADY_EXISTS");
    throw error;
  }
  await mkdir(LOGS);
  await writeFile(JOURNAL, "", { flag: "wx", mode: 0o600 });
}

function verifyGit(): Readonly<{ branch: string; head: string; tree: string }> {
  const branch = gitText(["branch", "--show-current"]);
  const head = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT, windowsHide: true });
  if (branch !== BRANCH || ancestry.status !== 0 || gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0101_FINAL_GIT_STATE_INVALID");
  }
  return Object.freeze({ branch, head, tree });
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error("V0101_FINAL_GIT_COMMAND_FAILED");
  return result.stdout.trim();
}

function safeEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of [
    "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ",
    "USERPROFILE", "windir",
  ] as const) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  return {
    ...safe,
    ...extra,
    CI: "1",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
