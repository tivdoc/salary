import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseOrderedIntegrationLedger,
  validateV0101AssessmentAgainstReceipts,
  V0101_FINAL_COMMAND_IDS,
  V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS,
  type V0101EvidenceEntry,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";
import { inspectDeterministicStoreZip } from "../canonical-persistence-v091/evidence/deterministic-zip.mts";

const ROOT = path.resolve(process.cwd());
const BASE = "3b1740d63bb6978d990d1a6127730f3cec3574cc";
const BRANCH = "codex/tivdoc-engine-foundation";
const FINAL = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "final");
const MANIFEST_PATH = path.join(FINAL, "manifest.json");
const ARCHIVE_PATH = path.join(FINAL, "tivdoc-v0101-evidence.zip");
const ARCHIVE_HASH_PATH = `${ARCHIVE_PATH}.sha256`;
const OUTPUT_PATH = path.join(FINAL, "detached-verifier-output.json");
const ASSESSMENT_ENTRY = "payload/working/integration-repair-assessment.v0.10.1.json";
const FINAL_VERIFICATION_ENTRY = "payload/working/final-verification.json";
const EXTERNAL_GATES_ENTRY = "payload/repository/src/server/system-marathon/external-gates.v0.10.1.json";
const LEDGER_ENTRY = "payload/repository/src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson";
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

const manifestBytes = await ordinaryBytes(MANIFEST_PATH);
const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "V0101_VERIFY_MANIFEST_INVALID");
if (manifest.schema_version !== "tivdoc-canonical-integration-durability-repair-manifest-v0.10.1"
    || manifest.branch !== BRANCH || manifest.base_head !== BASE
    || manifest.self_reference_rule !== "manifest_archive_hash_and_detached_verifier_are_not_payload_files") {
  throw new Error("V0101_VERIFY_MANIFEST_INVALID");
}
const payload = entries(manifest.payload_files);
if (manifest.payload_file_count !== payload.length
    || manifest.payload_bytes !== payload.reduce((sum, entry) => sum + entry.byte_count, 0)
    || manifest.payload_set_sha256 !== canonicalPayloadSetHash(payload)) {
  throw new Error("V0101_VERIFY_PAYLOAD_SET_INVALID");
}
const payloadMap = new Map(payload.map((entry) => [entry.path, entry]));
for (const required of [ASSESSMENT_ENTRY, FINAL_VERIFICATION_ENTRY, EXTERNAL_GATES_ENTRY, LEDGER_ENTRY]) {
  if (!payloadMap.has(required)) throw new Error(`V0101_VERIFY_REQUIRED_PAYLOAD_MISSING:${required}`);
}
if (payload.some((entry) => /(?:^|\/)(?:manifest\.json|tivdoc-v0101-evidence\.zip(?:\.sha256)?|detached-verifier-output\.json)$/u
  .test(entry.path))) throw new Error("V0101_VERIFY_SELF_REFERENCE_IN_PAYLOAD");

for (const entry of payload) {
  const bytes = await ordinaryBytes(path.join(FINAL, ...entry.path.split("/")));
  if (bytes.byteLength !== entry.byte_count || sha256(bytes) !== entry.sha256) {
    throw new Error(`V0101_VERIFY_PAYLOAD_BYTES_INVALID:${entry.path}`);
  }
}

const inspection = await inspectDeterministicStoreZip(ARCHIVE_PATH);
const expectedArchive = Object.freeze([
  Object.freeze({ path: "manifest.json", sha256: sha256(manifestBytes), byte_count: manifestBytes.byteLength }),
  ...payload,
].sort((left, right) => compare(left.path, right.path)));
const actualArchive = [...inspection.entries]
  .map((entry) => ({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count }))
  .sort((left, right) => compare(left.path, right.path));
if (JSON.stringify(actualArchive) !== JSON.stringify(expectedArchive)) {
  throw new Error("V0101_VERIFY_ARCHIVE_ENTRY_SET_INVALID");
}

const archiveBytes = await ordinaryBytes(ARCHIVE_PATH);
const archiveSha256 = sha256(archiveBytes);
const declaredHash = (await ordinaryBytes(ARCHIVE_HASH_PATH)).toString("ascii").trim();
if (declaredHash !== `${archiveSha256}  ${path.basename(ARCHIVE_PATH)}`) {
  throw new Error("V0101_VERIFY_ARCHIVE_HASH_INVALID");
}

const assessment = await jsonPayload(ASSESSMENT_ENTRY, "V0101_VERIFY_ASSESSMENT_INVALID");
const finalVerification = await jsonPayload(FINAL_VERIFICATION_ENTRY, "V0101_VERIFY_FINAL_VERIFICATION_INVALID");
const externalGates = await jsonPayload(EXTERNAL_GATES_ENTRY, "V0101_VERIFY_EXTERNAL_GATES_INVALID");
const matrixHead = String(assessment.matrix_head);
const matrixTree = String(assessment.matrix_tree);
validateV0101AssessmentAgainstReceipts(assessment, finalVerification, externalGates);
parseOrderedIntegrationLedger((await payloadBytes(LEDGER_ENTRY)).toString("utf8"));
await validateFinalVerificationReferences(finalVerification);
await validateAssessmentEvidencePaths(assessment);

const head = git(["rev-parse", "HEAD"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);
const branch = git(["branch", "--show-current"]);
if (branch !== BRANCH || manifest.final_head !== head || manifest.final_tree !== tree
    || assessment.verified_head !== head || assessment.verified_tree !== tree
    || finalVerification.verified_branch !== branch || finalVerification.verified_head !== matrixHead
    || finalVerification.verified_tree !== matrixTree) {
  throw new Error("V0101_VERIFY_STALE_HEAD");
}
validatePostMatrixRepair(assessment, matrixHead, matrixTree, head, tree);
await validateWorkingArtifactSet(branch, head, tree, matrixHead, matrixTree, finalVerification);
const gitProof = await jsonPayload("payload/git/base-final.json", "V0101_VERIFY_GIT_PROOF_INVALID");
if (gitProof.branch !== branch || gitProof.base_head !== BASE || gitProof.final_head !== head
    || gitProof.final_tree !== tree || gitProof.base_is_ancestor !== true || gitProof.worktree_clean_before_build !== true) {
  throw new Error("V0101_VERIFY_GIT_PROOF_INVALID");
}
if (spawnSync("git", ["merge-base", "--is-ancestor", BASE, head], { cwd: ROOT }).status !== 0) {
  throw new Error("V0101_VERIFY_BASE_NOT_ANCESTOR");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("V0101_VERIFY_WORKTREE_NOT_CLEAN");
}

const closureResults = new Map<string, Record<string, unknown>>();
for (const value of [...array(assessment.mc_results, "V0101_VERIFY_RESULTS_INVALID"),
  ...array(assessment.ir_results, "V0101_VERIFY_RESULTS_INVALID")]) {
  const result = record(value, "V0101_VERIFY_RESULT_INVALID");
  closureResults.set(String(result.id), result);
}
for (const id of ["MC-35", "IR-26"] as const) {
  const result = closureResults.get(id);
  if (result?.status !== "PASS" || JSON.stringify(result.evidence) !== JSON.stringify(["detached-verifier-output.json"])) {
    throw new Error(`V0101_VERIFY_DETACHED_CLOSURE_NOT_ADMISSIBLE:${id}`);
  }
}

const receipt = Object.freeze({
  schema_version: "tivdoc-canonical-integration-durability-repair-detached-verifier-v0.10.1",
  status: "PASS",
  verified_branch: branch,
  final_head: head,
  final_tree: tree,
  matrix_head: matrixHead,
  matrix_tree: matrixTree,
  post_matrix_evidence_only_repair_verified: assessment.post_matrix_evidence_only_repair !== null,
  manifest_sha256: sha256(manifestBytes),
  payload_file_count: payload.length,
  payload_set_sha256: manifest.payload_set_sha256,
  archive_entry_count: inspection.entry_count,
  archive_sha256: archiveSha256,
  traversal_rejected: true,
  duplicate_normalized_paths_rejected: true,
  out_of_root_evidence_rejected: true,
  missing_evidence_rejected: true,
  malformed_ledgers_rejected: true,
  self_reference_absent: true,
  stale_head_rejected: true,
  contradictory_statuses_rejected: true,
  blocked_gate_false_pass_rejected: true,
  detached_closure: Object.freeze({
    status: "PASS",
    closes_assessment_ids: Object.freeze(["MC-35", "IR-26"]),
    proof_established_after_manifest_payload_archive_and_status_verification: true,
    self_reference_rule_preserved: true,
  }),
});
await writeFile(OUTPUT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify(receipt)}\n`);

async function validateFinalVerificationReferences(verification: Record<string, unknown>): Promise<void> {
  const commands = array(verification.commands, "V0101_VERIFY_FINAL_COMMANDS_INVALID").map((value) => record(value,
    "V0101_VERIFY_FINAL_COMMAND_INVALID"));
  if (commands.length !== V0101_FINAL_COMMAND_IDS.length
      || JSON.stringify(verification.execution_order) !== JSON.stringify(V0101_FINAL_COMMAND_IDS)) {
    throw new Error("V0101_VERIFY_FINAL_COMMANDS_INVALID");
  }
  for (const [index, command] of commands.entries()) {
    const id = V0101_FINAL_COMMAND_IDS[index]!;
    if (command.command_id !== id || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1) {
      throw new Error("V0101_VERIFY_FINAL_COMMAND_INVALID");
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const relative = `final-logs/${id}.${stream}.log`;
      if (command[`${stream}_log`] !== relative) throw new Error("V0101_VERIFY_LOG_REFERENCE_INVALID");
      const bytes = await payloadBytes(`payload/working/${relative}`);
      if (command[`${stream}_sha256`] !== sha256(bytes) || command[`${stream}_byte_count`] !== bytes.byteLength) {
        throw new Error("V0101_VERIFY_LOG_HASH_INVALID");
      }
    }
  }
  if (verification.journal_log !== "final-command-journal.ndjson") throw new Error("V0101_VERIFY_JOURNAL_REFERENCE_INVALID");
  const journal = await payloadBytes("payload/working/final-command-journal.ndjson");
  if (verification.journal_sha256 !== sha256(journal) || verification.journal_byte_count !== journal.byteLength) {
    throw new Error("V0101_VERIFY_JOURNAL_HASH_INVALID");
  }
  const events = journal.toString("utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return record(JSON.parse(line), "V0101_VERIFY_JOURNAL_INVALID"); } catch { throw new Error("V0101_VERIFY_JOURNAL_INVALID"); }
  });
  if (events.length !== commands.length * 2) throw new Error("V0101_VERIFY_JOURNAL_INVALID");
  for (const [index, command] of commands.entries()) {
    const started = events[index * 2]!;
    const completed = events[index * 2 + 1]!;
    if (started.event_id !== `V0101-FINAL-${String(index * 2 + 1).padStart(4, "0")}`
        || completed.event_id !== `V0101-FINAL-${String(index * 2 + 2).padStart(4, "0")}`
        || started.event_type !== "COMMAND_STARTED" || completed.event_type !== "COMMAND_COMPLETED"
        || started.command_id !== command.command_id || completed.command_id !== command.command_id
        || started.attempt_ordinal !== 1 || completed.attempt_ordinal !== 1
        || completed.status !== command.status || completed.stdout_sha256 !== command.stdout_sha256
        || completed.stderr_sha256 !== command.stderr_sha256) {
      throw new Error("V0101_VERIFY_JOURNAL_COMMAND_MISMATCH");
    }
  }
}

function validatePostMatrixRepair(
  assessment: Record<string, unknown>,
  matrixHead: string,
  matrixTree: string,
  finalHead: string,
  finalTree: string,
): void {
  if (git(["rev-parse", `${matrixHead}^{tree}`]) !== matrixTree) {
    throw new Error("V0101_VERIFY_MATRIX_TREE_INVALID");
  }
  if (matrixHead === finalHead && matrixTree === finalTree) {
    if (assessment.post_matrix_evidence_only_repair !== null) throw new Error("V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
    return;
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", matrixHead, finalHead], { cwd: ROOT }).status !== 0) {
    throw new Error("V0101_VERIFY_POST_MATRIX_ANCESTRY_INVALID");
  }
  const repair = record(assessment.post_matrix_evidence_only_repair, "V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
  const changedPaths = git(["diff", "--name-only", `${matrixHead}..${finalHead}`])
    .split(/\r?\n/u).filter(Boolean).sort(compare);
  if (changedPaths.length < 1
      || changedPaths.some((entry) => !(V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS as readonly string[]).includes(entry))
      || JSON.stringify(repair.changed_paths) !== JSON.stringify(changedPaths)
      || repair.from_head !== matrixHead || repair.from_tree !== matrixTree
      || repair.to_head !== finalHead || repair.to_tree !== finalTree
      || repair.scope !== "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE"
      || repair.product_runtime_changed !== false || repair.matrix_reused_as_final_head_proof !== false) {
    throw new Error("V0101_VERIFY_POST_MATRIX_REPAIR_INVALID");
  }
}

async function validateWorkingArtifactSet(
  expectedBranch: string,
  finalHead: string,
  finalTree: string,
  matrixHead: string,
  matrixTree: string,
  verification: Record<string, unknown>,
): Promise<void> {
  const schemaArtifacts = [
    ["regressions/browser.json", "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1", matrixHead, matrixTree, true],
    ["regressions/postgresql.json", "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1", matrixHead, matrixTree, true],
    ["product/unified-timeline.json", "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1", matrixHead, matrixTree, true],
    ["verification/safety-and-reachability.json", "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1", matrixHead, matrixTree, true],
    ["integration-repair-assessment.v0.10.1.json", "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1", finalHead, finalTree, false],
  ] as const;
  for (const [relative, schema, artifactHead, artifactTree, requiresBranch] of schemaArtifacts) {
    const value = await jsonPayload(`payload/working/${relative}`, "V0101_VERIFY_WORKING_JSON_INVALID");
    if (value.schema_version !== schema || value.verified_head !== artifactHead || value.verified_tree !== artifactTree
        || (requiresBranch && value.verified_branch !== expectedBranch)) {
      throw new Error(`V0101_VERIFY_WORKING_IDENTITY_INVALID:${relative}`);
    }
  }

  const postgresRegression = await jsonPayload("payload/working/regressions/postgresql.json",
    "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const after = record(postgresRegression.after, "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const copied = array(after.copied_receipts, "V0101_VERIFY_POSTGRES_COPIES_INVALID")
    .map((value) => record(value, "V0101_VERIFY_POSTGRES_COPY_INVALID"));
  const commands = array(verification.commands, "V0101_VERIFY_FINAL_COMMANDS_INVALID")
    .map((value) => record(value, "V0101_VERIFY_FINAL_COMMAND_INVALID"));
  await validateRecordedArtifactBindings(commands);
  const postgresCommand = commands.find((command) => command.command_id === "postgresql_full_regression");
  const allowedPostgres = new Map([
    ["postgresql/matrix-smoke.json", "tivdoc-real-postgresql-matrix-smoke-v0.9.1"],
    ["postgresql/marathon-v010-matrix.json", "tivdoc-marathon-v010-postgresql-matrix-v1"],
  ]);
  if (!postgresCommand || (postgresCommand.status === "PASS" && copied.length !== allowedPostgres.size)
      || (postgresCommand.status === "FAIL" && copied.length !== 0)) {
    throw new Error("V0101_VERIFY_POSTGRES_COPIES_INVALID");
  }
  const postgresFiles: string[] = [];
  for (const copy of copied) {
    const destination = String(copy.destination);
    const expectedSchema = allowedPostgres.get(destination);
    if (!expectedSchema || postgresFiles.includes(destination) || copy.status !== "PASS"
        || copy.schema_version !== expectedSchema || copy.current_head_bound_by_command !== matrixHead
        || copy.current_tree_bound_by_command !== matrixTree) {
      throw new Error("V0101_VERIFY_POSTGRES_COPY_INVALID");
    }
    const entryPath = `payload/working/${destination}`;
    const bytes = await payloadBytes(entryPath);
    const value = record(JSON.parse(bytes.toString("utf8")), "V0101_VERIFY_POSTGRES_COPY_INVALID");
    if (copy.sha256 !== sha256(bytes) || copy.byte_count !== bytes.byteLength
        || value.schema_version !== expectedSchema || value.status !== "PASS") {
      throw new Error("V0101_VERIFY_POSTGRES_COPY_INVALID");
    }
    postgresFiles.push(destination);
  }

  const expectedFiles = [...FIXED_WORKING_FILES, ...postgresFiles].sort(compare);
  const actualFiles = [...payloadMap.keys()].filter((entry) => entry.startsWith("payload/working/"))
    .map((entry) => entry.slice("payload/working/".length)).sort(compare);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("V0101_VERIFY_WORKING_ARTIFACT_SET_INVALID");
  }
}

async function validateRecordedArtifactBindings(commands: readonly Record<string, unknown>[]): Promise<void> {
  const command = (id: string) => {
    const value = commands.find((entry) => entry.command_id === id);
    if (!value) throw new Error(`V0101_VERIFY_ARTIFACT_COMMAND_MISSING:${id}`);
    return value;
  };
  const browser = command("browser_e2e_full");
  const postgres = command("postgresql_full_regression");
  const browserRegression = await jsonPayload("payload/working/regressions/browser.json",
    "V0101_VERIFY_BROWSER_REGRESSION_INVALID");
  const browserAfter = record(browserRegression.after, "V0101_VERIFY_BROWSER_REGRESSION_INVALID");
  const browserDurableProof = browser.status === "PASS" && browser.proof_contract_status === "PASS";
  if (browserAfter.status !== browser.status || browserAfter.execution_status !== browser.execution_status
      || browserAfter.proof_contract_status !== browser.proof_contract_status
      || browserAfter.durable_identity_postgres_private_storage_proven !== browserDurableProof
      || JSON.stringify(browserAfter.command_receipt) !== JSON.stringify(browser)) {
    throw new Error("V0101_VERIFY_BROWSER_COMMAND_BINDING_INVALID");
  }

  const postgresRegression = await jsonPayload("payload/working/regressions/postgresql.json",
    "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  const postgresAfter = record(postgresRegression.after, "V0101_VERIFY_POSTGRES_REGRESSION_INVALID");
  if (postgresAfter.status !== postgres.status
      || JSON.stringify(postgresAfter.command_receipt) !== JSON.stringify(postgres)) {
    throw new Error("V0101_VERIFY_POSTGRES_COMMAND_BINDING_INVALID");
  }

  const timeline = await jsonPayload("payload/working/product/unified-timeline.json", "V0101_VERIFY_TIMELINE_INVALID");
  const expectedSteps = [
    { step: "durable_cookie_identity", status: "IMPLEMENTED_NOT_INSTALLED" },
    { step: "portal_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "operations_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "postgres_worker_report_private_object_restart", status: postgres.status },
    { step: "rendered_browser_download", status: browserDurableProof ? "PASS" : "NOT_PROVEN" },
  ];
  if (timeline.status !== "FAIL" || JSON.stringify(timeline.steps) !== JSON.stringify(expectedSteps)
      || timeline.exact_pdf_bytes_at_postgres_boundary !== (postgres.status === "PASS")
      || timeline.durable_browser_product_path !== browserDurableProof) {
    throw new Error("V0101_VERIFY_TIMELINE_COMMAND_BINDING_INVALID");
  }

  const safety = await jsonPayload("payload/working/verification/safety-and-reachability.json",
    "V0101_VERIFY_SAFETY_INVALID");
  for (const [field, id] of [
    ["prohibited_operation_audit", "prohibited_operation_audit"],
    ["canonical_reachability", "canonical_reachability"],
    ["persistence_wiring", "persistence_wiring"],
  ] as const) {
    if (JSON.stringify(safety[field]) !== JSON.stringify(command(id))) {
      throw new Error(`V0101_VERIFY_SAFETY_COMMAND_BINDING_INVALID:${id}`);
    }
  }
  const counters = record(safety.counters, "V0101_VERIFY_SAFETY_COUNTERS_INVALID");
  for (const name of ["deployments", "remote_migrations", "customer_data_reads", "live_provider_calls", "openai_calls",
    "real_activations", "manufactured_human_evidence"] as const) {
    if (counters[name] !== 0) throw new Error(`V0101_VERIFY_SAFETY_COUNTER_INVALID:${name}`);
  }
}

async function validateAssessmentEvidencePaths(assessment: Record<string, unknown>): Promise<void> {
  for (const value of [...array(assessment.mc_results, "V0101_VERIFY_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0101_VERIFY_RESULTS_INVALID")]) {
    const result = record(value, "V0101_VERIFY_RESULT_INVALID");
    const evidence = array(result.evidence, "V0101_VERIFY_EVIDENCE_INVALID");
    if (result.id === "MC-35" || result.id === "IR-26") {
      if (evidence.length !== 1 || evidence[0] !== "detached-verifier-output.json") {
        throw new Error("V0101_VERIFY_DETACHED_CLOSURE_REFERENCE_INVALID");
      }
      continue;
    }
    for (const raw of evidence) {
      if (typeof raw !== "string") throw new Error("V0101_VERIFY_EVIDENCE_INVALID");
      assertPortableEvidencePath(raw);
      if (!raw.startsWith("payload/") || !payloadMap.has(raw)) throw new Error(`V0101_VERIFY_EVIDENCE_MISSING:${raw}`);
      await payloadBytes(raw);
    }
  }
}

function entries(value: unknown): V0101EvidenceEntry[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("V0101_VERIFY_PAYLOAD_ENTRIES_INVALID");
  return value.map((item) => {
    const entry = record(item, "V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    if (typeof entry.path !== "string" || !entry.path.startsWith("payload/")
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)
        || !Number.isSafeInteger(entry.byte_count) || (entry.byte_count as number) < 0) {
      throw new Error("V0101_VERIFY_PAYLOAD_ENTRY_INVALID");
    }
    assertPortableEvidencePath(entry.path);
    return Object.freeze({ path: entry.path, sha256: entry.sha256, byte_count: entry.byte_count as number });
  });
}

async function payloadBytes(entryPath: string): Promise<Buffer> {
  if (!payloadMap.has(entryPath)) throw new Error(`V0101_VERIFY_REQUIRED_PAYLOAD_MISSING:${entryPath}`);
  return await ordinaryBytes(path.join(FINAL, ...entryPath.split("/")));
}

async function jsonPayload(entryPath: string, code: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse((await payloadBytes(entryPath)).toString("utf8")), code);
  } catch {
    throw new Error(code);
  }
}

async function ordinaryBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0101_VERIFY_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0101_VERIFY_FILE_CHANGED");
  return bytes;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
