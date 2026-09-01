import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { Pool } from "pg";

import type { PinnedPostgresBinaries } from "./pinned-binaries.mts";
import { contained, type DynamicPostgresPaths } from "./paths.mts";
import {
  buildPostgresChildEnvironment,
  type CommandRunner,
  runSafeCommand,
} from "./process.mts";
import { assertSafeTargetIdentity, type ApprovedPostgresTarget } from "./safety.mts";

export const CANONICAL_COMPOSITION_MIGRATION = "202608310002_canonical_postgresql_composition.sql" as const;
export const CANONICAL_COMPOSITION_MIGRATION_SHA256 =
  "27e6163ff8e4caf6512925c96bcb8ead398f47da85e152a52beadcbcaad132a2" as const;

export const EXPECTED_MIGRATION_CHAIN = Object.freeze([
  "202608220001_salary_mvp.sql",
  "202608220002_invoice4u_verification.sql",
  "202608220003_invoice4u_checkout_expiry.sql",
  "202608220004_payment_return_recovery.sql",
  "202608220005_meta_measurement.sql",
  "202608270001_reconciliation_attribution.sql",
  "202608280001_ga4_measurement_protocol.sql",
  "202608290001_engine_persistence_foundation.sql",
  "202608300001_canonical_upgrade_compatibility.sql",
  "202608310001_engine_platform_persistence.sql",
  CANONICAL_COMPOSITION_MIGRATION,
  "202608310003_canonical_postgresql_dynamic_hardening.sql",
  "202609010001_controlled_import_ledger.sql",
  "202609010002_durable_product_boundaries.sql",
  "202609010003_durable_product_integrity_hardening.sql",
  "202609010004_durable_governance_workflows.sql",
  "202609010005_governance_runtime_security.sql",
] as const);

export const EXPECTED_MIGRATION_SHA256: Readonly<Record<(typeof EXPECTED_MIGRATION_CHAIN)[number], string>> = Object.freeze({
  "202608220001_salary_mvp.sql": "bd8e8a66ccf583a962c5fe28cb23335c16cda6616ca6ef12d258f2e8aed78141",
  "202608220002_invoice4u_verification.sql": "b69cdeb7a6b768408f115487be76af6e69a955f1d10699f06fb9cda68085e56d",
  "202608220003_invoice4u_checkout_expiry.sql": "681108245c1b62c79dc330498810be1316405c4842d873109cfb9e7d29e7c212",
  "202608220004_payment_return_recovery.sql": "f78c5b32317055c8748ef47a891e58b9b9351547d2f594228a6ccf45e4afe35a",
  "202608220005_meta_measurement.sql": "456781cac1d54dc1be1f191ce4232904b56a0b8863bc6dd48faa22fa6a1b9a5c",
  "202608270001_reconciliation_attribution.sql": "a3803d56fa0ba9b8e14cfc0420ec858a965537ac47533ac604ee31f2490a01a6",
  "202608280001_ga4_measurement_protocol.sql": "8f18399f804b465d796d1828b852738745dc266aa8f202e265f64028e78b4bed",
  "202608290001_engine_persistence_foundation.sql": "0dd5d93d113a7c4ed68515af30d9927bd320255f88593fc04e6015a429db36e5",
  "202608300001_canonical_upgrade_compatibility.sql": "7ec2cad5d3d6f6890fbf8ec3bfa0916176b515f804d497ee1359c9938b83d304",
  "202608310001_engine_platform_persistence.sql": "74e0615c6375b8cb87da5a09c6a8a29d4e27fe503793b14d767a2199d92c4460",
  "202608310002_canonical_postgresql_composition.sql": CANONICAL_COMPOSITION_MIGRATION_SHA256,
  "202608310003_canonical_postgresql_dynamic_hardening.sql": "5a270a03e234794213a4c4fd68706c53b86e9e4501688a77bf628f346e2690da",
  "202609010001_controlled_import_ledger.sql": "3e51b4c1cd06c4f654566937c486856c78c192c1923fc287da29f8c0a1463e34",
  "202609010002_durable_product_boundaries.sql": "455e8789de89bef18fb1041e009ab87d7a7e005a294209df3b83456d42ff3e6f",
  "202609010003_durable_product_integrity_hardening.sql": "2882adc09d5faccbee2f96cf9f1c75b1b40b586f206408795bde189914501029",
  "202609010004_durable_governance_workflows.sql": "343f72ff7ee9d15c1007261c382223e4aac59e1f0227fad7c32fc05e230ed012",
  "202609010005_governance_runtime_security.sql": "ceef0ea9c5f4aa0a8f9a2b5b5b57e7a6281ec9f8edc93ef7e54fe0f24105f426",
});

export type MigrationFile = Readonly<{
  migration_id: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}>;

export type MigrationChainReceipt = Readonly<{
  schema_version: "tivdoc-postgres-migration-chain-v0.9.1";
  migrations: readonly MigrationFile[];
  migration_count: number;
  canonical_migration_sha256: typeof CANONICAL_COMPOSITION_MIGRATION_SHA256;
  order_verified: true;
  unknown_migrations: 0;
  missing_migrations: 0;
}>;

export type MigrationApplyReceipt = Readonly<{
  schema_version: "tivdoc-postgres-migration-apply-v0.9.1";
  mode: "compatibility_bootstrap" | "clean_chain" | "pre_canonical_upgrade" | "canonical_upgrade";
  applied: readonly Readonly<{
    name: string;
    sha256: string;
    duration_ms: number;
    exit_code: 0;
  }>[];
  applied_count: number;
  database: string;
  credentials_emitted: 0;
}>;

export async function discoverMigrationChain(paths: DynamicPostgresPaths): Promise<MigrationChainReceipt> {
  const entries = (await readdir(paths.migrations_root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{12}_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== EXPECTED_MIGRATION_CHAIN.length
    || entries.some((name, index) => name !== EXPECTED_MIGRATION_CHAIN[index])) {
    throw new Error("POSTGRES_MIGRATION_CHAIN_UNEXPECTED");
  }
  const realMigrationRoot = await realpath(paths.migrations_root);
  const migrations: MigrationFile[] = [];
  for (const name of entries) {
    const path = contained(paths.migrations_root, resolve(paths.migrations_root, name));
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`POSTGRES_MIGRATION_FILE_UNSAFE:${name}`);
    const resolved = await realpath(path);
    contained(realMigrationRoot, resolved);
    const bytes = await readFile(resolved);
    const expectedDigest = EXPECTED_MIGRATION_SHA256[name as (typeof EXPECTED_MIGRATION_CHAIN)[number]];
    const digest = sqlSha256(bytes, expectedDigest);
    if (digest !== expectedDigest) {
      throw new Error(`POSTGRES_MIGRATION_CHECKSUM_MISMATCH:${name}`);
    }
    migrations.push(Object.freeze({
      migration_id: name.slice(0, 12),
      name,
      path: resolved,
      bytes: bytes.byteLength,
      sha256: digest,
    }));
  }
  const canonical = migrations.find((migration) => migration.name === CANONICAL_COMPOSITION_MIGRATION);
  if (canonical?.sha256 !== CANONICAL_COMPOSITION_MIGRATION_SHA256) {
    throw new Error("CANONICAL_COMPOSITION_MIGRATION_CHECKSUM_MISMATCH");
  }
  return Object.freeze({
    schema_version: "tivdoc-postgres-migration-chain-v0.9.1",
    migrations: Object.freeze(migrations),
    migration_count: migrations.length,
    canonical_migration_sha256: CANONICAL_COMPOSITION_MIGRATION_SHA256,
    order_verified: true,
    unknown_migrations: 0,
    missing_migrations: 0,
  });
}

export async function applyCompatibilityBootstrap(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner?: CommandRunner;
}>): Promise<MigrationApplyReceipt> {
  const digest = await hashApprovedSqlFile(input.paths.repository_root, input.paths.bootstrap_sql);
  const result = await runPsqlFile({ ...input, runner: input.runner ?? runSafeCommand, file: input.paths.bootstrap_sql });
  return applyReceipt("compatibility_bootstrap", input.target, [{
    name: "plain-postgres-supabase-compat.sql",
    sha256: digest,
    duration_ms: result.duration_ms,
    exit_code: 0,
  }]);
}

export async function applyCleanMigrationChain(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  chain: MigrationChainReceipt;
  runner?: CommandRunner;
}>): Promise<MigrationApplyReceipt> {
  return await applyMigrationFiles("clean_chain", input, input.chain.migrations);
}

export async function applyPreCanonicalUpgradeChain(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  chain: MigrationChainReceipt;
  runner?: CommandRunner;
}>): Promise<MigrationApplyReceipt> {
  return await applyMigrationFiles(
    "pre_canonical_upgrade",
    input,
    input.chain.migrations.slice(0, canonicalMigrationIndex(input.chain)),
  );
}

export async function applyCanonicalUpgrade(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  chain: MigrationChainReceipt;
  runner?: CommandRunner;
}>): Promise<MigrationApplyReceipt> {
  const canonicalIndex = canonicalMigrationIndex(input.chain);
  const canonicalAndLater = input.chain.migrations.slice(canonicalIndex);
  if (canonicalAndLater[0]?.name !== CANONICAL_COMPOSITION_MIGRATION
    || canonicalAndLater[0]?.sha256 !== CANONICAL_COMPOSITION_MIGRATION_SHA256) {
    throw new Error("CANONICAL_COMPOSITION_MIGRATION_NOT_PROVEN");
  }
  return await applyMigrationFiles("canonical_upgrade", input, canonicalAndLater);
}

function canonicalMigrationIndex(chain: MigrationChainReceipt): number {
  const index = chain.migrations.findIndex((migration) => migration.name === CANONICAL_COMPOSITION_MIGRATION);
  if (index < 0) throw new Error("CANONICAL_COMPOSITION_MIGRATION_NOT_PROVEN");
  return index;
}

async function applyMigrationFiles(
  mode: MigrationApplyReceipt["mode"],
  input: Readonly<{
    target: ApprovedPostgresTarget;
    paths: DynamicPostgresPaths;
    binaries: PinnedPostgresBinaries;
    runner?: CommandRunner;
  }>,
  migrations: readonly MigrationFile[],
): Promise<MigrationApplyReceipt> {
  assertSafeTargetIdentity(input.target.descriptor);
  const runner = input.runner ?? runSafeCommand;
  const applied: Array<MigrationApplyReceipt["applied"][number]> = [];
  for (const migration of migrations) {
    contained(input.paths.migrations_root, migration.path);
    const actualDigest = await hashApprovedSqlFile(input.paths.migrations_root, migration.path, migration.sha256);
    if (actualDigest !== migration.sha256) throw new Error(`POSTGRES_MIGRATION_CHANGED_AFTER_DISCOVERY:${migration.name}`);
    const result = await runPsqlFile({ ...input, runner, file: migration.path });
    applied.push(Object.freeze({
      name: migration.name,
      sha256: migration.sha256,
      duration_ms: result.duration_ms,
      exit_code: 0,
    }));
  }
  return applyReceipt(mode, input.target, applied);
}

async function runPsqlFile(input: Readonly<{
  target: ApprovedPostgresTarget;
  paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  runner: CommandRunner;
  file: string;
}>) {
  assertSafeTargetIdentity(input.target.descriptor);
  if (input.binaries.source_kind === "edb_authenticode_signed_windows_installer") {
    const started = Date.now();
    const sql = await readFile(input.file, "utf8");
    const pool = new Pool({
      host: input.target.descriptor.host,
      port: input.target.descriptor.port,
      database: input.target.descriptor.database,
      user: input.target.username.reveal(),
      password: input.target.password.reveal(),
      ssl: false,
      max: 1,
      allowExitOnIdle: true,
      application_name: "tivdoc-v091-node-migration",
      connectionTimeoutMillis: 5_000,
    });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
    return Object.freeze({ duration_ms: Date.now() - started });
  }
  return await input.runner({
    executable: input.binaries.executable_paths.psql,
    args: Object.freeze([
      "--no-psqlrc",
      "--no-password",
      "--quiet",
      "--set=ON_ERROR_STOP=1",
      "--single-transaction",
      "--file", input.file,
    ]),
    cwd: input.paths.repository_root,
    env: buildPostgresChildEnvironment(input.target),
    redactions: Object.freeze([
      input.target.username,
      input.target.password,
      ...(input.target.ownership_token ? [input.target.ownership_token] : []),
    ]),
    timeout_ms: 120_000,
  });
}

function applyReceipt(
  mode: MigrationApplyReceipt["mode"],
  target: ApprovedPostgresTarget,
  applied: readonly MigrationApplyReceipt["applied"][number][],
): MigrationApplyReceipt {
  return Object.freeze({
    schema_version: "tivdoc-postgres-migration-apply-v0.9.1",
    mode,
    applied: Object.freeze([...applied]),
    applied_count: applied.length,
    database: target.descriptor.database,
    credentials_emitted: 0,
  });
}

async function hashApprovedSqlFile(parent: string, path: string, expectedSha256?: string): Promise<string> {
  contained(parent, path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("POSTGRES_SQL_FILE_UNSAFE");
  const bytes = await readFile(path);
  return sqlSha256(bytes, expectedSha256);
}

function sqlSha256(bytes: Buffer, expectedSha256?: string): string {
  const raw = createHash("sha256").update(bytes).digest("hex");
  if (!expectedSha256 || raw === expectedSha256) return raw;
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD") || /\r(?!\n)/u.test(text)) {
    throw new Error("POSTGRES_SQL_FILE_ENCODING_INVALID");
  }
  return createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}
