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

import { buildConnectionUrl, readDevEnvFile, writeDevEnvFile } from "./dev-credential.mts";
import { replayMigrationChain } from "./chain-replay.mts";
import { TIVDOC_DEV_LABEL } from "./guard.mts";

/** Receipts belong to the wave that produced them; never overwrite an older one. */
const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v0.10.11";
const RECEIPT = path.join("output", WAVE, "supabase", "chain-replay.json");

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
        where grantee in ('anon','authenticated','service_role')) as exposed_grants,
      -- The legal review surface the operations journey depends on.
      (select string_agg(c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity
                         || ':' || pg_get_userbyid(c.relowner), ', ' order by c.relname)
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r'
          and c.relname like 'governance_legal_review%') as legal_review_tables,
      (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relname like 'governance_legal_review%') as legal_review_policies`);
    writeFileSync(
      path.join("output", WAVE, "supabase", "replay-inventory.json"),
      `${JSON.stringify({ schema_version: "tivdoc-chain-replay-inventory-v0.10.10", ...rows.rows[0] }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`inventory ${JSON.stringify(rows.rows[0])}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Two statement families in `202609010005` cannot execute on this managed
 * platform by any reachable role:
 *
 * - `alter role ... nosuperuser ...` — changing the SUPERUSER attribute needs a
 *   superuser, and Supabase exposes none. `postgres` is `rolsuper=false` and
 *   returns 42501 on exactly that attribute while accepting the other six.
 * - `revoke tivdoc_governance_owner from anon, authenticated, service_role, ...`
 *   — `supautils` refuses any modification of the reserved `anon`,
 *   `authenticated` and `service_role` roles (supautils.c:583, 42501).
 *
 * Both are defensive: the same migration creates those roles NOSUPERUSER, and
 * the reserved roles were never granted the governance owner. So the file is
 * applied from its own bytes minus those lines, every dropped line is recorded
 * verbatim in the receipt, and the intended end state is asserted afterwards
 * rather than assumed.
 */
const COMPENSATIONS = Object.freeze([
  Object.freeze({
    file: "202609010005_governance_runtime_security.sql",
    omit_patterns: Object.freeze([
      "^alter role tivdoc_[a-z_]+ nologin nosuperuser nocreatedb nocreaterole"
      + " noinherit noreplication nobypassrls;$",
      "^revoke tivdoc_governance_owner from anon, authenticated, service_role,",
      "^revoke service_role from tivdoc_governance_owner,",
    ]),
    // `alter table ... owner to tivdoc_governance_owner` requires the incoming
    // owner to hold CREATE on the table's schema. A cluster superuser bypasses
    // that check, which is how the chain passes locally; no Supabase role can.
    // Granting the function-owner role CREATE on the schema it is about to own
    // every table in is the narrow, explicit form of the same permission, and
    // migration 202609010009 already grants it USAGE on that schema.
    pre_statements: Object.freeze([
      "grant usage, create on schema private to tivdoc_governance_owner",
    ]),
    reason: "managed platform refuses SUPERUSER attribute changes, reserved-role modification,"
      + " and ownership transfer without CREATE on the target schema",
    sqlstate: "42501",
  }),
]);

const GOVERNANCE_ROLES = Object.freeze([
  "tivdoc_governance_owner",
  "tivdoc_operations_runtime",
  "tivdoc_worker_runtime",
  "tivdoc_web_runtime",
  "tivdoc_identity_runtime",
]);

/** Proves the compensated statements' intended end state actually holds. */
async function assertRolePostconditions(): Promise<Readonly<Record<string, unknown>>> {
  const url = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const result = await client.query(
      `select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole,
              rolinherit, rolreplication, rolbypassrls
         from pg_roles where rolname = any($1::text[]) order by rolname`,
      [[...GOVERNANCE_ROLES]],
    );
    const rows = result.rows as Readonly<Record<string, boolean | string>>[];
    const attributesSatisfied = rows.length === GOVERNANCE_ROLES.length && rows.every((row) =>
      row.rolsuper === false && row.rolcanlogin === false && row.rolcreatedb === false
      && row.rolcreaterole === false && row.rolinherit === false
      && row.rolreplication === false && row.rolbypassrls === false);
    // The omitted revoke was defensive; prove the membership it guarded against
    // does not exist rather than assuming the revoke was unnecessary.
    const leaked = await client.query(
      `select r.rolname || ' -> ' || g.rolname as membership from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles g on g.oid = m.member
        where (r.rolname = 'tivdoc_governance_owner' and g.rolname = any($1::text[]))
           or (r.rolname = 'service_role' and g.rolname = any($2::text[]))`,
      [["anon", "authenticated", "service_role", "tivdoc_identity_runtime",
        "tivdoc_operations_runtime", "tivdoc_worker_runtime", "tivdoc_web_runtime"],
      ["tivdoc_governance_owner", "tivdoc_identity_runtime",
        "tivdoc_operations_runtime", "tivdoc_worker_runtime", "tivdoc_web_runtime"]],
    );
    return Object.freeze({
      schema_version: "tivdoc-chain-compensation-postconditions-v0.10.11",
      expected_roles: GOVERNANCE_ROLES.length,
      observed_roles: rows.length,
      role_attributes_satisfied: attributesSatisfied,
      forbidden_memberships: leaked.rows.map((row) => String(row.membership)),
      intended_end_state_satisfied: attributesSatisfied && leaked.rowCount === 0,
      roles: rows,
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function replay(): Promise<void> {
  const receipt = await replayMigrationChain({
    migrations_root: path.join("supabase", "migrations"),
    environment: environment(),
    compensations: COMPENSATIONS,
    schema_create_grant_role: "tivdoc_governance_owner",
  });
  const postconditions = receipt.status === "PASS" ? await assertRolePostconditions() : null;
  writeFileSync(RECEIPT, `${JSON.stringify({ ...receipt, compensation_postconditions: postconditions }, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${receipt.status} applied=${receipt.files_applied} compensated=${receipt.files_compensated ?? 0}`
    + `/${receipt.files_discovered} reapply=${receipt.idempotent_reapply}`
    + ` role=${receipt.executing_role ?? "?"} postconditions=${postconditions?.intended_end_state_satisfied ?? "n/a"}\n`,
  );
}

/** prepare + retarget + scaffold, so one clean replay run is one command. */
async function bootstrap(database: string): Promise<void> {
  await prepare(database);
  const entries = readDevEnvFile();
  const current = entries.get("TIVDOC_DEV_DATABASE_URL");
  const password = entries.get("TIVDOC_DEV_PASSWORD__tivdoc_dev_migrator");
  const ref = entries.get("TIVDOC_DEV_PROJECT_REF");
  if (!current || !password || !ref) throw new Error("CHAIN_REPLAY_DEV_ENV_MISSING");
  const parsed = new URL(current);
  entries.set("TIVDOC_DEV_DATABASE_URL", buildConnectionUrl({
    role: "tivdoc_dev_migrator",
    password,
    host: parsed.hostname,
    port: Number(parsed.port),
    database,
    pooler_tenant: entries.get("TIVDOC_DEV_DB_POOLER_TENANT") === "none" ? null : ref,
  }));
  writeDevEnvFile(entries);
  await scaffold();
}

const [command, ...rest] = process.argv.slice(2);
if (command === "bootstrap") await bootstrap(rest[0] as string);
else if (command === "prepare") await prepare(rest[0] ?? "tivdoc_replay_owned_v01010");
else if (command === "scaffold") await scaffold();
else if (command === "inventory") await inventory();
else if (command === "replay") await replay();
else throw new Error("CHAIN_REPLAY_COMMAND_UNKNOWN");
