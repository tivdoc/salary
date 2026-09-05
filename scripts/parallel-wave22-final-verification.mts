import "./production-refusal.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2.2", "final-verification");
const requiredBase = "48be587d5a394e37656e20a1276b4cebb85c60bb";
const contractSha = "acdf75383125fb67187de58dd331577eefb106bb";
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const v04 = path.join(repoRoot, "output", "parallel-wave-2", "review-package-v0.4.zip");
const v041 = path.join(repoRoot, "output", "parallel-wave-2.1", "review-package-v0.4.1.zip");
const w1Integration = path.join(repoRoot, "output", "parallel-wave-2.2", "workers", "w1-integration-verification");
const w2Integration = path.join(repoRoot, "output", "parallel-wave-2.2", "workers", "w2-integration-verification");
const w3Integration = path.join(repoRoot, "output", "parallel-wave-2.2", "workers", "w3-integration-verification");

if (process.env.TIVDOC_LEGAL_NETWORK_DISABLED !== "1") throw new Error("wave22_final_verification_requires_offline_canary");
if (!existsSync(v04) || !existsSync(v041)) throw new Error("wave22_historical_package_missing");
const relativeOutput = path.relative(path.join(repoRoot, "output", "parallel-wave-2.2"), outputRoot).replaceAll("\\", "/");
if (relativeOutput !== "final-verification") throw new Error("wave22_verification_output_path_escape");

type CommandDefinition = Readonly<{
  id: string;
  command: string;
  args: readonly string[];
  expectedExit: number;
  maxAttempts?: number;
}>;

const npmRun = (id: string, script: string, expectedExit = 0, args: readonly string[] = []): CommandDefinition => ({
  id,
  command: process.execPath,
  args: [npmCli, "run", script, ...(args.length ? ["--", ...args] : [])],
  expectedExit,
});

const vitest = (id: string, files: readonly string[], maxAttempts = 1): CommandDefinition => ({
  id,
  command: process.execPath,
  args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...files, "--reporter=dot", "--maxWorkers=1"],
  expectedExit: 0,
  maxAttempts,
});

function pythonCommand() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  if (bundled && existsSync(bundled)) return { command: bundled, prefix: [] as string[] };
  return { command: "py", prefix: ["-3"] };
}

const python = pythonCommand();
const nodeTypes = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"];
const commands: readonly CommandDefinition[] = [
  { id: "git-diff-check", command: "git", args: ["diff", "--check", `${requiredBase}..HEAD`], expectedExit: 0 },
  { id: "git-base-ancestry", command: "git", args: ["merge-base", "--is-ancestor", requiredBase, "HEAD"], expectedExit: 0 },
  { id: "git-wave1-ancestry", command: "git", args: ["merge-base", "--is-ancestor", "bb9a61eae55d49529d7cd633a2c9c2615a8d842e", "HEAD"], expectedExit: 0 },
  { id: "git-foundation-ancestry", command: "git", args: ["merge-base", "--is-ancestor", "e978ae5cee4a92f20dcc7db448b275170b8bf724", "HEAD"], expectedExit: 0 },
  { id: "git-contract-ancestry", command: "git", args: ["merge-base", "--is-ancestor", contractSha, "HEAD"], expectedExit: 0 },
  { id: "git-first-parent", command: "git", args: ["rev-list", "--first-parent", "--reverse", `${requiredBase}^..HEAD`], expectedExit: 0 },
  vitest("focused-w1-evidence-forensics", ["src/engine/wave22/evidence-forensics/evidence-forensics.test.ts"]),
  vitest("focused-w2-corpus-readiness", [
    "src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.test.ts",
    "src/engine/legal-knowledge/corpus-hardening/corpus-transition.test.ts",
    "src/engine/legal-knowledge/corpus-hardening/pension-ocr.test.ts",
    "src/engine/legal-knowledge/retrieval.test.ts",
    "src/engine/legal-knowledge/temporal-resolver.test.ts",
    "src/engine/wave2/evidence-audit/artifact-reconciliation.test.ts",
    "src/engine/wave2/evidence-audit/topic-readiness-command.test.ts",
  ]),
  vitest("focused-w3-closure-operational", [
    "src/engine/wave22/closure-verification/case-registry.test.ts",
    "src/server/engine/legal-knowledge/wave22-operational-proof/operational-proof.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/multiprocess.test.ts",
  ], 2),
  npmRun("rule-input-negatives", "wave2:rule-input:verify"),
  npmRun("ground-truth-negatives", "wave2:ground-truth:all"),
  npmRun("lint", "lint"),
  { id: "typescript-no-emit", command: process.execPath, args: [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], expectedExit: 0 },
  { id: "full-test-suite-sequential", command: process.execPath, args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--maxWorkers=1", "--reporter=dot"], expectedExit: 0, maxAttempts: 2 },
  npmRun("production-build", "build"),
  npmRun("legal-validate", "legal:sources:validate"),
  npmRun("legal-build", "legal:sources:build"),
  npmRun("legal-status", "legal:sources:status"),
  npmRun("legal-search-review-only", "legal:sources:search", 0, ["--topic", "minimum_wage", "--date", "2026-08-29", "--sector", "general", "--limit", "5"]),
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
  npmRun("wave2-evidence-audit", "wave2:evidence:audit"),
  npmRun("wave21-canonical-evidence", "wave21:corpus:evidence"),
  npmRun("wave21-seven-topic-strict", "wave21:corpus:readiness-strict", 2),
  { ...npmRun("wave21-real-reader-crash-matrix", "wave21:controlled-import:local"), maxAttempts: 2 },
  npmRun("full-base-to-head-scope-scan", "wave2:evidence:scan"),
  {
    id: "wave22-w1-diagnostic",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-evidence-forensics", "diagnostic.mts"), "--output-root", w1Integration, "--v0-4-zip", v04, "--v0-4-1-zip", v041],
    expectedExit: 0,
  },
  {
    id: "wave22-w1-strict-evidence-gate",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-evidence-forensics", "strict.mts"), "--output-root", w1Integration, "--report", path.join(w1Integration, "diagnostic-result.json")],
    expectedExit: 6,
  },
  {
    id: "wave22-w1-false-overall-regression",
    command: python.command,
    args: [...python.prefix, path.join(repoRoot, "scripts", "wave22-evidence-forensics", "forensics.py"), "self-test", "--repo-root", repoRoot, "--output-root", w1Integration],
    expectedExit: 0,
  },
  {
    id: "wave22-w2-corpus-evidence-diagnostic",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-corpus-readiness", "run.mts"), "--corpus-root", repoRoot, "--output", w2Integration],
    expectedExit: 0,
  },
  {
    id: "wave22-w2-corpus-evidence-strict",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-corpus-readiness", "run.mts"), "--corpus-root", repoRoot, "--output", w2Integration, "--strict"],
    expectedExit: 2,
  },
  {
    id: "wave22-w3-independent-diagnostic",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-closure-verification", "run.mts"), "diagnostic", "--python", python.command, "--repo", repoRoot, "--v041", v041, "--output", w3Integration],
    expectedExit: 0,
    maxAttempts: 2,
  },
  { id: "wave22-independent-archive-self-test", command: python.command, args: [...python.prefix, path.join(repoRoot, "scripts", "wave22-closure-verification", "independent_closure_verifier.py"), "self-test"], expectedExit: 0 },
  { id: "git-clean-status", command: "git", args: ["status", "--porcelain=v1", "--untracked-files=all"], expectedExit: 0 },
] as const;

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function atomicJson(target: string, value: unknown) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rm(target, { force: true });
  await rename(temporary, target);
}

function displayCommand(command: CommandDefinition) {
  const executable = command.command === process.execPath ? "node" : command.command;
  return [executable, ...command.args].map((part) => /\s/u.test(part) ? JSON.stringify(part) : part).join(" ");
}

for (const target of [outputRoot, w1Integration, w2Integration, w3Integration]) await rm(target, { recursive: true, force: true });
await mkdir(path.join(outputRoot, "commands"), { recursive: true });

const records = [];
for (let index = 0; index < commands.length; index += 1) {
  const definition = commands[index]!;
  const attempts = [];
  for (let attempt = 1; attempt <= (definition.maxAttempts ?? 1); attempt += 1) {
    const result = spawnSync(definition.command, [...definition.args], {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", TIVDOC_LEGAL_NETWORK_DISABLED: "1" },
      encoding: "utf8",
      windowsHide: true,
      timeout: 20 * 60 * 1000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const observedExit = result.status ?? (result.signal ? 128 : 1);
    attempts.push({
      attempt,
      observed_exit_code: observedExit,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    if (observedExit === definition.expectedExit) break;
  }
  const finalAttempt = attempts.at(-1)!;
  const record = {
    sequence: index + 1,
    id: definition.id,
    command: displayCommand(definition),
    expected_exit_code: definition.expectedExit,
    observed_exit_code: finalAttempt.observed_exit_code,
    passed: finalAttempt.observed_exit_code === definition.expectedExit,
    attempts: attempts.map((attempt) => ({
      attempt: attempt.attempt,
      observed_exit_code: attempt.observed_exit_code,
      signal: attempt.signal,
      error: attempt.error,
      stdout_sha256: sha256(attempt.stdout),
      stderr_sha256: sha256(attempt.stderr),
    })),
    stdout_sha256: sha256(finalAttempt.stdout),
    stderr_sha256: sha256(finalAttempt.stderr),
    stdout: finalAttempt.stdout,
    stderr: finalAttempt.stderr,
  };
  await atomicJson(path.join(outputRoot, "commands", `${String(index + 1).padStart(2, "0")}-${definition.id}.json`), record);
  records.push(record);
}

const finalHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim();
const firstParent = records.find((record) => record.id === "git-first-parent")?.stdout.trim().split(/\r?\n/u).filter(Boolean) ?? [];
const cleanRecord = records.find((record) => record.id === "git-clean-status");
const semanticAssertions = {
  first_parent_starts_at_required_base: firstParent[0] === requiredBase,
  first_parent_includes_contract: firstParent.includes(contractSha),
  first_parent_ends_at_observed_head: firstParent.at(-1) === finalHead,
  final_tracked_worktree_clean: cleanRecord?.stdout.trim() === "",
  all_expected_exit_codes_observed: records.every((record) => record.passed),
  evidence_diagnostic_and_strict_independent: records.find((record) => record.id === "wave22-w1-diagnostic")?.observed_exit_code === 0
    && records.find((record) => record.id === "wave22-w1-strict-evidence-gate")?.observed_exit_code === 6,
};
const passed = Object.values(semanticAssertions).every(Boolean);
const result = {
  schema_version: "tivdoc-parallel-wave22-final-verification-v0.4.2",
  required_base: requiredBase,
  contract_sha: contractSha,
  final_head: finalHead,
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
    attempts: record.attempts,
    stdout_sha256: record.stdout_sha256,
    stderr_sha256: record.stderr_sha256,
  })),
  engineering_verification_status: passed ? "WAVE22_ENGINEERING_VERIFICATION_PASSED" : "WAVE22_ENGINEERING_VERIFICATION_FAILED",
  primary_wave_status: "PARALLEL_WAVE_2_2_PARTIAL",
};
await atomicJson(path.join(outputRoot, "result.json"), result);

const inventory = [];
for (const name of (await readdir(path.join(outputRoot, "commands"))).sort()) {
  const bytes = await readFile(path.join(outputRoot, "commands", name));
  inventory.push({ path: `commands/${name}`, byte_count: bytes.byteLength, sha256: sha256(bytes) });
}
await atomicJson(path.join(outputRoot, "evidence-manifest.json"), {
  schema_version: "tivdoc-parallel-wave22-final-verification-manifest-v0.4.2",
  result_sha256: sha256(await readFile(path.join(outputRoot, "result.json"))),
  files: inventory,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!passed) process.exitCode = 1;
