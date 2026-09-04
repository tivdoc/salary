// Addendum 7 A7-1. Proves the three reference-tenant guards by execution
// against DEV, as the actual runtime roles the guards are about — not as
// the admin/migrator connection.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TENANT } from "./pool-p-parameter-import.mts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

// A session row is immutable and cannot be deleted (product_identity_sessions
// has a blanket restrictive no-delete policy, by design — this table is an
// append-only ledger even for the owner role). A per-run unique sid means a
// re-run never collides with a prior run's residue.
const PROBE_SID = `session.guard-proof.${randomUUID().slice(0, 12)}`;

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};
const sqlstateOf = (error: unknown) => (error as { code?: string })?.code ?? "unknown";

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const identityUrl = env.get("TIVDOC_IDENTITY_POSTGRES_URL");
  const webUrl = env.get("TIVDOC_WEB_POSTGRES_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  if (!identityUrl || !webUrl || !operationsUrl || !adminUrl) throw new Error("GUARD_PROOF_ENV_MISSING");
  const { default: pg } = await import("pg");

  // --- Guard 1: the tenant id is a named constant, not a literal.
  const literalHits: string[] = [];
  const { execSync } = await import("node:child_process");
  try {
    const grepOut = execSync(
      // This proof script's own name would otherwise match its comments and
      // the exclusion logic's string literals below — excluded by name, not
      // by trying to out-clever grep about which of its own lines are code.
      `grep -rn "legal.reference.il" scripts/legal-review-projection/*.mts docs/tivdoc-development-state.md `
      + `| grep -v "legal-reference-tenant-guards.mts"`,
      { encoding: "utf8" },
    );
    for (const line of grepOut.split("\n")) {
      if (!line.trim()) continue;
      // The only permitted literal is the constant's own definition and its
      // doc-comment mentions; anything constructing a tenant value some OTHER
      // way (not via `TENANT` or a template literal built from it) is a hit.
      if (line.includes("const TENANT = \"legal.reference.il\"")) continue;
      if (line.includes("//")) continue; // comments explaining the constant
      if (line.includes("docs/tivdoc-development-state.md")) continue; // prose, not code
      if (/\$\{TENANT\}/.test(line)) continue; // derived from the constant
      literalHits.push(line);
    }
  } catch { /* grep exits 1 on no match, which would be the passing case */ }
  record("guard1_tenant_id_single_named_constant", literalHits.length === 0,
    literalHits.length === 0 ? "no stray literal" : literalHits.join(" | ").slice(0, 300));

  // --- Guard 2: product_identity_session_register refuses the reference tenant.
  const identity = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
  await identity.connect();
  try {
    await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    let refused = false;
    let sqlstate = "none";
    try {
      await identity.query(
        `select * from private.product_identity_session_register($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8::timestamptz)`,
        [PROBE_SID, "system_import", "token.guard-proof",
          0, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString(),
          null, new Date().toISOString()],
      );
    } catch (error) {
      refused = true;
      sqlstate = sqlstateOf(error);
    }
    record("guard2_register_refuses_reference_tenant",
      refused && sqlstate === "42501", `refused=${refused} sqlstate=${sqlstate}`);

  } finally {
    await identity.end().catch(() => undefined);
  }

  // Confirm-by-execution: no row exists for that sid under the reference
  // tenant after the refused call (the effect, not just the exception).
  // tivdoc_identity_runtime has no raw SELECT on the table (execute-only,
  // by design), so this observation is made as the table owner.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    const planted = await admin.query(
      `select 1 from public.product_identity_sessions where tenant_id = $1 and sid = $2`,
      [TENANT, PROBE_SID],
    );
    record("guard2_no_row_was_planted", planted.rowCount === 0, `rows=${planted.rowCount}`);
  } finally {
    await admin.end().catch(() => undefined);
  }

  // --- Guard 3a: tivdoc_web_runtime reads nothing operative for any of this
  // session's (draft, activation_allowed=false) parameters.
  const web = new pg.Client({ connectionString: webUrl, connectionTimeoutMillis: 20_000 });
  await web.connect();
  try {
    await web.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const readBack = await web.query(
      `select * from private.governance_parameter_operative_read($1,$2,$3)`,
      [TENANT, "il.minimum_wage.monthly", "2026.1.0"],
    );
    record("guard3_operative_read_refuses_draft_row", readBack.rowCount === 0, `rows=${readBack.rowCount}`);

    // --- Guard 3b: tivdoc_web_runtime cannot write — no grant on any
    // governance mutation function at all.
    let writeRefused = false;
    let writeSqlstate = "none";
    try {
      await web.query(
        `select * from private.governance_parameter_import($1,$2::jsonb,$3,$4,$5::timestamptz)`,
        [TENANT, "{}", "guard-proof-should-refuse", "0".repeat(64), new Date().toISOString()],
      );
    } catch (error) {
      writeRefused = true;
      writeSqlstate = sqlstateOf(error);
    }
    record("guard3_web_runtime_cannot_write",
      writeRefused && writeSqlstate === "42501", `refused=${writeRefused} sqlstate=${writeSqlstate}`);
  } finally {
    await web.end().catch(() => undefined);
  }

  // --- Guard 3, other direction: tivdoc_operations_runtime (the role that
  // DOES import) has no grant on the operative-read function either — the
  // read path is tivdoc_web_runtime's alone.
  const operations = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
  await operations.connect();
  try {
    await operations.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    let opsReadRefused = false;
    let opsReadSqlstate = "none";
    try {
      await operations.query(
        `select * from private.governance_parameter_operative_read($1,$2,$3)`,
        [TENANT, "il.minimum_wage.monthly", "2026.1.0"],
      );
    } catch (error) {
      opsReadRefused = true;
      opsReadSqlstate = sqlstateOf(error);
    }
    record("guard3_operations_runtime_has_no_operative_read_grant",
      opsReadRefused && opsReadSqlstate === "42501", `refused=${opsReadRefused} sqlstate=${opsReadSqlstate}`);
  } finally {
    await operations.end().catch(() => undefined);
  }

  writeFileSync(path.join(RECEIPT_ROOT, "legal-reference-tenant-guards.json"), `${JSON.stringify({ results }, null, 2)}\n`);
  const failed = results.filter((r) => r.outcome === "fail");
  process.stdout.write(`${JSON.stringify({ total: results.length, failed: failed.length })}\n`);
  for (const r of results) process.stdout.write(`${r.outcome === "pass" ? "PASS" : "FAIL"} ${r.case} — ${r.observed}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
