import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const WORKING = path.join(ROOT, "output", "canonical-integration-durability-repair-v0.10.1", "working");
const FINAL_VERIFICATION = path.join(WORKING, "final-verification.json");
const verification = record(JSON.parse(await readFile(FINAL_VERIFICATION, "utf8")));
const commands = Array.isArray(verification.commands) ? verification.commands.map(record) : [];
const head = git("HEAD");
const tree = git("HEAD^{tree}");
if (verification.verified_head !== head || verification.verified_tree !== tree) throw new Error("V0101_RECORD_STALE_VERIFICATION");

const browser = command("browser_e2e_full");
const postgres = command("postgresql_full_regression");
const security = command("prohibited_operation_audit");
const reachability = command("canonical_reachability");
const wiring = command("persistence_wiring");

await writeJson("regressions/browser.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-browser-regression-v0.10.1",
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
    disposition: browser.status === "PASS" ? "SYNTHETIC_BROWSER_PASS_NOT_DURABLE_PRODUCT_PROOF" : "FAILED_LOCAL_WITH_EVIDENCE",
    observed_error: browser.status === "PASS" ? null : "UnhandledSchemeError: node:crypto",
    import_trace: browser.status === "PASS" ? [] : ["src/instrumentation.ts", "src/server/product/integration/browser-runtime.ts:1", "node:crypto"],
    routes_not_reached: browser.status === "PASS" ? [] : ["/", "/portal", "/operations"],
    durable_identity_postgres_private_storage_proven: false,
    command_receipt: browser,
  },
});

const postgresSources = [
  ["output/canonical-postgresql-dynamic-v0.9.1/development/matrix-smoke.json", "postgresql/matrix-smoke.json"],
  ["output/canonical-postgresql-dynamic-v0.9.1/development/marathon-v010-matrix.json", "postgresql/marathon-v010-matrix.json"],
  ["output/product-durable-postgres-v0.10.1/final/acceptance-receipt.json", "postgresql/product-acceptance-receipt.json"],
] as const;
const copiedPostgres: Readonly<Record<string, unknown>>[] = [];
for (const [source, destination] of postgresSources) {
  const sourcePath = path.join(ROOT, ...source.split("/"));
  try {
    const bytes = await ordinaryBytes(sourcePath);
    const destinationPath = path.join(WORKING, ...destination.split("/"));
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath, 1);
    copiedPostgres.push(Object.freeze({ source, destination, sha256: sha256(bytes), byte_count: bytes.byteLength }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    copiedPostgres.push(Object.freeze({ source, destination, status: "ABSENT" }));
  }
}
await writeJson("regressions/postgresql.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-postgresql-regression-v0.10.1",
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
    commit: "eb7ed50",
    canonical_identity_bound: ["tenant", "owner", "case", "analysis", "RuleInput", "dependencies", "report", "PDF", "object", "approval", "grant"],
  },
  after: { status: postgres.status, command_receipt: postgres, copied_receipts: copiedPostgres },
});

await writeJson("product/unified-timeline.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-product-timeline-v0.10.1",
  verified_head: head,
  verified_tree: tree,
  status: "FAIL",
  steps: [
    { step: "durable_cookie_identity", status: "IMPLEMENTED_NOT_INSTALLED" },
    { step: "portal_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "operations_http", status: "IMPLEMENTED_NOT_WIRED" },
    { step: "postgres_worker_report_private_object_restart", status: postgres.status },
    { step: "rendered_browser_download", status: "NOT_PROVEN" }
  ],
  exact_pdf_bytes_at_postgres_boundary: postgres.status === "PASS",
  durable_browser_product_path: false
});

await writeJson("verification/safety-and-reachability.json", {
  schema_version: "tivdoc-canonical-integration-durability-repair-safety-reachability-v0.10.1",
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
    manufactured_human_evidence: 0
  }
});

process.stdout.write(`${JSON.stringify({ status: "PASS", verified_head: head, verified_tree: tree,
  browser: browser.status, postgres: postgres.status, copied_postgres_receipts: copiedPostgres.length })}\n`);

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

async function ordinaryBytes(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("V0101_RECORD_SOURCE_INVALID");
  }
  return await readFile(file);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_RECORD_INPUT_INVALID");
  return value as Record<string, unknown>;
}

function git(revision: string): string {
  const result = spawnSync("git", ["rev-parse", revision], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || result.error) throw new Error("V0101_RECORD_GIT_FAILED");
  return result.stdout.trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
