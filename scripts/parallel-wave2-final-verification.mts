import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2", "final-verification");
const requiredBase = "bb9a61eae55d49529d7cd633a2c9c2615a8d842e";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") {
  throw new Error("parallel_wave2_final_verification_requires_offline_canary");
}
if (path.relative(path.join(repoRoot, "output", "parallel-wave-2"), outputRoot).replaceAll("\\", "/") !== "final-verification") {
  throw new Error("parallel_wave2_verification_output_path_escape");
}

type CommandDefinition = Readonly<{
  id: string;
  command: string;
  args: readonly string[];
  expectedExit: number;
}>;

const vitest = (id: string, paths: readonly string[]): CommandDefinition => ({
  id,
  command: process.execPath,
  args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...paths, "--reporter=dot"],
  expectedExit: 0,
});

const npmRun = (id: string, script: string, expectedExit = 0): CommandDefinition => ({
  id,
  command: npm,
  args: ["run", script],
  expectedExit,
});

const commands: readonly CommandDefinition[] = [
  { id: "git-diff-check", command: "git", args: ["diff", "--check", `${requiredBase}..HEAD`], expectedExit: 0 },
  { id: "git-ancestry", command: "git", args: ["merge-base", "--is-ancestor", requiredBase, "HEAD"], expectedExit: 0 },
  { id: "git-first-parent", command: "git", args: ["rev-list", "--first-parent", "--reverse", `${requiredBase}^..HEAD`], expectedExit: 0 },
  vitest("focused-a1-evidence-audit", ["src/engine/wave2/evidence-audit"]),
  vitest("focused-a2-corpus-hardening", ["src/engine/legal-knowledge/corpus-hardening", "src/server/engine/legal-knowledge/wave2-corpus-hardening"]),
  vitest("focused-a3-controlled-import", [
    "src/server/engine/legal-knowledge/controlled-import-recovery/protocol.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-security.test.ts",
    "src/server/engine/legal-knowledge/parser-isolation/parser-isolation.test.ts",
  ]),
  vitest("focused-b1-review-dossier", ["src/engine/legal-knowledge/review-dossier", "src/engine/legal-parameters"]),
  vitest("focused-b2-rule-input", ["src/engine/rule-input", "src/engine/analysis-orchestration"]),
  vitest("focused-b3-ground-truth", ["src/engine/extraction-ground-truth"]),
  npmRun("lint", "lint"),
  { id: "typescript-no-emit", command: npm, args: ["exec", "tsc", "--", "--noEmit"], expectedExit: 0 },
  npmRun("full-test-suite", "test"),
  npmRun("production-build", "build"),
  npmRun("legal-validate", "legal:sources:validate"),
  npmRun("legal-build", "legal:sources:build"),
  npmRun("legal-status", "legal:sources:status"),
  npmRun("legal-diffs", "legal:sources:diffs"),
  npmRun("legal-coverage", "legal:sources:coverage"),
  npmRun("legal-citations", "legal:sources:citations"),
  npmRun("legal-reproducibility", "legal:sources:reproducibility"),
  npmRun("controlled-import-self-test", "legal:sources:acquisition:self-test"),
  npmRun("controlled-import-persistent-verify", "legal:sources:acquisition:verify"),
  npmRun("controlled-import-persistent-readiness", "legal:sources:acquisition:readiness", 2),
  npmRun("corpus-persistent-readiness", "legal:sources:readiness", 1),
  npmRun("persistence-static-readiness", "engine:persistence:wave1:verify", 2),
  npmRun("topic-readiness-diagnostic", "wave2:topic:status"),
  npmRun("topic-readiness-strict", "wave2:topic:gate", 2),
  npmRun("corpus-hardening-evidence-verify", "wave2:corpus:verify"),
  npmRun("corpus-hardening-readiness-diagnostic", "wave2:corpus:readiness"),
  npmRun("corpus-hardening-readiness-strict", "wave2:corpus:readiness-strict", 2),
  npmRun("controlled-import-adversarial-evidence", "wave2:controlled-import:verify"),
  npmRun("rule-input-synthetic-replay", "wave2:rule-input:verify"),
  npmRun("ground-truth-validator-evaluator", "wave2:ground-truth:all"),
  npmRun("wave2-evidence-audit", "wave2:evidence:audit"),
  npmRun("full-base-to-head-scope-scan", "wave2:evidence:scan"),
  { id: "git-clean-status", command: "git", args: ["status", "--porcelain", "--untracked-files=all"], expectedExit: 0 },
] as const;

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayCommand(command: CommandDefinition) {
  const executable = command.command === process.execPath ? "node" : command.command;
  return [executable, ...command.args].map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(" ");
}

async function atomicJson(target: string, value: unknown) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rm(target, { force: true });
  await rename(temporary, target);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "commands"), { recursive: true });

const records = [];
for (let index = 0; index < commands.length; index += 1) {
  const definition = commands[index];
  const result = spawnSync(definition.command, [...definition.args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      TIVDOC_LEGAL_NETWORK_DISABLED: "1",
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 20 * 60 * 1000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const observedExit = result.status ?? (result.signal ? 128 : 1);
  const record = {
    sequence: index + 1,
    id: definition.id,
    command: displayCommand(definition),
    expected_exit_code: definition.expectedExit,
    observed_exit_code: observedExit,
    passed: observedExit === definition.expectedExit,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout,
    stderr,
  };
  await atomicJson(path.join(outputRoot, "commands", `${String(index + 1).padStart(2, "0")}-${definition.id}.json`), record);
  records.push(record);
}

const firstParent = records.find((record) => record.id === "git-first-parent")?.stdout.trim().split(/\r?\n/u).filter(Boolean) ?? [];
const cleanRecord = records.find((record) => record.id === "git-clean-status");
const semanticAssertions = {
  first_parent_starts_at_required_base: firstParent[0] === requiredBase,
  first_parent_ends_at_observed_head: firstParent.at(-1) === spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim(),
  final_tracked_worktree_clean: cleanRecord?.stdout.trim() === "",
  all_expected_exit_codes_observed: records.every((record) => record.passed),
};
const result = {
  schema_version: "tivdoc-parallel-wave2-final-verification-v0.4",
  required_base: requiredBase,
  final_head: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim(),
  generated_offline: true,
  command_count: records.length,
  passed_command_count: records.filter((record) => record.passed).length,
  failed_command_count: records.filter((record) => !record.passed).length,
  expected_nonzero_gate_count: records.filter((record) => record.expected_exit_code !== 0).length,
  semantic_assertions: semanticAssertions,
  commands: records.map((record) => ({
    sequence: record.sequence,
    id: record.id,
    command: record.command,
    expected_exit_code: record.expected_exit_code,
    observed_exit_code: record.observed_exit_code,
    passed: record.passed,
    signal: record.signal,
    error: record.error,
    stdout_sha256: record.stdout_sha256,
    stderr_sha256: record.stderr_sha256,
  })),
  status: Object.values(semanticAssertions).every(Boolean) ? "WAVE2_FINAL_VERIFICATION_PASSED" : "WAVE2_FINAL_VERIFICATION_FAILED",
};
await atomicJson(path.join(outputRoot, "result.json"), result);

const files = (await readdir(path.join(outputRoot, "commands"))).sort();
const inventory = [];
for (const name of files) {
  const bytes = await readFile(path.join(outputRoot, "commands", name));
  inventory.push({ path: `commands/${name}`, byte_count: bytes.byteLength, sha256: sha256(bytes) });
}
await atomicJson(path.join(outputRoot, "evidence-manifest.json"), {
  schema_version: "tivdoc-parallel-wave2-final-verification-manifest-v0.4",
  result_sha256: sha256(await readFile(path.join(outputRoot, "result.json"))),
  files: inventory,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== "WAVE2_FINAL_VERIFICATION_PASSED") process.exitCode = 1;
