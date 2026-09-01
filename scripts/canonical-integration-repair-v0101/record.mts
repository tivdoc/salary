import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
