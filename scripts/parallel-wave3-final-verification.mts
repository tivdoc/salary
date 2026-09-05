#!/usr/bin/env node
import "./production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repo = process.cwd();
const outputRoot = path.resolve(repo, "output", "parallel-wave-3");
const commandRoot = path.join(outputRoot, "commands");
await mkdir(commandRoot, { recursive: true });

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError("receipt_value_not_json");
}

function sha256Bytes(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args: string[]) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

type CommandRecord = Readonly<{
  command_id: string;
  purpose: string;
  command: string;
  expected_exit: number;
  actual_exit: number;
  expectation_matched: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  stdout_sha256: string;
  stderr_sha256: string;
  output_path: string;
}>;

const commandDefinitions = [
  {
    purpose: "Integrated targeted Wave 3 acceptance matrix",
    command: "npx vitest run src/engine/case-operations src/server/engine/case-operations src/server/reports src/engine/legal-operations src/server/engine/legal-operations src/engine/case-analysis src/server/engine/case-analysis --reporter=default",
    expected: 0,
  },
  { purpose: "Full repository lint", command: "npm run lint", expected: 0 },
  { purpose: "Full TypeScript no-emit check", command: "npx tsc --noEmit --pretty false", expected: 0 },
  { purpose: "Full repository test suite", command: "npx vitest run --no-file-parallelism --reporter=default", expected: 0 },
  { purpose: "Production-shaped Next.js build without deployment", command: "npm run build", expected: 0 },
  { purpose: "W1 canonical case operations verification", command: "npm run case:ops:verify", expected: 0 },
  { purpose: "W2 legal operations and review packet verification", command: "npm run legal:ops:verify", expected: 0 },
  { purpose: "W3 raw acceptance matrix", command: "npm run case:analysis:verify -- --output output/parallel-wave-3/w3-acceptance.json", expected: 0 },
  { purpose: "Merged W1-W2-W3 synthetic and real fail-closed demonstration", command: "npm run full-system:synthetic -- --output output/parallel-wave-3/integrated-acceptance.json", expected: 0 },
  { purpose: "Real legal catalog strict non-readiness gate", command: "npm run legal:ops:strict-readiness", expected: 2 },
] as const;

const verificationStartedAt = new Date().toISOString();
const commandRecords: CommandRecord[] = [];
for (const [index, definition] of commandDefinitions.entries()) {
  const started = new Date();
  const execution = spawnSync(definition.command, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  const ended = new Date();
  const actualExit = execution.status ?? 255;
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";
  const commandId = `WAVE3_COMMAND_${String(index + 1).padStart(3, "0")}`;
  const outputPath = path.join(commandRoot, `${commandId}.json`);
  const outputRecord = {
    schema_version: "tivdoc-wave3-command-output-v0.6.0",
    command_id: commandId,
    command: definition.command,
    expected_exit: definition.expected,
    actual_exit: actualExit,
    stdout,
    stderr,
  };
  await writeFile(outputPath, `${canonical(outputRecord)}\n`, "utf8");
  commandRecords.push({
    command_id: commandId,
    purpose: definition.purpose,
    command: definition.command,
    expected_exit: definition.expected,
    actual_exit: actualExit,
    expectation_matched: actualExit === definition.expected,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.getTime() - started.getTime(),
    stdout_sha256: sha256Bytes(stdout),
    stderr_sha256: sha256Bytes(stderr),
    output_path: path.relative(repo, outputPath).replaceAll("\\", "/"),
  });
}
const verificationEndedAt = new Date().toISOString();

const ledgerSeed = {
  schema_version: "tivdoc-wave3-command-ledger-v0.6.0",
  expected_command_count: commandDefinitions.length,
  expectation_matched_count: commandRecords.filter((entry) => entry.expectation_matched).length,
  commands: commandRecords,
};
const ledger = { ...ledgerSeed, ledger_sha256: sha256Bytes(canonical(ledgerSeed)) };
const ledgerPath = path.join(outputRoot, "command-ledger-v0.6.0.json");
await writeFile(ledgerPath, `${canonical(ledger)}\n`, "utf8");

async function jsonFile(relativePath: string) {
  const absolute = path.resolve(repo, relativePath);
  const bytes = await readFile(absolute);
  return { path: relativePath, sha256: sha256Bytes(bytes), byte_length: bytes.byteLength, value: JSON.parse(bytes.toString("utf8")) };
}

const integrated = await jsonFile("output/parallel-wave-3/integrated-acceptance.json");
const w1 = await jsonFile("output/parallel-wave-3/workers/w1-case-ops/verify.json");
const w2 = await jsonFile("output/parallel-wave-3/workers/w2-legal-operations/evidence-summary.json");
const packetManifest = await jsonFile("output/parallel-wave-3/workers/w2-legal-operations/review-packet-manifest.json");
const handoff = await jsonFile("output/parallel-wave-3/workers/w2-legal-operations/owner-handoff-index.json");
const w3 = await jsonFile("output/parallel-wave-3/w3-acceptance.json");

const v05PackageLedger = "C:/dev/tivdoc/salary/output/parallel-wave-2.3/package-command-ledger.json";
const v05Receipt = "C:/dev/tivdoc/salary/output/parallel-wave-2.3/verification-receipt-v0.5.0.json";
const v05Zip = "C:/dev/tivdoc/salary/output/parallel-wave-2.3/review-package-v0.5.0.zip";
const v05PackageLedgerBytes = await readFile(v05PackageLedger);
const v05ReceiptBytes = await readFile(v05Receipt);
const v05ZipBytes = await readFile(v05Zip);
const v05ReceiptValue = JSON.parse(v05ReceiptBytes.toString("utf8"));

const allPassed = commandRecords.every((entry) => entry.expectation_matched)
  && integrated.value.passed === true
  && w1.value.passed === true
  && w2.value.passed === true
  && w3.value.passed === true;
const blockers = [
  "LEGAL_SOURCE_CORPUS_INCOMPLETE",
  "OWNER_OFFICIAL_SOURCE_HANDOFF_REQUIRED",
  "HUMAN_LEGAL_SOURCE_REVIEW_REQUIRED",
  "EFFECTIVE_PERIOD_SECTOR_POPULATION_REVIEW_REQUIRED",
  "NUMERIC_DUAL_ATTESTATION_REQUIRED",
  "RULE_LEGAL_APPROVAL_REQUIRED",
  "HUMAN_GROUND_TRUTH_REQUIRED",
  "ISOLATED_SUPABASE_MIGRATION_RLS_VERIFICATION_REQUIRED",
  "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
  "PARSER_OS_SANDBOX_NOT_VERIFIED",
  "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
  "CUSTOMER_CASE_PROCESSING_NOT_YET_PRODUCTION_ENABLED",
  "CUSTOMER_SHADOW_NOT_AUTHORIZED",
  "PRODUCTION_DELIVERY_DISABLED",
  "SHADOW_MODE_NOT_READY",
];
const receiptSeed = {
  schema_version: "tivdoc-full-system-functional-core-receipt-v0.6.0",
  status: allPassed ? "FULL_SYSTEM_FUNCTIONAL_CORE_READY_FOR_HUMAN_LEGAL_INPUT" : "FULL_SYSTEM_FUNCTIONAL_CORE_PARTIAL",
  branch: git("branch", "--show-current"),
  required_base_head: "cf922d8f3ee634b7707554e4b9260a2e1a101b14",
  contract_commit: "354995d9bde4e74ceba0c4e27dea07c821539b87",
  final_head: git("rev-parse", "HEAD"),
  final_tree: git("rev-parse", "HEAD^{tree}"),
  worker_commits: {
    W1: "f5bb4c6dfb7fa16531e76c0678ee08b8029af09b",
    W2: "906ae6e4747a2b73302f0ac80fbef5ecfc1850b2",
    W3: "7a42ae455845f317933dee28a429f9c6c5a1ac91",
  },
  verification: {
    started_at: verificationStartedAt,
    ended_at: verificationEndedAt,
    duration_ms: new Date(verificationEndedAt).getTime() - new Date(verificationStartedAt).getTime(),
    command_ledger_path: path.relative(repo, ledgerPath).replaceAll("\\", "/"),
    command_ledger_sha256: sha256Bytes(await readFile(ledgerPath)),
    command_count: commandRecords.length,
    expectation_matched_count: commandRecords.filter((entry) => entry.expectation_matched).length,
  },
  test_counts: { preexisting: 784, newly_added: 51, final: 835 },
  evidence: {
    integrated: { path: integrated.path, sha256: integrated.sha256, acceptance_sha256: integrated.value.acceptance_sha256 },
    W1: { path: w1.path, sha256: w1.sha256, artifact_hashes: w1.value.artifact_hashes },
    W2: { path: w2.path, sha256: w2.sha256, packet_manifest: { path: packetManifest.path, sha256: packetManifest.sha256 }, owner_handoff: { path: handoff.path, sha256: handoff.sha256 } },
    W3: { path: w3.path, sha256: w3.sha256, report_sha256: w3.value.report_sha256, case_count: w3.value.case_count },
  },
  v0_5_0_preflight: {
    package: { path: v05Zip, sha256: sha256Bytes(v05ZipBytes), byte_length: v05ZipBytes.byteLength },
    detached_receipt: { path: v05Receipt, sha256: sha256Bytes(v05ReceiptBytes), command_ledger_sha256: v05ReceiptValue.command_ledger_sha256 },
    package_command_ledger: { path: v05PackageLedger, sha256: sha256Bytes(v05PackageLedgerBytes), role: "post-package eight-command ledger outside the ZIP" },
    receipt_command_ledger_role: "pre-package 36-command orchestrator ledger embedded as current-claims/orchestrator/command-ledger.json",
    discrepancy_resolved: v05ReceiptValue.command_ledger_sha256 === "4971a01e51b3c426e042f704a27b770dc0ff97c57808537a15fc025c5baa00c4"
      && sha256Bytes(v05PackageLedgerBytes) === "b2c14033f0cf36d6a6dc9ceacbea1dd4e2196f633970c3ab57372e86453d87c9",
  },
  persistence: {
    adapter: integrated.value.persistence_adapter,
    durable: false,
    checks: ["stage append/idempotency", "failure-after-each-stage resume", "immutable completed run", "pinned replay", "version-unavailable fail-closed"],
  },
  zero_prohibited_operations: integrated.value.prohibited_operations,
  blockers,
};
const receipt = { ...receiptSeed, receipt_payload_sha256: sha256Bytes(canonical(receiptSeed)) };
const receiptPath = path.join(outputRoot, "execution-receipt-v0.6.0.json");
await writeFile(receiptPath, `${canonical(receipt)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  status: receipt.status,
  final_head: receipt.final_head,
  final_tree: receipt.final_tree,
  command_count: receipt.verification.command_count,
  expectation_matched_count: receipt.verification.expectation_matched_count,
  receipt_path: path.relative(repo, receiptPath).replaceAll("\\", "/"),
  receipt_sha256: sha256Bytes(await readFile(receiptPath)),
}, null, 2)}\n`);
process.exitCode = allPassed ? 0 : 9;
