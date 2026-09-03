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
  "202609010006_durable_portal_runtime_security.sql",
  "202609010007_global_dependency_invalidation.sql",
  "202609010008_runtime_product_forward_repair.sql",
  "202609010009_governance_owner_schema_usage_repair.sql",
  "202609010010_runtime_canonical_helper_acl_repair.sql",
  "202609010011_durable_legal_review.sql",
  "202609020001_legal_review_runtime_execute_grants.sql",
  "202609020002_legal_review_observation_blocks.sql",
  "202609020003_governance_import_operations_grants.sql",
  "202609020004_identity_session_tenant_enforcement.sql",
  "202609020005_controlled_import_reserved_execute_revoke.sql",
  "202609020006_controlled_import_service_role_execute_restore.sql",
  "202609020007_force_rls_owner_writer_clean_tables.sql",
  "202609020008_legal_review_observation_supersessions.sql",
  "202609020009_owner_access_policy_force_remaining.sql",
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
  "202609010005_governance_runtime_security.sql": "3632b1a8d6b8a08360e3f1d99aadb591d42fa577677ce87f77c114e89f41c63e",
  "202609010006_durable_portal_runtime_security.sql": "994bb2a3f14dd58e002f4e605bc8e03c5422a1904b9ec1f733ca1d1e21f9635d",
  "202609010007_global_dependency_invalidation.sql": "6d57e778a95d8e0988d4cf986a30577ec841847f189c225abdb29b9441eb45af",
  "202609010008_runtime_product_forward_repair.sql": "2271602fc133a4552d813278697138634b9ebb4327c941c3e373e2c99cbfacbe",
  "202609010009_governance_owner_schema_usage_repair.sql": "806480d5d6ff7a807bd7154909aab9711a613c25e0afe35651de2a1b77016ba9",
  "202609010010_runtime_canonical_helper_acl_repair.sql": "4aaa964b7288d38fa209df3058d76bba67bdf9031d7067410c8fa6073b96e1c2",
  "202609010011_durable_legal_review.sql": "4cf07944e87cd2ae8da631167610d39abdfc6b252db2d595434e9485ff7df882",
  "202609020001_legal_review_runtime_execute_grants.sql":
    "642c9b72fcd6471eb821158f756550e832d9dfd653ecfad986f6af5a8ddb0450",
  "202609020002_legal_review_observation_blocks.sql":
    "339b574e18d50d8a93f62c282c9becc2e64388cc0b29e6098a382e26b7a85c11",
  "202609020003_governance_import_operations_grants.sql":
    "f27e3fce0e5b98374428ddb6125df6812901e37540eef59ee38fa82d4ccc35af",
  "202609020004_identity_session_tenant_enforcement.sql":
    "5c05212bf6e57faafaf81aa57cbc5348628fe90158410150085c80469ccd640e",
  "202609020005_controlled_import_reserved_execute_revoke.sql":
    "2a771010004a5c856ef29b57724e1120bcca97284075ac12a7696ceb09c12a8b",
  "202609020006_controlled_import_service_role_execute_restore.sql":
    "a9f6b96c78b743984a1cf88f6520e9cad86351fbc4e0aa14cece08148fe48d31",
  "202609020007_force_rls_owner_writer_clean_tables.sql":
    "7bfb7da15449b3b8c330fb92bce4b7990afa4a54ffecdee1c8a090714ac2327b",
  "202609020008_legal_review_observation_supersessions.sql":
    "37cf0c78d9468c93df4c73d0d275f1885ef18e38f92d611876d3dcaa26fdbe79",
  "202609020009_owner_access_policy_force_remaining.sql":
    "f87ff804c1db299087b24cdeb6e28213173aa5c0a412672cebaa2f272f0668e8",
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
