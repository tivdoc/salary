// V0.10.4 dynamic PostgreSQL proof for the legal review migration.
//
// The V0.9.1 orchestrator pins its dynamic run to the canonical branch, and
// this work sits on an integration branch, so that provenance guard is left
// exactly as it is. This driver instead composes the same repository-owned
// provisioning primitives — unchanged — to prove the migration chain, this
// migration included, applies to a real ephemeral loopback cluster.
//
// Loopback only, owned temporary directory only, torn down at the end. No
// remote database is contacted and no package is installed.

import { rm } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

import {
  createOwnedDatabase,
  initializeOwnedCluster,
  selectRandomHighLoopbackPort,
  startOwnedCluster,
  stopOwnedCluster,
} from "../canonical-persistence-v091/foundation/local-postgres.mts";
import {
  applyCleanMigrationChain,
  applyCompatibilityBootstrap,
  discoverMigrationChain,
} from "../canonical-persistence-v091/foundation/migrations.mts";
import { resolveDynamicPostgresPaths } from "../canonical-persistence-v091/foundation/paths.mts";
import { inspectPinnedPostgresBinaries } from "../canonical-persistence-v091/foundation/pinned-binaries.mts";
import { createOwnedLocalTarget } from "../canonical-persistence-v091/foundation/safety.mts";

const ROOT = path.resolve(process.cwd());
const MIGRATION = "202609010011_durable_legal_review.sql";

const port = await selectRandomHighLoopbackPort({ minimum: 40_000, maximum: 49_151 });
const target = createOwnedLocalTarget({ port, suffix: `lrproof${Date.now().toString(36)}`.slice(0, 20) });
const paths = resolveDynamicPostgresPaths(ROOT, target);
const binaries = await inspectPinnedPostgresBinaries(paths);

const receipt: Record<string, unknown> = {
  schema_version: "tivdoc-legal-review-postgres-proof-v0.10.4",
  postgres_version: binaries.postgres_version,
  host: target.descriptor.host,
  port,
  database: target.descriptor.database,
};

let started = false;
try {
  await initializeOwnedCluster({ target, paths, binaries });
  await startOwnedCluster({ target, paths, binaries });
  started = true;
  await createOwnedDatabase({ target, paths, binaries });

  const chain = await discoverMigrationChain(paths);
  receipt.migration_count = chain.migration_count;
  receipt.legal_review_migration_present = chain.migrations.some((entry) => entry.name === MIGRATION);

  const bootstrap = await applyCompatibilityBootstrap({ target, paths, binaries });
  const migrations = await applyCleanMigrationChain({ target, paths, binaries, chain });
  receipt.bootstrap_applied = bootstrap.applied_count;
  receipt.migrations_applied = migrations.applied_count;

  const pool = new Pool({
    host: target.descriptor.host,
    port,
    database: target.descriptor.database,
    user: target.username.reveal(),
    password: target.password.reveal(),
    ssl: false,
    max: 1,
    allowExitOnIdle: true,
    application_name: "tivdoc-legal-review-postgres-proof",
  });
  try {
    const server = await pool.query("select current_setting('server_version') as version");
    receipt.server_version = server.rows[0]?.version ?? null;

    const relations = await pool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_catalog.pg_class c
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname like 'governance_legal_review_%'
        order by c.relname`,
    );
    receipt.legal_review_tables = relations.rows.map((row) => row.relname);
    receipt.rls_enabled_and_forced = relations.rows.every(
      (row) => row.relrowsecurity === true && row.relforcerowsecurity === true,
    );

    const policies = await pool.query(
      `select polname from pg_catalog.pg_policy p
         join pg_catalog.pg_class c on c.oid = p.polrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname like 'governance_legal_review_%'
        order by polname`,
    );
    receipt.legal_review_policies = policies.rows.map((row) => row.polname);

    const routines = await pool.query(
      `select p.proname from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'private' and p.proname like 'governance_legal_review_%'
        order by p.proname`,
    );
    receipt.legal_review_functions = routines.rows.map((row) => row.proname);

    // The tenant guard must reject a caller with no verified durable session.
    const guard = await pool.query(
      `select private.governance_legal_review_queue_list($1::text, $2::integer) as entries`,
      ["tenant.unverified", 10],
    ).then(() => "ACCEPTED_UNEXPECTEDLY").catch((error: Error) => error.message.trim());
    receipt.unverified_tenant_rejected = typeof guard === "string" && guard.includes("GOVERNANCE_TENANT_CONTEXT_MISMATCH");
    receipt.unverified_tenant_error = guard;

    const metadata = await pool.query(
      "select schema_version, migration_id from public.engine_schema_metadata where component = $1",
      ["durable_legal_review"],
    );
    receipt.schema_metadata = metadata.rows[0] ?? null;

    const connections = await pool.query(
      "select count(*)::int as total from pg_catalog.pg_stat_activity where datname = $1",
      [target.descriptor.database],
    );
    receipt.connection_count = connections.rows[0]?.total ?? null;
  } finally {
    await pool.end();
  }
  receipt.status = receipt.rls_enabled_and_forced === true
    && receipt.legal_review_migration_present === true
    && receipt.unverified_tenant_rejected === true ? "PASS" : "FAIL";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = error instanceof Error ? error.message : String(error);
} finally {
  if (started) {
    try {
      await stopOwnedCluster({ target, paths, binaries });
      receipt.cluster_stopped = true;
    } catch {
      receipt.cluster_stopped = false;
    }
  }
  try {
    await rm(paths.cluster_root, { recursive: true, force: true });
    receipt.cluster_removed = true;
  } catch {
    receipt.cluster_removed = false;
  }
}

process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "PASS") process.exitCode = 1;
