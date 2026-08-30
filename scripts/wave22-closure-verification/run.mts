#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runWave22OperationalProof } from "../../src/server/engine/legal-knowledge/wave22-operational-proof/operational-proof.ts";

const defaultOutput = path.resolve("output/parallel-wave-2.2/workers/w3-closure-verification");
const verifier = path.resolve("scripts/wave22-closure-verification/independent_closure_verifier.py");

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid_argument:${key ?? "missing"}`);
    parsed.set(key.slice(2), value);
  }
  return parsed;
}

function required(args: Map<string, string>, name: string) {
  const value = args.get(name);
  if (!value) throw new Error(`missing_required_argument:${name}`);
  return value;
}

async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, stableJson(value), "utf8");
}

async function run(command: string, args: string[]) {
  return await new Promise<{ exit_code: number; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exit_code: code ?? 127, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

async function pythonEvidence(
  python: string,
  args: string[],
  outputFile: string,
  safeCommand: string,
) {
  const result = await run(python, [verifier, ...args, "--output", outputFile]);
  return {
    command: safeCommand,
    exit_code: result.exit_code,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    output_file: path.basename(outputFile),
    passed: result.exit_code === 0,
  };
}

async function evidenceManifest(outputRoot: string) {
  const files = (await readdir(outputRoot)).filter((name) => name !== "evidence-manifest.json").sort();
  const records = await Promise.all(files.map(async (name) => {
    const bytes = await readFile(path.join(outputRoot, name));
    return { path: name, byte_count: bytes.byteLength, sha256: sha256(bytes) };
  }));
  return {
    schema_version: "tivdoc-wave22-w3-evidence-manifest-v0.4.2",
    manifest_self_excluded: true,
    files: records,
  };
}

async function diagnostic(args: Map<string, string>) {
  const python = required(args, "python");
  const repo = path.resolve(args.get("repo") ?? ".");
  const v041 = path.resolve(required(args, "v041"));
  const outputRoot = path.resolve(args.get("output") ?? defaultOutput);
  if (outputRoot === defaultOutput) {
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });
  } else {
    await mkdir(outputRoot, { recursive: true });
    if ((await readdir(outputRoot)).length !== 0) throw new Error("output_directory_not_clean");
  }

  const operational = await runWave22OperationalProof();
  await writeJson(path.join(outputRoot, "operational-proof.json"), operational);
  const archive = await pythonEvidence(
    python,
    ["self-test"],
    path.join(outputRoot, "adversarial-archive-matrix.json"),
    "python independent_closure_verifier.py self-test",
  );
  const historical = await pythonEvidence(
    python,
    ["historical-matrices", "--v041", v041],
    path.join(outputRoot, "raw-case-matrices.json"),
    "python independent_closure_verifier.py historical-matrices --v041 <historical-package>",
  );
  const packageVerification = await pythonEvidence(
    python,
    [
      "verify-package", "--package", v041, "--repo", repo,
      "--expected-zip-sha256", "3926163f825c02fdd7e0fec49ae396ef8fa8ebcc0334961ee1f84e71384570d2",
      "--expected-manifest-sha256", "f4a4ea363abdaf15a2a3cdbba925937360a08d14d704bc3fe6060b2264fcf16b",
      "--expected-head", "48be587d5a394e37656e20a1276b4cebb85c60bb",
      "--label", "v0.4.1",
    ],
    path.join(outputRoot, "v0.4.1-independent-verification.json"),
    "python independent_closure_verifier.py verify-package <frozen-v0.4.1>",
  );

  const testFiles = [
    "src/engine/wave21/evidence-audit/negative-matrices.test.ts",
    "src/server/engine/legal-knowledge/acquisition.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-security.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/protocol.test.ts",
    "src/server/engine/legal-knowledge/controlled-import-recovery/multiprocess.test.ts",
    "src/server/engine/legal-knowledge/parser-isolation/parser-isolation.test.ts",
    "src/server/engine/legal-knowledge/wave22-operational-proof/operational-proof.test.ts",
    "src/engine/wave22/closure-verification/case-registry.test.ts",
  ];
  const testCommandArgs = [
    "node_modules/vitest/vitest.mjs", "run", ...testFiles, "--reporter=verbose", "--maxWorkers=1",
  ];
  const testAttempts = [await run(process.execPath, testCommandArgs)];
  if (testAttempts[0].exit_code !== 0) testAttempts.push(await run(process.execPath, testCommandArgs));
  const testResult = testAttempts.at(-1)!;
  const testEvidence = {
    command: "node node_modules/vitest/vitest.mjs run <eight focused test files> --reporter=verbose --maxWorkers=1",
    test_files: testFiles,
    exit_code: testResult.exit_code,
    stdout_sha256: sha256(testResult.stdout),
    stderr_sha256: sha256(testResult.stderr),
    attempts: testAttempts.map((attempt, index) => ({
      attempt: index + 1,
      exit_code: attempt.exit_code,
      stdout_sha256: sha256(attempt.stdout),
      stderr_sha256: sha256(attempt.stderr),
    })),
    passed: testResult.exit_code === 0,
  };
  await writeJson(path.join(outputRoot, "focused-tests.json"), testEvidence);

  const report = {
    schema_version: "tivdoc-wave22-w3-diagnostic-v0.4.2",
    mode: "diagnostic",
    final_package_mode_implemented_not_executed: true,
    historical_packages_mutated: false,
    production_evidence_generators_imported_by_independent_verifier: false,
    operational_proof: { passed: operational.overall },
    adversarial_archive: archive,
    raw_case_matrices: historical,
    frozen_v0_4_1: packageVerification,
    fresh_canonical_runtime_tests: testEvidence,
    persistent_owner_import_entries: 0,
    assurance: operational.assurance,
    zero_invariants: operational.zero_invariants,
    independent_scanner_member: "independent-secret-pii-scan.json",
    overall: operational.overall && archive.passed && historical.passed && packageVerification.passed && testEvidence.passed,
  };
  await writeJson(path.join(outputRoot, "diagnostic-result.json"), report);
  const scanner = await pythonEvidence(
    python,
    ["scan-staging", "--staging", outputRoot],
    path.join(outputRoot, "independent-secret-pii-scan.json"),
    "python independent_closure_verifier.py scan-staging <clean-worker-evidence>",
  );
  if (!scanner.passed) throw new Error("independent_worker_evidence_scan_failed");
  await writeJson(path.join(outputRoot, "evidence-manifest.json"), await evidenceManifest(outputRoot));
  process.stdout.write(stableJson(report));
  return 0;
}

async function strict(args: Map<string, string>) {
  const python = required(args, "python");
  const outputRoot = path.resolve(args.get("output") ?? defaultOutput);
  await mkdir(outputRoot, { recursive: true });
  const outputFile = path.join(outputRoot, "strict-result.json");
  const forwarded = [
    "final-package",
    "--repo", required(args, "repo"),
    "--v04", required(args, "v04"),
    "--v04-erratum", required(args, "v04-erratum"),
    "--v041", required(args, "v041"),
    "--v042", required(args, "v042"),
    "--expected-v042-sha256", required(args, "expected-v042-sha256"),
    "--expected-v042-manifest-sha256", required(args, "expected-v042-manifest-sha256"),
    "--expected-head", required(args, "expected-head"),
    "--output", outputFile,
  ];
  const result = await run(python, [verifier, ...forwarded]);
  const commandEvidence = {
    schema_version: "tivdoc-wave22-w3-strict-command-v0.4.2",
    command: "python independent_closure_verifier.py final-package <frozen-chain-and-final-package>",
    exit_code: result.exit_code,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
    passed: result.exit_code === 0,
  };
  await writeJson(path.join(outputRoot, "strict-command.json"), commandEvidence);
  await rm(path.join(outputRoot, "evidence-manifest.json"), { force: true });
  const scanner = await pythonEvidence(
    python,
    ["scan-staging", "--staging", outputRoot],
    path.join(outputRoot, "independent-secret-pii-scan.json"),
    "python independent_closure_verifier.py scan-staging <worker-evidence-with-strict-result>",
  );
  if (!scanner.passed) throw new Error("independent_worker_evidence_scan_failed");
  await writeJson(path.join(outputRoot, "evidence-manifest.json"), await evidenceManifest(outputRoot));
  process.stdout.write(stableJson(commandEvidence));
  return result.exit_code;
}

const [mode, ...rest] = process.argv.slice(2);
try {
  const args = parseArgs(rest);
  process.exitCode = mode === "diagnostic" ? await diagnostic(args) : mode === "strict" ? await strict(args) : 2;
  if (process.exitCode === 2) process.stderr.write("usage: run.mts diagnostic|strict [--name value ...]\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "wave22_closure_runner_failed"}\n`);
  process.exitCode = 7;
}
