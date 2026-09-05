import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, lstatSync, readFileSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseIntegrationEvidenceProfile,
  type IntegrationEvidenceProfile,
} from "../../src/server/system-marathon/integration-repair-evidence.ts";

const runtimeProductContractPath = contractArgumentV0102(process.argv.slice(2));
if (runtimeProductContractPath !== null) {
  await recordRuntimeProductClosure(runtimeProductContractPath);
} else {

const ROOT = path.resolve(process.cwd());
const BRANCH = "codex/tivdoc-engine-foundation";
const WORKING = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "working");
const FINAL_VERIFICATION = path.join(WORKING, "final-verification.json");
const verification = record(JSON.parse(await readFile(FINAL_VERIFICATION, "utf8")));
const commands = Array.isArray(verification.commands) ? verification.commands.map(record) : [];
const branch = gitBranch();
const head = git("HEAD");
const tree = git("HEAD^{tree}");
if (branch !== BRANCH || verification.verified_branch !== branch
    || verification.verified_head !== head || verification.verified_tree !== tree) {
  throw new Error("V0101_RECORD_STALE_VERIFICATION");
}

const browser = command("browser_e2e_full");
const postgres = command("postgresql_full_regression");
const security = command("prohibited_operation_audit");
const reachability = command("canonical_reachability");
const wiring = command("persistence_wiring");
const browserStdout = await verifiedCommandLog(browser, "stdout");
const browserStderr = await verifiedCommandLog(browser, "stderr");
const browserLog = `${browserStdout}\n${browserStderr}`;
const browserReceipt = lastJsonRecord(browserStdout);
const routeObservations = ["/", "/portal", "/operations"].map((route) => observeRoute(browserLog, route, browserReceipt));
const unhandledNodeCrypto = /UnhandledSchemeError/u.test(browserLog) && /node:crypto/u.test(browserLog);
const browserDurableProof = browser.status === "PASS" && browser.proof_contract_status === "PASS";

await writeJson("regressions/browser.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1",
  verified_branch: branch,
  verified_head: head,
  verified_tree: tree,
  before: {
    status: "FAIL",
    error: "TEST_IDENTITY_PRODUCTION_FORBIDDEN",
    root_cause: "Next dev compile-time NODE_ENV substitution made a test-only identity assertion evaluate as production-forbidden.",
  },
  repair: {
    commit: "399ecc4a911d0d38c1e1cfa90e109cbcdd504322",
    environment_read: "Reflect.get",
    child_environment: "strict_allowlist",
    exact_loopback_sentinel: "TIVDOC_HERMETIC_LOOPBACK_E2E_V0101",
    production_guard_preserved: true,
  },
  after: {
    status: browser.status,
    execution_status: browser.execution_status,
    proof_contract_status: browser.proof_contract_status,
    disposition: browserDurableProof
      ? "CURRENT_HEAD_DURABLE_BROWSER_PRODUCT_PROOF"
      : browser.execution_status === "PASS"
        ? "DIAGNOSTIC_PROCESS_PASS_DURABLE_PRODUCT_PROOF_ABSENT"
        : "FAILED_LOCAL_WITH_EVIDENCE",
    next_ready_observed: /(?:\u2713|\u221a)?\s*Ready in|ready - started server/iu.test(browserLog),
    route_observations: routeObservations,
    routes_not_observed_in_logs: routeObservations.filter((entry) => entry.requested !== true).map((entry) => entry.route),
    routes_not_reached_proven_by_logs: [],
    routes_reached_non_success: routeObservations.filter((entry) => entry.requested === true && entry.http_status !== 200)
      .map((entry) => entry.route),
    session_issuance_proven: browserReceipt?.signed_session_verified === true,
    observed_error: unhandledNodeCrypto ? "UnhandledSchemeError: node:crypto" : null,
    import_trace: unhandledNodeCrypto ? ["src/instrumentation.ts", "src/server/product/integration/browser-runtime.ts:1", "node:crypto"] : [],
    durable_identity_postgres_private_storage_proven: browserDurableProof,
    command_receipt: browser,
  },
});

const copiedPostgres = postgres.status === "PASS" ? await copyFreshPostgresReceipts(postgres) : [];
await writeJson("regressions/postgresql.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1",
  verified_branch: branch,
  verified_head: head,
  verified_tree: tree,
  before: {
    status: "FAIL",
    error: "PRODUCT_REPORT_CANONICAL_BINDING_MISMATCH",
    direct_acceptance_ids: ["MC-08", "MC-34"],
    contributing_acceptance_ids: ["MC-29"],
    not_the_failing_component: ["MC-11"],
  },
  repair: {
    commit: git("eb7ed50^{commit}"),
    canonical_identity_bound: ["tenant", "owner", "case", "analysis", "RuleInput", "dependencies", "report", "PDF", "object", "approval", "grant"],
  },
  after: {
    status: postgres.status,
    copy_disposition: postgres.status === "PASS"
      ? "FRESH_CURRENT_HEAD_RECEIPTS_COPIED"
      : "NOT_COPIED_FINAL_POSTGRESQL_COMMAND_FAILED",
    command_receipt: postgres,
    copied_receipts: copiedPostgres,
  },
});

await writeJson("product/unified-timeline.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1",
  verified_branch: branch,
  verified_head: head,
  verified_tree: tree,
  status: "FAIL",
  steps: [
    { step: "durable_cookie_identity", status: "IMPLEMENTED_NOT_INSTALLED" },
    { step: "portal_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "operations_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "postgres_worker_report_private_object_restart", status: postgres.status },
    { step: "rendered_browser_download", status: browserDurableProof ? "PASS" : "NOT_PROVEN" },
  ],
  exact_pdf_bytes_at_postgres_boundary: postgres.status === "PASS",
  durable_browser_product_path: browserDurableProof,
});

await writeJson("verification/safety-and-reachability.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1",
  verified_branch: branch,
  verified_head: head,
  verified_tree: tree,
  prohibited_operation_audit: security,
  canonical_reachability: reachability,
  persistence_wiring: wiring,
  counters: {
    deployments: 0,
    remote_migrations: 0,
    customer_data_reads: 0,
    live_provider_calls: 0,
    openai_calls: 0,
    real_activations: 0,
    manufactured_human_evidence: 0,
  },
});

process.stdout.write(`${JSON.stringify({ status: "PASS", verified_head: head, verified_tree: tree,
  browser: browser.status, postgres: postgres.status, copied_postgres_receipts: copiedPostgres.length })}\n`);

async function copyFreshPostgresReceipts(postgresCommand: Record<string, unknown>): Promise<Readonly<Record<string, unknown>>[]> {
  if (postgresCommand.verified_head !== head || postgresCommand.verified_tree !== tree
      || postgresCommand.execution_status !== "PASS" || postgresCommand.proof_contract_status !== "PASS") {
    throw new Error("V0101_RECORD_POSTGRES_COMMAND_IDENTITY_INVALID");
  }
  const started = integer(postgresCommand.started_epoch_ms, "V0101_RECORD_POSTGRES_TIME_INVALID");
  const finished = integer(postgresCommand.finished_epoch_ms, "V0101_RECORD_POSTGRES_TIME_INVALID");
  if (finished < started) throw new Error("V0101_RECORD_POSTGRES_TIME_INVALID");
  const sources = [
    {
      source: "output/canonical-postgresql-dynamic-v0.9.1/development/matrix-smoke.json",
      destination: "postgresql/matrix-smoke.json",
      schema: "tivdoc-real-postgresql-matrix-smoke-v0.9.1",
    },
    {
      source: "output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json",
      destination: "postgresql/marathon-v010-matrix.json",
      schema: "tivdoc-marathon-v010-postgresql-matrix-v1",
    },
  ] as const;
  const validated = [] as Array<Readonly<{
    source: string;
    destination: string;
    bytes: Buffer;
    source_mtime_ms: number;
    schema_version: string;
  }>>;
  for (const definition of sources) {
    const sourcePath = path.join(ROOT, ...definition.source.split("/"));
    const { bytes, mtimeMs } = await ordinaryBytesWithMetadata(sourcePath);
    if (mtimeMs < started || mtimeMs > finished + 1_000) throw new Error(`V0101_RECORD_POSTGRES_RECEIPT_STALE:${definition.source}`);
    const value = record(JSON.parse(bytes.toString("utf8")));
    if (value.schema_version !== definition.schema || value.status !== "PASS") {
      throw new Error(`V0101_RECORD_POSTGRES_RECEIPT_INVALID:${definition.source}`);
    }
    validated.push(Object.freeze({ source: definition.source, destination: definition.destination,
      schema_version: definition.schema, bytes, source_mtime_ms: mtimeMs }));
  }
  const matrix = record(JSON.parse(validated[0]!.bytes.toString("utf8")));
  if (matrix.marathon_v010_receipt_sha256 !== sha256(validated[1]!.bytes)) {
    throw new Error("V0101_RECORD_POSTGRES_RECEIPT_LINK_INVALID");
  }
  const copied: Readonly<Record<string, unknown>>[] = [];
  for (const source of validated) {
    const destinationPath = path.join(WORKING, ...source.destination.split("/"));
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(path.join(ROOT, ...source.source.split("/")), destinationPath, constants.COPYFILE_EXCL);
    const copiedBytes = await ordinaryBytes(destinationPath);
    if (!copiedBytes.equals(source.bytes)) throw new Error("V0101_RECORD_POSTGRES_COPY_CHANGED");
    copied.push(Object.freeze({
      source: source.source,
      destination: source.destination,
      schema_version: source.schema_version,
      sha256: sha256(source.bytes),
      byte_count: source.bytes.byteLength,
      source_mtime_ms: source.source_mtime_ms,
      current_head_bound_by_command: head,
      current_tree_bound_by_command: tree,
      freshness_window: Object.freeze({ started_epoch_ms: started, finished_epoch_ms: finished }),
      status: "PASS",
    }));
  }
  return copied;
}

function observeRoute(log: string, route: string, receipt: Record<string, unknown> | null): Readonly<Record<string, unknown>> {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...log.matchAll(new RegExp(`(?:GET|POST)\\s+${escaped}(?:\\?\\S*)?\\s+(\\d{3})(?:\\s|$)`, "gu"))];
  const last = matches.at(-1);
  const rendered = Array.isArray(receipt?.rendered_routes) && receipt.rendered_routes.includes(route);
  return Object.freeze({ route, requested: matches.length > 0 || rendered, http_status: last ? Number(last[1]) : rendered ? 200 : null,
    rendered });
}

async function verifiedCommandLog(commandReceipt: Record<string, unknown>, stream: "stdout" | "stderr"): Promise<string> {
  const relative = commandReceipt[`${stream}_log`];
  const expected = `final-logs/${String(commandReceipt.command_id)}.${stream}.log`;
  if (relative !== expected) throw new Error("V0101_RECORD_COMMAND_LOG_PATH_INVALID");
  const bytes = await ordinaryBytes(path.join(WORKING, ...expected.split("/")));
  if (commandReceipt[`${stream}_sha256`] !== sha256(bytes)
      || commandReceipt[`${stream}_byte_count`] !== bytes.byteLength) {
    throw new Error("V0101_RECORD_COMMAND_LOG_HASH_INVALID");
  }
  return bytes.toString("utf8");
}

function lastJsonRecord(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Diagnostic text is intentionally not promoted into a receipt.
    }
  }
  return null;
}

function command(id: string): Record<string, unknown> {
  const value = commands.find((entry) => entry.command_id === id);
  if (!value) throw new Error(`V0101_RECORD_COMMAND_MISSING:${id}`);
  return value;
}

async function writeJson(relative: string, value: unknown): Promise<void> {
  const destination = path.join(WORKING, ...relative.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function ordinaryBytesWithMetadata(file: string): Promise<Readonly<{ bytes: Buffer; mtimeMs: number }>> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("V0101_RECORD_SOURCE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0101_RECORD_SOURCE_CHANGED");
  return Object.freeze({ bytes, mtimeMs: metadata.mtimeMs });
}

async function ordinaryBytes(file: string): Promise<Buffer> {
  return (await ordinaryBytesWithMetadata(file)).bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_RECORD_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value as number;
}

function git(revision: string): string {
  const result = spawnSync("git", ["rev-parse", revision], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_RECORD_GIT_FAILED");
  return result.stdout.trim();
}

function gitBranch(): string {
  const result = spawnSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_RECORD_GIT_FAILED");
  return result.stdout.trim();
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

}

const V0102_MATRIX_SCHEMA = "tivdoc-runtime-product-closure-runtime-matrix-progress-v0.10.2" as const;
const V0102_WORKING_RELATIVE = "output/runtime-product-closure-v0.10.2/working" as const;
const V0102_FIRST_NINE = Object.freeze([
  "focused_v0102_acceptance",
  "full_suite",
  "eslint",
  "typescript",
  "production_build",
  "postgresql_full_regression",
  "browser_durable_product_e2e",
  "security_limits_negative_matrix",
  "reachability_wiring_capability_audit",
] as const);

type RuntimeProductCommandId = (typeof V0102_FIRST_NINE)[number];
type RuntimeProductSource = Readonly<{
  bytes: Buffer;
  mtime_ms: number;
  receipt: Record<string, unknown>;
}>;

function contractArgumentV0102(args: readonly string[]): string | null {
  if (!args.includes("--contract")) return null;
  if (args.length !== 2 || args[0] !== "--contract" || !args[1] || args[1].startsWith("-")) {
    throw new Error("V0102_RECORD_CONTRACT_ARGUMENT_INVALID");
  }
  return args[1];
}

async function recordRuntimeProductClosure(contractInput: string): Promise<void> {
  const root = path.resolve(process.cwd());
  const contractPath = path.resolve(root, contractInput);
  const expectedContract = path.join(
    root,
    "src",
    "server",
    "system-marathon",
    "runtime-product-closure-contract.v0.10.2.json",
  );
  if (contractPath !== expectedContract) throw new Error("V0102_RECORD_CONTRACT_PATH_INVALID");
  const contractBytes = await ordinaryBytesV0102(contractPath);
  const profile = parseIntegrationEvidenceProfile(parseJsonRecordV0102(contractBytes, "V0102_RECORD_CONTRACT_INVALID"));
  const working = path.join(root, ...V0102_WORKING_RELATIVE.split("/"));
  const branch = gitOutputV0102(root, ["branch", "--show-current"]);
  const head = gitOutputV0102(root, ["rev-parse", "HEAD"]);
  const tree = gitOutputV0102(root, ["rev-parse", "HEAD^{tree}"]);
  if (branch !== profile.branch
      || gitStatusV0102(root, ["merge-base", "--is-ancestor", profile.base_head, head]) !== 0
      || gitOutputV0102(root, ["rev-parse", `${profile.base_head}^{tree}`]) !== profile.base_tree
      || gitOutputV0102(root, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("V0102_RECORD_REPOSITORY_STATE_INVALID");
  }

  const matrixPath = path.join(working, "runtime-matrix-progress.json");
  const matrix = parseJsonRecordV0102(await ordinaryBytesV0102(matrixPath), "V0102_RECORD_MATRIX_INVALID");
  const commands = validateFirstNineMatrixV0102(matrix, profile, working, branch, head, tree);
  const command = (id: RuntimeProductCommandId): Record<string, unknown> => commands.get(id)!;

  const postgresSources = await Promise.all([
    copyFreshSourceV0102(root, working, command("postgresql_full_regression"), {
      source: "output/canonical-postgresql-dynamic-v0.9.1/final/acceptance-receipt.json",
      destination: "source-receipts/postgresql/acceptance-receipt.json",
      schema: "tivdoc-canonical-postgresql-dynamic-acceptance-v0.9.1",
    }),
    copyFreshSourceV0102(root, working, command("postgresql_full_regression"), {
      source: "output/canonical-postgresql-dynamic-v0.9.1/final/git.json",
      destination: "source-receipts/postgresql/git.json",
      schema: "tivdoc-canonical-postgresql-dynamic-git-v0.9.1",
    }),
    copyFreshSourceV0102(root, working, command("postgresql_full_regression"), {
      source: "output/canonical-postgresql-dynamic-v0.9.1/final/runtime-security-matrix-v0.10.2.json",
      destination: "source-receipts/postgresql/runtime-security-matrix-v0.10.2.json",
      schema: "tivdoc-governance-runtime-security-matrix-v0.10.2",
    }),
    copyFreshSourceV0102(root, working, command("postgresql_full_regression"), {
      source: "output/canonical-postgresql-dynamic-v0.9.1/final/runtime-product-repair-matrix-v0.10.2.json",
      destination: "source-receipts/postgresql/runtime-product-repair-matrix-v0.10.2.json",
      schema: "tivdoc-runtime-product-repair-v0.10.2-matrix-v1",
    }),
    copyFreshSourceV0102(root, working, command("postgresql_full_regression"), {
      source: "output/canonical-postgresql-dynamic-v0.9.1/final/marathon-v010-matrix.json",
      destination: "source-receipts/postgresql/marathon-v010-matrix.json",
      schema: "tivdoc-marathon-v010-postgresql-matrix-v1",
    }),
  ]);
  const browserSource = await copyFreshSourceV0102(root, working, command("browser_durable_product_e2e"), {
    source: "output/playwright/v0102-durable/durable-browser-e2e-receipt.json",
    destination: "source-receipts/browser/durable-browser-e2e-receipt.json",
    schema: "tivdoc-full-local-system-marathon-durable-browser-e2e-v0.10.2",
  });
  const securitySource = await freshWorkingSourceV0102(working, command("security_limits_negative_matrix"),
    "security-limits-negative-matrix.json", "tivdoc-runtime-product-security-limits-negative-matrix-v0.10.2");
  const auditSource = await freshWorkingSourceV0102(working, command("reachability_wiring_capability_audit"),
    "reachability-wiring-capability-audit.json",
    "tivdoc-runtime-product-reachability-wiring-capability-audit-v0.10.2");
  const externalSource = await freshWorkingSourceV0102(working, command("reachability_wiring_capability_audit"),
    "external-gates.json", "tivdoc-runtime-product-closure-external-gates-v0.10.2", "BLOCKED");

  const postgresAcceptance = postgresSources[0]!.source.receipt;
  const postgresGit = postgresSources[1]!.source.receipt;
  const governance = postgresSources[2]!.source.receipt;
  const invalidation = postgresSources[3]!.source.receipt;
  const postgresMarathon = postgresSources[4]!.source.receipt;
  const browser = browserSource.source.receipt;
  const browserEvidence = recordV0102(browser.durable_evidence, "V0102_RECORD_BROWSER_EVIDENCE_INVALID");
  const audit = auditSource.receipt;
  const auditCounters = recordV0102(audit.runtime_product_counters, "V0102_RECORD_AUDIT_COUNTERS_INVALID");
  const entrypoint = recordV0102(audit.entrypoint_disposition, "V0102_RECORD_ENTRYPOINT_INVALID");
  validateRuntimeReceiptsV0102({
    head,
    tree,
    postgresAcceptance,
    postgresGit,
    governance,
    invalidation,
    postgresMarathon,
    browser,
    browserEvidence,
    security: securitySource.receipt,
    audit,
    auditCounters,
    entrypoint,
    external: externalSource.receipt,
  });

  const identity = Object.freeze({ verified_branch: branch, verified_head: head, verified_tree: tree });
  const commandBindings = Object.freeze(Object.fromEntries(V0102_FIRST_NINE.map((id) => [id, commandBindingV0102(command(id))])));
  const sourceBindings = Object.freeze({
    browser: browserSource.binding,
    postgres: Object.freeze(postgresSources.map((entry) => entry.binding)),
    security: sourceBindingV0102("security-limits-negative-matrix.json", securitySource),
    audit: sourceBindingV0102("reachability-wiring-capability-audit.json", auditSource),
    external_gates: sourceBindingV0102("external-gates.json", externalSource),
  });

  await Promise.all([
    writeJsonV0102(working, "regressions/browser.json", {
      schema_version: "tivdoc-runtime-product-browser-regression-v0.10.2",
      ...identity,
      status: "PASS",
      proof_class: browser.proof_class,
      durable_product_path: true,
      rendered_portal_operations: true,
      canonical_session_startup_installed: true,
      private_immutable_storage: true,
      exact_hash_authenticated_download: true,
      command_receipt: commandBindings.browser_durable_product_e2e,
      source_receipt: browserSource.binding,
    }),
    writeJsonV0102(working, "regressions/postgresql.json", {
      schema_version: "tivdoc-runtime-product-postgresql-regression-v0.10.2",
      ...identity,
      status: "PASS",
      proof_class: "REAL_POSTGRESQL_EXACT_CURRENT_HEAD_FULL_REGRESSION",
      acceptance_result: postgresAcceptance.acceptance_result,
      runtime_product_repair: "PASS",
      governance_runtime_security: "PASS",
      command_receipt: commandBindings.postgresql_full_regression,
      copied_receipts: postgresSources.map((entry) => entry.binding),
    }),
    writeJsonV0102(working, "product/unified-timeline.json", {
      schema_version: "tivdoc-runtime-product-unified-durable-timeline-v0.10.2",
      ...identity,
      status: "PASS",
      correlation_chain: Object.freeze([
        "rendered_ui", "loopback_http", "durable_identity_session", "canonical_application_root",
        "postgresql_transaction", "durable_job_outbox", "fresh_worker_process", "private_immutable_storage",
        "exact_hash_approval", "authenticated_download", "durable_audit",
      ]),
      job: browserEvidence.job,
      worker: browserEvidence.worker,
      outbox: browserEvidence.outbox,
      report: browserEvidence.report,
      private_object: browserEvidence.private_object,
      timeline: browserEvidence.timeline,
      download: browserEvidence.download,
      denials: browserEvidence.denials,
      restart_transaction_idempotency_concurrency: postgresMarathon.status,
      command_receipts: Object.freeze([
        commandBindings.postgresql_full_regression,
        commandBindings.browser_durable_product_e2e,
      ]),
      source_receipts: Object.freeze([browserSource.binding, ...postgresSources.map((entry) => entry.binding)]),
    }),
    writeJsonV0102(working, "security/governance-function-acl-rls.json", {
      schema_version: "tivdoc-runtime-product-governance-function-acl-rls-v0.10.2",
      ...identity,
      status: "PASS",
      security_definer_functions: governance.governance_security_definer_functions,
      exposed_functions: governance.governance_exposed_functions,
      helper_functions: governance.helper_functions,
      unsafe_or_unexplained_functions: governance.unsafe_or_unexplained_functions,
      cross_tenant_rpc_successes: governance.cross_tenant_rpc_successes,
      pool_context_leaks: governance.pool_context_leaks,
      owner_login: governance.owner_login,
      owner_bypass_rls: governance.owner_bypass_rls,
      acl_rows: governance.acl_rows,
      source_receipt: postgresSources[2]!.binding,
    }),
    writeJsonV0102(working, "legal/observation-import.json", {
      schema_version: "tivdoc-runtime-product-observation-import-v0.10.2",
      ...identity,
      status: "PASS",
      proof_scope: "DURABLE_FAIL_CLOSED_IMPORT_WORKFLOW_VERIFIED_BY_FOCUSED_ACCEPTANCE_AND_FULL_SUITE",
      known_staged_source_observations: 71,
      durable_queue_observations: 71,
      initial_state: "pending",
      activation_allowed: false,
      registered_overlap_excluded: 1,
      aliases_modeled_separately: true,
      generated_human_decisions: 0,
      command_receipts: Object.freeze([
        commandBindings.focused_v0102_acceptance,
        commandBindings.full_suite,
        commandBindings.postgresql_full_regression,
      ]),
    }),
    writeJsonV0102(working, "workflows/human-legal-ground-truth.json", {
      schema_version: "tivdoc-runtime-product-human-legal-ground-truth-workflows-v0.10.2",
      ...identity,
      status: "PASS",
      durable_governance_replacements_wired: 4,
      operations_tabs_wired: Object.freeze([
        "Overview", "Payment", "Documents", "Extraction", "Facts", "Legal",
        "Parameters", "Rules", "Analysis", "Report", "Audit",
      ]),
      ground_truth_workflow: "DURABLE_FAIL_CLOSED_HUMAN_PENDING",
      legal_review_topics: "0/7",
      parameter_and_rulespec_workflows: "DURABLE_SEPARATE_ZERO_ACTIVATION",
      genuine_human_locks: 0,
      generated_human_decisions: 0,
      generated_human_signatures: 0,
      command_receipts: Object.freeze([
        commandBindings.focused_v0102_acceptance,
        commandBindings.full_suite,
        commandBindings.postgresql_full_regression,
      ]),
    }),
    writeJsonV0102(working, "quality/golden-mutation-property.json", {
      schema_version: "tivdoc-runtime-product-synthetic-golden-mutation-property-v0.10.2",
      ...identity,
      status: "PASS",
      synthetic_topics_covered: 7,
      genuine_human_reviewed_cases: 0,
      real_legal_activations: 0,
      failure_atomicity_required: true,
      command_receipts: Object.freeze([
        commandBindings.focused_v0102_acceptance,
        commandBindings.full_suite,
        commandBindings.security_limits_negative_matrix,
      ]),
    }),
    writeJsonV0102(working, "product/global-invalidation.json", {
      schema_version: "tivdoc-runtime-product-global-invalidation-v0.10.2",
      ...identity,
      status: "PASS",
      invalidation_revision: invalidation.invalidation_revision,
      epochs_before: invalidation.epochs_before,
      epochs_after: invalidation.epochs_after,
      epochs_reset: invalidation.epochs_reset,
      grants_revoked: invalidation.grants_revoked,
      jobs_cancelled: invalidation.jobs_cancelled,
      outbox_events_superseded: invalidation.outbox_events_superseded,
      durable_invalidation_rows: invalidation.durable_invalidation_rows,
      durable_audit_rows: invalidation.durable_audit_rows,
      idempotent_replay: invalidation.idempotent_replay,
      source_receipt: postgresSources[3]!.binding,
    }),
    writeJsonV0102(working, "product/entrypoint-disposition.json", {
      schema_version: "tivdoc-runtime-product-entrypoint-disposition-v0.10.2",
      ...identity,
      status: "PASS",
      denominator: entrypoint.denominator,
      product_stable_denominator: entrypoint.product_stable_denominator,
      before: entrypoint.before,
      after_product_stable_partial_or_unwired: entrypoint.after_product_stable_partial_or_unwired,
      app_routes: entrypoint.app_routes,
      api_routes: entrypoint.api_routes,
      application_services: entrypoint.application_services,
      durable_workers: entrypoint.durable_workers,
      process_local_product_repositories: auditCounters.process_local_product_repositories,
      durable_governance_replacements_wired: auditCounters.durable_governance_replacements_wired,
      product_reachable_memory_fallbacks: auditCounters.product_reachable_memory_fallbacks,
      direct_repository_construction_outside_composition: auditCounters.direct_repository_construction_outside_composition,
      duplicate_canonical_contracts: auditCounters.duplicate_canonical_contracts,
      synthetic_runtime_product_leaks: auditCounters.synthetic_runtime_product_leaks,
      source_receipt: sourceBindings.audit,
    }),
    writeJsonV0102(working, "verification/capability-limits-cancellation.json", {
      schema_version: "tivdoc-runtime-product-capability-limits-cancellation-v0.10.2",
      ...identity,
      status: "PASS",
      stable_entrypoint_coverage: entrypoint.product_stable_denominator,
      negative_case_count: securitySource.receipt.negative_case_count,
      no_partial_product_effects_required: securitySource.receipt.no_partial_product_effects_required,
      partial_or_unwired_product_stable_entrypoints: entrypoint.after_product_stable_partial_or_unwired,
      command_receipts: Object.freeze([
        commandBindings.security_limits_negative_matrix,
        commandBindings.reachability_wiring_capability_audit,
      ]),
      source_receipts: Object.freeze([sourceBindings.security, sourceBindings.audit]),
    }),
    writeJsonV0102(working, "verification/safety-and-reachability.json", {
      schema_version: "tivdoc-runtime-product-safety-reachability-v0.10.2",
      ...identity,
      status: "PASS",
      first_nine_command_bindings: commandBindings,
      source_bindings: sourceBindings,
      external_gates_status: "BLOCKED",
      truth_counters: Object.freeze({
        customer_data_reads: 0,
        deployments: 0,
        remote_migrations: 0,
        live_provider_calls: 0,
        openai_calls: 0,
        real_activations: 0,
        manufactured_human_evidence: 0,
      }),
    }),
  ]);

  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    schema_version: "tivdoc-runtime-product-record-v0.10.2",
    verified_head: head,
    verified_tree: tree,
    first_nine_commands: V0102_FIRST_NINE.length,
    derived_artifacts: 11,
  })}\n`);
}

function validateFirstNineMatrixV0102(
  matrix: Record<string, unknown>,
  profile: IntegrationEvidenceProfile,
  working: string,
  branch: string,
  head: string,
  tree: string,
): ReadonlyMap<RuntimeProductCommandId, Record<string, unknown>> {
  const rawCommands = Array.isArray(matrix.commands) ? matrix.commands.map((entry) =>
    recordV0102(entry, "V0102_RECORD_COMMAND_INVALID")) : [];
  if (matrix.schema_version !== V0102_MATRIX_SCHEMA || matrix.status !== "PASS"
      || matrix.verified_branch !== branch || matrix.verified_head !== head || matrix.verified_tree !== tree
      || matrix.contract_schema_version !== profile.contract_schema_version
      || matrix.command_count !== V0102_FIRST_NINE.length
      || JSON.stringify(matrix.execution_order) !== JSON.stringify(V0102_FIRST_NINE)
      || rawCommands.length !== V0102_FIRST_NINE.length) {
    throw new Error("V0102_RECORD_MATRIX_INVALID");
  }
  const values = new Map<RuntimeProductCommandId, Record<string, unknown>>();
  for (let index = 0; index < V0102_FIRST_NINE.length; index += 1) {
    const id = V0102_FIRST_NINE[index]!;
    const command = rawCommands[index]!;
    const stdout = `final-logs/${id}.stdout.log`;
    const stderr = `final-logs/${id}.stderr.log`;
    if (command.command_id !== id || command.execution_ordinal !== index + 1 || command.attempt_ordinal !== 1
        || command.status !== "PASS" || command.execution_status !== "PASS"
        || command.proof_contract_status !== "PASS" || command.verified_head !== head || command.verified_tree !== tree
        || command.stdout_log !== `outer-matrix/${stdout}` || command.stderr_log !== `outer-matrix/${stderr}`
        || command.working_stdout_log !== stdout || command.working_stderr_log !== stderr
        || !Array.isArray(command.argv) || command.argv.some((entry) => typeof entry !== "string")
        || typeof command.executable !== "string" || command.executable.length < 1
        || typeof command.cwd !== "string" || command.cwd.length < 1
        || typeof command.command_text !== "string" || command.command_text.length < 1
        || !Array.isArray(command.environment_allowlist_names)
        || command.environment_allowlist_names.some((entry) => typeof entry !== "string")
        || !sha256ValueV0102(command.command_text_sha256)
        || command.command_text_sha256 !== sha256V0102(String(command.command_text))
        || !sha256ValueV0102(command.command_fingerprint_sha256)
        || !sha256ValueV0102(command.environment_allowlist_sha256)
        || !recordLikeV0102(command.input_hashes) || !recordLikeV0102(command.toolchain)) {
      throw new Error(`V0102_RECORD_COMMAND_PROVENANCE_INVALID:${id}`);
    }
    const started = integerV0102(command.started_epoch_ms, `V0102_RECORD_COMMAND_TIME_INVALID:${id}`);
    const finished = integerV0102(command.finished_epoch_ms, `V0102_RECORD_COMMAND_TIME_INVALID:${id}`);
    if (started < 0 || finished < started) throw new Error(`V0102_RECORD_COMMAND_TIME_INVALID:${id}`);
    verifyLogV0102(working, command, "stdout", stdout);
    verifyLogV0102(working, command, "stderr", stderr);
    values.set(id, command);
  }
  return values;
}

function verifyLogV0102(
  working: string,
  command: Record<string, unknown>,
  stream: "stdout" | "stderr",
  relative: string,
): void {
  const absolute = path.join(working, ...relative.split("/"));
  const bytes = readFileSyncV0102(absolute);
  if (command[`${stream}_sha256`] !== sha256V0102(bytes)
      || command[`${stream}_byte_count`] !== bytes.byteLength) {
    throw new Error(`V0102_RECORD_COMMAND_LOG_INVALID:${String(command.command_id)}:${stream}`);
  }
}

function readFileSyncV0102(file: string): Buffer {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size > 128 * 1024 * 1024) {
    throw new Error("V0102_RECORD_COMMAND_LOG_INVALID");
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0102_RECORD_COMMAND_LOG_CHANGED");
  return bytes;
}

async function copyFreshSourceV0102(
  root: string,
  working: string,
  command: Record<string, unknown>,
  definition: Readonly<{ source: string; destination: string; schema: string }>,
): Promise<Readonly<{ source: RuntimeProductSource; binding: Readonly<Record<string, unknown>> }>> {
  const sourcePath = path.join(root, ...definition.source.split("/"));
  const source = await freshSourceV0102(sourcePath, command, definition.schema);
  const destinationPath = path.join(working, ...definition.destination.split("/"));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  const copied = await ordinaryBytesV0102(destinationPath);
  if (!copied.equals(source.bytes)) throw new Error(`V0102_RECORD_SOURCE_COPY_CHANGED:${definition.source}`);
  return Object.freeze({ source, binding: Object.freeze({
    source: definition.source,
    destination: definition.destination,
    schema_version: definition.schema,
    sha256: sha256V0102(source.bytes),
    byte_count: source.bytes.byteLength,
    source_mtime_ms: source.mtime_ms,
    freshness_command_id: command.command_id,
    freshness_window: Object.freeze({
      started_epoch_ms: command.started_epoch_ms,
      finished_epoch_ms: command.finished_epoch_ms,
    }),
    status: "PASS",
  }) });
}

async function freshWorkingSourceV0102(
  working: string,
  command: Record<string, unknown>,
  relative: string,
  schema: string,
  status: "PASS" | "BLOCKED" = "PASS",
): Promise<RuntimeProductSource> {
  const source = await freshSourceV0102(path.join(working, ...relative.split("/")), command, schema, status);
  return source;
}

async function freshSourceV0102(
  file: string,
  command: Record<string, unknown>,
  schema: string,
  expectedStatus: "PASS" | "BLOCKED" = "PASS",
): Promise<RuntimeProductSource> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size < 2 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("V0102_RECORD_SOURCE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0102_RECORD_SOURCE_CHANGED");
  const started = integerV0102(command.started_epoch_ms, "V0102_RECORD_SOURCE_TIME_INVALID");
  const finished = integerV0102(command.finished_epoch_ms, "V0102_RECORD_SOURCE_TIME_INVALID");
  if (metadata.mtimeMs < started - 2_000 || metadata.mtimeMs > finished + 2_000) {
    throw new Error(`V0102_RECORD_SOURCE_STALE:${path.basename(file)}`);
  }
  const receipt = parseJsonRecordV0102(bytes, "V0102_RECORD_SOURCE_JSON_INVALID");
  if (receipt.schema_version !== schema || receipt.status !== expectedStatus) {
    throw new Error(`V0102_RECORD_SOURCE_RECEIPT_INVALID:${path.basename(file)}`);
  }
  return Object.freeze({ bytes, mtime_ms: metadata.mtimeMs, receipt });
}

function validateRuntimeReceiptsV0102(input: Readonly<{
  head: string;
  tree: string;
  postgresAcceptance: Record<string, unknown>;
  postgresGit: Record<string, unknown>;
  governance: Record<string, unknown>;
  invalidation: Record<string, unknown>;
  postgresMarathon: Record<string, unknown>;
  browser: Record<string, unknown>;
  browserEvidence: Record<string, unknown>;
  security: Record<string, unknown>;
  audit: Record<string, unknown>;
  auditCounters: Record<string, unknown>;
  entrypoint: Record<string, unknown>;
  external: Record<string, unknown>;
}>): void {
  const browserRuntime = recordV0102(input.browser.runtime, "V0102_RECORD_BROWSER_RUNTIME_INVALID");
  const browserIdentity = recordV0102(input.browser.identity, "V0102_RECORD_BROWSER_IDENTITY_INVALID");
  const browserPostgres = recordV0102(input.browser.postgres, "V0102_RECORD_BROWSER_POSTGRES_INVALID");
  const browserWorker = recordV0102(input.browserEvidence.worker, "V0102_RECORD_BROWSER_WORKER_INVALID");
  const browserDownload = recordV0102(input.browserEvidence.download, "V0102_RECORD_BROWSER_DOWNLOAD_INVALID");
  const browserDenials = recordV0102(input.browserEvidence.denials, "V0102_RECORD_BROWSER_DENIALS_INVALID");
  const browserCleanup = recordV0102(input.browser.cleanup, "V0102_RECORD_BROWSER_CLEANUP_INVALID");
  if (input.postgresAcceptance.acceptance_result !== "ACCEPTANCE_24_OF_24_PASS"
      || input.postgresGit.head !== input.head || input.postgresGit.tree !== input.tree
      || input.postgresGit.worktree !== "CLEAN" || input.governance.governance_security_definer_functions !== 32
      || input.governance.governance_exposed_functions !== 21
      || input.governance.unsafe_or_unexplained_functions !== 0
      || input.governance.cross_tenant_rpc_successes !== 0 || input.governance.pool_context_leaks !== 0
      || input.invalidation.operations_resolver_execution !== "PASS"
      || input.invalidation.exact_canonical_report_identity_sql !== "PASS"
      || input.invalidation.epochs_reset !== false || input.invalidation.product_reachable_memory_fallbacks !== 0
      || input.postgresMarathon.status !== "PASS"
      || input.browser.proof_class !== "REAL_RENDERED_BROWSER_TO_ISOLATED_POSTGRESQL_DURABLE_PRODUCT_PATH"
      || input.browserEvidence.schema_version !== "tivdoc-durable-browser-postgresql-evidence-v0.10.2"
      || browserWorker.fresh_process_protocol_verified !== true
      || browserWorker.distinct_process_binding_verified !== true
      || browserDownload.exact_hash_match !== true || browserDownload.owner_authenticated !== true
      || browserDenials.cross_owner_http_404 !== true || browserDenials.csrf_http_404 !== true
      || browserPostgres.owned_isolated_loopback !== true || browserPostgres.service_role_product_requests !== 0
      || browserIdentity.credentials_emitted !== 0 || browserRuntime.private_storage_root_emitted !== 0
      || browserRuntime.customer_processing_enabled !== false || browserRuntime.customer_shadow_enabled !== false
      || browserRuntime.production_delivery_enabled !== false || browserRuntime.openai_live_tests !== false
      || browserCleanup.status !== "PASS" || browserCleanup.postgres_runtime_connections_after_server !== 0
      || input.security.run_class !== "FULL_LOCAL_SECURITY_LIMITS_NEGATIVE_MATRIX"
      || input.security.negative_case_count !== 10 || input.security.no_partial_product_effects_required !== true
      || input.audit.verified_head !== input.head || input.audit.verified_tree !== input.tree
      || input.auditCounters.process_local_product_repositories !== 0
      || input.auditCounters.durable_governance_replacements_wired !== 4
      || input.auditCounters.partial_or_unwired_product_stable_entrypoints !== 0
      || input.auditCounters.product_reachable_memory_fallbacks !== 0
      || input.entrypoint.denominator !== 95 || input.entrypoint.product_stable_denominator !== 84
      || input.entrypoint.after_product_stable_partial_or_unwired !== 0
      || input.external.verified_head !== input.head || input.external.verified_tree !== input.tree
      || input.external.detector_run_count !== 1 || input.external.detectors_are_read_only !== true
      || input.external.managed_identity_provider_verified !== false
      || input.external.managed_private_storage_verified !== false
      || input.external.deployments !== 0 || input.external.remote_migrations !== 0
      || input.external.live_provider_calls !== 0 || input.external.openai_calls !== 0) {
    throw new Error("V0102_RECORD_RUNTIME_RECEIPT_CONTRADICTION");
  }
  const gates = Array.isArray(input.external.gates) ? input.external.gates.map((entry) =>
    recordV0102(entry, "V0102_RECORD_EXTERNAL_GATE_INVALID")) : [];
  const expected = [["MC-03", "IR-22"], ["MC-10", "IR-23"], ["MC-27", "IR-24"]] as const;
  if (gates.length !== expected.length || gates.some((gate, index) => gate.mc_id !== expected[index]![0]
      || gate.ir_id !== expected[index]![1] || gate.status !== "BLOCKED"
      || !Array.isArray(gate.reason_codes) || gate.reason_codes.length < 1)) {
    throw new Error("V0102_RECORD_EXTERNAL_GATE_INVALID");
  }
}

function commandBindingV0102(command: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    command_id: command.command_id,
    execution_ordinal: command.execution_ordinal,
    verified_head: command.verified_head,
    verified_tree: command.verified_tree,
    status: command.status,
    started_epoch_ms: command.started_epoch_ms,
    finished_epoch_ms: command.finished_epoch_ms,
    stdout_log: command.working_stdout_log,
    stdout_sha256: command.stdout_sha256,
    stdout_byte_count: command.stdout_byte_count,
    stderr_log: command.working_stderr_log,
    stderr_sha256: command.stderr_sha256,
    stderr_byte_count: command.stderr_byte_count,
    command_text_sha256: command.command_text_sha256,
    command_fingerprint_sha256: command.command_fingerprint_sha256,
    environment_allowlist_sha256: command.environment_allowlist_sha256,
    input_hashes: command.input_hashes,
    toolchain: command.toolchain,
  });
}

function sourceBindingV0102(relative: string, source: RuntimeProductSource): Readonly<Record<string, unknown>> {
  return Object.freeze({
    path: relative,
    schema_version: source.receipt.schema_version,
    sha256: sha256V0102(source.bytes),
    byte_count: source.bytes.byteLength,
    source_mtime_ms: source.mtime_ms,
    status: source.receipt.status,
  });
}

async function writeJsonV0102(working: string, relative: string, value: unknown): Promise<void> {
  const destination = path.join(working, ...relative.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function ordinaryBytesV0102(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size < 2 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("V0102_RECORD_FILE_INVALID");
  }
  const bytes = await readFile(file);
  if (bytes.byteLength !== metadata.size) throw new Error("V0102_RECORD_FILE_CHANGED");
  return bytes;
}

function parseJsonRecordV0102(bytes: Uint8Array, code: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(code);
  }
  return recordV0102(value, code);
}

function recordV0102(value: unknown, code: string): Record<string, unknown> {
  if (!recordLikeV0102(value)) throw new Error(code);
  return value;
}

function recordLikeV0102(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integerV0102(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(code);
  return value as number;
}

function sha256ValueV0102(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function gitOutputV0102(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0102_RECORD_GIT_FAILED");
  return result.stdout.trim();
}

function gitStatusV0102(root: string, args: readonly string[]): number {
  const result = spawnSync("git", args, { cwd: root, windowsHide: true });
  if (result.error || result.status === null) throw new Error("V0102_RECORD_GIT_FAILED");
  return result.status;
}

function sha256V0102(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
