import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import {
  assertPlainPostgresFoundationInventory,
  collectPostgresInventory,
  createOwnedLocalTarget,
  resolveDynamicPostgresPaths,
  type ApprovedPostgresTarget,
  type DynamicPostgresPaths,
  type PinnedPostgresBinaries,
} from "../foundation/index.mts";
import { buildPostgresChildEnvironment, runSafeCommand } from "../foundation/process.mts";
import { roleConnectionUrls, targetConnectionUrl, type DynamicRoleSecrets } from "../orchestration/roles.mts";
import { replayCanonicalCapabilityMatrix, type DurableCapabilityState } from "./capabilities.mts";
import { runRealPostgresRlsMatrix } from "./rls.mts";

export type BackupRestoreReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-backup-restore-v0.9.1";
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF";
  backup_format: "POSTGRESQL_CUSTOM";
  backup_sha256: string;
  backup_byte_count: number;
  source_database: string;
  restored_database: string;
  source_table_count: number;
  restored_table_count: number;
  source_record_set_sha256: string;
  restored_record_set_sha256: string;
  source_inventory_sha256: string;
  restored_inventory_sha256: string;
  migration_state_equal: true;
  capability_replay: "PASS";
  focused_rls_matrix: "PASS";
  connection_attempts: number;
  credentials_recorded: 0;
  backup_in_evidence_bundle: false;
  status: "PASS";
}>;

type SafeRecordSet = Readonly<{
  tables: readonly Readonly<{ schema: string; table: string; row_count: number; state_sha256: string }>[];
  record_set_sha256: string;
}>;

/**
 * Creates and restores a genuine custom-format PostgreSQL backup. Only hashes,
 * counts and schema names leave the ignored runtime directory.
 */
export async function runBackupRestoreMatrix(input: Readonly<{
  root: string;
  source_target: ApprovedPostgresTarget;
  source_paths: DynamicPostgresPaths;
  binaries: PinnedPostgresBinaries;
  build_identity_sha: string;
  run_id: string;
  durable_state: DurableCapabilityState;
  role_secrets: DynamicRoleSecrets;
  tenant_a: string;
  tenant_b: string;
}>): Promise<BackupRestoreReceipt> {
  const restored = createOwnedLocalTarget({
    port: input.source_target.descriptor.port,
    suffix: `restore_${input.run_id}`,
    username: input.source_target.username.reveal(),
    password: input.source_target.password.reveal(),
  });
  const restoredPaths = resolveDynamicPostgresPaths(input.root, restored);
  const maintenanceUrl = targetConnectionUrl(input.source_target, "postgres");
  await createDatabase(maintenanceUrl, restored.descriptor.database);

  const backupPath = path.resolve(input.source_paths.backup_root, `canonical-${input.run_id}.dump`);
  if (!backupPath.startsWith(`${path.resolve(input.source_paths.backup_root)}${path.sep}`)) {
    throw new Error("POSTGRES_BACKUP_PATH_UNSAFE");
  }
  await runSafeCommand({
    executable: input.binaries.executable_paths.pg_dump,
    args: Object.freeze(["--format=custom", "--no-owner", "--file", backupPath]),
    cwd: input.root,
    env: buildPostgresChildEnvironment(input.source_target),
    redactions: Object.freeze([input.source_target.username, input.source_target.password]),
    timeout_ms: 120_000,
  });
  const backupMetadata = await stat(backupPath);
  if (!backupMetadata.isFile() || backupMetadata.size <= 0) throw new Error("POSTGRES_BACKUP_EMPTY");
  const backupSha256 = await sha256File(backupPath);

  await runSafeCommand({
    executable: input.binaries.executable_paths.pg_restore,
    args: Object.freeze([
      `--dbname=${restored.descriptor.database}`,
      "--no-owner",
      "--exit-on-error",
      "--single-transaction",
      backupPath,
    ]),
    cwd: input.root,
    env: buildPostgresChildEnvironment(restored),
    redactions: Object.freeze([restored.username, restored.password]),
    timeout_ms: 120_000,
  });

  const sourceRecords = await collectRecordSet(targetConnectionUrl(input.source_target));
  const restoredRecords = await collectRecordSet(targetConnectionUrl(restored));
  if (sourceRecords.record_set_sha256 !== restoredRecords.record_set_sha256
      || sourceRecords.tables.length !== restoredRecords.tables.length) {
    throw new Error("POSTGRES_RESTORED_RECORD_SET_MISMATCH");
  }

  const sourceInventory = await collectPostgresInventory({
    target: input.source_target,
    paths: input.source_paths,
    binaries: input.binaries,
  });
  const restoredInventory = await collectPostgresInventory({
    target: restored,
    paths: restoredPaths,
    binaries: input.binaries,
  });
  assertPlainPostgresFoundationInventory(restoredInventory);
  if (sourceInventory.inventory_sha256 !== restoredInventory.inventory_sha256) {
    throw new Error("POSTGRES_RESTORED_INVENTORY_MISMATCH");
  }

  const restoredRoleUrls = roleConnectionUrls({
    target: restored,
    database: restored.descriptor.database,
    secrets: input.role_secrets,
  });
  const replay = await replayCanonicalCapabilityMatrix({
    connection_url: restoredRoleUrls.service_role,
    build_identity_sha: input.build_identity_sha,
  }, input.durable_state);
  if (!replay.replayed || replay.matrix.length !== 14) throw new Error("POSTGRES_RESTORED_REPLAY_FAILED");

  const rls = await runRealPostgresRlsMatrix({
    admin_connection_url: targetConnectionUrl(restored),
    role_connection_urls: {
      anon: restoredRoleUrls.anon,
      authenticated: restoredRoleUrls.authenticated,
      service_role: restoredRoleUrls.service_role,
      tenant_policy_probe: restoredRoleUrls.tivdoc_policy_probe,
    },
    tenant_a: input.tenant_a,
    tenant_b: input.tenant_b,
  });
  if (rls.status !== "PASS") throw new Error("POSTGRES_RESTORED_RLS_FAILED");

  return Object.freeze({
    schema_version: "tivdoc-real-postgresql-backup-restore-v0.9.1",
    proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
    backup_format: "POSTGRESQL_CUSTOM",
    backup_sha256: backupSha256,
    backup_byte_count: backupMetadata.size,
    source_database: input.source_target.descriptor.database,
    restored_database: restored.descriptor.database,
    source_table_count: sourceRecords.tables.length,
    restored_table_count: restoredRecords.tables.length,
    source_record_set_sha256: sourceRecords.record_set_sha256,
    restored_record_set_sha256: restoredRecords.record_set_sha256,
    source_inventory_sha256: sourceInventory.inventory_sha256,
    restored_inventory_sha256: restoredInventory.inventory_sha256,
    migration_state_equal: true,
    capability_replay: "PASS",
    focused_rls_matrix: "PASS",
    connection_attempts: replay.driver_metrics.connection_attempts,
    credentials_recorded: 0,
    backup_in_evidence_bundle: false,
    status: "PASS",
  });
}

async function createDatabase(maintenanceUrl: string, database: string): Promise<void> {
  if (!/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(database)) throw new Error("POSTGRES_DATABASE_NAME_UNSAFE");
  const pool = postgresPool(maintenanceUrl, "tivdoc-v091-backup-restore-create");
  try {
    await pool.query(`create database "${database}" encoding 'UTF8' template template0`);
  } finally {
    await pool.end();
  }
}

async function collectRecordSet(connectionUrl: string): Promise<SafeRecordSet> {
  const pool = postgresPool(connectionUrl, "tivdoc-v091-backup-record-set");
  try {
    const inventory = await pool.query<{ schema_name: string; table_name: string }>(`
      select n.nspname as schema_name, c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any($1::text[]) and c.relkind = 'r'
       order by n.nspname, c.relname`, [["public", "storage"]]);
    const tables: Array<SafeRecordSet["tables"][number]> = [];
    for (const row of inventory.rows) {
      const schema = identifier(row.schema_name);
      const table = identifier(row.table_name);
      const result = await pool.query<{ row_count: string; state_sha256: string }>(`
        select count(*)::text as row_count,
               encode(public.digest(coalesce(string_agg(to_jsonb(snapshot_row)::text, E'\\n'
                 order by to_jsonb(snapshot_row)::text), ''), 'sha256'), 'hex') as state_sha256
          from ${schema}.${table} snapshot_row`);
      const count = result.rows[0]?.row_count;
      const digest = result.rows[0]?.state_sha256;
      if (!count || !/^\d+$/u.test(count) || !digest || !/^[0-9a-f]{64}$/u.test(digest)) {
        throw new Error("POSTGRES_RECORD_SET_ROW_INVALID");
      }
      tables.push(Object.freeze({
        schema: row.schema_name,
        table: row.table_name,
        row_count: Number(count),
        state_sha256: digest,
      }));
    }
    return Object.freeze({ tables: Object.freeze(tables), record_set_sha256: canonicalHash(tables) });
  } finally {
    await pool.end();
  }
}

function postgresPool(connectionString: string, applicationName: string): Pool {
  return new Pool({ connectionString, application_name: applicationName, ssl: false, max: 2, allowExitOnIdle: true });
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("POSTGRES_IDENTIFIER_UNSAFE");
  return `"${value}"`;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
