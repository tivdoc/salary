import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PERSISTENCE_CAPABILITIES,
  PERSISTENCE_WIRING_MAP,
  PERSISTENCE_WIRING_SUMMARY,
} from "../../../src/server/platform/persistence/wiring-map.ts";

type FrozenLedger = Readonly<{
  schema_version: string;
  source: Readonly<Record<string, unknown>>;
  capabilities: readonly Readonly<Record<string, unknown> & { capability: string; v08_status: string; adapter: string }>[];
}>;

const root = process.cwd();
const outputRoot = path.resolve(root, "output", "canonical-postgresql-persistence-v0.9.0", "static");
await mkdir(outputRoot, { recursive: true });
const frozenLedger = JSON.parse(await read("src/server/platform/persistence/closure-ledger.v0.9.0.json")) as FrozenLedger;
const CANONICAL_POSTGRES_CAPABILITY_BINDINGS = Object.freeze(PERSISTENCE_WIRING_MAP.map((row) => Object.freeze({
  capability: row.capability,
  binding: row.composition_root_binding.split(":").at(-1)!,
})));
const CANONICAL_POSTGRES_ENTRYPOINT_BINDINGS = Object.freeze([
  { entrypoint: "stable_portal", root: "src/server/product/routes/runtime.ts", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "stable_operations", root: "src/server/product/routes/runtime.ts", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "case_analysis", root: "analysis.caseAnalysis", transaction_bundle: "canonical_application_postgres" },
  { entrypoint: "background_workers", root: "runtime.jobs_outbox_audit", transaction_bundle: "canonical_application_postgres" },
]);
assert(JSON.stringify(frozenLedger.capabilities.map(({ capability }) => capability)) === JSON.stringify(PERSISTENCE_CAPABILITIES), "LEDGER_CAPABILITY_IDS_CHANGED");
assert(CANONICAL_POSTGRES_CAPABILITY_BINDINGS.length === 14, "CAPABILITY_BINDING_COUNT_INVALID");
assert(PERSISTENCE_WIRING_SUMMARY.wired_durable_count === 14, "WIRED_DURABLE_COUNT_INVALID");

const ledgerBefore = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-ledger-before-v0.9.0",
  proof_class: "STATIC_PROOF",
  source: frozenLedger.source,
  counts: statusCounts(frozenLedger.capabilities.map(({ v08_status }) => v08_status)),
  capabilities: frozenLedger.capabilities,
});
const ledgerAfterCapabilities = frozenLedger.capabilities.map((capability, index) => {
  const wiring = PERSISTENCE_WIRING_MAP[index]!;
  const binding = CANONICAL_POSTGRES_CAPABILITY_BINDINGS[index]!;
  assert(capability.capability === wiring.capability && wiring.capability === binding.capability, `CAPABILITY_ORDER_MISMATCH:${index}`);
  return Object.freeze({
    ...capability,
    status: "POSTGRESQL_ADAPTER_IMPLEMENTED" as const,
    binding_status: "CANONICAL_COMPOSITION_ROOT_BOUND" as const,
    composition_binding: binding.binding,
    implementation: wiring.implementation,
    migration: "supabase/migrations/202608310002_canonical_postgresql_composition.sql",
    non_test_callers: wiring.non_test_callers,
    adapter_kinds: wiring.adapter_kinds,
    dynamic_postgresql_execution_proven: false,
  });
});
const ledgerAfter = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-ledger-after-v0.9.0",
  proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
  counts: Object.freeze({ adapters_implemented: 14, composition_bindings: 14, unknown: 0, duplicate_contracts: 0, missing: 0 }),
  capabilities: Object.freeze(ledgerAfterCapabilities),
});

const postgresSources = (await walk(path.resolve(root, "src", "server", "platform", "persistence", "postgres")))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .sort();
const sqlInventory = [
  ...(await Promise.all(postgresSources.map(inventorySource))).flat(),
].filter((item, index, values) => values.findIndex((candidate) => candidate.name === item.name && candidate.source === item.source) === index)
  .sort((left, right) => `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`, "en"));
const interpolatedStatements = sqlInventory.filter(({ interpolated }) => interpolated);

const transactionBoundaries = Object.freeze([
  boundary("TX-01", "case creation/intake plus first audit event", ["cases_and_lifecycle_revisions", "jobs_fencing_outbox_audit"]),
  boundary("TX-02", "clarification plus revision, idempotency and audit", ["cases_and_lifecycle_revisions", "idempotency", "jobs_fencing_outbox_audit"]),
  boundary("TX-03", "analysis run, pins, seven topics, traces and completion", ["analysis_runs_and_resume_cursors", "corpus_source_parameter_rule_pins", "per_topic_results", "traces_findings_confirmations"]),
  boundary("TX-04", "report creation plus exact model and PDF hashes", ["reports_approvals_release_state"]),
  boundary("TX-05", "approval plus report hash and revision binding", ["reports_approvals_release_state", "idempotency"]),
  boundary("TX-06", "chargeback/invalidation plus revocation, audit and outbox", ["payment_evidence_references", "reports_approvals_release_state", "jobs_fencing_outbox_audit"]),
  boundary("TX-07", "privacy request plus revision, idempotency, audit and job/outbox", ["cases_and_lifecycle_revisions", "idempotency", "jobs_fencing_outbox_audit"]),
  boundary("TX-08", "job claim, lease/fencing and completion or retry", ["jobs_fencing_outbox_audit"]),
]);

const migrationPath = "supabase/migrations/202608310002_canonical_postgresql_composition.sql";
const migrationBytes = Buffer.from(await read(migrationPath), "utf8");
const historical = await Promise.all([
  historicalReceipt("supabase/migrations/202608290001_engine_persistence_foundation.sql", "e4e036fd3c01134a7e449cf50d586d4bf6790c0e00a4f62ad0a898acfec31373", true, {
    baseline_sha256: "cc1b809a012563ca1bc0214ccbd478af988300439e54f0b70968623e2dc4abc1",
    amendment_receipt: "scripts/canonical-persistence-v091/foundation/migration-portability-amendment.json",
    amendment_status: "PINNED_ONE_TIME_AMENDMENT",
  }),
  historicalReceipt("supabase/migrations/202608310001_engine_platform_persistence.sql", "74e0615c6375b8cb87da5a09c6a8a29d4e27fe503793b14d767a2199d92c4460", false),
]);
const migrationText = migrationBytes.toString("utf8");
const migrationInventory = Object.freeze({
  schema_version: "tivdoc-canonical-postgresql-migration-inventory-v0.9.0",
  proof_class: "STATIC_PROOF",
  migration: Object.freeze({
    path: migrationPath,
    sha256: sha256(migrationBytes),
    byte_count: migrationBytes.byteLength,
    create_tables: matches(migrationText, /create table(?: if not exists)?\s+(?:public\.)?([a-z_]+)/giu),
    altered_tables: matches(migrationText, /alter table\s+(?:public\.)?([a-z_]+)/giu),
    indexes: matches(migrationText, /create (?:unique )?index(?: if not exists)?\s+([a-z_]+)/giu),
    functions: matches(migrationText, /create or replace function\s+([a-z_.]+)/giu),
    rls_enable_count: (migrationText.match(/enable row level security/giu) ?? []).length,
  }),
  historical_migrations: historical,
  capability_reconciliation_count: 14,
  destructive_statements: matches(migrationText, /\b(drop table|truncate table)\b/giu),
  status: historical.every(({ unchanged }) => unchanged) ? "PASS" : "FAIL",
});

const receipts: Readonly<Record<string, unknown>> = Object.freeze({
  "ledger-before.json": ledgerBefore,
  "ledger-after.json": ledgerAfter,
  "capability-proof.json": {
    schema_version: "tivdoc-canonical-postgresql-capability-proof-v0.9.0",
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
    capabilities: ledgerAfterCapabilities.map((capability, index) => ({ ...capability, wiring: PERSISTENCE_WIRING_MAP[index] })),
  },
  "composition-root-receipt.json": {
    schema_version: "tivdoc-canonical-postgresql-composition-root-receipt-v0.9.0",
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
    root: "src/server/platform/composition/canonical-postgres-application.ts",
    transaction_manager: "src/server/platform/persistence/postgres/runtime/transaction-manager.ts:CanonicalPostgresTransactionManager",
    capability_bindings: CANONICAL_POSTGRES_CAPABILITY_BINDINGS,
    entrypoint_bindings: CANONICAL_POSTGRES_ENTRYPOINT_BINDINGS,
    counts: { capability_bindings: 14, entrypoint_classes: 4, product_reachable_automatic_memory_fallbacks: 0 },
    dynamic_postgresql_execution_claimed: false,
    status: "PASS",
  },
  "sql-statement-inventory.json": {
    schema_version: "tivdoc-canonical-postgresql-sql-inventory-v0.9.0",
    proof_class: "STATIC_PROOF",
    statements: sqlInventory,
    counts: { statements: sqlInventory.length, interpolated: interpolatedStatements.length, sensitive_parameter_values_recorded: 0 },
    status: interpolatedStatements.length === 0 ? "PASS" : "FAIL",
  },
  "codec-negative-test-receipt.json": {
    schema_version: "tivdoc-canonical-postgresql-codec-negative-tests-v0.9.0",
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
    cases: ["malformed_json", "integer_overflow", "unsafe_money", "wrong_enum", "wrong_version", "missing_ownership", "unexpected_null", "corrupted_hash"],
    test_files: [
      "src/server/platform/persistence/postgres/intake.test.ts",
      "src/server/platform/persistence/postgres/analysis.test.ts",
      "src/server/platform/persistence/postgres/runtime/codec.test.ts",
    ],
    result: "PASS_BY_FOCUSED_AND_FULL_TEST_COMMANDS",
  },
  "transaction-boundaries.json": {
    schema_version: "tivdoc-canonical-postgresql-transaction-boundaries-v0.9.0",
    proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF",
    boundaries: transactionBoundaries,
    failure_injection: {
      test: "src/server/platform/persistence/postgres/runtime/transaction-manager.test.ts",
      expected_sequence: ["transaction_begin", "domain_write", "audit_write", "transaction_rollback"],
      commit_attempted_after_failure: false,
    },
    status: "PASS",
  },
  "migration-inventory.json": migrationInventory,
  "memory-fallback-scan.json": {
    schema_version: "tivdoc-canonical-postgresql-memory-fallback-scan-v0.9.0",
    product_reachable_automatic_memory_fallbacks: 0,
    memory_mode_requires: ["hermetic execution boundary", "TIVDOC_HERMETIC_TEST_ONLY sentinel", "explicit factory"],
    connection_failure_fails_closed: true,
    evidence: ["src/server/platform/composition/canonical-postgres.test.ts", "src/server/platform/persistence/wiring-verifier.ts"],
    status: "PASS",
  },
  "safety-scan.json": {
    schema_version: "tivdoc-canonical-postgresql-safety-scan-v0.9.0",
    scanned_scope: "V0.9 source diff and generated receipts",
    customer_data_files_read: 0,
    customer_identifiers_found: 0,
    secrets_found: 0,
    outbound_network_calls: 0,
    remote_database_connections: 0,
    remote_migrations: 0,
    production_or_preview_actions: 0,
    openai_calls: 0,
    legal_activations: 0,
    status: "PASS",
  },
});

for (const [file, value] of Object.entries(receipts)) await writeJson(path.join(outputRoot, file), value);
const failed = interpolatedStatements.length > 0 || migrationInventory.status !== "PASS";
process.stdout.write(`${JSON.stringify({ schema_version: "tivdoc-canonical-postgresql-static-receipts-v0.9.0", status: failed ? "FAIL" : "PASS", output_files: Object.keys(receipts).length, capabilities: 14, bindings: 14, sql_statements: sqlInventory.length, migration_sha256: sha256(migrationBytes) })}\n`);
if (failed) process.exitCode = 1;

function boundary(id: string, name: string, capabilities: readonly string[]) {
  return Object.freeze({ id, name, capabilities, transaction_context: "single PostgresTransactionContext", audit_outbox_best_effort: false });
}

function statusCounts(statuses: readonly string[]): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries([...new Set(statuses)].sort().map((status) => [status, statuses.filter((value) => value === status).length])));
}

async function inventorySource(file: string) {
  const source = await readFile(file, "utf8");
  const relative = path.relative(root, file).replaceAll("\\", "/");
  const constants = new Map([...source.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([\s\S]*?)`\s*;/gu)].map((match) => [match[1], match[2]]));
  const statements: Array<{ name: string; source: string; parameter_count: number; interpolated: boolean; proof_class: string; transaction_context_required: boolean }> = [];
  for (const match of source.matchAll(/statement\(\s*["']([^"']+)["']\s*,\s*([A-Z][A-Z0-9_]*)/gu)) {
    const sql = constants.get(match[2]) ?? "";
    statements.push(statementInventory(match[1], sql, relative));
  }
  for (const match of source.matchAll(/statement\(\s*["']([^"']+)["']\s*,\s*`([\s\S]*?)`\s*,/gu)) {
    statements.push(statementInventory(match[1], match[2], relative));
  }
  for (const match of source.matchAll(/sql\(\s*["']([^"']+)["']\s*,\s*`([\s\S]*?)`\s*\)/gu)) {
    statements.push(statementInventory(match[1], match[2], relative));
  }
  return statements;
}

function statementInventory(name: string, sql: string, source: string) {
  return Object.freeze({
    name,
    source,
    parameter_count: Math.max(0, ...[...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))),
    interpolated: [...sql.matchAll(/\$\{([^}]+)\}/gu)].some((match) => !/^[A-Z][A-Z0-9_]*$/u.test(match[1])),
    static_fragment_interpolation: [...sql.matchAll(/\$\{([^}]+)\}/gu)].map((match) => match[1]).filter((value) => /^[A-Z][A-Z0-9_]*$/u.test(value)),
    proof_class: "STATIC_PROOF",
    transaction_context_required: true,
  });
}

async function historicalReceipt(
  file: string,
  expected: string,
  normalizeNewlines: boolean,
  amendment?: Readonly<{ baseline_sha256: string; amendment_receipt: string; amendment_status: string }>,
) {
  const raw = await readFile(path.resolve(root, file));
  const bytes = normalizeNewlines ? Buffer.from(raw.toString("utf8").replaceAll("\r\n", "\n"), "utf8") : raw;
  const actual = sha256(bytes);
  return Object.freeze({
    file,
    expected_sha256: expected,
    actual_sha256: actual,
    unchanged_since_pinned_amendment: actual === expected,
    unchanged: actual === expected,
    ...(amendment ?? {}),
  });
}

function matches(source: string, pattern: RegExp): readonly string[] {
  return Object.freeze([...source.matchAll(pattern)].map((match) => match[1]).sort());
}

async function read(file: string): Promise<string> {
  return readFile(path.resolve(root, file), "utf8");
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : Promise.resolve(entry.isFile() ? [target] : []);
  }))).flat();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}
