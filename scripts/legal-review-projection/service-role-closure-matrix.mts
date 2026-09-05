// E3. Does `tivdoc_service_tenant_scope` widen anything?
//
// Wave 3 concluded it does not, on the premise that the policy is `to
// service_role` and `service_role` holds no privilege on the 33 tables it sits
// on. That premise is void if some role inherits `service_role` and does hold
// privilege — RLS role matching uses `has_privs_of_role`, not role identity, so
// an inheriting role is bound by every policy granted to its parent.
//
// The policy's test is `tenant_id = current_setting('tivdoc.tenant_id')`, a
// value any session may set. So for every role in the inheritance closure that
// holds DML on a table, that table is reachable at any tenant the caller names.
//
// This computes the closure transitively rather than one level, computes the
// effective privilege per role per table with `has_table_privilege` rather than
// reading grants, and reports the exposure that actually exists.

import "../production-refusal.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const POLICY = "tivdoc_service_tenant_scope";

/** Roles that inherit `service_role`, directly or through another role. */
const CLOSURE_SQL = `
  with recursive closure as (
    select m.member as oid, 0 as depth, m.inherit_option as inherits
      from pg_auth_members m
      join pg_roles parent on parent.oid = m.roleid
     where parent.rolname = 'service_role'
    union all
    select m.member, closure.depth + 1, m.inherit_option and closure.inherits
      from pg_auth_members m
      join closure on closure.oid = m.roleid
     where closure.depth < 8
  )
  select r.rolname, min(closure.depth) as depth, bool_or(closure.inherits) as inherits,
         r.rolbypassrls, r.rolsuper, r.rolcanlogin
    from closure join pg_roles r on r.oid = closure.oid
   group by 1, 4, 5, 6 order by 2, 1`;

/** Tables the policy sits on, and its expression. */
const TABLES_SQL = `
  select n.nspname || '.' || c.relname as qname,
         c.relrowsecurity as rls, c.relforcerowsecurity as forced,
         pg_get_expr(p.polqual, p.polrelid) as using_expr,
         p.polpermissive as permissive
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where p.polname = $1
   order by 1`;

type Role = Readonly<{
  rolname: string; depth: number; inherits: boolean;
  rolbypassrls: boolean; rolsuper: boolean; rolcanlogin: boolean;
}>;
type Table = Readonly<{ qname: string; rls: boolean; forced: boolean; using_expr: string }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const connectionString = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!connectionString) throw new Error("SERVICE_ROLE_CLOSURE_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await client.connect();

  try {
    const roles = (await client.query(CLOSURE_SQL)).rows as Role[];
    const tables = (await client.query(TABLES_SQL, [POLICY])).rows as Table[];

    // Effective privilege, asked of PostgreSQL rather than reassembled from
    // grant rows: `has_table_privilege` already accounts for inheritance.
    const exposure: Record<string, unknown>[] = [];
    for (const role of roles) {
      for (const table of tables) {
        const privileges = (await client.query(
          `select has_table_privilege($1, $2, 'select') as can_select,
                  has_table_privilege($1, $2, 'insert') as can_insert,
                  has_table_privilege($1, $2, 'update') as can_update,
                  has_table_privilege($1, $2, 'delete') as can_delete`,
          [role.rolname, table.qname])).rows[0] as Record<string, boolean>;
        const held = Object.entries(privileges)
          .filter(([, value]) => value).map(([key]) => key.replace("can_", ""));
        if (held.length === 0) continue;
        exposure.push({
          role: role.rolname, inherits_service_role: role.inherits,
          bypasses_rls: role.rolbypassrls || role.rolsuper,
          can_login: role.rolcanlogin,
          table: table.qname, forced: table.forced, privileges: held,
        });
      }
    }

    // A role only reaches a table *through this policy* when the policy binds
    // it (it inherits) and the policy is what admits it — which requires the
    // table to force RLS, or the role not to own it. A role that bypasses RLS
    // never needed the policy at all, and one that cannot log in cannot open a
    // session to set the GUC.
    const widening = exposure.filter((row) =>
      row.inherits_service_role === true && row.bypasses_rls === false && row.can_login === true);

    const receipt = {
      schema_version: "tivdoc-service-role-closure-e3",
      policy: POLICY,
      tables: tables.length,
      forced_tables: tables.filter((table) => table.forced).length,
      closure: roles,
      inheriting_roles: roles.filter((role) => role.inherits).map((role) => role.rolname),
      exposure_rows: exposure.length,
      widening_rows: widening.length,
      widening_roles: [...new Set(widening.map((row) => row.role))],
      widening_tables: [...new Set(widening.map((row) => row.table))].sort(),
      exposure,
    };
    writeFileSync(path.join(RECEIPT_ROOT, "service-role-closure.json"),
      `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    process.stdout.write(`policy_tables=${tables.length} forced=${receipt.forced_tables}`
      + ` closure=${roles.length} inheriting=${receipt.inheriting_roles.length}`
      + ` exposure_rows=${exposure.length} widening_rows=${widening.length}`
      + ` widening_roles=${JSON.stringify(receipt.widening_roles)}\n`);
    for (const role of roles) {
      process.stdout.write(`  ${role.rolname} depth=${role.depth} inherits=${role.inherits}`
        + ` bypassrls=${role.rolbypassrls || role.rolsuper} login=${role.rolcanlogin}\n`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
