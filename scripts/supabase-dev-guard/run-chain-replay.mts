// V0.10.10 W2 runner for the byte-pinned migration chain replay.
//
// Loads the ignored DEV env file, satisfies the DEV guard from it, and drives
// `replayMigrationChain` against the isolated DEV project. It writes a receipt
// under output/v0.10.10/supabase/ and never emits a connection string, a
// password or any part of one.
//
// `prepare` asks the migrator role to create its own replay database, so the
// replay starts from an empty schema without dropping anything that already
// exists on the project.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "./dev-credential.mts";
import { replayMigrationChain } from "./chain-replay.mts";
import { TIVDOC_DEV_LABEL } from "./guard.mts";

const RECEIPT = path.join("output", "v0.10.10", "supabase", "chain-replay.json");

function environment(): NodeJS.ProcessEnv {
  const entries = readDevEnvFile();
  const ref = entries.get("TIVDOC_DEV_PROJECT_REF");
  if (!ref) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  return {
    ...process.env,
    SUPABASE_PROJECT_REF: ref,
    SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL,
    TIVDOC_DEV_DATABASE_URL: entries.get("TIVDOC_DEV_DATABASE_URL") ?? "",
  };
}

async function prepare(database: string): Promise<void> {
  const url = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  if (!/^[a-z][a-z0-9_]{4,60}$/u.test(database)) throw new Error("CHAIN_REPLAY_DATABASE_NAME_INVALID");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [database]);
    if (existing.rowCount === 0) await client.query(`create database ${database}`);
    const owner = await client.query(
      "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1", [database],
    );
    process.stdout.write(`prepared ${database} owner=${owner.rows[0]?.owner ?? "?"}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The repository chain assumes a Supabase-provisioned database: migration
 * 202608220001 inserts into `storage.buckets`, which only exists in a project's
 * own default database. A replay database therefore needs that one platform
 * relation stubbed before the chain can apply. It is created here, labelled,
 * and reported separately from the pinned files so the receipt never claims the
 * stub is part of the chain.
 */
async function scaffold(): Promise<void> {
  const url = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    await client.query("create schema if not exists storage");
    await client.query(`create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      owner uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      public boolean not null default false,
      avif_autodetection boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    )`);
    await client.query(
      "comment on schema storage is 'DEV / SYNTHETIC ONLY - platform contract stub for chain replay, not part of the pinned chain'",
    );
    process.stdout.write("scaffolded storage.buckets\n");
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Read-only inventory of everything the replay actually created. */
async function inventory(): Promise<void> {
  const url = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const rows = await client.query(`select
      (select count(*)::int from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema') as schemas,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema') as tables,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and c.relrowsecurity and n.nspname not like 'pg\\_%') as rls_enabled,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and c.relforcerowsecurity and n.nspname not like 'pg\\_%') as rls_forced,
      (select count(*)::int from pg_policy) as policies,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'i' and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema') as indexes,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema') as functions,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not like 'pg\\_%') as security_definer,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname not like 'pg\\_%'
          and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%') as security_definer_pinned,
      (select count(*)::int from pg_trigger where not tgisinternal) as triggers,
      (select count(*)::int from information_schema.role_table_grants
        where grantee in ('anon','authenticated','service_role')) as exposed_grants`);
    writeFileSync(
      path.join("output", "v0.10.10", "supabase", "replay-inventory.json"),
      `${JSON.stringify({ schema_version: "tivdoc-chain-replay-inventory-v0.10.10", ...rows.rows[0] }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`inventory ${JSON.stringify(rows.rows[0])}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function replay(): Promise<void> {
  const receipt = await replayMigrationChain({
    migrations_root: path.join("supabase", "migrations"),
    environment: environment(),
  });
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${receipt.status} applied=${receipt.files_applied}/${receipt.files_discovered}`
    + ` reapply=${receipt.idempotent_reapply}\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === "prepare") await prepare(rest[0] ?? "tivdoc_replay_owned_v01010");
else if (command === "scaffold") await scaffold();
else if (command === "inventory") await inventory();
else if (command === "replay") await replay();
else throw new Error("CHAIN_REPLAY_COMMAND_UNKNOWN");
