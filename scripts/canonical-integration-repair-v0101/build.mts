import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101AssessmentAgainstReceipts,
  V0101_FINAL_COMMAND_IDS,
  V0101_RUN_COUNT_NAMES,
  type V0101EvidenceEntry,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";
import { writeDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const OUTPUT_ROOT = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1");
const WORKING = path.join(OUTPUT_ROOT, "working");
const FINAL = path.join(OUTPUT_ROOT, "final");
const PAYLOAD = path.join(FINAL, "payload");
const MANIFEST = path.join(FINAL, "manifest.json");
const ARCHIVE = path.join(FINAL, "tivdoc-v0101-evidence.zip");
const ARCHIVE_HASH = `${ARCHIVE}.sha256`;
const ASSESSMENT_PATH = path.join(WORKING, "integration-repair-assessment.v0.10.1.json");
const FINAL_VERIFICATION_PATH = path.join(WORKING, "final-verification.json");
const EXTERNAL_GATES_PATH = path.join(ROOT, "src", "server", "system-marathon", "external-gates.v0.10.1.json");
const WORKER_RECEIPTS_PATH = path.join(ROOT, "src", "server", "system-marathon",
  "integration-repair-worker-receipts.v0.10.1.json");

const SOURCE_FILES = Object.freeze([
  "src/server/system-marathon/integration-repair-contract.v0.10.1.json",
  "src/server/system-marathon/integration-repair-audit.v0.10.1.json",
  "src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson",
  "src/server/system-marathon/integration-repair-worker-receipts.v0.10.1.json",
  "src/server/system-marathon/external-gates.v0.10.1.json",
  "src/server/system-marathon/integration-repair-metrics.v0.10.1.json",
  "src/server/system-marathon/owner-action-index.v0.10.1.json",
  "src/server/system-marathon/canonical-entrypoints.v0.10.0.json",
  "src/server/platform/persistence/wiring-map.ts",
]);
const FIXED_WORKING_FILES = Object.freeze([
  "final-command-journal.ndjson",
  "final-verification.json",
  "integration-repair-assessment.v0.10.1.json",
  "product/unified-timeline.json",
  "regressions/browser.json",
  "regressions/postgresql.json",
  "verification/safety-and-reachability.json",
  ...V0101_FINAL_COMMAND_IDS.flatMap((id) => [
    `final-logs/${id}.stderr.log`,
    `final-logs/${id}.stdout.log`,
  ]),
]);

await assertFreshOutput();
const head = gitText(["rev-parse", "HEAD"]);
const tree = gitText(["rev-parse", "HEAD^{tree}"]);
const branch = gitText(["branch", "--show-current"]);
if (branch !== BRANCH) throw new Error("V0101_BUILD_BRANCH_INVALID");
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT }).status !== 0) {
  throw new Error("V0101_BUILD_BASE_NOT_ANCESTOR");
}
if (gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_BUILD_WORKTREE_NOT_CLEAN");
}

const assessment = jsonRecord(await ordinaryBytes(ASSESSMENT_PATH), "V0101_BUILD_ASSESSMENT_INVALID");
const finalVerification = jsonRecord(await ordinaryBytes(FINAL_VERIFICATION_PATH), "V0101_BUILD_FINAL_VERIFICATION_INVALID");
const externalGates = jsonRecord(await ordinaryBytes(EXTERNAL_GATES_PATH), "V0101_BUILD_EXTERNAL_GATES_INVALID");
const workerReceiptLedger = jsonRecord(await ordinaryBytes(WORKER_RECEIPTS_PATH), "V0101_BUILD_WORKER_RECEIPTS_INVALID");
const workerReceipts = array(workerReceiptLedger.receipts, "V0101_BUILD_WORKER_RECEIPTS_INVALID")
  .map((value) => record(value, "V0101_BUILD_WORKER_RECEIPT_INVALID"));
if (workerReceiptLedger.schema_version !== "tivdoc-canonical-integration-durability-repair-worker-receipts-v0.10.1"
    || workerReceiptLedger.receipt_count !== workerReceipts.length) throw new Error("V0101_BUILD_WORKER_RECEIPTS_INVALID");
validateV0101AssessmentAgainstReceipts(assessment, finalVerification, externalGates);
if (assessment.verified_head !== head || assessment.verified_tree !== tree) throw new Error("V0101_BUILD_ASSESSMENT_STALE_HEAD");
parseOrderedIntegrationLedger(await readFile(path.join(ROOT,
  "src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson"), "utf8"));
await validateWorkingArtifacts(branch, head, tree, finalVerification);

await mkdir(PAYLOAD, { recursive: true });
for (const source of SOURCE_FILES) await copyOrdinaryFile(path.join(ROOT, source), path.join(PAYLOAD, "repository", source));
for (const source of await ordinaryFiles(WORKING)) {
  const relative = portableRelative(WORKING, source);
  await copyOrdinaryFile(source, path.join(PAYLOAD, "working", ...relative.split("/")), 128 * 1024 * 1024);
}

await writeJson(path.join(PAYLOAD, "git", "base-final.json"), {
  schema_version: "tivdoc-canonical-integration-durability-repair-git-v0.10.1",
  branch,
  base_head: BASE,
  base_tree: gitText(["rev-parse", `${BASE}^{tree}`]),
  final_head: head,
  final_tree: tree,
  base_is_ancestor: true,
  worktree_clean_before_build: true,
});
await writeFile(path.join(PAYLOAD, "git", "full.diff"), gitBytes(["diff", "--binary", "--full-index", `${BASE}..${head}`]));
await writeJson(path.join(PAYLOAD, "git", "commit-receipts.json"), {
  schema_version: "tivdoc-canonical-integration-durability-repair-commits-v0.10.1",
  branch,
  base_head: BASE,
  final_head: head,
  final_tree: tree,
  commits: gitText(["rev-list", "--reverse", `${BASE}..${head}`]).split(/\r?\n/u).filter(Boolean)
    .map((commit, index) => commitReceipt(commit, index + 1)),
});
await validateAssessmentEvidencePaths(assessment);

const payloadFiles = await ordinaryFiles(PAYLOAD);
const payloadEntries: V0101EvidenceEntry[] = [];
for (const file of payloadFiles) {
  const bytes = await readFile(file);
  payloadEntries.push(Object.freeze({
    path: `payload/${portableRelative(PAYLOAD, file)}`,
    sha256: sha256(bytes),
    byte_count: bytes.byteLength,
  }));
}
payloadEntries.sort((left, right) => compare(left.path, right.path));
const manifest = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-manifest-v0.10.1",
  branch,
  base_head: BASE,
  final_head: head,
  final_tree: tree,
  payload_files: Object.freeze(payloadEntries),
  payload_file_count: payloadEntries.length,
  payload_bytes: payloadEntries.reduce((sum, entry) => sum + entry.byte_count, 0),
  payload_set_sha256: canonicalPayloadSetHash(payloadEntries),
  self_reference_rule: "manifest_archive_hash_and_detached_verifier_are_not_payload_files",
});
await writeJson(MANIFEST, manifest);
await writeDeterministicStoreZip({
  root: FINAL,
  output: ARCHIVE,
  entries: Object.freeze(["manifest.json", ...payloadEntries.map((entry) => entry.path)]),
});
const archiveBytes = await readFile(ARCHIVE);
await writeFile(ARCHIVE_HASH, `${sha256(archiveBytes)}  ${path.basename(ARCHIVE)}\n`, { flag: "wx", mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  schema_version: "tivdoc-canonical-integration-durability-repair-build-v0.10.1",
  status: "PASS",
  branch,
  final_head: head,
  final_tree: tree,
  payload_file_count: payloadEntries.length,
  payload_set_sha256: manifest.payload_set_sha256,
  archive_sha256: sha256(archiveBytes),
  archive_byte_count: archiveBytes.byteLength,
})}\n`);

async function validateWorkingArtifacts(
  expectedBranch: string,
  expectedHead: string,
  expectedTree: string,
  verification: Record<string, unknown>,
): Promise<void> {
  if (verification.schema_version !== "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1"
      || verification.verified_branch !== expectedBranch || verification.verified_head !== expectedHead
      || verification.verified_tree !== expectedTree || verification.exact_once !== true
      || verification.working_preflight !== "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND") {
    throw new Error("V0101_BUILD_FINAL_VERIFICATION_IDENTITY_INVALID");
  }
  const commands = array(verification.commands, "V0101_BUILD_FINAL_COMMANDS_INVALID").map((value) => record(value,
    "V0101_BUILD_FINAL_COMMAND_INVALID"));
  if (commands.length !== V0101_FINAL_COMMAND_IDS.length || verification.command_count !== commands.length
      || JSON.stringify(verification.execution_order) !== JSON.stringify(V0101_FINAL_COMMAND_IDS)) {
    throw new Error("V0101_BUILD_FINAL_COMMANDS_INVALID");
  }
  const runCounts = record(verification.run_counts, "V0101_BUILD_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) if (runCounts[name] !== 1) throw new Error(`V0101_BUILD_RUN_COUNT_INVALID:${name}`);
  const logPaths = new Set<string>();
  for (const [index, command] of commands.entries()) {
    const id = V0101_FINAL_COMMAND_IDS[index]!;
    if (command.command_id !== id || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1
        || command.verified_head !== expectedHead || command.verified_tree !== expectedTree
        || (command.status !== "PASS" && command.status !== "FAIL")
        || (command.execution_status !== "PASS" && command.execution_status !== "FAIL")
        || (command.proof_contract_status !== "PASS" && command.proof_contract_status !== "FAIL")
        || !Number.isSafeInteger(command.started_epoch_ms) || !Number.isSafeInteger(command.finished_epoch_ms)
        || (command.finished_epoch_ms as number) < (command.started_epoch_ms as number)) {
      throw new Error(`V0101_BUILD_FINAL_COMMAND_INVALID:${id}`);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const relative = `final-logs/${id}.${stream}.log`;
      if (command[`${stream}_log`] !== relative || logPaths.has(relative)) throw new Error("V0101_BUILD_LOG_REFERENCE_INVALID");
      const bytes = await ordinaryBytes(path.join(WORKING, ...relative.split("/")));
      if (command[`${stream}_sha256`] !== sha256(bytes) || command[`${stream}_byte_count`] !== bytes.byteLength) {
        throw new Error(`V0101_BUILD_LOG_HASH_INVALID:${relative}`);
      }
      logPaths.add(relative);
    }
  }
  const allCommandsPass = commands.every((command) => command.status === "PASS");
  if (verification.status !== (allCommandsPass ? "PASS" : "FAIL")) throw new Error("V0101_BUILD_FINAL_STATUS_INVALID");

  const journalPath = path.join(WORKING, "final-command-journal.ndjson");
  const journalBytes = await ordinaryBytes(journalPath);
  if (verification.journal_log !== "final-command-journal.ndjson" || verification.journal_sha256 !== sha256(journalBytes)
      || verification.journal_byte_count !== journalBytes.byteLength) throw new Error("V0101_BUILD_JOURNAL_HASH_INVALID");
  const journal = journalBytes.toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return record(JSON.parse(line), "V0101_BUILD_JOURNAL_INVALID"); } catch { throw new Error("V0101_BUILD_JOURNAL_INVALID"); }
  });
  if (journal.length !== commands.length * 2) throw new Error("V0101_BUILD_JOURNAL_EVENT_COUNT_INVALID");
  for (const [index, command] of commands.entries()) {
    const started = journal[index * 2]!;
    const completed = journal[index * 2 + 1]!;
    if (started.event_id !== `V0101-FINAL-${String(index * 2 + 1).padStart(4, "0")}`
        || completed.event_id !== `V0101-FINAL-${String(index * 2 + 2).padStart(4, "0")}`
        || started.event_type !== "COMMAND_STARTED" || completed.event_type !== "COMMAND_COMPLETED"
        || started.command_id !== command.command_id || completed.command_id !== command.command_id
        || started.attempt_ordinal !== 1 || completed.attempt_ordinal !== 1
        || started.started_epoch_ms !== command.started_epoch_ms || completed.finished_epoch_ms !== command.finished_epoch_ms
        || completed.status !== command.status || completed.stdout_sha256 !== command.stdout_sha256
        || completed.stderr_sha256 !== command.stderr_sha256) {
      throw new Error("V0101_BUILD_JOURNAL_COMMAND_MISMATCH");
    }
  }

  const schemaArtifacts = [
    ["regressions/browser.json", "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1"],
    ["regressions/postgresql.json", "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1"],
    ["product/unified-timeline.json", "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1"],
    ["verification/safety-and-reachability.json", "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1"],
    ["integration-repair-assessment.v0.10.1.json", "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1"],
  ] as const;
  for (const [relative, schema] of schemaArtifacts) {
    const value = jsonRecord(await ordinaryBytes(path.join(WORKING, ...relative.split("/"))), "V0101_BUILD_WORKING_JSON_INVALID");
    if (value.schema_version !== schema || value.verified_head !== expectedHead || value.verified_tree !== expectedTree
        || (relative !== "integration-repair-assessment.v0.10.1.json" && value.verified_branch !== expectedBranch)) {
      throw new Error(`V0101_BUILD_WORKING_IDENTITY_INVALID:${relative}`);
    }
  }

  const postgresRegression = jsonRecord(await ordinaryBytes(path.join(WORKING, "regressions", "postgresql.json")),
    "V0101_BUILD_POSTGRES_REGRESSION_INVALID");
  const after = record(postgresRegression.after, "V0101_BUILD_POSTGRES_REGRESSION_INVALID");
  const copied = array(after.copied_receipts, "V0101_BUILD_POSTGRES_COPIES_INVALID").map((value) => record(value,
    "V0101_BUILD_POSTGRES_COPY_INVALID"));
  const postgresCommand = commands.find((command) => command.command_id === "postgresql_full_regression")!;
  const allowedPostgres = new Map([
    ["postgresql/matrix-smoke.json", "tivdoc-real-postgresql-matrix-smoke-v0.9.1"],
    ["postgresql/marathon-v010-matrix.json", "tivdoc-marathon-v010-postgresql-matrix-v1"],
  ]);
  if ((postgresCommand.status === "PASS" && copied.length !== allowedPostgres.size)
      || (postgresCommand.status === "FAIL" && copied.length !== 0)) throw new Error("V0101_BUILD_POSTGRES_COPIES_INVALID");
  const postgresFiles: string[] = [];
  for (const copy of copied) {
    const destination = String(copy.destination);
    const expectedSchema = allowedPostgres.get(destination);
    if (!expectedSchema || postgresFiles.includes(destination) || copy.status !== "PASS"
        || copy.schema_version !== expectedSchema || copy.current_head_bound_by_command !== expectedHead
        || copy.current_tree_bound_by_command !== expectedTree) throw new Error("V0101_BUILD_POSTGRES_COPY_INVALID");
    const bytes = await ordinaryBytes(path.join(WORKING, ...destination.split("/")));
    const value = jsonRecord(bytes, "V0101_BUILD_POSTGRES_COPY_INVALID");
    if (copy.sha256 !== sha256(bytes) || copy.byte_count !== bytes.byteLength
        || value.schema_version !== expectedSchema || value.status !== "PASS") throw new Error("V0101_BUILD_POSTGRES_COPY_INVALID");
    postgresFiles.push(destination);
  }

  const expectedFiles = [...FIXED_WORKING_FILES, ...postgresFiles].sort(compare);
  const actualFiles = (await ordinaryFiles(WORKING)).map((file) => portableRelative(WORKING, file)).sort(compare);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error("V0101_BUILD_WORKING_ARTIFACT_SET_INVALID");
}

async function validateAssessmentEvidencePaths(assessment: Record<string, unknown>): Promise<void> {
  for (const value of [...array(assessment.mc_results, "V0101_BUILD_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0101_BUILD_RESULTS_INVALID")]) {
    const result = record(value, "V0101_BUILD_RESULT_INVALID");
    const evidence = array(result.evidence, "V0101_BUILD_RESULT_EVIDENCE_INVALID");
    if (result.id === "MC-35" || result.id === "IR-26") {
      if (evidence.length !== 1 || evidence[0] !== "detached-verifier-output.json") {
        throw new Error(`V0101_BUILD_DETACHED_CLOSURE_REFERENCE_INVALID:${String(result.id)}`);
      }
      continue;
    }
    for (const raw of evidence) {
      if (typeof raw !== "string") throw new Error("V0101_BUILD_RESULT_EVIDENCE_INVALID");
      assertPortableEvidencePath(raw);
      if (!raw.startsWith("payload/")) throw new Error(`V0101_BUILD_EVIDENCE_OUT_OF_PAYLOAD:${raw}`);
      await ordinaryBytes(path.join(FINAL, ...raw.split("/")));
    }
  }
}

async function assertFreshOutput(): Promise<void> {
  try {
    await lstat(FINAL);
    throw new Error("V0101_BUILD_FINAL_ALREADY_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const working = await lstat(WORKING);
  if (!working.isDirectory() || working.isSymbolicLink()) throw new Error("V0101_BUILD_WORKING_INVALID");
}

async function ordinaryFiles(root: string): Promise<string[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("V0101_BUILD_SOURCE_ROOT_INVALID");
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("V0101_BUILD_SOURCE_SYMLINK_FORBIDDEN");
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
      else throw new Error("V0101_BUILD_SOURCE_NOT_ORDINARY");
    }
  }
  await visit(root);
  return files;
}

async function ordinaryBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0101_BUILD_SOURCE_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0101_BUILD_SOURCE_FILE_CHANGED");
  return bytes;
}

async function copyOrdinaryFile(source: string, destination: string, maxBytes = 16 * 1024 * 1024): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maxBytes) {
    throw new Error("V0101_BUILD_SOURCE_FILE_INVALID");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 1);
}

function portableRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("V0101_BUILD_SOURCE_ESCAPE");
  }
  return relative.split(path.sep).join("/");
}

function commitReceipt(commit: string, ordinal: number): Readonly<Record<string, unknown>> {
  const patch = gitBytes(["show", "--pretty=format:", "--binary", commit]);
  const patchIdProcess = spawnSync("git", ["patch-id", "--stable"], {
    cwd: ROOT,
    input: patch,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (patchIdProcess.status !== 0) throw new Error("V0101_BUILD_PATCH_ID_FAILED");
  const patchId = String(patchIdProcess.stdout).trim().split(/\s+/u)[0];
  if (!patchId || !/^[a-f0-9]{40}$/u.test(patchId)) throw new Error("V0101_BUILD_PATCH_ID_INVALID");
  const worker = workerReceipts.find((receipt) => receipt.stable_patch_id === patchId);
  return Object.freeze({
    ordinal,
    commit,
    tree: gitText(["rev-parse", `${commit}^{tree}`]),
    parents: gitText(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean),
    subject: gitText(["show", "-s", "--format=%s", commit]),
    stable_patch_id: patchId,
    diffstat: gitText(["show", "--format=", "--shortstat", commit]),
    changed_paths: gitText(["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split(/\r?\n/u).filter(Boolean),
    worker_receipt_source: "payload/repository/src/server/system-marathon/integration-repair-worker-receipts.v0.10.1.json",
    provenance_match: worker ? "STABLE_PATCH_ID" : "ORCHESTRATOR_COMMIT",
    wave: worker?.lane ?? "ORCHESTRATOR",
    lane: worker?.lane ?? "ORCHESTRATOR",
    worker: worker?.worker ?? null,
    original_worker_commit: worker?.commit_sha ?? null,
    original_worker_tree: worker?.tree_sha ?? null,
    allowlist_result: worker?.allowlist_result ?? "NOT_APPLICABLE_ORCHESTRATOR_COMMIT",
    focused_checks: worker?.focused_checks ?? null,
  });
}

function gitText(args: readonly string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

async function writeJson(destination: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function jsonRecord(bytes: Uint8Array, code: string): Record<string, unknown> {
  try { return record(JSON.parse(Buffer.from(bytes).toString("utf8")), code); } catch { throw new Error(code); }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
