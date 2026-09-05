import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseIntegrationEvidenceProfile,
  RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS,
  validateRuntimeProductClosureAssessmentAgainstReceipts,
  type IntegrationEvidenceProfile,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";

const ROOT = path.resolve(process.cwd());
const NODE = process.execPath;
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const ESLINT = path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const STRIP_TYPES = Object.freeze(["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types"]);

const profile = await loadProfile(process.argv.slice(2));
const WORKING = path.join(profile.output_root, "working");
const LOGS = path.join(WORKING, "final-logs");
const JOURNAL = path.join(WORKING, "final-command-journal.ndjson");
const RECEIPT = path.join(WORKING, "final-verification.json");
const RUNTIME_PROGRESS = path.join(WORKING, "runtime-matrix-progress.json");
const RUNTIME_JOURNAL = path.join(WORKING, "runtime-command-journal.ndjson");
const ASSESSMENT = path.join(WORKING, "runtime-product-closure-assessment.v0.10.2.json");
const git = verifyGit();
const inputHashes = await evidenceInputHashes(profile);
await initializeFreshWorkingDirectory();

const specifications = profile.kind === "v0102"
  ? runtimeProductSpecifications(profile)
  : v0101Specifications();
if (JSON.stringify(specifications.map((entry) => entry.command_id)) !== JSON.stringify(profile.command_ids)) {
  throw new Error(`${profile.error_prefix}_FINAL_COMMAND_SET_INVALID`);
}

const attempts: string[] = [];
const completed = new Set<string>();
let journalSequence = 0;
const commands: Readonly<Record<string, unknown>>[] = [];
for (const specification of specifications) {
  if (profile.kind === "v0102" && commands.length === 9) await sealRuntimeProgress(commands);
  commands.push(await execute(specification));
}
for (const specification of specifications) {
  if (attempts.filter((id) => id === specification.command_id).length !== 1 || !completed.has(specification.command_id)) {
    throw new Error(`${profile.error_prefix}_FINAL_EXACT_ONCE_INVARIANT_FAILED:${specification.command_id}`);
  }
}

const runCounts = Object.freeze({
  FULL_SUITE_RUN_COUNT: attemptCount("full_suite"),
  PRODUCTION_BUILD_RUN_COUNT: attemptCount("production_build"),
  BROWSER_E2E_FULL_RUN_COUNT: attemptCount(profile.kind === "v0102"
    ? "browser_durable_product_e2e" : "browser_e2e_full"),
  POSTGRESQL_FULL_REGRESSION_RUN_COUNT: attemptCount("postgresql_full_regression"),
});
const journalBytes = await readFile(JOURNAL);
const receipt = Object.freeze({
  schema_version: profile.final_verification_schema,
  ...(profile.integration_profile
    ? { contract_schema_version: profile.integration_profile.contract_schema_version }
    : {}),
  status: commands.every((entry) => entry.status === "PASS") ? "PASS" as const : "FAIL" as const,
  verified_branch: git.branch,
  verified_head: git.head,
  verified_tree: git.tree,
  command_count: commands.length,
  execution_order: Object.freeze(specifications.map((entry) => entry.command_id)),
  commands,
  run_counts: runCounts,
  exact_once: true,
  post_matrix_tracked_commit: null,
  working_preflight: "FRESH_DIRECTORY_CREATED_BEFORE_FIRST_COMMAND",
  journal_log: profile.kind === "v0102"
    ? "outer-matrix/final-command-journal.ndjson"
    : "final-command-journal.ndjson",
  journal_sha256: sha256(journalBytes),
  journal_byte_count: journalBytes.byteLength,
});
await writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });

if (profile.kind === "v0102") {
  if (profile.integration_profile && await ordinaryExists(ASSESSMENT)) {
    const assessment = JSON.parse(await readFile(ASSESSMENT, "utf8")) as unknown;
    validateRuntimeProductClosureAssessmentAgainstReceipts(profile.integration_profile, assessment, receipt);
  } else if (receipt.status === "PASS") {
    throw new Error("V0102_FINAL_ASSESSMENT_MISSING");
  }
  await sealOuterMatrix(receipt);
}

verifyExactFrozenGit();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;

type ProofKind = "process_exit" | "browser_v0101" | "browser_v0102" | "postgres_v0102" | "json_status_pass";
type Specification = Readonly<{
  command_id: string;
  executable: string;
  args: readonly string[];
  timeout_ms: number;
  extra_environment: Readonly<Record<string, string>>;
  proof_kind: ProofKind;
}>;
type FinalizeProfile = Readonly<{
  kind: "v0101" | "v0102";
  error_prefix: "V0101" | "V0102";
  branch: string;
  base_head: string;
  base_tree: string | null;
  output_root: string;
  final_root: string;
  contract_path: string;
  contract_relative: string;
  contract_sha256: string;
  final_verification_schema: string;
  journal_prefix: string;
  command_ids: readonly string[];
  integration_profile: IntegrationEvidenceProfile | null;
}>;

function spec(commandId: string, executable: string, args: readonly string[], timeoutMs: number,
  extraEnvironment: Readonly<Record<string, string>> = {}, proofKind: ProofKind = "process_exit"): Specification {
  return Object.freeze({ command_id: commandId, executable, args: Object.freeze([...args]), timeout_ms: timeoutMs,
    extra_environment: Object.freeze({ ...extraEnvironment }), proof_kind: proofKind });
}

function v0101Specifications(): readonly Specification[] {
  const focusedTests = Object.freeze([
    "src/server/system-marathon/integration-repair-contract.test.ts",
    "src/server/system-marathon/integration-repair-evidence.test.ts",
    "src/server/product/auth/identity-session.test.ts",
    "src/server/product/auth/hermetic-session.test.ts",
    "src/server/product/auth/durable-session-boundary.test.ts",
    "src/server/product/auth/runtime.test.ts",
    "src/server/product/routes/flags.test.ts",
    "src/server/product/routes/runtime.test.ts",
    "src/server/product/integration/browser-runtime.test.ts",
    "src/server/platform/persistence/postgres/governance/governance.test.ts",
    "src/server/platform/persistence/postgres/governance/migration-contract.test.ts",
    "src/server/product/durable-postgres/report-identity.test.ts",
    "scripts/canonical-persistence-v091/matrix/marathon-v010.test.mjs",
  ]);
  return Object.freeze([
    spec("focused_acceptance", NODE, [VITEST, "run", ...focusedTests, "--maxWorkers=1"], 10 * 60_000),
    spec("full_suite", NODE, [VITEST, "run", "--maxWorkers=1"], 30 * 60_000),
    spec("eslint", NODE, [ESLINT, "."], 15 * 60_000),
    spec("typescript", NODE, [TSC, "--noEmit"], 15 * 60_000),
    spec("production_build", NODE, [NEXT, "build", "--webpack"], 20 * 60_000, nextBuildEnvironment()),
    spec("postgresql_full_regression", NODE, [path.join(ROOT, "scripts", "canonical-persistence-v091", "bootstrap.mjs"), "--matrix-smoke"], 45 * 60_000),
    spec("browser_e2e_full", NODE, [...STRIP_TYPES, path.join(ROOT, "scripts", "full-local-system-marathon", "browser-e2e.mts")],
      10 * 60_000, {}, "browser_v0101"),
    spec("prohibited_operation_audit", NODE, [...STRIP_TYPES, path.join(ROOT, "scripts", "full-local-system-marathon", "security-scan.mts")], 5 * 60_000),
    spec("canonical_reachability", NODE, [...STRIP_TYPES, path.join(ROOT, "scripts", "product-integration", "reachability", "verify.mts")], 10 * 60_000),
    spec("persistence_wiring", NODE, [...STRIP_TYPES, path.join(ROOT, "scripts", "product-integration", "persistence", "wiring-map.mts")], 10 * 60_000),
  ]);
}

function runtimeProductSpecifications(active: FinalizeProfile): readonly Specification[] {
  const focusedTests = Object.freeze([
    "src/server/system-marathon/runtime-product-closure-contract.test.ts",
    "src/server/system-marathon/entrypoint-disposition-ledger.v0.10.2.test.ts",
    "src/server/system-marathon/integration-repair-evidence.test.ts",
    "src/server/system-marathon/runtime-security-migration.test.ts",
    "src/server/system-marathon/portal-runtime-security-migration.test.ts",
    "src/server/system-marathon/governance-owner-schema-usage-repair.test.ts",
    "src/server/system-marathon/runtime-canonical-helper-acl-repair.test.ts",
    "src/server/product/runtime/durable-local-config.test.ts",
    "src/server/product/runtime/durable-local-runtime.test.ts",
    "src/server/product/auth/identity-session.test.ts",
    "src/server/product/auth/durable-session-boundary.test.ts",
    "src/server/product/routes/durable-registration.test.ts",
    "src/server/product/routes/least-privilege-session-context.test.ts",
    "src/server/product/customer-portal/durable-postgres-application.test.ts",
    "src/server/product/internal-ops/durable-postgres-application.test.ts",
    "src/server/product/internal-ops/durable-governance/application.test.ts",
    "src/server/platform/persistence/postgres/governance/application.test.ts",
    "src/server/product/durable-postgres/runtime-product-lane.test.ts",
    "src/server/product/durable-postgres/fresh-worker-protocol.test.ts",
    "src/server/product/worker-runtime/durable-worker-launcher.test.ts",
    "src/server/product/worker-runtime/fresh-child-launcher.test.ts",
    "src/server/platform/storage/local-runtime/private-blob-provider.test.ts",
    "src/server/product/dependency-invalidation/global-invalidation.test.ts",
    "src/server/product/dependency-invalidation/postgres-port.test.ts",
    "src/server/engine/multi-document-intake/application.test.ts",
    "src/engine/legal-operations/rulespec-lifecycle.test.ts",
    "src/engine/legal-quality/synthetic-property-suite.test.ts",
    "src/server/platform/capabilities/stable-entrypoint-runtime.test.ts",
    "src/server/platform/capabilities/stable-http-entrypoint.test.ts",
    "scripts/canonical-persistence-v091/matrix/runtime-product-repair-v0102.test.mjs",
    "scripts/full-local-system-marathon/durable-browser-e2e-runtime.test.mjs",
  ]);
  const framework = (file: string) => path.join(ROOT, "scripts", "canonical-integration-repair-v0101", file);
  const marathon = (file: string) => path.join(ROOT, "scripts", "full-local-system-marathon", file);
  return Object.freeze([
    spec("focused_v0102_acceptance", NODE, [VITEST, "run", ...focusedTests, "--maxWorkers=1"], 20 * 60_000),
    spec("full_suite", NODE, [VITEST, "run", "--maxWorkers=1"], 45 * 60_000),
    spec("eslint", NODE, [ESLINT, "."], 20 * 60_000),
    spec("typescript", NODE, [TSC, "--noEmit"], 20 * 60_000),
    spec("production_build", NODE, [NEXT, "build", "--webpack"], 30 * 60_000, nextBuildEnvironment()),
    spec("postgresql_full_regression", NODE, [path.join(ROOT, "scripts", "canonical-persistence-v091", "bootstrap.mjs")],
      60 * 60_000, {}, "postgres_v0102"),
    spec("browser_durable_product_e2e", NODE, [...STRIP_TYPES, marathon("durable-browser-e2e.mts")],
      45 * 60_000, {}, "browser_v0102"),
    spec("security_limits_negative_matrix", NODE, [...STRIP_TYPES, marathon("runtime-product-negative-matrix.mts")],
      20 * 60_000, {}, "json_status_pass"),
    spec("reachability_wiring_capability_audit", NODE, [...STRIP_TYPES, marathon("runtime-product-audit.mts")],
      20 * 60_000, {}, "json_status_pass"),
    spec("evidence_build", NODE, [...STRIP_TYPES, framework("build.mts"), "--contract", active.contract_relative],
      15 * 60_000, {}, "json_status_pass"),
    spec("detached_verifier", NODE, [...STRIP_TYPES, framework("verify.mts"), "--contract", active.contract_relative],
      10 * 60_000, {}, "json_status_pass"),
    spec("repeat_archive_hash_verifier", NODE, [...STRIP_TYPES, framework("verify.mts"), "--contract", active.contract_relative,
      "--repeat", "--no-write"], 10 * 60_000, {}, "json_status_pass"),
  ]);
}

async function execute(specification: Specification): Promise<Readonly<Record<string, unknown>>> {
  if (attempts.includes(specification.command_id)) {
    throw new Error(`${profile.error_prefix}_FINAL_DUPLICATE_ATTEMPT:${specification.command_id}`);
  }
  verifyExactFrozenGit();
  const attemptOrdinal = attempts.push(specification.command_id);
  const environment = safeEnvironment(specification.extra_environment);
  const environmentNames = Object.keys(environment).sort(compare);
  const commandText = [specification.executable, ...specification.args].map(commandToken).join(" ");
  const commandFingerprint = JSON.stringify({ executable: specification.executable, argv: [...specification.args], cwd: ROOT });
  const startedEpochMs = Date.now();
  const startedAt = new Date(startedEpochMs).toISOString();
  await journal("COMMAND_STARTED", specification.command_id, {
    attempt_ordinal: 1, execution_ordinal: attemptOrdinal, started_at: startedAt, started_epoch_ms: startedEpochMs,
    verified_head: git.head, verified_tree: git.tree, command_text_sha256: sha256(commandText),
    command_fingerprint_sha256: sha256(commandFingerprint),
  });
  const started = performance.now();
  const result = spawnSync(specification.executable, specification.args, {
    cwd: ROOT, env: environment, encoding: "utf8", windowsHide: true, timeout: specification.timeout_ms,
    maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? (result.error ? String(result.error) : "");
  const workingStdoutName = `final-logs/${specification.command_id}.stdout.log`;
  const workingStderrName = `final-logs/${specification.command_id}.stderr.log`;
  await writeFile(path.join(WORKING, ...workingStdoutName.split("/")), stdout, { flag: "wx", encoding: "utf8" });
  await writeFile(path.join(WORKING, ...workingStderrName.split("/")), stderr, { flag: "wx", encoding: "utf8" });
  const exitCode = result.status ?? (result.error ? 124 : 1);
  const executionPassed = exitCode === 0 && result.signal === null;
  const proof = await evaluateProof(specification, executionPassed, stdout);
  const finishedEpochMs = Date.now();
  const finishedAt = new Date(finishedEpochMs).toISOString();
  verifyExactFrozenGit();
  const commandReceipt = Object.freeze({
    command_id: specification.command_id, status: proof.status,
    execution_status: executionPassed ? "PASS" as const : "FAIL" as const,
    proof_kind: specification.proof_kind, proof_contract_status: proof.proof_contract_status,
    ...(proof.failure_code ? { failure_code: proof.failure_code } : {}),
    attempt_ordinal: 1, execution_ordinal: attemptOrdinal, verified_head: git.head, verified_tree: git.tree,
    started_at: startedAt, finished_at: finishedAt, started_epoch_ms: startedEpochMs, finished_epoch_ms: finishedEpochMs,
    exit_code: exitCode, signal: result.signal, elapsed_ms: Math.round(performance.now() - started),
    executable: specification.executable, argv: Object.freeze([...specification.args]), cwd: ROOT,
    command_text: commandText, command_text_sha256: sha256(commandText),
    command_fingerprint_sha256: sha256(commandFingerprint), timeout_ms: specification.timeout_ms,
    environment_allowlist_names: Object.freeze(environmentNames),
    environment_allowlist_sha256: sha256(environmentNames.map((name) => `${name}\0${environment[name] ?? ""}\n`).join("")),
    input_hashes: inputHashes,
    toolchain: Object.freeze({ node: process.version, platform: process.platform, arch: process.arch }),
    stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr), stdout_byte_count: Buffer.byteLength(stdout),
    stderr_byte_count: Buffer.byteLength(stderr),
    stdout_log: profile.kind === "v0102" ? `outer-matrix/final-logs/${specification.command_id}.stdout.log` : workingStdoutName,
    stderr_log: profile.kind === "v0102" ? `outer-matrix/final-logs/${specification.command_id}.stderr.log` : workingStderrName,
    working_stdout_log: workingStdoutName, working_stderr_log: workingStderrName,
  });
  await journal("COMMAND_COMPLETED", specification.command_id, commandReceipt);
  completed.add(specification.command_id);
  return commandReceipt;
}

async function evaluateProof(specification: Specification, executionPassed: boolean, stdout: string): Promise<Readonly<{
  status: "PASS" | "FAIL";
  proof_contract_status: "PASS" | "FAIL";
  failure_code?: string;
}>> {
  const failure = (code: string) => Object.freeze({ status: "FAIL" as const, proof_contract_status: "FAIL" as const,
    failure_code: code });
  if (!executionPassed) return failure("COMMAND_PROCESS_FAILED");
  if (specification.proof_kind === "process_exit") return Object.freeze({ status: "PASS", proof_contract_status: "PASS" });
  const receipt = lastJsonRecord(stdout);
  if (!receipt) return failure("COMMAND_JSON_PROOF_MISSING");
  if (specification.proof_kind === "browser_v0101") {
    const passed = receipt.status === "PASS" && receipt.run_class === "FULL_RENDERED_BROWSER_DURABLE_PRODUCT_MATRIX"
      && receipt.verified_head === git.head && receipt.verified_tree === git.tree
      && receipt.durable_identity_postgres_private_storage_proven === true && receipt.signed_session_verified === true
      && receipt.real_postgresql_transaction_verified === true && receipt.private_storage_exact_bytes_verified === true;
    return passed ? Object.freeze({ status: "PASS", proof_contract_status: "PASS" })
      : failure("BROWSER_DIAGNOSTIC_EXIT_ZERO_WITHOUT_DURABLE_PRODUCT_PROOF");
  }
  if (specification.proof_kind === "postgres_v0102") {
    const postgresRoot = path.join(ROOT, "output", "canonical-postgresql-dynamic-v0.9.1", "final");
    const postgresGit = await jsonRecord(path.join(postgresRoot, "git.json"));
    const acceptance = await jsonRecord(path.join(postgresRoot, "acceptance-receipt.json"));
    const migration = await jsonRecord(path.join(postgresRoot, "migration-matrix.json"));
    const runtimeSecurity = await jsonRecord(path.join(postgresRoot, "runtime-security-matrix-v0.10.2.json"));
    const runtimeRepair = await jsonRecord(path.join(postgresRoot, "runtime-product-repair-matrix-v0.10.2.json"));
    const postRegression = childRecord(postgresGit?.post_regression);
    const passed = receipt.schema_version === "tivdoc-canonical-postgresql-dynamic-final-v0.9.1"
      && receipt.status === "PASS" && receipt.acceptance_result === "ACCEPTANCE_24_OF_24_PASS"
      && receipt.pc_22 === "PC-22_PASS" && receipt.repeat_build_match === true
      && postgresGit?.branch === git.branch && postgresGit.head === git.head && postgresGit.tree === git.tree
      && postgresGit.worktree === "CLEAN" && postgresGit.head_tree_cross_check === true
      && postRegression?.head === git.head && postRegression.tree === git.tree && postRegression.branch === git.branch
      && acceptance?.status === "PASS" && acceptance.acceptance_result === "ACCEPTANCE_24_OF_24_PASS"
      && migration?.status === "PASS" && runtimeSecurity?.status === "PASS"
      && runtimeSecurity.governance_exposed_functions === 21
      && runtimeSecurity.unsafe_or_unexplained_functions === 0
      && runtimeRepair?.status === "PASS" && runtimeRepair.operations_resolver_execution === "PASS"
      && runtimeRepair.exact_canonical_report_identity_sql === "PASS"
      && runtimeRepair.product_reachable_memory_fallbacks === 0;
    return passed ? Object.freeze({ status: "PASS", proof_contract_status: "PASS" })
      : failure("POSTGRESQL_EXIT_ZERO_WITHOUT_COMPLETE_RUNTIME_PRODUCT_PROOF");
  }
  if (specification.proof_kind === "browser_v0102") {
    const browser = childRecord(receipt.browser);
    const identity = childRecord(receipt.identity);
    const postgres = childRecord(receipt.postgres);
    const runtime = childRecord(receipt.runtime);
    const evidence = childRecord(receipt.durable_evidence);
    const cleanup = childRecord(receipt.cleanup);
    const report = childRecord(evidence?.report);
    const download = childRecord(evidence?.download);
    const timeline = childRecord(evidence?.timeline);
    const passed = receipt.schema_version === "tivdoc-full-local-system-marathon-durable-browser-e2e-v0.10.2"
      && receipt.status === "PASS" && receipt.proof_class === "REAL_RENDERED_BROWSER_TO_ISOLATED_POSTGRESQL_DURABLE_PRODUCT_PATH"
      && browser?.rendered_ui === true && browser.direct_service_shortcuts === false
      && browser.cross_owner_denied === true && browser.csrf_denied === true
      && identity?.secure_host_cookie === true && identity.credentials_emitted === 0
      && postgres?.owned_isolated_loopback === true && postgres.service_role_product_requests === 0
      && runtime?.durable_runtime_sentinel === true && runtime.customer_documents_used === 0
      && evidence?.status === "PASS" && report?.approval_state === "approved"
      && download?.exact_hash_match === true && download.owner_authenticated === true
      && timeline?.required_actions_complete === true && cleanup?.status === "PASS"
      && cleanup.postgres_runtime_connections_after_server === 0;
    return passed ? Object.freeze({ status: "PASS", proof_contract_status: "PASS" })
      : failure("BROWSER_EXIT_ZERO_WITHOUT_DURABLE_PRODUCT_PROOF");
  }
  return receipt.status === "PASS" ? Object.freeze({ status: "PASS", proof_contract_status: "PASS" })
    : failure("JSON_STATUS_PASS_PROOF_MISSING");
}

async function jsonRecord(file: string): Promise<Readonly<Record<string, unknown>> | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    return childRecord(value);
  } catch {
    return null;
  }
}

async function sealRuntimeProgress(runtimeCommands: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
  if (profile.kind !== "v0102" || runtimeCommands.length !== 9) throw new Error("V0102_RUNTIME_PROGRESS_COMMAND_SET_INVALID");
  const currentJournal = await readFile(JOURNAL);
  await writeFile(RUNTIME_JOURNAL, currentJournal, { flag: "wx", mode: 0o600 });
  const progress = Object.freeze({
    schema_version: "tivdoc-runtime-product-closure-runtime-matrix-progress-v0.10.2",
    status: runtimeCommands.every((entry) => entry.status === "PASS") ? "PASS" as const : "FAIL" as const,
    contract_schema_version: profile.integration_profile?.contract_schema_version,
    verified_branch: git.branch, verified_head: git.head, verified_tree: git.tree,
    command_count: runtimeCommands.length, execution_order: Object.freeze(profile.command_ids.slice(0, 9)),
    commands: Object.freeze([...runtimeCommands]),
    run_counts: Object.freeze({
      FULL_SUITE_RUN_COUNT: attemptCount("full_suite"), PRODUCTION_BUILD_RUN_COUNT: attemptCount("production_build"),
      BROWSER_E2E_FULL_RUN_COUNT: attemptCount("browser_durable_product_e2e"),
      POSTGRESQL_FULL_REGRESSION_RUN_COUNT: attemptCount("postgresql_full_regression"),
    }),
    exact_once: true, journal_log: "runtime-command-journal.ndjson", journal_sha256: sha256(currentJournal),
    journal_byte_count: currentJournal.byteLength,
  });
  await writeFile(RUNTIME_PROGRESS, `${JSON.stringify(progress, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function sealOuterMatrix(finalReceipt: Readonly<Record<string, unknown>>): Promise<void> {
  await mkdir(profile.final_root, { recursive: true });
  const outer = path.join(profile.final_root, "outer-matrix");
  const outerLogs = path.join(outer, "final-logs");
  await mkdir(outerLogs, { recursive: true });
  for (const commandId of profile.command_ids) {
    await copyExclusive(path.join(LOGS, `${commandId}.stdout.log`), path.join(outerLogs, `${commandId}.stdout.log`));
    await copyExclusive(path.join(LOGS, `${commandId}.stderr.log`), path.join(outerLogs, `${commandId}.stderr.log`));
  }
  await copyExclusive(JOURNAL, path.join(outer, "final-command-journal.ndjson"));
  await copyExclusive(RECEIPT, path.join(outer, "final-verification.json"));
  await copyExclusive(RUNTIME_PROGRESS, path.join(outer, "runtime-matrix-progress.json"));
  await copyExclusive(RUNTIME_JOURNAL, path.join(outer, "runtime-command-journal.ndjson"));
  if (await ordinaryExists(ASSESSMENT)) {
    await copyExclusive(ASSESSMENT, path.join(outer, "runtime-product-closure-assessment.v0.10.2.json"));
  }
  const finalReceiptBytes = await readFile(path.join(outer, "final-verification.json"));
  const finalJournalBytes = await readFile(path.join(outer, "final-command-journal.ndjson"));
  const envelope = Object.freeze({
    schema_version: "tivdoc-runtime-product-closure-outer-matrix-envelope-v0.10.2", status: finalReceipt.status,
    verified_branch: git.branch, base_head: profile.base_head, base_tree: profile.base_tree, final_head: git.head,
    final_tree: git.tree, base_is_ancestor: true, worktree_clean_after_matrix: true,
    no_tracked_commit_followed_matrix: gitText(["rev-parse", "HEAD"]) === git.head,
    self_reference_rule: "outer_matrix_receipt_journal_and_late_command_logs_are_sidecars_excluded_from_the_inner_archive",
    final_verification_sha256: sha256(finalReceiptBytes), final_verification_byte_count: finalReceiptBytes.byteLength,
    final_command_journal_sha256: sha256(finalJournalBytes), final_command_journal_byte_count: finalJournalBytes.byteLength,
    contract_sha256: profile.contract_sha256,
  });
  await writeFile(path.join(outer, "outer-envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function loadProfile(args: readonly string[]): Promise<FinalizeProfile> {
  const index = args.indexOf("--contract");
  if (index < 0) {
    const contractRelative = "src/server/system-marathon/integration-repair-contract.v0.10.1.json";
    const contractPath = path.join(ROOT, ...contractRelative.split("/"));
    return Object.freeze({
      kind: "v0101", error_prefix: "V0101", branch: "codex/tivdoc-engine-foundation",
      base_head: "3b1740d63bb6978d990d1a6127730f3cec3574cc", base_tree: null,
      output_root: path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1"),
      final_root: path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "final"),
      contract_path: contractPath, contract_relative: contractRelative, contract_sha256: sha256(await readFile(contractPath)),
      final_verification_schema: "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.1",
      journal_prefix: "V0101-FINAL",
      command_ids: Object.freeze(["focused_acceptance", "full_suite", "eslint", "typescript", "production_build",
        "postgresql_full_regression", "browser_e2e_full", "prohibited_operation_audit", "canonical_reachability", "persistence_wiring"]),
      integration_profile: null,
    });
  }
  const raw = args[index + 1];
  if (!raw) throw new Error("V0102_CONTRACT_PATH_REQUIRED");
  const contractPath = path.resolve(ROOT, raw);
  if (!contained(ROOT, contractPath)) throw new Error("V0102_CONTRACT_PATH_UNSAFE");
  const bytes = await readFile(contractPath);
  const integrationProfile = parseIntegrationEvidenceProfile(JSON.parse(bytes.toString("utf8")) as unknown);
  const finalRoot = path.resolve(ROOT, ...integrationProfile.final_output_root.split("/"));
  if (!contained(ROOT, finalRoot)) throw new Error("V0102_OUTPUT_PATH_UNSAFE");
  return Object.freeze({
    kind: "v0102", error_prefix: "V0102", branch: integrationProfile.branch, base_head: integrationProfile.base_head,
    base_tree: integrationProfile.base_tree, output_root: path.dirname(finalRoot), final_root: finalRoot,
    contract_path: contractPath, contract_relative: path.relative(ROOT, contractPath).replaceAll("\\", "/"),
    contract_sha256: sha256(bytes),
    final_verification_schema: "tivdoc-canonical-integration-durability-repair-final-verification-v0.10.2",
    journal_prefix: "V0102-FINAL", command_ids: Object.freeze([...RUNTIME_PRODUCT_CLOSURE_COMMAND_IDS]),
    integration_profile: integrationProfile,
  });
}

async function evidenceInputHashes(active: FinalizeProfile): Promise<Readonly<Record<string, string>>> {
  return Object.freeze({ package_json_sha256: sha256(await readFile(path.join(ROOT, "package.json"))),
    package_lock_sha256: sha256(await readFile(path.join(ROOT, "package-lock.json"))), contract_sha256: active.contract_sha256 });
}

async function journal(eventType: "COMMAND_STARTED" | "COMMAND_COMPLETED", commandId: string,
  details: Readonly<Record<string, unknown>>): Promise<void> {
  journalSequence += 1;
  const entry = Object.freeze({ event_id: `${profile.journal_prefix}-${String(journalSequence).padStart(4, "0")}`,
    event_type: eventType, command_id: commandId, ...details });
  await appendFile(JOURNAL, `${JSON.stringify(entry)}\n`, { flag: "a", encoding: "utf8" });
}

function attemptCount(commandId: string): number {
  return attempts.filter((id) => id === commandId).length;
}

async function initializeFreshWorkingDirectory(): Promise<void> {
  await mkdir(profile.output_root, { recursive: true });
  const outputMetadata = await lstat(profile.output_root);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) throw new Error(`${profile.error_prefix}_FINAL_OUTPUT_ROOT_INVALID`);
  try {
    await mkdir(WORKING);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${profile.error_prefix}_FINAL_WORKING_ALREADY_EXISTS`);
    throw error;
  }
  await mkdir(LOGS);
  await writeFile(JOURNAL, "", { flag: "wx", mode: 0o600 });
}

function verifyGit(): Readonly<{ branch: string; head: string; tree: string }> {
  const branch = gitText(["branch", "--show-current"]);
  const head = gitText(["rev-parse", "HEAD"]);
  const tree = gitText(["rev-parse", "HEAD^{tree}"]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", profile.base_head, head], { cwd: ROOT, windowsHide: true });
  const baseTree = gitText(["rev-parse", `${profile.base_head}^{tree}`]);
  if (branch !== profile.branch || ancestry.status !== 0 || (profile.base_tree !== null && baseTree !== profile.base_tree)
      || gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error(`${profile.error_prefix}_FINAL_GIT_STATE_INVALID`);
  }
  return Object.freeze({ branch, head, tree });
}

function verifyExactFrozenGit(): void {
  if (gitText(["branch", "--show-current"]) !== git.branch || gitText(["rev-parse", "HEAD"]) !== git.head
      || gitText(["rev-parse", "HEAD^{tree}"]) !== git.tree
      || gitText(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error(`${profile.error_prefix}_FINAL_FROZEN_GIT_CHANGED`);
  }
}

function gitText(args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error(`${profile.error_prefix}_FINAL_GIT_COMMAND_FAILED`);
  return result.stdout.trim();
}

function safeEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const key of ["ALLUSERSPROFILE", "APPDATA", "CI", "COMSPEC", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "CommonProgramW6432", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
    "OS", "Path", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "ProgramData", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramW6432", "SystemDrive", "SystemRoot", "TEMP", "TMP", "TZ", "USERPROFILE", "windir"] as const) {
    if (process.env[key] !== undefined) safe[key] = process.env[key];
  }
  return { ...safe, ...extra, CI: "1", OPENAI_API_KEY: "", TIVDOC_OPENAI_LIVE_TESTS: "0",
    TIVDOC_CUSTOMER_PROCESSING_ENABLED: "0", TIVDOC_CUSTOMER_SHADOW_AUTHORIZED: "0",
    TIVDOC_PRODUCTION_DELIVERY_ENABLED: "0", TIVDOC_RUNTIME_TARGET: "local_only" };
}

function nextBuildEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({ NEXT_FONT_GOOGLE_MOCKED_RESPONSES:
    path.join(ROOT, "scripts", "canonical-persistence-v091", "foundation", "next-font-google-mock.cjs"),
  TIVDOC_V091_FONT_MOCK_ALLOWED: "1" });
}

function lastJsonRecord(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Diagnostic output is not proof.
    }
  }
  return null;
}

function childRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function commandToken(value: string): string {
  return /^[A-Za-z0-9_./:\\=-]+$/u.test(value) ? value : JSON.stringify(value);
}

async function copyExclusive(source: string, destination: string): Promise<void> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("V0102_OUTER_SOURCE_UNSAFE");
  await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function ordinaryExists(file: string): Promise<boolean> {
  try {
    const metadata = await lstat(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
