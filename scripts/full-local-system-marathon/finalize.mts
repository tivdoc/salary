import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const OUTPUT = path.join(ROOT, "output", "full-local-system-marathon-v0.10.0", "working");
const LOGS = path.join(OUTPUT, "final-logs");
const BASE = "28d18da69108913252736f4b8a39c4ef614984a3";
const NODE = process.execPath;
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

await mkdir(LOGS, { recursive: true });
const migrationChanged = changedMigrations();
const specifications = [
  spec("focused_marathon", [NODE, [stripTypes(), path.join(ROOT, "scripts", "full-local-system-marathon", "focused.mts")]], 15 * 60_000),
  spec("full_suite", [NODE, [VITEST, "run"]], 20 * 60_000),
  spec("eslint", [NODE, [ESLINT, "."]], 15 * 60_000),
  spec("typescript", [NODE, [TSC, "--noEmit"]], 15 * 60_000),
  spec("production_build", [NODE, [NEXT, "build"]], 20 * 60_000),
  spec("browser_e2e", [NODE, [stripTypes(), path.join(ROOT, "scripts", "full-local-system-marathon", "browser-e2e.mts")]], 10 * 60_000),
  ...(migrationChanged ? [spec("postgresql_regression", [NODE, [path.join(ROOT, "scripts", "canonical-persistence-v091", "bootstrap.mjs")]], 45 * 60_000)] : []),
  spec("prohibited_operation_audit", [NODE, [stripTypes(), path.join(ROOT, "scripts", "full-local-system-marathon", "security-scan.mts")]], 5 * 60_000),
  spec("canonical_reachability", [NODE, [stripTypes(), path.join(ROOT, "scripts", "product-integration", "reachability", "verify.mts")]], 10 * 60_000),
  spec("persistence_wiring", [NODE, [stripTypes(), path.join(ROOT, "scripts", "product-integration", "persistence", "wiring-map.mts")]], 10 * 60_000),
] as const;

const commands = [];
for (const entry of specifications) commands.push(await execute(entry));
const required = commands.filter((entry) => !["canonical_reachability", "persistence_wiring"].includes(entry.command_id));
const receipt = Object.freeze({
  schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0",
  status: required.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
  migration_or_persistence_changed: migrationChanged,
  commands,
  run_counts: {
    full_suite: 1,
    production_build: 1,
    browser_e2e_full: 1,
    postgresql_regression: migrationChanged ? 1 : 0,
    complete_final_attempts: 1,
  },
});
await writeFile(path.join(OUTPUT, "final-verification.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type Specification = Readonly<{
  command_id: string;
  executable: string;
  args: readonly string[];
  timeout_ms: number;
}>;

function spec(commandId: string, command: readonly [string, readonly string[]], timeoutMs: number): Specification {
  return Object.freeze({ command_id: commandId, executable: command[0], args: command[1], timeout_ms: timeoutMs });
}

async function execute(entry: Specification) {
  const started = performance.now();
  const result = spawnSync(entry.executable, entry.args, {
    cwd: ROOT,
    env: safeEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: entry.timeout_ms,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  await writeFile(path.join(LOGS, `${entry.command_id}.stdout.log`), stdout, "utf8");
  await writeFile(path.join(LOGS, `${entry.command_id}.stderr.log`), stderr, "utf8");
  const exitCode = result.status ?? (result.error ? 124 : 1);
  return Object.freeze({
    command_id: entry.command_id,
    status: exitCode === 0 && result.signal === null ? "PASS" as const : "FAIL" as const,
    exit_code: exitCode,
    signal: result.signal,
    elapsed_ms: Math.round(performance.now() - started),
    stdout_sha256: hash(stdout),
    stderr_sha256: hash(stderr),
    stdout_byte_count: Buffer.byteLength(stdout),
    stderr_byte_count: Buffer.byteLength(stderr),
    stdout_log: `final-logs/${entry.command_id}.stdout.log`,
    stderr_log: `final-logs/${entry.command_id}.stderr.log`,
  });
}

function changedMigrations(): boolean {
  const result = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["diff", "--name-only", `${BASE}..HEAD`, "--", "supabase/migrations"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr !== "") throw new Error("MARATHON_MIGRATION_DIFF_FAILED");
  return result.stdout.trim().length > 0;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

function stripTypes(): string {
  return "--experimental-strip-types";
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
