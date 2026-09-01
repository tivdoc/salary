import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertEvidenceSelfReferenceAbsent,
  assertPortableEvidencePath,
  canonicalPayloadSetHash,
  parseIntegrationEvidenceProfile,
  parseOrderedIntegrationLedger,
  RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS,
  validateRuntimeProductClosureAssessment,
  validateV0101AssessmentAgainstReceipts,
  V0101_FINAL_COMMAND_IDS,
  V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS,
  V0101_RUN_COUNT_NAMES,
  type IntegrationEvidenceProfile,
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

const V0102_CONTRACT_RELATIVE =
  "src/server/system-marathon/runtime-product-closure-contract.v0.10.2.json" as const;
const V0102_FIRST_NINE = Object.freeze(RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS.slice(0, 9));
const V0102_ARCHIVE_BASENAME = "tivdoc-runtime-product-closure-v0.10.2-evidence.zip" as const;
const V0102_MANIFEST_SCHEMA = "tivdoc-runtime-product-closure-inner-manifest-v0.10.2" as const;
const V0102_SELF_REFERENCE_RULE =
  "manifest_archive_hash_verifier_outputs_and_outer_matrix_sidecars_are_excluded_from_the_inner_payload" as const;
const V0102_REPOSITORY_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  V0102_CONTRACT_RELATIVE,
  "src/server/system-marathon/integration-repair-evidence.ts",
  "scripts/canonical-integration-repair-v0101/build.mts",
  "scripts/canonical-integration-repair-v0101/verify.mts",
  "scripts/canonical-integration-repair-v0101/finalize.mts",
  "scripts/canonical-integration-repair-v0101/record.mts",
  "scripts/canonical-integration-repair-v0101/assess.mts",
] as const);

const runtimeProductContract = contractArgumentV0102(process.argv.slice(2));
if (runtimeProductContract !== null) {
  await buildRuntimeProductClosure(runtimeProductContract);
  process.exit(0);
}

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
const matrixHead = String(assessment.matrix_head);
const matrixTree = String(assessment.matrix_tree);
validatePostMatrixRepair(assessment, matrixHead, matrixTree, head, tree);
parseOrderedIntegrationLedger(await readFile(path.join(ROOT,
  "src/server/system-marathon/integration-repair-ledger.v0.10.1.ndjson"), "utf8"));
await validateWorkingArtifacts(branch, head, tree, matrixHead, matrixTree, finalVerification);

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
  finalHead: string,
  finalTree: string,
  matrixHead: string,
  matrixTree: string,
  verification: Record<string, unknown>,
): Promise<void> {
  if (verification.schema_version !== "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1"
      || verification.verified_branch !== expectedBranch || verification.verified_head !== matrixHead
      || verification.verified_tree !== matrixTree || verification.exact_once !== true
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
        || command.verified_head !== matrixHead || command.verified_tree !== matrixTree
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
    ["regressions/browser.json", "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1", matrixHead, matrixTree, true],
    ["regressions/postgresql.json", "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1", matrixHead, matrixTree, true],
    ["product/unified-timeline.json", "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1", matrixHead, matrixTree, true],
    ["verification/safety-and-reachability.json", "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1", matrixHead, matrixTree, true],
    ["integration-repair-assessment.v0.10.1.json", "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1", finalHead, finalTree, false],
  ] as const;
  for (const [relative, schema, artifactHead, artifactTree, requiresBranch] of schemaArtifacts) {
    const value = jsonRecord(await ordinaryBytes(path.join(WORKING, ...relative.split("/"))), "V0101_BUILD_WORKING_JSON_INVALID");
    if (value.schema_version !== schema || value.verified_head !== artifactHead || value.verified_tree !== artifactTree
        || (requiresBranch && value.verified_branch !== expectedBranch)) {
      throw new Error(`V0101_BUILD_WORKING_IDENTITY_INVALID:${relative}`);
    }
  }
  await validateRecordedArtifactBindings(commands);

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
        || copy.schema_version !== expectedSchema || copy.current_head_bound_by_command !== matrixHead
        || copy.current_tree_bound_by_command !== matrixTree) throw new Error("V0101_BUILD_POSTGRES_COPY_INVALID");
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

async function validateRecordedArtifactBindings(commands: readonly Record<string, unknown>[]): Promise<void> {
  const command = (id: string) => {
    const value = commands.find((entry) => entry.command_id === id);
    if (!value) throw new Error(`V0101_BUILD_ARTIFACT_COMMAND_MISSING:${id}`);
    return value;
  };
  const browser = command("browser_e2e_full");
  const postgres = command("postgresql_full_regression");
  const browserRegression = jsonRecord(await ordinaryBytes(path.join(WORKING, "regressions", "browser.json")),
    "V0101_BUILD_BROWSER_REGRESSION_INVALID");
  const browserAfter = record(browserRegression.after, "V0101_BUILD_BROWSER_REGRESSION_INVALID");
  const browserDurableProof = browser.status === "PASS" && browser.proof_contract_status === "PASS";
  if (browserAfter.status !== browser.status || browserAfter.execution_status !== browser.execution_status
      || browserAfter.proof_contract_status !== browser.proof_contract_status
      || browserAfter.durable_identity_postgres_private_storage_proven !== browserDurableProof
      || JSON.stringify(browserAfter.command_receipt) !== JSON.stringify(browser)) {
    throw new Error("V0101_BUILD_BROWSER_COMMAND_BINDING_INVALID");
  }

  const postgresRegression = jsonRecord(await ordinaryBytes(path.join(WORKING, "regressions", "postgresql.json")),
    "V0101_BUILD_POSTGRES_REGRESSION_INVALID");
  const postgresAfter = record(postgresRegression.after, "V0101_BUILD_POSTGRES_REGRESSION_INVALID");
  if (postgresAfter.status !== postgres.status
      || JSON.stringify(postgresAfter.command_receipt) !== JSON.stringify(postgres)) {
    throw new Error("V0101_BUILD_POSTGRES_COMMAND_BINDING_INVALID");
  }

  const timeline = jsonRecord(await ordinaryBytes(path.join(WORKING, "product", "unified-timeline.json")),
    "V0101_BUILD_TIMELINE_INVALID");
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
    throw new Error("V0101_BUILD_TIMELINE_COMMAND_BINDING_INVALID");
  }

  const safety = jsonRecord(await ordinaryBytes(path.join(WORKING, "verification", "safety-and-reachability.json")),
    "V0101_BUILD_SAFETY_INVALID");
  for (const [field, id] of [
    ["prohibited_operation_audit", "prohibited_operation_audit"],
    ["canonical_reachability", "canonical_reachability"],
    ["persistence_wiring", "persistence_wiring"],
  ] as const) {
    if (JSON.stringify(safety[field]) !== JSON.stringify(command(id))) {
      throw new Error(`V0101_BUILD_SAFETY_COMMAND_BINDING_INVALID:${id}`);
    }
  }
  const counters = record(safety.counters, "V0101_BUILD_SAFETY_COUNTERS_INVALID");
  for (const name of ["deployments", "remote_migrations", "customer_data_reads", "live_provider_calls", "openai_calls",
    "real_activations", "manufactured_human_evidence"] as const) {
    if (counters[name] !== 0) throw new Error(`V0101_BUILD_SAFETY_COUNTER_INVALID:${name}`);
  }
}

function validatePostMatrixRepair(
  assessment: Record<string, unknown>,
  matrixHead: string,
  matrixTree: string,
  finalHead: string,
  finalTree: string,
): void {
  if (gitText(["rev-parse", `${matrixHead}^{tree}`]) !== matrixTree) {
    throw new Error("V0101_BUILD_MATRIX_TREE_INVALID");
  }
  if (matrixHead === finalHead && matrixTree === finalTree) {
    if (assessment.post_matrix_evidence_only_repair !== null) throw new Error("V0101_BUILD_POST_MATRIX_REPAIR_INVALID");
    return;
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", matrixHead, finalHead], { cwd: ROOT }).status !== 0) {
    throw new Error("V0101_BUILD_POST_MATRIX_ANCESTRY_INVALID");
  }
  const repair = record(assessment.post_matrix_evidence_only_repair, "V0101_BUILD_POST_MATRIX_REPAIR_INVALID");
  const changedPaths = gitText(["diff", "--name-only", `${matrixHead}..${finalHead}`])
    .split(/\r?\n/u).filter(Boolean).sort(compare);
  if (changedPaths.length < 1
      || changedPaths.some((entry) => !(V0101_POST_MATRIX_EVIDENCE_ONLY_PATHS as readonly string[]).includes(entry))
      || JSON.stringify(repair.changed_paths) !== JSON.stringify(changedPaths)
      || repair.from_head !== matrixHead || repair.from_tree !== matrixTree
      || repair.to_head !== finalHead || repair.to_tree !== finalTree
      || repair.scope !== "EVIDENCE_TOOLING_ONLY_NO_PRODUCT_RUNTIME_CHANGE"
      || repair.product_runtime_changed !== false || repair.matrix_reused_as_final_head_proof !== false) {
    throw new Error("V0101_BUILD_POST_MATRIX_REPAIR_INVALID");
  }
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

type RuntimeProductBuildContext = Readonly<{
  profile: IntegrationEvidenceProfile;
  contract_path: string;
  contract_relative: string;
  contract_bytes: Buffer;
  contract_sha256: string;
  output_root: string;
  working: string;
  final: string;
  payload: string;
  manifest: string;
  archive: string;
  archive_hash: string;
  branch: string;
  head: string;
  tree: string;
}>;

type RuntimeProductStageReceipt = Readonly<{
  stage: "record" | "assess";
  stdout_path: string;
  stdout_sha256: string;
  stdout_byte_count: number;
  stderr_path: string;
  stderr_sha256: string;
  stderr_byte_count: number;
}>;

function contractArgumentV0102(args: readonly string[]): string | null {
  if (!args.includes("--contract")) return null;
  if (args.length !== 2 || args[0] !== "--contract" || !args[1] || args[1].startsWith("-")) {
    throw new Error("V0102_BUILD_CONTRACT_ARGUMENT_INVALID");
  }
  return args[1];
}

async function buildRuntimeProductClosure(contractInput: string): Promise<void> {
  const context = await runtimeProductBuildContext(contractInput);
  await assertFreshRuntimeProductOutput(context);

  const recordStage = await runInternalRuntimeProductStage(context, "record");
  const assessStage = await runInternalRuntimeProductStage(context, "assess");
  const internalStages = Object.freeze([recordStage, assessStage]);

  const assessmentPath = path.join(context.working, "runtime-product-closure-assessment.v0.10.2.json");
  const assessmentBytes = await ordinaryRuntimeProductBytes(assessmentPath);
  const assessment = jsonRecord(assessmentBytes, "V0102_BUILD_ASSESSMENT_INVALID");
  validateRuntimeProductClosureAssessment(context.profile, assessment);
  if (assessment.verified_head !== context.head || assessment.verified_tree !== context.tree
      || assessment.matrix_head !== context.head || assessment.matrix_tree !== context.tree) {
    throw new Error("V0102_BUILD_ASSESSMENT_STALE_HEAD");
  }

  const readWorking = (relative: string) => ordinaryRuntimeProductBytes(
    path.join(context.working, ...relative.split("/")),
  );
  const runtime = await validateRuntimeProductProgress({
    profile: context.profile,
    branch: context.branch,
    head: context.head,
    tree: context.tree,
    contract_sha256: context.contract_sha256,
    read: readWorking,
  });
  await validateRuntimeProductAssessmentBindings(
    context.profile,
    assessment,
    runtime.commands,
    runtime.progress,
    context.head,
    context.tree,
    readWorking,
  );

  const allWorkingFiles = await ordinaryRuntimeProductFiles(context.working);
  const innerWorkingFiles: ReadonlyArray<Readonly<{ absolute: string; relative: string }>> = Object.freeze(
    allWorkingFiles.map((absolute) => Object.freeze({
      absolute,
      relative: runtimeProductRelative(context.working, absolute),
    })).filter(({ relative }) => {
      if (relative === "final-command-journal.ndjson") return false;
      assertPortableEvidencePath(relative);
      if (relative.startsWith("final-logs/")) {
        const allowed = V0102_FIRST_NINE.some((id) => relative === `final-logs/${id}.stdout.log`
          || relative === `final-logs/${id}.stderr.log`);
        if (!allowed) throw new Error(`V0102_BUILD_OUTER_LOG_IN_INNER_SET:${relative}`);
      }
      assertEvidenceSelfReferenceAbsent([`payload/working/${relative}`]);
      return true;
    }).sort((left, right) => compare(left.relative, right.relative)),
  );
  const innerRelativeSet = new Set(innerWorkingFiles.map(({ relative }) => relative));
  for (const required of [
    "runtime-matrix-progress.json",
    "runtime-command-journal.ndjson",
    "runtime-product-closure-assessment.v0.10.2.json",
    "internal-stages/record.stdout.log",
    "internal-stages/record.stderr.log",
    "internal-stages/assess.stdout.log",
    "internal-stages/assess.stderr.log",
    ...V0102_FIRST_NINE.flatMap((id) => [`final-logs/${id}.stdout.log`, `final-logs/${id}.stderr.log`]),
  ]) {
    if (!innerRelativeSet.has(required)) throw new Error(`V0102_BUILD_REQUIRED_INNER_FILE_MISSING:${required}`);
  }

  await mkdir(context.payload, { recursive: true });
  for (const source of V0102_REPOSITORY_FILES) {
    await copyRuntimeProductFile(
      path.join(ROOT, ...source.split("/")),
      path.join(context.payload, "repository", ...source.split("/")),
      128 * 1024 * 1024,
    );
  }
  for (const source of innerWorkingFiles) {
    await copyRuntimeProductFile(
      source.absolute,
      path.join(context.payload, "working", ...source.relative.split("/")),
      128 * 1024 * 1024,
    );
  }

  await writeJson(path.join(context.payload, "git", "base-final.json"), {
    schema_version: "tivdoc-runtime-product-closure-git-provenance-v0.10.2",
    branch: context.branch,
    base_head: context.profile.base_head,
    base_tree: context.profile.base_tree,
    final_head: context.head,
    final_tree: context.tree,
    base_is_ancestor: true,
    worktree_clean_before_build: true,
    contract_path: context.contract_relative,
    contract_sha256: context.contract_sha256,
  });
  await writeFile(
    path.join(context.payload, "git", "full.diff"),
    gitBytes(["diff", "--binary", "--full-index", `${context.profile.base_head}..${context.head}`]),
    { flag: "wx", mode: 0o600 },
  );
  const commits = gitText(["rev-list", "--reverse", `${context.profile.base_head}..${context.head}`])
    .split(/\r?\n/u).filter(Boolean).map((commit, index) => runtimeProductCommitReceipt(commit, index + 1));
  await writeJson(path.join(context.payload, "git", "commit-provenance.json"), {
    schema_version: "tivdoc-runtime-product-closure-commit-provenance-v0.10.2",
    branch: context.branch,
    base_head: context.profile.base_head,
    final_head: context.head,
    final_tree: context.tree,
    commit_count: commits.length,
    commits,
  });

  const payloadFiles = await ordinaryRuntimeProductFiles(context.payload);
  const payloadEntries: V0101EvidenceEntry[] = [];
  for (const file of payloadFiles) {
    const bytes = await ordinaryRuntimeProductBytes(file);
    payloadEntries.push(Object.freeze({
      path: `payload/${runtimeProductRelative(context.payload, file)}`,
      sha256: sha256(bytes),
      byte_count: bytes.byteLength,
    }));
  }
  payloadEntries.sort((left, right) => compare(left.path, right.path));
  assertEvidenceSelfReferenceAbsent(payloadEntries.map((entry) => entry.path));
  const manifest = Object.freeze({
    schema_version: V0102_MANIFEST_SCHEMA,
    contract_schema_version: context.profile.contract_schema_version,
    branch: context.branch,
    base_head: context.profile.base_head,
    base_tree: context.profile.base_tree,
    final_head: context.head,
    final_tree: context.tree,
    contract_path: context.contract_relative,
    contract_sha256: context.contract_sha256,
    payload_files: Object.freeze(payloadEntries),
    payload_file_count: payloadEntries.length,
    payload_bytes: payloadEntries.reduce((sum, entry) => sum + entry.byte_count, 0),
    payload_set_sha256: canonicalPayloadSetHash(payloadEntries),
    inner_working_file_count: innerWorkingFiles.length,
    internal_stages: internalStages,
    self_reference_rule: V0102_SELF_REFERENCE_RULE,
    outer_matrix_sidecars_in_payload: 0,
  });
  await writeJson(context.manifest, manifest);
  await writeDeterministicStoreZip({
    root: context.final,
    output: context.archive,
    entries: Object.freeze(["manifest.json", ...payloadEntries.map((entry) => entry.path)]),
  });
  const archiveBytes = await ordinaryRuntimeProductBytes(context.archive);
  const archiveSha256 = sha256(archiveBytes);
  await writeFile(
    context.archive_hash,
    `${archiveSha256}  ${path.basename(context.archive)}\n`,
    { flag: "wx", mode: 0o600 },
  );

  process.stdout.write(`${JSON.stringify({
    schema_version: "tivdoc-runtime-product-closure-evidence-build-v0.10.2",
    status: "PASS",
    verified_branch: context.branch,
    final_head: context.head,
    final_tree: context.tree,
    contract_sha256: context.contract_sha256,
    internal_stage_count: internalStages.length,
    payload_file_count: payloadEntries.length,
    payload_set_sha256: manifest.payload_set_sha256,
    archive_sha256: archiveSha256,
    archive_byte_count: archiveBytes.byteLength,
    self_reference_absent: true,
    outer_matrix_sidecars_in_payload: 0,
  })}\n`);
}

async function runtimeProductBuildContext(contractInput: string): Promise<RuntimeProductBuildContext> {
  const contractPath = path.resolve(ROOT, contractInput);
  const expectedContract = path.join(ROOT, ...V0102_CONTRACT_RELATIVE.split("/"));
  if (contractPath !== expectedContract || !containedRuntimeProductPath(ROOT, contractPath)) {
    throw new Error("V0102_BUILD_CONTRACT_PATH_INVALID");
  }
  const contractBytes = await ordinaryRuntimeProductBytes(contractPath);
  const profile = parseIntegrationEvidenceProfile(jsonRecord(contractBytes, "V0102_BUILD_CONTRACT_INVALID"));
  const final = path.resolve(ROOT, ...profile.final_output_root.split("/"));
  if (!containedRuntimeProductPath(ROOT, final)
      || final !== path.join(ROOT, "output", "runtime-product-closure-v0.10.2", "final")) {
    throw new Error("V0102_BUILD_OUTPUT_PATH_INVALID");
  }
  const branch = gitText(["branch", "--show-current"]);
  const head = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  if (branch !== profile.branch
      || gitText(["rev-parse", `${profile.base_head}^{tree}`]) !== profile.base_tree
      || spawnSync("git", ["merge-base", "--is-ancestor", profile.base_head, head], { cwd: ROOT }).status !== 0
      || gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0102_BUILD_REPOSITORY_STATE_INVALID");
  }
  const outputRoot = path.dirname(final);
  return Object.freeze({
    profile,
    contract_path: contractPath,
    contract_relative: V0102_CONTRACT_RELATIVE,
    contract_bytes: contractBytes,
    contract_sha256: sha256(contractBytes),
    output_root: outputRoot,
    working: path.join(outputRoot, "working"),
    final,
    payload: path.join(final, "payload"),
    manifest: path.join(final, "manifest.json"),
    archive: path.join(final, V0102_ARCHIVE_BASENAME),
    archive_hash: path.join(final, `${V0102_ARCHIVE_BASENAME}.sha256`),
    branch,
    head,
    tree,
  });
}

async function assertFreshRuntimeProductOutput(context: RuntimeProductBuildContext): Promise<void> {
  try {
    await lstat(context.final);
    throw new Error("V0102_BUILD_FINAL_ALREADY_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const metadata = await lstat(context.working);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("V0102_BUILD_WORKING_INVALID");
  for (const forbidden of [
    "runtime-product-closure-assessment.v0.10.2.json",
    "internal-stages/record.stdout.log",
    "internal-stages/record.stderr.log",
    "internal-stages/assess.stdout.log",
    "internal-stages/assess.stderr.log",
  ]) {
    if (await runtimeProductExists(path.join(context.working, ...forbidden.split("/")))) {
      throw new Error(`V0102_BUILD_INTERNAL_STAGE_NOT_FRESH:${forbidden}`);
    }
  }
}

async function runInternalRuntimeProductStage(
  context: RuntimeProductBuildContext,
  stage: "record" | "assess",
): Promise<RuntimeProductStageReceipt> {
  const script = path.join(ROOT, "scripts", "canonical-integration-repair-v0101", `${stage}.mts`);
  const result = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    script,
    "--contract",
    context.contract_relative,
  ], {
    cwd: ROOT,
    env: runtimeProductChildEnvironment(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60_000,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  const stdoutRelative = `internal-stages/${stage}.stdout.log`;
  const stderrRelative = `internal-stages/${stage}.stderr.log`;
  await mkdir(path.join(context.working, "internal-stages"), { recursive: true });
  await writeFile(path.join(context.working, ...stdoutRelative.split("/")), stdout, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(context.working, ...stderrRelative.split("/")), stderr, { flag: "wx", mode: 0o600 });
  const receipt = lastRuntimeProductJson(stdout);
  const identityValid = receipt?.status === "PASS" && receipt.verified_head === context.head
    && receipt.verified_tree === context.tree;
  const stageValid = stage === "record"
    ? receipt?.schema_version === "tivdoc-runtime-product-record-v0.10.2"
      && receipt.first_nine_commands === V0102_FIRST_NINE.length && receipt.derived_artifacts === 11
    : receipt?.headline === "V0102_LOCAL_ENGINEERING_CLOSURE_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
      && receipt.mc_pass === 36 && receipt.mc_blocked === 3 && receipt.ir_pass === 24
      && receipt.ir_blocked === 3 && receipt.cr_pass === 22;
  if (result.error || result.status !== 0 || result.signal !== null || !identityValid || !stageValid) {
    throw new Error(`V0102_BUILD_INTERNAL_STAGE_FAILED:${stage}`);
  }
  return Object.freeze({
    stage,
    stdout_path: `payload/working/${stdoutRelative}`,
    stdout_sha256: sha256(Buffer.from(stdout, "utf8")),
    stdout_byte_count: Buffer.byteLength(stdout),
    stderr_path: `payload/working/${stderrRelative}`,
    stderr_sha256: sha256(Buffer.from(stderr, "utf8")),
    stderr_byte_count: Buffer.byteLength(stderr),
  });
}

async function validateRuntimeProductProgress(input: Readonly<{
  profile: IntegrationEvidenceProfile;
  branch: string;
  head: string;
  tree: string;
  contract_sha256: string;
  read: (relative: string) => Promise<Buffer>;
}>): Promise<Readonly<{ progress: Record<string, unknown>; commands: readonly Record<string, unknown>[] }>> {
  const progress = jsonRecord(await input.read("runtime-matrix-progress.json"), "V0102_BUILD_MATRIX_INVALID");
  const commands = array(progress.commands, "V0102_BUILD_MATRIX_COMMANDS_INVALID")
    .map((value) => record(value, "V0102_BUILD_MATRIX_COMMAND_INVALID"));
  if (progress.schema_version !== "tivdoc-runtime-product-closure-runtime-matrix-progress-v0.10.2"
      || progress.status !== "PASS" || progress.contract_schema_version !== input.profile.contract_schema_version
      || progress.verified_branch !== input.branch || progress.verified_head !== input.head
      || progress.verified_tree !== input.tree || progress.command_count !== V0102_FIRST_NINE.length
      || JSON.stringify(progress.execution_order) !== JSON.stringify(V0102_FIRST_NINE)
      || commands.length !== V0102_FIRST_NINE.length || progress.exact_once !== true
      || progress.journal_log !== "runtime-command-journal.ndjson") {
    throw new Error("V0102_BUILD_MATRIX_INVALID");
  }
  const packageJsonSha256 = sha256(await ordinaryRuntimeProductBytes(path.join(ROOT, "package.json")));
  const packageLockSha256 = sha256(await ordinaryRuntimeProductBytes(path.join(ROOT, "package-lock.json")));
  for (const [index, command] of commands.entries()) {
    const id = V0102_FIRST_NINE[index]!;
    const argv = array(command.argv, `V0102_BUILD_COMMAND_PROVENANCE_INVALID:${id}`);
    const environment = array(command.environment_allowlist_names, `V0102_BUILD_COMMAND_PROVENANCE_INVALID:${id}`);
    const hashes = record(command.input_hashes, `V0102_BUILD_COMMAND_PROVENANCE_INVALID:${id}`);
    const toolchain = record(command.toolchain, `V0102_BUILD_COMMAND_PROVENANCE_INVALID:${id}`);
    const expectedFingerprint = sha256(Buffer.from(JSON.stringify({
      executable: command.executable,
      argv,
      cwd: command.cwd,
    }), "utf8"));
    if (command.command_id !== id || command.attempt_ordinal !== 1 || command.execution_ordinal !== index + 1
        || command.status !== "PASS" || command.execution_status !== "PASS"
        || command.proof_contract_status !== "PASS" || command.verified_head !== input.head
        || command.verified_tree !== input.tree || !nonnegativeRuntimeProductInteger(command.started_epoch_ms)
        || !nonnegativeRuntimeProductInteger(command.finished_epoch_ms)
        || (command.finished_epoch_ms as number) < (command.started_epoch_ms as number)
        || !positiveRuntimeProductInteger(command.timeout_ms) || typeof command.executable !== "string"
        || command.executable.length < 1 || typeof command.cwd !== "string" || command.cwd.length < 1
        || typeof command.command_text !== "string" || command.command_text.length < 1
        || argv.some((entry) => typeof entry !== "string") || environment.length < 1
        || environment.some((entry) => typeof entry !== "string")
        || JSON.stringify(environment) !== JSON.stringify([...environment].sort(compare))
        || new Set(environment).size !== environment.length
        || command.command_text_sha256 !== sha256(Buffer.from(command.command_text, "utf8"))
        || command.command_fingerprint_sha256 !== expectedFingerprint
        || !runtimeProductSha256(command.environment_allowlist_sha256)
        || hashes.package_json_sha256 !== packageJsonSha256 || hashes.package_lock_sha256 !== packageLockSha256
        || hashes.contract_sha256 !== input.contract_sha256 || toolchain.node !== process.version
        || toolchain.platform !== process.platform || toolchain.arch !== process.arch) {
      throw new Error(`V0102_BUILD_COMMAND_PROVENANCE_INVALID:${id}`);
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const relative = `final-logs/${id}.${stream}.log`;
      if (command[`working_${stream}_log`] !== relative
          || command[`${stream}_log`] !== `outer-matrix/${relative}`) {
        throw new Error(`V0102_BUILD_COMMAND_LOG_REFERENCE_INVALID:${id}`);
      }
      const bytes = await input.read(relative);
      if (command[`${stream}_sha256`] !== sha256(bytes)
          || command[`${stream}_byte_count`] !== bytes.byteLength) {
        throw new Error(`V0102_BUILD_COMMAND_LOG_HASH_INVALID:${id}`);
      }
    }
  }
  const runCounts = record(progress.run_counts, "V0102_BUILD_RUN_COUNTS_INVALID");
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (runCounts[name] !== 1) throw new Error(`V0102_BUILD_RUN_COUNT_INVALID:${name}`);
  }
  const journal = await input.read("runtime-command-journal.ndjson");
  if (progress.journal_sha256 !== sha256(journal) || progress.journal_byte_count !== journal.byteLength) {
    throw new Error("V0102_BUILD_JOURNAL_HASH_INVALID");
  }
  validateRuntimeProductJournal(journal, commands);
  return Object.freeze({ progress, commands: Object.freeze(commands) });
}

async function validateRuntimeProductAssessmentBindings(
  profile: IntegrationEvidenceProfile,
  assessment: Record<string, unknown>,
  commands: readonly Record<string, unknown>[],
  progress: Record<string, unknown>,
  head: string,
  tree: string,
  read: (relative: string) => Promise<Buffer>,
): Promise<void> {
  const command = (id: string) => commands.find((entry) => entry.command_id === id)!;
  const truth = record(assessment.truth, "V0102_BUILD_ASSESSMENT_TRUTH_INVALID");
  const assessmentCounts = record(assessment.run_counts, "V0102_BUILD_ASSESSMENT_RUN_COUNTS_INVALID");
  const progressCounts = record(progress.run_counts, "V0102_BUILD_MATRIX_RUN_COUNTS_INVALID");
  if (truth.TYPESCRIPT !== command("typescript").status
      || truth.PRODUCTION_BUILD !== command("production_build").status
      || truth.REAL_POSTGRESQL_CURRENT_HEAD_PROOF !== command("postgresql_full_regression").status
      || truth.REAL_BROWSER_DURABLE_PRODUCT_PATH !== command("browser_durable_product_e2e").status) {
    throw new Error("V0102_BUILD_ASSESSMENT_COMMAND_CONTRADICTION");
  }
  for (const name of V0101_RUN_COUNT_NAMES) {
    if (assessmentCounts[name] !== 1 || progressCounts[name] !== 1 || truth[name] !== 1) {
      throw new Error(`V0102_BUILD_ASSESSMENT_RUN_COUNT_CONTRADICTION:${name}`);
    }
  }
  const schemas = new Map<string, Readonly<{
    schema: string;
    status: "PASS" | "BLOCKED";
    branch_required: boolean;
  }>>([
    ["external-gates.json", { schema: "tivdoc-runtime-product-closure-external-gates-v0.10.2", status: "BLOCKED", branch_required: false }],
    ["regressions/browser.json", { schema: "tivdoc-runtime-product-browser-regression-v0.10.2", status: "PASS", branch_required: true }],
    ["regressions/postgresql.json", { schema: "tivdoc-runtime-product-postgresql-regression-v0.10.2", status: "PASS", branch_required: true }],
    ["product/unified-timeline.json", { schema: "tivdoc-runtime-product-unified-durable-timeline-v0.10.2", status: "PASS", branch_required: true }],
    ["security/governance-function-acl-rls.json", { schema: "tivdoc-runtime-product-governance-function-acl-rls-v0.10.2", status: "PASS", branch_required: true }],
    ["legal/observation-import.json", { schema: "tivdoc-runtime-product-observation-import-v0.10.2", status: "PASS", branch_required: true }],
    ["workflows/human-legal-ground-truth.json", { schema: "tivdoc-runtime-product-human-legal-ground-truth-workflows-v0.10.2", status: "PASS", branch_required: true }],
    ["quality/golden-mutation-property.json", { schema: "tivdoc-runtime-product-synthetic-golden-mutation-property-v0.10.2", status: "PASS", branch_required: true }],
    ["product/global-invalidation.json", { schema: "tivdoc-runtime-product-global-invalidation-v0.10.2", status: "PASS", branch_required: true }],
    ["product/entrypoint-disposition.json", { schema: "tivdoc-runtime-product-entrypoint-disposition-v0.10.2", status: "PASS", branch_required: true }],
    ["verification/capability-limits-cancellation.json", { schema: "tivdoc-runtime-product-capability-limits-cancellation-v0.10.2", status: "PASS", branch_required: true }],
    ["verification/safety-and-reachability.json", { schema: "tivdoc-runtime-product-safety-reachability-v0.10.2", status: "PASS", branch_required: true }],
  ]);
  for (const [relative, expectation] of schemas) {
    const artifact = jsonRecord(await read(relative), `V0102_BUILD_ARTIFACT_INVALID:${relative}`);
    if (artifact.schema_version !== expectation.schema || artifact.status !== expectation.status
        || artifact.verified_head !== head || artifact.verified_tree !== tree
        || (expectation.branch_required && artifact.verified_branch !== profile.branch)) {
      throw new Error(`V0102_BUILD_ARTIFACT_STALE_OR_CONTRADICTORY:${relative}`);
    }
  }
  const evidenceResults = [
    ...array(assessment.mc_results, "V0102_BUILD_RESULTS_INVALID"),
    ...array(assessment.ir_results, "V0102_BUILD_RESULTS_INVALID"),
    ...array(assessment.cr_results, "V0102_BUILD_RESULTS_INVALID"),
  ];
  const governance = record(assessment.governance_security, "V0102_BUILD_GOVERNANCE_INVALID");
  evidenceResults.push({ evidence: governance.evidence });
  for (const value of evidenceResults) {
    const result = record(value, "V0102_BUILD_RESULT_INVALID");
    for (const raw of array(result.evidence, "V0102_BUILD_RESULT_EVIDENCE_INVALID")) {
      if (typeof raw !== "string" || raw.startsWith("payload/")) {
        throw new Error("V0102_BUILD_RESULT_EVIDENCE_INVALID");
      }
      assertPortableEvidencePath(raw);
      assertEvidenceSelfReferenceAbsent([`payload/working/${raw}`]);
      await read(raw);
    }
  }
}

function validateRuntimeProductJournal(
  bytes: Buffer,
  commands: readonly Record<string, unknown>[],
): void {
  const lines = bytes.toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== commands.length * 2) throw new Error("V0102_BUILD_JOURNAL_EVENT_COUNT_INVALID");
  const events = lines.map((line) => {
    try {
      return record(JSON.parse(line), "V0102_BUILD_JOURNAL_INVALID");
    } catch {
      throw new Error("V0102_BUILD_JOURNAL_INVALID");
    }
  });
  for (const [index, command] of commands.entries()) {
    const started = events[index * 2]!;
    const completed = events[index * 2 + 1]!;
    if (started.event_id !== `V0102-FINAL-${String(index * 2 + 1).padStart(4, "0")}`
        || completed.event_id !== `V0102-FINAL-${String(index * 2 + 2).padStart(4, "0")}`
        || started.event_type !== "COMMAND_STARTED" || completed.event_type !== "COMMAND_COMPLETED"
        || started.command_id !== command.command_id || completed.command_id !== command.command_id
        || started.attempt_ordinal !== 1 || completed.attempt_ordinal !== 1
        || started.execution_ordinal !== index + 1 || completed.execution_ordinal !== index + 1
        || started.verified_head !== command.verified_head || started.verified_tree !== command.verified_tree
        || started.command_text_sha256 !== command.command_text_sha256
        || started.command_fingerprint_sha256 !== command.command_fingerprint_sha256
        || completed.status !== command.status || completed.execution_status !== command.execution_status
        || completed.proof_contract_status !== command.proof_contract_status
        || completed.stdout_sha256 !== command.stdout_sha256 || completed.stderr_sha256 !== command.stderr_sha256
        || completed.finished_epoch_ms !== command.finished_epoch_ms) {
      throw new Error("V0102_BUILD_JOURNAL_COMMAND_MISMATCH");
    }
  }
}

function runtimeProductCommitReceipt(commit: string, ordinal: number): Readonly<Record<string, unknown>> {
  const changedPaths = gitText(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
    .split(/\r?\n/u).filter(Boolean).sort(compare);
  changedPaths.forEach(assertPortableEvidencePath);
  return Object.freeze({
    ordinal,
    commit,
    tree: gitText(["rev-parse", `${commit}^{tree}`]),
    parents: Object.freeze(gitText(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean)),
    subject: gitText(["show", "-s", "--format=%s", commit]),
    changed_paths: Object.freeze(changedPaths),
  });
}

function runtimeProductChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ",
    "USERPROFILE", "windir",
  ] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    CI: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    OPENAI_API_KEY: "",
    TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0",
    TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0",
    TIVDOC_RUNTIME_TARGET: "local_only",
  };
}

function lastRuntimeProductJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Child diagnostics are not evidence receipts.
    }
  }
  return null;
}

async function ordinaryRuntimeProductFiles(root: string): Promise<string[]> {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("V0102_BUILD_SOURCE_ROOT_INVALID");
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compare(left.name, right.name));
    for (const child of children) {
      if (child.isSymbolicLink()) throw new Error("V0102_BUILD_SOURCE_SYMLINK_FORBIDDEN");
      const candidate = path.join(directory, child.name);
      if (child.isDirectory()) await visit(candidate);
      else if (child.isFile()) files.push(candidate);
      else throw new Error("V0102_BUILD_SOURCE_NOT_ORDINARY");
    }
  }
  await visit(root);
  return files;
}

async function ordinaryRuntimeProductBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0102_BUILD_SOURCE_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0102_BUILD_SOURCE_FILE_CHANGED");
  return bytes;
}

async function copyRuntimeProductFile(source: string, destination: string, maxBytes: number): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maxBytes) {
    throw new Error("V0102_BUILD_SOURCE_FILE_INVALID");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, 1);
  const copied = await ordinaryRuntimeProductBytes(destination);
  const original = await ordinaryRuntimeProductBytes(source);
  if (!copied.equals(original)) throw new Error("V0102_BUILD_SOURCE_COPY_CHANGED");
}

function runtimeProductRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("V0102_BUILD_SOURCE_ESCAPE");
  }
  const portable = relative.split(path.sep).join("/");
  assertPortableEvidencePath(portable);
  return portable;
}

function containedRuntimeProductPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function runtimeProductExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runtimeProductSha256(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonnegativeRuntimeProductInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveRuntimeProductInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
