// Wave 3 (C2). The SECURITY DEFINER surface, gated or not, computed at DEV.
//
// The question is not "does this function mention the verified tenant" — that
// is a shape, and shapes produced three wrong counts before this script settled
// it. A definer function is gated when a forged tenant argument cannot reach
// another tenant's rows, which is true if either
//
//   * the body resolves the tenant through `runtime_verified_tenant()`, or
//   * every tenant-scoped table it touches carries a verified-tenant policy
//     that applies to *the identity the function runs as*.
//
// Both halves of that second clause matter. FORCE row level security only
// changes anything where the function's owner is also the table's owner. And a
// policy binds only the roles it names: `tivdoc_service_tenant_scope` is keyed
// to a caller-settable GUC and sits on 33 tables, but it is granted `to
// service_role`, a role holding no privilege on any of them, so it widens
// nothing for a function owned by `tivdoc_governance_owner`.
//
// Two sites are ungated and are meant to be. `runtime_context_install` and
// `product_identity_session_read` both have to reach a session row *before* any
// tenant is verified — that is what they are for — so a verified-tenant gate
// there would deadlock the identity layer against itself. They are named here
// so that a third one cannot appear without this failing.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave3";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");

/** Ungated by construction, because they run before a tenant exists. */
const BOOTSTRAP_SITES = Object.freeze([
  "private.product_identity_session_read",
  "private.runtime_context_install",
]);

/** The surface may not grow silently; a new definer function updates this. */
const EXPECTED_TOTAL = 88;

// Definer functions a Supabase reserved role may still execute. These eight are
// reached exactly that way today — `supabase.rpc` from src/app/api/cases/status
// /route.ts, src/lib/ga4-server.ts and src/lib/verify-payment.ts — so the grant
// is load-bearing and removing it would break the running product. Narrowing
// that path means moving those callers first. Everything else was revoked by
// 202609020005; a ninth name appearing here is a new hole, not a new feature.
const RESERVED_EXECUTE_ALLOWED = Object.freeze([
  "public.claim_salary_ga4_purchase",
  "public.claim_salary_meta_purchase",
  "public.claim_salary_payment_completed",
  "public.complete_salary_ga4_purchase",
  "public.complete_salary_meta_purchase",
  "public.release_salary_ga4_purchase",
  "public.release_salary_meta_purchase",
  "public.verify_salary_payment",
]);

type PolicyRow = Readonly<{
  name: string; permissive: boolean; roles: readonly string[];
  verified_tenant: boolean; caller_settable: boolean;
}>;
type TableRow = Readonly<{
  qname: string; owner: string; rls: boolean; forced: boolean;
  tenant_scoped: boolean; policies: readonly PolicyRow[];
}>;

const FUNCTION_SQL = `
  select n.nspname as schema, p.proname as name,
         pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
         r.rolname as owner,
         r.rolbypassrls or r.rolsuper as owner_escapes_rls,
         p.prorettype = 'pg_catalog.trigger'::regtype as is_trigger,
         (select string_agg(g.rolname, ',' order by g.rolname)
            from pg_roles g
           where g.rolname in ('anon','authenticated','service_role')
             and has_function_privilege(g.rolname, p.oid, 'execute')) as reserved_execute,
         pg_get_functiondef(p.oid) as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
   where p.prosecdef and n.nspname in ('public','private')
   order by 1, 2`;

const TABLE_SQL = `
  select n.nspname || '.' || c.relname as qname, r.rolname as owner,
         c.relrowsecurity as rls, c.relforcerowsecurity as forced,
         exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'tenant_id'
                    and a.attnum > 0 and not a.attisdropped) as tenant_scoped,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'name', pol.polname,
                     'permissive', pol.polpermissive,
                     'roles', (select coalesce(array_agg(coalesce(pr.rolname, 'public')), array[]::text[])
                                 from unnest(pol.polroles) as u(role_oid)
                                 left join pg_roles pr on pr.oid = u.role_oid),
                     'verified_tenant', pg_get_expr(pol.polqual, pol.polrelid) like '%runtime_verified_tenant()%',
                     'caller_settable', pg_get_expr(pol.polqual, pol.polrelid) like '%current_setting(''tivdoc.%'))
                   from pg_policy pol where pol.polrelid = c.oid), '[]'::jsonb) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
   where c.relkind = 'r' and n.nspname in ('public','private')`;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const connectionString = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!connectionString) throw new Error("SECDEF_MATRIX_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await client.connect();
  let functions: readonly Record<string, never>[];
  let tableRows: readonly TableRow[];
  try {
    functions = (await client.query(FUNCTION_SQL)).rows;
    tableRows = (await client.query(TABLE_SQL)).rows as TableRow[];
  } finally {
    await client.end().catch(() => undefined);
  }
  const tables = new Map(tableRows.map((row) => [row.qname, row]));

  const results = functions.map((raw) => {
    const fn = raw as unknown as Readonly<{
      schema: string; name: string; args: string; owner: string;
      reserved_execute: string | null;
      owner_escapes_rls: boolean; is_trigger: boolean; body: string;
    }>;
    const referenced = [...new Set([...fn.body.matchAll(/\b(public|private)\.([a-z0-9_]+)/gu)]
      .map((match) => `${match[1]}.${match[2]}`))].filter((qname) => tables.has(qname));
    const tenantTables = referenced.filter((qname) => (tables.get(qname) as TableRow).tenant_scoped);
    const applies = (policy: PolicyRow) =>
      policy.roles.includes("public") || policy.roles.includes(fn.owner);
    const ownerBypass = tenantTables.filter((qname) => {
      const table = tables.get(qname) as TableRow;
      return fn.owner_escapes_rls || (table.owner === fn.owner && !table.forced);
    });
    const noRealGate = tenantTables.filter((qname) => {
      const table = tables.get(qname) as TableRow;
      return !table.rls || !table.policies.some((policy) => applies(policy) && policy.verified_tenant);
    });
    const callerSettable = tenantTables.filter((qname) => (tables.get(qname) as TableRow).policies
      .some((policy) => applies(policy) && policy.permissive && policy.caller_settable));
    const bodyGate = /runtime_verified_tenant\(\)|product_identity_session_resolved_tenant\(\)/u.test(fn.body);

    let verdict: string;
    if (fn.is_trigger) verdict = "trigger_row_scoped";
    else if (tenantTables.length === 0) verdict = "no_tenant_scoped_table";
    else if (bodyGate) verdict = "gated_in_body";
    else if (ownerBypass.length > 0) verdict = "ungated_owner_bypasses_rls";
    else if (noRealGate.length > 0) verdict = "ungated_no_verified_tenant_policy";
    else if (callerSettable.length > 0) verdict = "ungated_caller_settable_policy";
    else verdict = "gated_by_policy";

    return {
      site: `${fn.schema}.${fn.name}`, signature: `${fn.schema}.${fn.name}(${fn.args})`,
      owner: fn.owner, reserved_execute: fn.reserved_execute, verdict, tenant_tables: tenantTables,
      owner_bypass_tables: ownerBypass, no_gate_tables: noRealGate,
      caller_settable_tables: callerSettable,
    };
  });

  const tally: Record<string, number> = {};
  for (const row of results) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
  const ungated = results.filter((row) => row.verdict.startsWith("ungated"));
  const unexpected = ungated.filter((row) => !BOOTSTRAP_SITES.includes(row.site));
  const missingBootstrap = BOOTSTRAP_SITES
    .filter((site) => !ungated.some((row) => row.site === site));

  const failures: string[] = [];
  if (results.length !== EXPECTED_TOTAL) {
    failures.push(`total ${results.length} != ${EXPECTED_TOTAL}`);
  }
  for (const row of unexpected) failures.push(`ungated ${row.signature} (${row.verdict})`);
  // A bootstrap site that stops being ungated is not a failure of the schema,
  // but it does mean this allowlist is stale and is claiming more than it holds.
  for (const site of missingBootstrap) failures.push(`allowlist stale: ${site} is now gated`);

  const reserved = results.filter((row) => row.reserved_execute !== null);
  for (const row of reserved) {
    if (!RESERVED_EXECUTE_ALLOWED.includes(row.site)) {
      failures.push(`reserved execute ${row.signature} to ${row.reserved_execute}`);
    }
  }
  for (const site of RESERVED_EXECUTE_ALLOWED) {
    if (!reserved.some((row) => row.site === site)) {
      failures.push(`allowlist stale: ${site} no longer holds a reserved grant`);
    }
  }

  writeFileSync(path.join(RECEIPT_ROOT, "secdef-surface-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-secdef-surface-matrix-wave3",
    total: results.length, tally,
    ungated: ungated.map((row) => row.signature),
    accepted_bootstrap: [...BOOTSTRAP_SITES],
    reserved_execute: reserved.map((row) => `${row.signature} -> ${row.reserved_execute}`),
    accepted_reserved_execute: [...RESERVED_EXECUTE_ALLOWED],
    failures, results,
  }, null, 2)}\n`, "utf8");

  process.stdout.write(`secdef=${results.length} ${JSON.stringify(tally)}`
    + ` ungated=${ungated.length} unexpected=${unexpected.length} reserved_execute=${reserved.length}`
    + `${failures.length > 0 ? ` failures=${failures.join("; ")}` : ""}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
