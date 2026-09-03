import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";

import { canonicalSha256 } from "../../../src/engine/rule-runtime/canonical.ts";
import { startCanonicalApplicationPostgres } from "../../../src/server/platform/composition/canonical-postgres-application.ts";
import { NodePostgresConnectionFactory } from "../../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import {
  applyCanonicalUpgrade,
  applyCompatibilityBootstrap,
  applyPreCanonicalUpgradeChain,
  assertPlainPostgresFoundationInventory,
  collectPostgresInventory,
  createOwnedLocalTarget,
  resolveDynamicPostgresPaths,
  type ApprovedPostgresTarget,
  type MigrationChainReceipt,
  type PinnedPostgresBinaries,
} from "../foundation/index.mts";
import {
  configureRuntimeRoleSessions,
  generateRuntimeRoleSecrets,
  runtimeRoleConnectionUrls,
  targetConnectionUrl,
} from "../orchestration/roles.mts";
import { runCanonicalCapabilityMatrix } from "./capabilities.mts";
import { analysisCommand } from "./runtime.mts";

export type MigrationMatrixReceipt = Readonly<{
  schema_version: "tivdoc-real-postgresql-migration-matrix-v0.9.1";
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF";
  clean: Readonly<{ status: "PASS"; migration_count: number }>;
  upgrade: Readonly<{
    status: "PASS";
    pre_upgrade_rows: number;
    post_upgrade_rows: number;
    pre_upgrade_state_sha256: string;
    post_upgrade_state_sha256: string;
    application_root_reachable: true;
    analysis_run_metadata_enrichment: true;
    document_metadata_enrichment: true;
    schema_inventory_reconciled: true;
    upgraded_inventory_sha256: string;
    terminal_history_immutability: true;
    canonical_capability_count: 14;
    canonical_capabilities_passed: 14;
    capability_connection_class: "owned_admin_migration_rehearsal_with_verified_worker_runtime";
    worker_runtime_principal: "tivdoc_worker_runtime";
    worker_runtime_service_role_calls: 0;
  }>;
  failed_partial: Readonly<{
    status: "PASS";
    controlled_failure_observed: true;
    canonical_metadata_after_failure: 0;
    recovery_rerun: "PASS";
    recovery_schema_inventory_reconciled: true;
    recovery_inventory_sha256: string;
  }>;
  credentials_recorded: 0;
  status: "PASS";
}>;

export async function runRealMigrationMatrix(input: Readonly<{
  root: string;
  owner_target: ApprovedPostgresTarget;
  binaries: PinnedPostgresBinaries;
  chain: MigrationChainReceipt;
  build_identity_sha: string;
  run_id: string;
}>): Promise<MigrationMatrixReceipt> {
  const upgrade = cloneTarget(input.owner_target, `upgrade_${input.run_id}`);
  const failure = cloneTarget(input.owner_target, `failure_${input.run_id}`);
  const maintenanceUrl = targetConnectionUrl(input.owner_target, "postgres");
  await createDatabase(maintenanceUrl, upgrade.descriptor.database);
  await createDatabase(maintenanceUrl, failure.descriptor.database);

  const upgradePaths = resolveDynamicPostgresPaths(input.root, upgrade);
  await applyCompatibilityBootstrap({ target: upgrade, paths: upgradePaths, binaries: input.binaries });
  await applyPreCanonicalUpgradeChain({ target: upgrade, paths: upgradePaths, binaries: input.binaries, chain: input.chain });
  const seeded = await seedRepresentativeUpgradeState(targetConnectionUrl(upgrade), input.build_identity_sha);
  const before = await upgradeState(targetConnectionUrl(upgrade), seeded.tenant_id);
  await applyCanonicalUpgrade({ target: upgrade, paths: upgradePaths, binaries: input.binaries, chain: input.chain });
  const after = await upgradeState(targetConnectionUrl(upgrade), seeded.tenant_id);
  const upgradedInventory = await collectPostgresInventory({
    target: upgrade,
    paths: upgradePaths,
    binaries: input.binaries,
  });
  assertPlainPostgresFoundationInventory(upgradedInventory, { runtime_roles_login: false });
  const enrichment = await verifyUpgradeEnrichment(targetConnectionUrl(upgrade), seeded);
  const reachable = await proveUpgradedApplicationRoot({
    connection_url: targetConnectionUrl(upgrade),
    build_identity_sha: input.build_identity_sha,
    ...seeded,
  });
  const terminalHistoryImmutability = await proveTerminalHistoryImmutability(
    targetConnectionUrl(upgrade),
    seeded.analysis_run_id,
    seeded.tenant_id,
  );
  const upgradeRuntimeSecrets = generateRuntimeRoleSecrets();
  await configureRuntimeRoleSessions({
    admin_connection_url: targetConnectionUrl(upgrade),
    secrets: upgradeRuntimeSecrets,
  });
  const upgradeRuntimeUrls = runtimeRoleConnectionUrls({
    target: upgrade,
    database: upgrade.descriptor.database,
    secrets: upgradeRuntimeSecrets,
  });
  const upgradedCapabilities = await runCanonicalCapabilityMatrix({
    connection_url: targetConnectionUrl(upgrade),
    worker_runtime_connection_url: upgradeRuntimeUrls.tivdoc_worker_runtime,
    worker_runtime_principal: "tivdoc_worker_runtime",
    build_identity_sha: input.build_identity_sha,
    fixture_suffix: input.run_id,
  });
  const capabilitiesPassed = upgradedCapabilities.matrix.filter((row) => row.status === "PASS").length;
  if (before.rows !== 3 || after.rows !== before.rows || after.sha256 !== before.sha256 || !reachable
    || !enrichment.analysis_run || !enrichment.document || !terminalHistoryImmutability
    || upgradedCapabilities.matrix.length !== 14 || capabilitiesPassed !== 14
    || upgradedCapabilities.worker_runtime_principal !== "tivdoc_worker_runtime"
    || upgradedCapabilities.worker_runtime_verified_session !== true
    || upgradedCapabilities.worker_runtime_service_role_calls !== 0) {
    throw new Error("POSTGRES_UPGRADE_RECONCILIATION_FAILED");
  }

  const failurePaths = resolveDynamicPostgresPaths(input.root, failure);
  await applyCompatibilityBootstrap({ target: failure, paths: failurePaths, binaries: input.binaries });
  await applyPreCanonicalUpgradeChain({ target: failure, paths: failurePaths, binaries: input.binaries, chain: input.chain });
  const controlledFailure = await injectCanonicalMigrationFailure({
    connection_url: targetConnectionUrl(failure),
    canonical_migration_path: input.chain.migrations.find(({ name }) => name === "202608310002_canonical_postgresql_composition.sql")?.path,
  });
  if (!controlledFailure.observed || controlledFailure.metadataCount !== 0) {
    throw new Error("POSTGRES_PARTIAL_MIGRATION_ROLLBACK_FAILED");
  }
  await applyCanonicalUpgrade({ target: failure, paths: failurePaths, binaries: input.binaries, chain: input.chain });
  const recovered = await canonicalMetadataCount(targetConnectionUrl(failure));
  if (recovered !== 1) throw new Error("POSTGRES_PARTIAL_MIGRATION_RECOVERY_FAILED");
  const recoveredInventory = await collectPostgresInventory({
    target: failure,
    paths: failurePaths,
    binaries: input.binaries,
  });
  assertPlainPostgresFoundationInventory(recoveredInventory, { runtime_roles_login: false });

  return Object.freeze({
    schema_version: "tivdoc-real-postgresql-migration-matrix-v0.9.1",
    proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
    clean: Object.freeze({ status: "PASS", migration_count: input.chain.migration_count }),
    upgrade: Object.freeze({
      status: "PASS",
      pre_upgrade_rows: before.rows,
      post_upgrade_rows: after.rows,
      pre_upgrade_state_sha256: before.sha256,
      post_upgrade_state_sha256: after.sha256,
      application_root_reachable: true,
      analysis_run_metadata_enrichment: true,
      document_metadata_enrichment: true,
      schema_inventory_reconciled: true,
      upgraded_inventory_sha256: upgradedInventory.inventory_sha256,
      terminal_history_immutability: true,
      canonical_capability_count: 14,
      canonical_capabilities_passed: 14,
      capability_connection_class: "owned_admin_migration_rehearsal_with_verified_worker_runtime",
      worker_runtime_principal: "tivdoc_worker_runtime",
      worker_runtime_service_role_calls: 0,
    }),
    failed_partial: Object.freeze({
      status: "PASS",
      controlled_failure_observed: true,
      canonical_metadata_after_failure: 0,
      recovery_rerun: "PASS",
      recovery_schema_inventory_reconciled: true,
      recovery_inventory_sha256: recoveredInventory.inventory_sha256,
    }),
    credentials_recorded: 0,
    status: "PASS",
  });
}

function cloneTarget(owner: ApprovedPostgresTarget, suffix: string): ApprovedPostgresTarget {
  return createOwnedLocalTarget({
    port: owner.descriptor.port,
    suffix,
    username: owner.username.reveal(),
    password: owner.password.reveal(),
    ownership_token: owner.ownership_token?.reveal(),
  });
}

async function createDatabase(maintenanceUrl: string, database: string): Promise<void> {
  if (!/^tivdoc_v09_[a-z0-9_]{8,48}$/u.test(database)) throw new Error("POSTGRES_DATABASE_NAME_UNSAFE");
  const pool = postgresPool(maintenanceUrl, "tivdoc-v091-create-matrix-database");
  try {
    await pool.query(`create database "${database}" encoding 'UTF8' template template0`);
  } finally {
    await pool.end();
  }
}

async function seedRepresentativeUpgradeState(connectionUrl: string, buildIdentitySha: string) {
  const tenantId = "tenant-v091-upgrade";
  const caseId = randomUUID();
  const runId = randomUUID();
  const documentId = randomUUID();
  const command = analysisCommand(caseId, "upgrade-analysis-idempotency", 2);
  const commandSha256 = canonicalSha256(command);
  const stateSha256 = canonicalSha256({ case_id: caseId, revision: 2, state: "awaiting_documents" });
  const documentSha256 = canonicalSha256({ document_id: documentId, synthetic: true });
  const pool = postgresPool(connectionUrl, "tivdoc-v091-upgrade-seed");
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`
        insert into public.cases (id, public_id, first_name, email, phone, status, payment_status)
        values ($1::uuid, $2, 'Synthetic', 'synthetic-upgrade@example.invalid', '0000000000', 'started', 'not_started')`,
      [caseId, `TV-${caseId.replaceAll("-", "").slice(0, 8).toUpperCase()}`]);
      await client.query(`
        insert into public.engine_case_state (case_id, tenant_id, revision, lifecycle_state, state_sha256, updated_at)
        values ($1::uuid, $2, 2, 'awaiting_documents', $3, '2026-08-31T12:00:00Z')`,
      [caseId, tenantId, stateSha256]);
      await client.query(`
        insert into public.analysis_runs (
          id, case_id, run_type, status, trigger_reason, engine_version, engine_git_sha,
          contract_version, ontology_version, input_snapshot, input_snapshot_hash,
          idempotency_key, created_at
        ) values (
          $1::uuid, $2::uuid, 'full_investigation', 'queued', 'synthetic.upgrade',
          'case-analysis@0.9.1', $3, 'tivdoc-case-analysis-v0.6.0',
          'tivdoc-canonical-persistence-v0.9.0', $4::jsonb, $5,
          'upgrade-analysis-idempotency', '2026-08-31T12:00:01Z'
        )`, [runId, caseId, buildIdentitySha, JSON.stringify(command), commandSha256]);
      await client.query(`
        insert into public.documents (
          id, case_id, document_type, storage_path, original_filename, mime_type, size,
          declared_type, content_sha256, processing_status, storage_layout, created_at
        ) values (
          $1::uuid, $2::uuid, 'payslip', $3, 'synthetic-upgrade.pdf',
          'application/pdf', 1024, 'payslip', $4, 'ready', 'immutable_v1',
          '2026-08-31T12:00:02Z'
        )`, [documentId, caseId, `cases/${caseId}/documents/${documentId}/original.pdf`, documentSha256]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  return Object.freeze({
    tenant_id: tenantId,
    case_id: caseId,
    analysis_run_id: runId,
    document_id: documentId,
    command,
    command_sha256: commandSha256,
    document_sha256: documentSha256,
  });
}

async function verifyUpgradeEnrichment(
  connectionUrl: string,
  seeded: Awaited<ReturnType<typeof seedRepresentativeUpgradeState>>,
): Promise<Readonly<{ analysis_run: boolean; document: boolean }>> {
  const pool = postgresPool(connectionUrl, "tivdoc-v091-upgrade-enrichment");
  try {
    const result = await pool.query<{ analysis_run: boolean; document: boolean }>(`
      select
        exists (
          select 1
          from public.analysis_runs run
          where run.id = $1::uuid
            and run.tenant_id = $2
            and run.canonical_case_id = $3
            and run.canonical_analysis_run_id = $1::text
            and run.command_sha256 = $4
            and run.command_payload = $5::jsonb
            and run.case_revision = 2
            and run.completion_payload is null
        ) as analysis_run,
        exists (
          select 1
          from public.documents document
          where document.id = $6::uuid
            and document.tenant_id = $2
            and document.canonical_case_id = $3
            and document.canonical_document_id = $6::text
            and document.content_sha256 = $7
        ) as document`, [
      seeded.analysis_run_id,
      seeded.tenant_id,
      seeded.case_id,
      seeded.command_sha256,
      JSON.stringify(seeded.command),
      seeded.document_id,
      seeded.document_sha256,
    ]);
    const row = result.rows[0];
    if (!row?.analysis_run || !row.document) throw new Error("POSTGRES_UPGRADE_METADATA_ENRICHMENT_FAILED");
    return Object.freeze(row);
  } finally {
    await pool.end();
  }
}

async function proveTerminalHistoryImmutability(
  connectionUrl: string,
  analysisRunId: string,
  tenantId: string,
): Promise<boolean> {
  const pool = postgresPool(connectionUrl, "tivdoc-v091-terminal-history");
  try {
    // Everything here runs on one checked-out client with the tenant declared.
    // The table is tenant-scoped, a transaction-local setting cannot follow a
    // pooled query to the next backend, and once the table forces row level
    // security the owner connection sees nothing without it — at which point
    // the transitions would match no rows and this would fail as a transition
    // failure rather than as the visibility problem it actually is.
    const scoped = await pool.connect();
    try {
      await scoped.query("begin");
      await scoped.query("select set_config($1, $2, true)", ["tivdoc.tenant_id", tenantId]);
      const transitioned = await scoped.query(`
        update public.analysis_runs
           set status = 'running', started_at = transaction_timestamp()
         where id = $1::uuid and status = 'queued'
         returning id`, [analysisRunId]);
      if (transitioned.rowCount !== 1) throw new Error("POSTGRES_UPGRADE_HISTORY_TRANSITION_FAILED");
      const terminal = await scoped.query(`
        update public.analysis_runs
           set status = 'failed', completed_at = transaction_timestamp(),
               error_code = 'synthetic.dynamic_proof', error_stage = 'upgrade_verification'
         where id = $1::uuid and status = 'running'
         returning id`, [analysisRunId]);
      if (terminal.rowCount !== 1) throw new Error("POSTGRES_UPGRADE_HISTORY_TRANSITION_FAILED");

      let rejected = false;
      await scoped.query("savepoint immutability_probe");
      try {
        await scoped.query(`
          update public.analysis_runs
             set completion_payload = '{}'::jsonb
           where id = $1::uuid`, [analysisRunId]);
      } catch (error) {
        rejected = isPostgresError(error) && error.code === "P0001";
      }
      await scoped.query("rollback to savepoint immutability_probe");
      const preserved = await scoped.query<{ immutable: boolean }>(`
        select status = 'failed' and completion_payload is null as immutable
        from public.analysis_runs where id = $1::uuid`, [analysisRunId]);
      await scoped.query("commit");
      return rejected && preserved.rows[0]?.immutable === true;
    } catch (error) {
      await scoped.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      scoped.release();
    }
  } finally {
    await pool.end();
  }
}

async function upgradeState(connectionUrl: string, tenantId: string): Promise<Readonly<{ rows: number; sha256: string }>> {
  const pool = postgresPool(connectionUrl, "tivdoc-v091-upgrade-state");
  try {
    const result = await pool.query<{ rows: string; sha256: string }>(`
      with evidence as (
        select 'case:' || case_id::text || ':' || revision::text || ':' || state_sha256 as token
          from public.engine_case_state where tenant_id = $1
        union all
        select 'run:' || id::text || ':' || status || ':' || input_snapshot_hash
          from public.analysis_runs run
          join public.engine_case_state state on state.case_id = run.case_id
         where state.tenant_id = $1
        union all
        select 'document:' || document.id::text || ':' || document.content_sha256
          from public.documents document
          join public.engine_case_state state on state.case_id = document.case_id
         where state.tenant_id = $1
      )
      select count(*)::text as rows,
             encode(public.digest(string_agg(token, E'\n' order by token), 'sha256'), 'hex') as sha256
      from evidence`, [tenantId]);
    const row = result.rows[0];
    if (!row || !/^\d+$/u.test(row.rows) || !/^[0-9a-f]{64}$/u.test(row.sha256)) {
      throw new Error("POSTGRES_UPGRADE_STATE_INVALID");
    }
    return Object.freeze({ rows: Number(row.rows), sha256: row.sha256 });
  } finally {
    await pool.end();
  }
}

async function proveUpgradedApplicationRoot(input: Readonly<{
  connection_url: string;
  build_identity_sha: string;
  tenant_id: string;
  case_id: string;
  analysis_run_id: string;
}>): Promise<boolean> {
  const driver = NodePostgresConnectionFactory.fromConnectionUrl({ connection_url: input.connection_url });
  try {
    const application = await startCanonicalApplicationPostgres({
      mode: "isolated_postgres",
      execution_boundary: "non_test",
      target: driver.target,
      build_identity_sha: input.build_identity_sha,
    }, { connection_factory: driver });
    if (application.mode !== "isolated_postgres") return false;
    return await application.transaction(input.tenant_id, input.case_id, async (bundle) => {
      const state = await bundle.intake.case_lifecycle.get(bundle.context, {
        tenant_id: input.tenant_id,
        case_id: input.case_id,
      });
      const run = await bundle.analysis.caseAnalysis.getByRunId(input.analysis_run_id);
      return state?.revision === 2 && run?.analysis_run_id === input.analysis_run_id;
    });
  } finally {
    await driver.close();
  }
}

async function injectCanonicalMigrationFailure(input: Readonly<{
  connection_url: string;
  canonical_migration_path: string | undefined;
}>): Promise<Readonly<{ observed: boolean; metadataCount: number }>> {
  if (!input.canonical_migration_path) throw new Error("CANONICAL_MIGRATION_PATH_MISSING");
  const sql = await readFile(input.canonical_migration_path, "utf8");
  const pool = postgresPool(input.connection_url, "tivdoc-v091-controlled-migration-failure");
  let observed = false;
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("select 1 / 0");
      await client.query("commit");
    } catch (error) {
      observed = isPostgresError(error) && error.code === "22012";
      await client.query("rollback");
    } finally {
      client.release();
    }
    return Object.freeze({ observed, metadataCount: await canonicalMetadataCount(input.connection_url) });
  } finally {
    await pool.end();
  }
}

async function canonicalMetadataCount(connectionUrl: string): Promise<number> {
  const pool = postgresPool(connectionUrl, "tivdoc-v091-migration-metadata-count");
  try {
    const present = await pool.query<{ present: boolean }>(
      "select to_regclass('public.engine_schema_metadata') is not null as present",
    );
    if (!present.rows[0]?.present) return 0;
    const result = await pool.query<{ count: string }>(`
      select count(*)::text as count from public.engine_schema_metadata
       where component = 'canonical_postgresql_composition'`);
    const count = result.rows[0]?.count;
    if (count !== "0" && count !== "1") throw new Error("CANONICAL_METADATA_COUNT_INVALID");
    return Number(count);
  } finally {
    await pool.end();
  }
}

function postgresPool(connectionString: string, applicationName: string): Pool {
  return new Pool({ connectionString, application_name: applicationName, ssl: false, max: 2, allowExitOnIdle: true });
}

function isPostgresError(value: unknown): value is Readonly<{ code: string }> {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}
