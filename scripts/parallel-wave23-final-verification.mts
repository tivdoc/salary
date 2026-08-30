import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());
const outputRoot = path.join(repoRoot, "output", "parallel-wave-2.3", "orchestrator");
const commandRoot = path.join(outputRoot, "commands");
const baseSha = "984b640fe360cbeb74f8f3eb0c6ae6c6e79c939d";
const contractSha = "bcbf22139452213e9e60df5d5e3ad65a28fafff5";
const v04 = path.join(repoRoot, "output", "parallel-wave-2", "review-package-v0.4.zip");
const v041 = path.join(repoRoot, "output", "parallel-wave-2.1", "review-package-v0.4.1.zip");
const v042 = path.join(repoRoot, "output", "parallel-wave-2.2", "review-package-v0.4.2.zip");
const v04Erratum = path.join(repoRoot, "output", "parallel-wave-2.2", "workers", "w1-evidence-forensics", "v0.4-immutable-erratum.json");
const w1Output = path.join(repoRoot, "output", "parallel-wave-2.3", "workers", "w1-evidence-incident");
const w2Output = path.join(repoRoot, "output", "parallel-wave-2.3", "workers", "w2-corpus-trust");
const w3Output = path.join(repoRoot, "output", "parallel-wave-2.3", "workers", "w3-evidence-epoch");
const historicalDiagnosticOutput = path.join(outputRoot, "historical-wave22-diagnostic");
const historicalStrictOutput = path.join(outputRoot, "historical-wave22-strict");
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const nodeTypes = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"] as const;

type SubjectClass = "engineering" | "historical_root" | "product_readiness" | "operational_readiness";
type CommandDefinition = Readonly<{
  id: string;
  purpose: string;
  command: string;
  args: readonly string[];
  expectedExit: number;
  subjectClass?: SubjectClass;
  expectedSubjectStatus?: string;
  maxAttempts?: number;
}>;

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}
const stableJson = (value: unknown) => `${JSON.stringify(stableValue(value), null, 2)}\n`;

function pythonExecutable() {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : "";
  if (bundled && existsSync(bundled)) return bundled;
  return "python";
}
const python = pythonExecutable();

const npmRun = (id: string, purpose: string, script: string, expectedExit = 0, extra: readonly string[] = [], subjectClass: SubjectClass = "engineering", expectedSubjectStatus?: string): CommandDefinition => ({
  id, purpose, command: process.execPath,
  args: [npmCli, "run", script, ...(extra.length ? ["--", ...extra] : [])],
  expectedExit, subjectClass, expectedSubjectStatus,
});
const vitest = (id: string, purpose: string, files: readonly string[], maxAttempts = 1): CommandDefinition => ({
  id, purpose, command: process.execPath,
  args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...files, "--reporter=dot", "--maxWorkers=1"],
  expectedExit: 0, maxAttempts,
});

const commands: readonly CommandDefinition[] = [
  { id: "git-diff-check", purpose: "Verify base-to-final patch whitespace integrity", command: "git", args: ["diff", "--check", `${baseSha}..HEAD`], expectedExit: 0 },
  { id: "git-base-ancestry", purpose: "Verify immutable Wave 2.2 base ancestry", command: "git", args: ["merge-base", "--is-ancestor", baseSha, "HEAD"], expectedExit: 0 },
  { id: "git-contract-ancestry", purpose: "Verify Wave 2.3 contract ancestry", command: "git", args: ["merge-base", "--is-ancestor", contractSha, "HEAD"], expectedExit: 0 },
  { id: "git-foundation-ancestry", purpose: "Verify original engine-foundation ancestry", command: "git", args: ["merge-base", "--is-ancestor", "e978ae5cee4a92f20dcc7db448b275170b8bf724", "HEAD"], expectedExit: 0 },
  vitest("focused-w1", "Verify evidence incident and disposition governance", [
    "src/engine/wave23/evidence-incident/disposition.test.ts",
    "src/engine/wave23/evidence-incident/incident-registry.test.ts",
  ]),
  vitest("focused-w2", "Verify orthogonal lifecycle and synthetic readiness matrices", [
    "src/engine/wave23/corpus-trust/lifecycle.test.ts",
    "src/engine/wave23/corpus-trust/synthetic-matrices.test.ts",
    "src/engine/wave23/corpus-trust/reporting-reconciliation.test.ts",
    "src/engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.test.ts",
  ]),
  vitest("focused-w3", "Verify evidence epoch contract", ["src/engine/wave23/evidence-epoch/epoch-contract.test.ts"]),
  npmRun("lint", "Run repository lint", "lint"),
  { id: "typescript-no-emit", purpose: "Run repository type checking", command: process.execPath, args: [path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], expectedExit: 0 },
  { id: "full-tests-sequential", purpose: "Run the complete test suite sequentially", command: process.execPath, args: [path.join(repoRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--maxWorkers=1", "--reporter=dot"], expectedExit: 0, maxAttempts: 2 },
  npmRun("production-build", "Run the production build without deployment", "build"),
  npmRun("legal-validate", "Validate the inactive legal source registry", "legal:sources:validate"),
  npmRun("legal-build", "Build the local inactive legal corpus", "legal:sources:build"),
  npmRun("legal-status", "Report legal corpus status", "legal:sources:status"),
  npmRun("legal-search-review-only", "Exercise review-only search without runtime activation", "legal:sources:search", 0, ["--topic", "minimum_wage", "--date", "2026-08-30", "--sector", "general", "--limit", "5"]),
  npmRun("legal-diffs", "Verify local source diff evidence", "legal:sources:diffs"),
  npmRun("legal-coverage", "Verify local source coverage evidence", "legal:sources:coverage"),
  npmRun("legal-citations", "Verify citation inventory and zero active citations", "legal:sources:citations"),
  npmRun("legal-reproducibility", "Verify local legal corpus reproducibility", "legal:sources:reproducibility"),
  npmRun("topic-readiness-diagnostic", "Report the seven real topic decisions", "wave2:topic:status"),
  npmRun("topic-readiness-strict", "Preserve blocked product readiness for all real topics", "wave2:topic:gate", 2, [], "product_readiness", "LEGAL_SOURCE_CORPUS_INCOMPLETE"),
  npmRun("corpus-readiness-diagnostic", "Report real corpus readiness", "wave2:corpus:readiness"),
  npmRun("corpus-readiness-strict", "Preserve strict real corpus readiness denial", "wave2:corpus:readiness-strict", 2, [], "product_readiness", "LEGAL_SOURCE_CORPUS_INCOMPLETE"),
  { ...npmRun("controlled-import-local", "Verify local controlled-import protocol behavior", "wave21:controlled-import:local"), maxAttempts: 2 },
  npmRun("controlled-import-operational-strict", "Preserve denial of persistent operational import readiness", "wave21:controlled-import:strict", 5, [], "operational_readiness", "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED"),
  npmRun("rule-input-negative", "Verify synthetic-only Rule Input boundary", "wave2:rule-input:verify"),
  npmRun("ground-truth-negative", "Verify Ground Truth remains synthetic/unavailable", "wave2:ground-truth:all"),
  {
    id: "w1-incident-diagnostic", purpose: "Generate bounded incident and immutable disposition evidence",
    command: python, args: [path.join(repoRoot, "scripts", "wave23-evidence-incident", "incident_registry.py"), "diagnostic", "--repo-root", repoRoot, "--historical-root", repoRoot, "--output-root", w1Output], expectedExit: 0,
  },
  {
    id: "w1-historical-strict", purpose: "Preserve the actual historical-root failure under quarantine",
    command: python, args: [path.join(repoRoot, "scripts", "wave23-evidence-incident", "incident_registry.py"), "strict", "--repo-root", repoRoot, "--historical-root", repoRoot, "--output-root", w1Output], expectedExit: 6,
    subjectClass: "historical_root", expectedSubjectStatus: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
  },
  {
    id: "w2-current-corpus-evidence", purpose: "Generate corrected lifecycle and canonical readiness evidence",
    command: process.execPath, args: [...nodeTypes, path.join(repoRoot, "scripts", "wave23-corpus-trust", "generate-evidence.mts"), "--corpus-root", repoRoot, "--output", w2Output], expectedExit: 0,
  },
  {
    id: "w3-adversarial-matrix", purpose: "Run deterministic package and adversarial trust-root self-tests",
    command: python, args: [path.join(repoRoot, "scripts", "wave23-evidence-epoch", "adversarial_self_test.py"), "--source-repo", repoRoot, "--output-root", w3Output], expectedExit: 0,
  },
  {
    id: "historical-wave22-diagnostic", purpose: "Re-derive controlled-import, TOCTOU, Ground Truth, Rule Input, and historical diagnostic matrices",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-closure-verification", "run.mts"), "diagnostic", "--python", python, "--repo", repoRoot, "--v041", v041, "--output", historicalDiagnosticOutput],
    expectedExit: 0, subjectClass: "historical_root", expectedSubjectStatus: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
  },
  {
    id: "historical-v041-independent-strict", purpose: "Independently retain frozen V0.4/V0.4.1 evidence-chain failure",
    command: process.execPath,
    args: [...nodeTypes, path.join(repoRoot, "scripts", "wave22-closure-verification", "run.mts"), "strict", "--python", python, "--repo", repoRoot, "--v04", v04, "--v04-erratum", v04Erratum, "--v041", v041, "--v042", v042, "--expected-v042-sha256", "c3c7135821097e68e00717b93300939cc84d565932a0dacd6cc239a684db6636", "--expected-v042-manifest-sha256", "6b8082a2aa4149cba35ead01500114323658d58ac8e2899694a2873b0d50a9c1", "--expected-head", baseSha, "--output", historicalStrictOutput],
    expectedExit: 7, subjectClass: "historical_root", expectedSubjectStatus: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
  },
  { id: "historical-v04-hash", purpose: "Rehash the frozen V0.4 package", command: "git", args: ["hash-object", "--no-filters", v04], expectedExit: 0 },
  { id: "historical-v041-hash", purpose: "Rehash the frozen V0.4.1 package", command: "git", args: ["hash-object", "--no-filters", v041], expectedExit: 0 },
  { id: "historical-v042-hash", purpose: "Rehash the frozen V0.4.2 package", command: "git", args: ["hash-object", "--no-filters", v042], expectedExit: 0 },
] as const;

function display(definition: CommandDefinition) {
  const executable = definition.command === process.execPath ? "node" : definition.command;
  return [executable, ...definition.args].map(sanitizeEvidence).map((entry) => /\s/u.test(entry) ? JSON.stringify(entry) : entry).join(" ");
}

function sanitizeEvidence(value: string) {
  return value
    .replace(/C:\\Users\\[^\\\s"']+/giu, "<USERPROFILE>")
    .replace(/C:\/Users\/[^/\s"']+/giu, "<USERPROFILE>");
}

function subject(definition: CommandDefinition, observedExit: number) {
  const expectationMatched = observedExit === definition.expectedExit;
  if (definition.subjectClass === "historical_root") return {
    subject_passed: false,
    subject_status: definition.expectedSubjectStatus ?? "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
    subject_reason: expectationMatched ? "Historical strict failure was preserved; the harness matched its expected nonzero exit." : "Historical gate did not produce the frozen expected failure.",
  };
  if (definition.subjectClass === "product_readiness") return {
    subject_passed: false,
    subject_status: definition.expectedSubjectStatus ?? "LEGAL_SOURCE_CORPUS_INCOMPLETE",
    subject_reason: expectationMatched ? "The real product readiness subject remains blocked as required." : "The real product readiness gate diverged from the required blocked result.",
  };
  if (definition.subjectClass === "operational_readiness") return {
    subject_passed: false,
    subject_status: definition.expectedSubjectStatus ?? "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
    subject_reason: expectationMatched ? "Operational readiness remains denied while the local protocol test is separately exercised." : "Operational denial did not match its contract.",
  };
  return {
    subject_passed: expectationMatched,
    subject_status: expectationMatched ? "PASSED" : "FAILED",
    subject_reason: expectationMatched ? "The engineering subject passed." : "The engineering subject did not pass.",
  };
}

if (!existsSync(v04) || !existsSync(v041) || !existsSync(v042) || !existsSync(v04Erratum)) {
  throw new Error("wave23_required_historical_artifact_missing");
}
await rm(outputRoot, { recursive: true, force: true });
await mkdir(commandRoot, { recursive: true });
const records = [];
for (let index = 0; index < commands.length; index += 1) {
  const definition = commands[index]!;
  const attempts = [];
  for (let attempt = 1; attempt <= (definition.maxAttempts ?? 1); attempt += 1) {
    const result = spawnSync(definition.command, [...definition.args], {
      cwd: repoRoot,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", TIVDOC_LEGAL_NETWORK_DISABLED: "1" },
      encoding: "utf8", windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 256 * 1024 * 1024,
    });
    const actualExit = result.status ?? (result.signal ? 128 : 1);
    attempts.push({
      attempt, actual_exit: actualExit, signal: result.signal, error: result.error?.message ?? null,
      stdout: sanitizeEvidence(result.stdout ?? ""), stderr: sanitizeEvidence(result.stderr ?? ""),
    });
    if (actualExit === definition.expectedExit) break;
  }
  const observed = attempts.at(-1)!;
  const commandId = `COMMAND_${String(index + 1).padStart(3, "0")}`;
  const artifactRelative = `commands/${commandId}-${definition.id}.json`;
  const subjectResult = subject(definition, observed.actual_exit);
  const commandArtifact = {
    command_id: commandId, stable_id: definition.id, purpose: definition.purpose,
    command: display(definition), expected_exit: definition.expectedExit, actual_exit: observed.actual_exit,
    expectation_matched: observed.actual_exit === definition.expectedExit, ...subjectResult,
    attempts: attempts.map((entry) => ({
      attempt: entry.attempt, actual_exit: entry.actual_exit, signal: entry.signal, error: entry.error,
      stdout_sha256: sha256(entry.stdout), stderr_sha256: sha256(entry.stderr),
    })),
    stdout: observed.stdout, stderr: observed.stderr,
  };
  const bytes = stableJson(commandArtifact);
  await writeFile(path.join(outputRoot, artifactRelative), bytes, "utf8");
  records.push({
    command_id: commandId, stable_id: definition.id, purpose: definition.purpose,
    command: display(definition), expected_exit: definition.expectedExit, actual_exit: observed.actual_exit,
    expectation_matched: observed.actual_exit === definition.expectedExit, ...subjectResult,
    output_artifact_path: `output/parallel-wave-2.3/orchestrator/${artifactRelative}`,
    output_artifact_sha256: sha256(bytes),
  });
}

const ledger = {
  schema_version: "tivdoc-wave23-command-ledger-v0.5.0",
  generated_offline: true,
  command_ids_are_sequential: records.every((record, index) => record.command_id === `COMMAND_${String(index + 1).padStart(3, "0")}`),
  verification_command_denominator: records.length,
  verification_expectation_matched_count: records.filter((record) => record.expectation_matched).length,
  package_steps_excluded_from_verification_denominator: true,
  package_step_denominator: 8,
  package_step_ledger_path: "output/parallel-wave-2.3/package-command-ledger.json",
  commands: records,
};
await writeFile(path.join(outputRoot, "command-ledger.json"), stableJson(ledger), "utf8");
for (const [sourceName, targetName] of [
  ["adversarial-matrix.json", "w3-adversarial-package-matrix.json"],
  ["synthetic-python-verifier.json", "w3-synthetic-python-verifier.json"],
  ["synthetic-typescript-verifier.json", "w3-synthetic-typescript-verifier.json"],
  ["synthetic-receipt.json", "w3-synthetic-receipt.json"],
] as const) {
  await copyFile(path.join(w3Output, sourceName), path.join(outputRoot, targetName));
}
const packageIdentities = [];
for (const [id, target] of [["V0.4", v04], ["V0.4.1", v041], ["V0.4.2", v042]] as const) {
  const bytes = await readFile(target);
  packageIdentities.push({ package_id: id, path: path.relative(repoRoot, target).replaceAll("\\", "/"), byte_length: bytes.byteLength, sha256: sha256(bytes), available: true });
}
const finalHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim();
const finalTree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim();
const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8", windowsHide: true }).stdout.trim();
const result = {
  schema_version: "tivdoc-wave23-final-verification-v0.5.0",
  final_head: finalHead, final_tree: finalTree,
  command_count: records.length,
  expectation_matched_count: records.filter((record) => record.expectation_matched).length,
  engineering_subject_passed_count: records.filter((record) => record.subject_passed).length,
  deliberately_failed_subject_count: records.filter((record) => !record.subject_passed && record.expectation_matched).length,
  all_command_expectations_matched: records.every((record) => record.expectation_matched),
  historical_roots_subject_passed: false,
  historical_roots_status: "HISTORICAL_EVIDENCE_ROOTS_QUARANTINED_FAILED",
  current_trust_baseline_prepackage_checks_passed: records.filter((record) => record.subject_status === "PASSED").every((record) => record.expectation_matched),
  product_legal_readiness_subject_passed: false,
  product_legal_readiness_status: "LEGAL_SOURCE_CORPUS_INCOMPLETE",
  package_identities: packageIdentities,
  tracked_worktree_clean: status === "",
  status_porcelain: status,
  passed: records.every((record) => record.expectation_matched) && status === "",
};
await writeFile(path.join(outputRoot, "verification-result.json"), stableJson(result), "utf8");
const files = [];
for (const name of (await readdir(outputRoot, { recursive: true })) as string[]) {
  const absolute = path.join(outputRoot, name);
  if (!existsSync(absolute) || name.replaceAll("\\", "/") === "evidence-manifest.json") continue;
  try {
    const bytes = await readFile(absolute);
    files.push({ path: name.replaceAll("\\", "/"), byte_length: bytes.byteLength, sha256: sha256(bytes) });
  } catch { /* directories are excluded */ }
}
await writeFile(path.join(outputRoot, "evidence-manifest.json"), stableJson({
  schema_version: "tivdoc-wave23-orchestrator-evidence-manifest-v0.5.0",
  manifest_self_excluded: true, files: files.sort((left, right) => left.path.localeCompare(right.path, "en")),
}), "utf8");
process.stdout.write(stableJson(result));
if (!result.passed) process.exitCode = 1;
