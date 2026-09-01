import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const OUTPUT = path.join(ROOT, "output", "full-local-system-marathon-v0.10.0", "working");
const LOGS = path.join(OUTPUT, "final-logs");
const ATTEMPTS = path.join(OUTPUT, "final-attempts");
const BASE = "28d18da69108913252736f4b8a39c4ef614984a3";
const NODE = process.execPath;
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const MAX_COMPLETE_ATTEMPTS = 2;
const BRANCH = "codex/tivdoc-engine-foundation";

const git = gitIdentity();
await mkdir(LOGS, { recursive: true });
await mkdir(ATTEMPTS, { recursive: true });
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

const selected = await selectAttempt(specifications, migrationChanged, git);
if (!selected.recover_only) {
  const commands: CommandReceipt[] = [];
  for (const entry of specifications) {
    const prior = await readCommandReceipt(selected.directory, entry.command_id);
    if (prior) {
      commands.push(prior);
      continue;
    }
    commands.push(await execute(entry, selected.attempt_number, selected.directory));
  }

  const required = commands.filter((entry) => !["canonical_reachability", "persistence_wiring"].includes(entry.command_id));
  const attempt = Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-v0.10.0",
    attempt_number: selected.attempt_number,
    status: required.every((entry) => entry.status === "PASS") ? "PASS" as const : "FAIL" as const,
    migration_or_persistence_changed: migrationChanged,
    verified_head: git.head,
    verified_tree: git.tree,
    commands,
  });
  await writeJsonAtomic(path.join(selected.directory, "attempt.json"), attempt, true);
}

const attempts = await readCompletedAttempts();
const receipt = buildFinalReceipt(attempts);
await writeJsonAtomic(path.join(OUTPUT, "final-verification.json"), receipt, false);
await writeTextAtomic(
  path.join(OUTPUT, "final-attempt-ledger.ndjson"),
  `${attempts.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
);
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type Specification = Readonly<{
  command_id: string;
  executable: string;
  args: readonly string[];
  timeout_ms: number;
}>;

type CommandReceipt = Readonly<{
  command_id: string;
  status: "PASS" | "FAIL";
  exit_code: number;
  signal: NodeJS.Signals | null;
  elapsed_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_byte_count: number;
  stderr_byte_count: number;
  stdout_log: string;
  stderr_log: string;
}>;

type AttemptReceipt = Readonly<{
  schema_version: "tivdoc-full-local-system-marathon-final-attempt-v0.10.0";
  attempt_number: number;
  status: "PASS" | "FAIL";
  migration_or_persistence_changed: boolean;
  verified_head: string;
  verified_tree: string;
  commands: readonly CommandReceipt[];
}>;

function spec(commandId: string, command: readonly [string, readonly string[]], timeoutMs: number): Specification {
  return Object.freeze({ command_id: commandId, executable: command[0], args: command[1], timeout_ms: timeoutMs });
}

async function selectAttempt(
  expected: readonly Specification[],
  currentMigrationChanged: boolean,
  currentGit: Readonly<{ head: string; tree: string }>,
): Promise<Readonly<{ attempt_number: number; directory: string; recover_only: boolean }>> {
  const names = (await readdir(ATTEMPTS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.some((name, index) => name !== attemptName(index + 1)) || names.length > MAX_COMPLETE_ATTEMPTS) {
    throw new Error("MARATHON_FINAL_ATTEMPT_SEQUENCE_INVALID");
  }

  if (names.length > 0) {
    const latestNumber = names.length;
    const latestDirectory = path.join(ATTEMPTS, names.at(-1)!);
    const latest = await readJsonIfPresent<AttemptReceipt>(path.join(latestDirectory, "attempt.json"));
    if (!latest) {
      await validateAttemptStart(latestDirectory, latestNumber, expected, currentMigrationChanged, currentGit);
      await assertNoDanglingCommand(latestDirectory, expected);
      return Object.freeze({ attempt_number: latestNumber, directory: latestDirectory, recover_only: false });
    }
    validateAttemptReceipt(latest, latestNumber);
    if (!await exists(path.join(OUTPUT, "final-verification.json"))) {
      return Object.freeze({ attempt_number: latestNumber, directory: latestDirectory, recover_only: true });
    }
    if (latest.status === "PASS") throw new Error("MARATHON_FINAL_VERIFICATION_ALREADY_PASSED");
    if (names.length >= MAX_COMPLETE_ATTEMPTS) throw new Error("MARATHON_FINAL_RERUN_LIMIT_REACHED");
  }

  const attemptNumber = names.length + 1;
  const directory = path.join(ATTEMPTS, attemptName(attemptNumber));
  await mkdir(directory, { recursive: false });
  await writeJsonAtomic(path.join(directory, "attempt-start.json"), {
    schema_version: "tivdoc-full-local-system-marathon-final-attempt-start-v0.10.0",
    attempt_number: attemptNumber,
    migration_or_persistence_changed: currentMigrationChanged,
    verified_head: currentGit.head,
    verified_tree: currentGit.tree,
    command_ids: expected.map((entry) => entry.command_id),
  }, true);
  return Object.freeze({ attempt_number: attemptNumber, directory, recover_only: false });
}

async function validateAttemptStart(
  directory: string,
  attemptNumber: number,
  expected: readonly Specification[],
  currentMigrationChanged: boolean,
  currentGit: Readonly<{ head: string; tree: string }>,
): Promise<void> {
  const value = await readJsonIfPresent<Record<string, unknown>>(path.join(directory, "attempt-start.json"));
  if (!value
      || value.schema_version !== "tivdoc-full-local-system-marathon-final-attempt-start-v0.10.0"
      || value.attempt_number !== attemptNumber
      || value.migration_or_persistence_changed !== currentMigrationChanged
      || value.verified_head !== currentGit.head
      || value.verified_tree !== currentGit.tree
      || JSON.stringify(value.command_ids) !== JSON.stringify(expected.map((entry) => entry.command_id))) {
    throw new Error("MARATHON_FINAL_INCOMPLETE_ATTEMPT_CHANGED");
  }
}

async function assertNoDanglingCommand(directory: string, expected: readonly Specification[]): Promise<void> {
  for (const entry of expected) {
    const started = await exists(path.join(directory, `${entry.command_id}.started.json`));
    const completed = await exists(path.join(directory, `${entry.command_id}.json`));
    if (started !== completed) throw new Error(`MARATHON_FINAL_COMMAND_STATE_UNCERTAIN:${entry.command_id}`);
  }
}

async function execute(entry: Specification, attemptNumber: number, attemptDirectory: string): Promise<CommandReceipt> {
  const attemptLabel = attemptName(attemptNumber);
  const logDirectory = path.join(LOGS, attemptLabel);
  await mkdir(logDirectory, { recursive: true });
  await writeJsonAtomic(path.join(attemptDirectory, `${entry.command_id}.started.json`), {
    schema_version: "tivdoc-full-local-system-marathon-command-start-v0.10.0",
    attempt_number: attemptNumber,
    command_id: entry.command_id,
  }, true);

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
  const stdoutName = `final-logs/${attemptLabel}/${entry.command_id}.stdout.log`;
  const stderrName = `final-logs/${attemptLabel}/${entry.command_id}.stderr.log`;
  await writeFile(path.join(OUTPUT, ...stdoutName.split("/")), stdout, { encoding: "utf8", flag: "wx" });
  await writeFile(path.join(OUTPUT, ...stderrName.split("/")), stderr, { encoding: "utf8", flag: "wx" });
  const exitCode = result.status ?? (result.error ? 124 : 1);
  const receipt = Object.freeze({
    command_id: entry.command_id,
    status: exitCode === 0 && result.signal === null ? "PASS" as const : "FAIL" as const,
    exit_code: exitCode,
    signal: result.signal,
    elapsed_ms: Math.round(performance.now() - started),
    stdout_sha256: hash(stdout),
    stderr_sha256: hash(stderr),
    stdout_byte_count: Buffer.byteLength(stdout),
    stderr_byte_count: Buffer.byteLength(stderr),
    stdout_log: stdoutName,
    stderr_log: stderrName,
  });
  await writeJsonAtomic(path.join(attemptDirectory, `${entry.command_id}.json`), receipt, true);
  return receipt;
}

async function readCommandReceipt(directory: string, commandId: string): Promise<CommandReceipt | null> {
  const value = await readJsonIfPresent<CommandReceipt>(path.join(directory, `${commandId}.json`));
  if (!value) return null;
  validateCommandReceipt(value, commandId);
  for (const [name, expectedHash, expectedBytes] of [
    [value.stdout_log, value.stdout_sha256, value.stdout_byte_count],
    [value.stderr_log, value.stderr_sha256, value.stderr_byte_count],
  ] as const) {
    const absolute = path.resolve(OUTPUT, ...name.split("/"));
    assertWithin(OUTPUT, absolute);
    const bytes = await readFile(absolute);
    if (bytes.byteLength !== expectedBytes || hash(bytes) !== expectedHash) {
      throw new Error(`MARATHON_FINAL_COMMAND_LOG_MISMATCH:${commandId}`);
    }
  }
  return Object.freeze(value);
}

async function readCompletedAttempts(): Promise<readonly AttemptReceipt[]> {
  const names = (await readdir(ATTEMPTS, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^attempt-\d{2}$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const attempts: AttemptReceipt[] = [];
  for (const [index, name] of names.entries()) {
    const value = await readJsonIfPresent<AttemptReceipt>(path.join(ATTEMPTS, name, "attempt.json"));
    if (!value) throw new Error("MARATHON_FINAL_ATTEMPT_NOT_COMPLETE");
    validateAttemptReceipt(value, index + 1);
    attempts.push(Object.freeze(value));
  }
  return Object.freeze(attempts);
}

function buildFinalReceipt(attempts: readonly AttemptReceipt[]) {
  if (attempts.length < 1 || attempts.length > MAX_COMPLETE_ATTEMPTS) throw new Error("MARATHON_FINAL_ATTEMPT_COUNT_INVALID");
  const latest = attempts.at(-1)!;
  const count = (commandId: string) => attempts.reduce(
    (total, entry) => total + entry.commands.filter((command) => command.command_id === commandId).length,
    0,
  );
  return Object.freeze({
    schema_version: "tivdoc-full-local-system-marathon-final-verification-v0.10.0",
    status: latest.status,
    migration_or_persistence_changed: attempts.some((entry) => entry.migration_or_persistence_changed),
    verified_head: latest.verified_head,
    verified_tree: latest.verified_tree,
    commands: latest.commands,
    attempts,
    run_counts: Object.freeze({
      full_suite: count("full_suite"),
      production_build: count("production_build"),
      browser_e2e_full: count("browser_e2e"),
      postgresql_regression: count("postgresql_regression"),
      complete_final_attempts: attempts.length,
    }),
    complete_attempt_limit: MAX_COMPLETE_ATTEMPTS,
  });
}

function validateAttemptReceipt(value: AttemptReceipt, attemptNumber: number): void {
  if (value.schema_version !== "tivdoc-full-local-system-marathon-final-attempt-v0.10.0"
      || value.attempt_number !== attemptNumber
      || !["PASS", "FAIL"].includes(value.status)
      || typeof value.migration_or_persistence_changed !== "boolean"
      || !/^[a-f0-9]{40}$/u.test(value.verified_head)
      || !/^[a-f0-9]{40}$/u.test(value.verified_tree)
      || !Array.isArray(value.commands)) throw new Error("MARATHON_FINAL_ATTEMPT_RECEIPT_INVALID");
  for (const command of value.commands) validateCommandReceipt(command, command.command_id);
}

function validateCommandReceipt(value: CommandReceipt, commandId: string): void {
  if (value.command_id !== commandId
      || !["PASS", "FAIL"].includes(value.status)
      || !Number.isSafeInteger(value.exit_code)
      || !Number.isSafeInteger(value.elapsed_ms)
      || value.elapsed_ms < 0
      || !/^[a-f0-9]{64}$/u.test(value.stdout_sha256)
      || !/^[a-f0-9]{64}$/u.test(value.stderr_sha256)
      || !Number.isSafeInteger(value.stdout_byte_count)
      || !Number.isSafeInteger(value.stderr_byte_count)
      || !isSafeRelativeLog(value.stdout_log)
      || !isSafeRelativeLog(value.stderr_log)) {
    throw new Error(`MARATHON_FINAL_COMMAND_RECEIPT_INVALID:${commandId}`);
  }
}

function changedMigrations(): boolean {
  const result = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["diff", "--name-only", `${BASE}..HEAD`, "--", "supabase/migrations"], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr !== "") throw new Error("MARATHON_MIGRATION_DIFF_FAILED");
  return result.stdout.trim().length > 0;
}

function gitIdentity(): Readonly<{ head: string; tree: string }> {
  const head = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  const branch = gitText(["branch", "--show-current"]);
  const status = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const ancestry = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", ["merge-base", "--is-ancestor", BASE, head], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (branch !== BRANCH
      || status.error || status.status !== 0 || status.stderr.byteLength !== 0 || status.stdout.byteLength !== 0
      || ancestry.error || ancestry.status !== 0 || ancestry.stderr !== "") {
    throw new Error("MARATHON_FINAL_GIT_STATE_INVALID");
  }
  return Object.freeze({ head, tree });
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("C:\\Program Files\\Git\\cmd\\git.exe", args, {
    cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr !== "") throw new Error("MARATHON_FINAL_GIT_COMMAND_FAILED");
  return result.stdout.trim();
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of [
    "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
    "LANG", "LC_ALL", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ", "USERPROFILE", "windir",
  ] as const) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  return {
    ...safe,
    CI: "1",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown, exclusive: boolean): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`, exclusive);
}

async function writeTextAtomic(file: string, value: string, exclusive = false): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, value, { encoding: "utf8", flag: "wx" });
  if (exclusive && await exists(file)) throw new Error(`MARATHON_FINAL_RECEIPT_ALREADY_EXISTS:${path.basename(file)}`);
  await rename(temporary, file);
}

function attemptName(value: number): string {
  return `attempt-${String(value).padStart(2, "0")}`;
}

function isSafeRelativeLog(value: unknown): value is string {
  return typeof value === "string"
    && /^final-logs\/attempt-\d{2}\/[a-z0-9_]+\.(?:stdout|stderr)\.log$/u.test(value)
    && path.posix.normalize(value) === value;
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MARATHON_FINAL_PATH_ESCAPE");
  }
}

function stripTypes(): string {
  return "--experimental-strip-types";
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
