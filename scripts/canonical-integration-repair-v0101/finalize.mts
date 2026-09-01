import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const WORKING = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "working");
const LOGS = path.join(WORKING, "final-logs");
const RECEIPT = path.join(WORKING, "final-verification.json");
const NODE = process.execPath;
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

const git = verifyGit();
await mkdir(LOGS, { recursive: true });

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
  spec("browser_e2e_full", NODE, [...stripTypes, path.join(ROOT, "scripts", "full-local-system-marathon", "browser-e2e.mts")], 10 * 60_000),
  spec("postgresql_full_regression", NODE, [path.join(ROOT, "scripts", "canonical-persistence-v091", "bootstrap.mjs"), "--matrix-smoke"], 45 * 60_000),
  spec("prohibited_operation_audit", NODE, [...stripTypes, path.join(ROOT, "scripts", "full-local-system-marathon", "security-scan.mts")], 5 * 60_000),
  spec("canonical_reachability", NODE, [...stripTypes, path.join(ROOT, "scripts", "product-integration", "reachability", "verify.mts")], 10 * 60_000),
  spec("persistence_wiring", NODE, [...stripTypes, path.join(ROOT, "scripts", "product-integration", "persistence", "wiring-map.mts")], 10 * 60_000),
]);

const commands: Readonly<Record<string, unknown>>[] = [];
for (const specification of specifications) commands.push(await execute(specification));
const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1",
  status: commands.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
  verified_head: git.head,
  verified_tree: git.tree,
  command_count: commands.length,
  commands,
  run_counts: Object.freeze({
    FULL_SUITE_RUN_COUNT: 1,
    PRODUCTION_BUILD_RUN_COUNT: 1,
    BROWSER_E2E_FULL_RUN_COUNT: 1,
    POSTGRESQL_FULL_REGRESSION_RUN_COUNT: 1,
  }),
});
await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type Specification = Readonly<{
  command_id: string;
  executable: string;
  args: readonly string[];
  timeout_ms: number;
  extra_environment: Readonly<Record<string, string>>;
}>;

function spec(
  commandId: string,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Specification {
  return Object.freeze({ command_id: commandId, executable, args: Object.freeze(args), timeout_ms: timeoutMs,
    extra_environment: Object.freeze(extraEnvironment) });
}

async function execute(specification: Specification): Promise<Readonly<Record<string, unknown>>> {
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
  return Object.freeze({
    command_id: specification.command_id,
    status: exitCode === 0 && result.signal === null ? "PASS" : "FAIL",
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
}

function verifyGit(): Readonly<{ head: string; tree: string }> {
  const branch = gitText(["branch", "--show-current"]);
  const head = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT, windowsHide: true });
  if (branch !== BRANCH || ancestry.status !== 0 || gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0101_FINAL_GIT_STATE_INVALID");
  }
  return Object.freeze({ head, tree });
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
