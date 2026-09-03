// Pool A. What FORCE row level security would actually change, table by table,
// measured rather than reasoned about.
//
// Thirty tenant-scoped tables have RLS enabled and not forced. All thirty are
// owned by `tivdoc_dev_migrator`, so today the owner connection bypasses their
// policies entirely; FORCE is what makes those policies apply to it.
//
// The premise this started from was that a table whose only policies name
// `service_role` would refuse the migrator once forced. That is wrong, and the
// correction is the whole reason this instrument exists: `tivdoc_dev_migrator`
// inherits `service_role` (`pg_auth_members.inherit_option` true) and RLS role
// matching uses `has_privs_of_role`, so `tivdoc_service_tenant_scope` binds it.
// It does NOT inherit the four runtime roles, so the verified-tenant policies
// never admit it. The one gate that decides the outcome is therefore
// `tenant_id = current_setting('tivdoc.tenant_id')`, and whether a table breaks
// turns entirely on whether its owner-connection writer declares that setting.
//
// Every measurement happens inside a transaction that is rolled back, so no
// table's setting changes here and nothing is written.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");

const CANDIDATES_SQL = `
  select n.nspname as schema, c.relname as name,
         r.rolname as owner, c.relforcerowsecurity as forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles r on r.oid = c.relowner
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
                       and a.attnum > 0 and not a.attisdropped
   where c.relkind = 'r' and n.nspname in ('public','private') and c.relrowsecurity
   order by 1, 2`;

type Row = Readonly<{ schema: string; name: string; owner: string; forced: boolean }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const connectionString = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!connectionString) throw new Error("RLS_FORCE_MATRIX_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await client.connect();

  const results: Record<string, unknown>[] = [];
  try {
    const principal = (await client.query("select current_user as role")).rows[0] as { role: string };
    const candidates = (await client.query(CANDIDATES_SQL)).rows as Row[];

    for (const table of candidates) {
      const qname = `${table.schema}.${table.name}`;
      if (table.forced) {
        results.push({ table: qname, verdict: "already_forced" });
        continue;
      }
      await client.query("begin");
      try {
        // A tenant that actually has rows, so visibility is measurable at all.
        const sample = await client.query(
          `select tenant_id, count(*)::int as n from ${qname}
            group by tenant_id order by 2 desc limit 1`);
        const tenant = sample.rows[0]?.tenant_id as string | undefined;
        const rows = (sample.rows[0]?.n as number | undefined) ?? 0;
        if (tenant === undefined || rows === 0) {
          results.push({ table: qname, verdict: "inconclusive_empty", rows: 0 });
          continue;
        }
        await client.query(`alter table ${qname} force row level security`);
        await client.query("select set_config('tivdoc.tenant_id', '', true)");
        const withoutGuc = await client.query(`select count(*)::int as n from ${qname}`);
        await client.query("select set_config('tivdoc.tenant_id', $1, true)", [tenant]);
        const withGuc = await client.query(`select count(*)::int as n from ${qname}`);
        const blind = (withoutGuc.rows[0].n as number) === 0;
        const restored = (withGuc.rows[0].n as number) >= rows;
        results.push({
          table: qname, verdict: blind && restored ? "gate_engages_guc_restores"
            : blind ? "gate_engages_guc_does_not_restore"
              : "force_changes_nothing",
          sample_tenant_rows: rows,
          visible_without_guc: withoutGuc.rows[0].n,
          visible_with_guc: withGuc.rows[0].n,
        });
      } catch (error) {
        results.push({
          table: qname, verdict: "probe_failed",
          detail: `${(error as { code?: string }).code ?? ""} ${String((error as Error).message).slice(0, 120)}`,
        });
      } finally {
        await client.query("rollback").catch(() => undefined);
      }
    }

    const stillUnforced = (await client.query(
      `select count(*)::int as n from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
                            and a.attnum > 0 and not a.attisdropped
        where c.relkind = 'r' and n.nspname in ('public','private')
          and c.relrowsecurity and not c.relforcerowsecurity`)).rows[0].n as number;

    const tally: Record<string, number> = {};
    for (const row of results) tally[String(row.verdict)] = (tally[String(row.verdict)] ?? 0) + 1;
    writeFileSync(path.join(RECEIPT_ROOT, "rls-force-matrix.json"), `${JSON.stringify({
      schema_version: "tivdoc-rls-force-matrix-poola",
      principal: principal.role, candidates: candidates.length,
      unforced_after_probe: stillUnforced, tally, results,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`principal=${principal.role} tenant_scoped=${candidates.length}`
      + ` unforced=${stillUnforced} ${JSON.stringify(tally)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
