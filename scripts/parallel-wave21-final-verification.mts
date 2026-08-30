import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2.1", "final-verification");
const requiredBase = "5ce3eba6ab816cd6a20e101c913f7f1177c7598a";
const contractSha = "09bc4448265eb7a7dc0044b86ae094b9f53616da";
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const python = { command: "py", prefix: ["-3"] } as const;

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("wave21_final_verification_requires_offline_canary");
if (path.relative(path.join(repoRoot, "output", "parallel-wave-2.1"), outputRoot).replaceAll("\\", "/") !== "final-verification") {
  throw new Error("wave21_final_verification_output_escape");
}

type CommandDefinition = Readonly<{ id: string; command: string; args: readonly string[]; expectedExit: number; maxAttempts?: number }>;
const npmRun = (id: string, script: string, expectedExit = 0, args: readonly string[] = []): CommandDefinition => ({
  id,
  command: process.execPath,
  args: [npmCli, "run", script, ...(args.length ? ["--", ...args] : [])],
  expectedExit,
});
const vitest = (id: string, files: readonly string[]): CommandDefinition => ({
  id,
  command: process.execPath,
  args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...files, "--reporter=dot"],
  expectedExit: 0,
});

const commands: readonly CommandDefinition[] = [
  { id: "git-diff-check", command: "git", args: ["diff", "--check", `${requiredBase}..HEAD`], expectedExit: 0 },
  { id: "git-base-ancestry", command: "git", args: ["merge-base", "--is-ancestor", requiredBase, "HEAD"], expectedExit: 0 },
  { id: "git-wave1-ancestry", command: "git", args: ["merge-base", "--is-ancestor", "bb9a61eae55d49529d7cd633a2c9c2615a8d842e", "HEAD"], expectedExit: 0 },
  { id: "git-foundation-ancestry", command: "git", args: ["merge-base", "--is-ancestor", "e978ae5cee4a92f20dcc7db448b275170b8bf724", "HEAD"], expectedExit: 0 },
  { id: "git-contract-ancestry", command: "git", args: ["merge-base", "--is-ancestor", contractSha, "HEAD"], expectedExit: 0 },
  { id: "git-first-parent", command: "git", args: ["rev-list", "--first-parent", "--reverse", `${requiredBase}^..HEAD`], expectedExit: 0 },
  vitest("focused-w1-evidence", ["src/engine/wave21/evidence-audit"]),
  vitest("focused-w2-canonical-corpus", ["src/engine/legal-knowledge/corpus-hardening", "src/engine/legal-knowledge/retrieval.test.ts", "src/engine/legal-knowledge/temporal-resolver.test.ts"]),
  { ...vitest("focused-w3-ledger-parser", [
    "src/server/engine/legal-knowledge/acquisition.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-security.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/protocol.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/multiprocess.test.ts",
    "src/server/engine/legal-knowledge/parser-isolation/parser-isolation.test.ts",
  ]), maxAttempts: 2 },
  npmRun("rule-input-negatives", "wave2:rule-input:verify"),
  npmRun("ground-truth-negatives", "wave2:ground-truth:all"),
  npmRun("lint", "lint"),
  { id: "typescript-no-emit", command: process.execPath, args: [npmCli, "exec", "tsc", "--", "--noEmit"], expectedExit: 0 },
  npmRun("full-test-suite", "test"),
  npmRun("production-build", "build"),
  npmRun("legal-validate", "legal:sources:validate"),
  npmRun("legal-build", "legal:sources:build"),
  npmRun("legal-status", "legal:sources:status"),
  npmRun("legal-changes-offline-denied", "legal:sources:changes", 1),
  npmRun("legal-catalogs-offline-denied", "legal:sources:catalogs", 1),
  npmRun("legal-diffs", "legal:sources:diffs"),
  npmRun("legal-coverage", "legal:sources:coverage"),
  npmRun("legal-citations", "legal:sources:citations"),
  npmRun("legal-reproducibility", "legal:sources:reproducibility"),
  npmRun("acquisition-self-test", "legal:sources:acquisition:self-test"),
  npmRun("acquisition-verify-zero-ledger", "legal:sources:acquisition:verify"),
  npmRun("acquisition-status", "legal:sources:acquisition:status"),
  npmRun("acquisition-readiness", "legal:sources:acquisition:readiness", 2),
  npmRun("acquisition-operational-readiness", "wave21:controlled-import:strict", 5),
  npmRun("corpus-persistent-readiness", "legal:sources:readiness", 1, ["--from", "2019-01-01", "--as-of", "2026-08-29", "--sector", "general"]),
  npmRun("persistence-static-readiness", "engine:persistence:wave1:verify", 2),
  npmRun("topic-readiness-diagnostic", "wave2:topic:status"),
  npmRun("topic-readiness-strict", "wave2:topic:gate", 2),
  npmRun("wave2-corpus-verify", "wave2:corpus:verify"),
  npmRun("wave2-corpus-diagnostic", "wave2:corpus:readiness"),
  npmRun("wave2-corpus-strict", "wave2:corpus:readiness-strict", 2),
  npmRun("wave2-controlled-import", "wave2:controlled-import:verify"),
  npmRun("wave2-evidence-audit-stale-counts-denied", "wave2:evidence:audit", 1),
  npmRun("wave21-canonical-evidence", "wave21:corpus:evidence"),
  npmRun("wave21-seven-topic-strict", "wave21:corpus:readiness-strict", 2),
  { ...npmRun("wave21-real-reader-crash-matrix", "wave21:controlled-import:local"), maxAttempts: 2 },
  npmRun("full-base-to-head-scope-scan", "wave2:evidence:scan"),
  { id: "independent-v04-verifier-adversarial-self-test", command: python.command, args: [...python.prefix, path.join(repoRoot, "scripts", "wave21-evidence-audit", "independent_v04_verifier.py"), "self-test"], expectedExit: 0 },
  { id: "git-clean-status", command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"], expectedExit: 0 },
] as const;

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function atomicJson(target: string, value: unknown) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rm(target, { force: true });
  await rename(temporary, target);
}
function displayCommand(definition: CommandDefinition) {
  const executable = definition.command === process.execPath ? "node" : definition.command;
  return [executable, ...definition.args].map((entry) => /\s/u.test(entry) ? JSON.stringify(entry) : entry).join(" ");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "commands"), { recursive: true });
const records = [];
for (let index = 0; index < commands.length; index += 1) {
  const definition = commands[index]!;
  const attempts = [];
  let run: ReturnType<typeof spawnSync> | undefined;
  for (let attempt = 1; attempt <= (definition.maxAttempts ?? 1); attempt += 1) {
    run = spawnSync(definition.command, [...definition.args], {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", TIVDOC_LEGAL_NETWORK_DISABLED: "1" },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024,
    });
    const attemptExit = run.status ?? (run.signal ? 128 : 1);
    attempts.push({ attempt, observed_exit_code: attemptExit, passed: attemptExit === definition.expectedExit, signal: run.signal, error: run.error?.message ?? null });
    if (attemptExit === definition.expectedExit) break;
  }
  if (!run) throw new Error(`wave21_command_not_run:${definition.id}`);
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const observedExit = run.status ?? (run.signal ? 128 : 1);
  const record = {
    sequence: index + 1,
    id: definition.id,
    command: displayCommand(definition),
    expected_exit_code: definition.expectedExit,
    observed_exit_code: observedExit,
    passed: observedExit === definition.expectedExit,
    signal: run.signal,
    error: run.error?.message ?? null,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    attempt_count: attempts.length,
    attempts,
    stdout,
    stderr,
  };
  records.push(record);
  await atomicJson(path.join(outputRoot, "commands", `${String(index + 1).padStart(2, "0")}-${definition.id}.json`), record);
}

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim();
const firstParent = records.find((entry) => entry.id === "git-first-parent")?.stdout.trim().split(/\r?\n/u).filter(Boolean) ?? [];
const clean = records.find((entry) => entry.id === "git-clean-status")?.stdout.trim() === "";
const assertions = {
  required_base_is_first_parent_start: firstParent[0] === requiredBase,
  head_is_first_parent_end: firstParent.at(-1) === head,
  final_tracked_worktree_clean: clean,
  all_expected_exit_codes_observed: records.every((entry) => entry.passed),
  expected_nonzero_gates_remained_closed: records.filter((entry) => entry.expected_exit_code !== 0).every((entry) => entry.passed),
};
const result = {
  schema_version: "tivdoc-parallel-wave21-final-verification-v0.4.1",
  required_base: requiredBase,
  contract_sha: contractSha,
  final_head: head,
  generated_offline: true,
  customer_mount_configured: false,
  command_count: records.length,
  passed_command_count: records.filter((entry) => entry.passed).length,
  failed_command_count: records.filter((entry) => !entry.passed).length,
  expected_nonzero_gate_count: records.filter((entry) => entry.expected_exit_code !== 0).length,
  semantic_assertions: assertions,
  commands: records.map((entry) => ({
    sequence: entry.sequence,
    id: entry.id,
    command: entry.command,
    expected_exit_code: entry.expected_exit_code,
    observed_exit_code: entry.observed_exit_code,
    passed: entry.passed,
    signal: entry.signal,
    error: entry.error,
    stdout_sha256: entry.stdout_sha256,
    stderr_sha256: entry.stderr_sha256,
    attempt_count: entry.attempt_count,
    attempts: entry.attempts,
  })),
  status: Object.values(assertions).every(Boolean) ? "WAVE21_FINAL_VERIFICATION_PASSED" : "WAVE21_FINAL_VERIFICATION_FAILED",
};
await atomicJson(path.join(outputRoot, "result.json"), result);
const manifest = [];
for (const name of (await readdir(path.join(outputRoot, "commands"))).sort()) {
  const bytes = await readFile(path.join(outputRoot, "commands", name));
  manifest.push({ path: `commands/${name}`, byte_count: bytes.byteLength, sha256: sha256(bytes) });
}
await atomicJson(path.join(outputRoot, "evidence-manifest.json"), {
  schema_version: "tivdoc-parallel-wave21-final-verification-manifest-v0.4.1",
  result_sha256: sha256(await readFile(path.join(outputRoot, "result.json"))),
  files: manifest,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== "WAVE21_FINAL_VERIFICATION_PASSED") process.exitCode = 1;
