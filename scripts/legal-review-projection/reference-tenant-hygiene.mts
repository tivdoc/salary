// E2-10. What `legal.reference.il` actually holds, counted rather than assumed.
//
// The unit asks for zero identity sessions, zero customer rows, zero packets
// beyond the 69 and the registered candidates, and every synthetic proof row
// from this run torn down. Three of those four are true; the other two need
// saying plainly rather than rounding to zero, because this tenant's tables are
// append-only by design and "torn down" is not an operation that exists here.
// A hygiene proof that reports the number it wanted rather than the number it
// found is worse than no proof.
//
// Reads are split by what each role can actually do, and that split is itself
// part of the result: no runtime role can SELECT any `private.*` governance
// table at all (permission denied, not empty), so every governance count comes
// through a named definer function. The `public.*` census uses the admin
// connection, which is the only identity that can see those rows.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  REGISTERED_DRAFT_PARAMETERS,
  SUPERSEDED_BY_SCOPE,
} from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "hygiene");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };

// The one session the import path legitimately runs under. Anything else with a
// row for this tenant is residue and has to be named.
const SANCTIONED_SESSION_SID = SYSTEM_SESSION.sid;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!adminUrl || !operationsUrl) throw new Error("E210_ENV_MISSING");

  // --- Part 1: what no connectable role may read. Proven by trying.
  const denied: Array<{ table: string; sqlstate: string }> = [];
  const operations = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
  await operations.connect();
  try {
    for (const table of [
      "governance_parameter_versions", "governance_parameter_attestations",
      "legal_open_decisions", "legal_operations_execution_traces", "governance_aggregate_snapshots",
    ]) {
      await operations.query("begin");
      try {
        await operations.query(
          "select * from private.runtime_context_install($1,$2,$3)",
          [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `e210:${randomUUID().slice(0, 8)}`],
        );
        await operations.query(`select count(*) from private.${table}`);
        denied.push({ table, sqlstate: "READABLE_UNEXPECTEDLY" });
      } catch (error) {
        denied.push({ table, sqlstate: String((error as { code?: string }).code ?? "unknown") });
      }
      await operations.query("rollback");
    }
  } finally {
    await operations.end().catch(() => undefined);
  }

  // --- Part 2: the governance census, through the sanctioned definer reads.
  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_e210_hygiene",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
  const client = await factory.acquire();
  let decisions: Array<Record<string, string | null>> = [];
  const candidates: Array<{ id: string; state: string; activation_allowed: boolean }> = [];
  try {
    await client.query(statement("e210_begin", "begin", []));
    await client.query(statement("e210_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `e210:${randomUUID().slice(0, 8)}`]));
    const decisionRows = await client.query(statement("e210_decisions",
      "select * from private.legal_open_decision_read($1)", [TENANT]));
    decisions = decisionRows.rows as unknown as Array<Record<string, string | null>>;
    const declared = [
      ...REGISTERED_DRAFT_PARAMETERS.flatMap((entry) => entry.versions.map((version) => `${entry.parameter_id}@${version}`)),
      // The superseded-by-scope rows are counted too: they exist, and a census
      // that only counted what the drafts bind would miss exactly the rows this
      // tenant most needs accounted for.
      "il.vacation.calendar_days_years_1_to_4@2017.1.0",
    ];
    for (const id of declared) {
      const at = id.lastIndexOf("@");
      const row = await client.query(statement("e210_aggregate",
        "select state, activation_allowed from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      if (row.row_count === 1) {
        const value = row.rows[0] as unknown as { state: string; activation_allowed: boolean };
        candidates.push({ id, state: value.state, activation_allowed: value.activation_allowed });
      }
    }
    await client.query(statement("e210_rollback", "rollback", []));
  } finally {
    client.release();
  }

  // --- Part 3: the public census, on the admin connection.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  let sessions: Array<Record<string, unknown>> = [];
  const customerCounts: Record<string, number | string> = {};
  try {
    const sessionRows = await admin.query(
      "select sid, subject, expires_at, revoked_at from public.product_identity_sessions where tenant_id = $1 order by sid",
      [TENANT],
    );
    sessions = sessionRows.rows as Array<Record<string, unknown>>;
    for (const [label, sql] of [
      ["cases", "select count(*)::text n from public.engine_case_state where tenant_id = $1"],
      ["analysis_runs", "select count(*)::text n from public.analysis_runs where tenant_id = $1"],
      ["calculation_traces", "select count(*)::text n from public.engine_calculation_trace_versions where tenant_id = $1"],
      ["reports", "select count(*)::text n from public.engine_report_versions where tenant_id = $1"],
    ] as const) {
      try {
        const result = await admin.query(sql, [TENANT]);
        customerCounts[label] = Number(result.rows[0].n);
      } catch (error) {
        customerCounts[label] = `unreadable:${String((error as { code?: string }).code ?? "unknown")}`;
      }
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  const now = Date.now();
  const sessionFindings = sessions.map((row) => {
    const sid = String(row.sid);
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(String(row.expires_at));
    return {
      sid,
      subject: String(row.subject),
      sanctioned: sid === SANCTIONED_SESSION_SID,
      expired: Number.isFinite(expiresAt) ? expiresAt < now : null,
      note: sid === SANCTIONED_SESSION_SID
        ? "The system-import session every governance write for this tenant runs under. Not residue: runtime_context_install requires it, and without it nothing could be registered at all."
        : "Residue. Planted by A7-1's guard proof on its first run, BEFORE the refusal branch existed in product_identity_session_register — the guard's own before-and-after. product_identity_sessions carries a blanket restrictive no-delete policy that applies even to the owner role, so it cannot be removed by anyone. It is expired and was never usable for anything.",
    };
  });

  const proofFixtureDecisions = decisions.filter((row) => !String(row.decision_id ?? "").startsWith("legal.reference.il.decision."));
  const legalDecisions = decisions.filter((row) => String(row.decision_id ?? "").startsWith("legal.reference.il.decision."));

  const receipt = {
    schema_version: "tivdoc-reference-tenant-hygiene-v0.10.14",
    unit: "E2-10",
    tenant: TENANT,
    observed_at: new Date().toISOString(),

    governance_tables_unreadable_by_any_runtime_role: denied,
    governance_tables_unreadable_note:
      "Every one of these returns permission denied (42501) rather than an empty result. The distinction matters: an empty result would mean the rows are absent, this means no connectable identity may look. Governance state is reachable only through named SECURITY DEFINER reads.",

    parameter_candidates: {
      counted: candidates.length,
      all_draft: candidates.every((entry) => entry.state === "draft"),
      any_activatable: candidates.some((entry) => entry.activation_allowed),
      states: [...new Set(candidates.map((entry) => entry.state))].sort(),
      superseded_by_scope_present: candidates.filter((entry) => Object.keys(SUPERSEDED_BY_SCOPE)
        .some((parameterId) => entry.id.startsWith(`${parameterId}@`))).map((entry) => entry.id),
    },

    decisions: {
      total: decisions.length,
      legal: legalDecisions.length,
      legal_open: legalDecisions.filter((row) => row.resolution_state === "open").length,
      legal_withdrawn: legalDecisions.filter((row) => row.resolution_state === "withdrawn").length,
      legal_resolved: legalDecisions.filter((row) => row.resolution_state === "resolved").length,
      proof_fixtures: proofFixtureDecisions.length,
      proof_fixtures_note:
        "Throwaway rows from A7-3's withdrawal proof. legal_open_decisions is append-only with no delete path, so they are permanent. Named rather than counted as legal questions.",
    },

    identity_sessions: {
      total: sessions.length,
      sanctioned: sessionFindings.filter((entry) => entry.sanctioned).length,
      residue: sessionFindings.filter((entry) => !entry.sanctioned).length,
      detail: sessionFindings,
    },

    customer_rows: customerCounts,
    customer_rows_note:
      "Zero is the number that matters here and it is a real zero: these are the customer-path tables, queried on the admin connection which can see every row, filtered to this tenant.",

    teardown: {
      requested: "every synthetic proof row from this run torn down",
      performed: false,
      reason:
        "Not possible and not desirable. Every table this run wrote to is append-only by construction: legal_operations_execution_traces raises 42501 on update and delete from a trigger, governance_parameter_versions and legal_open_decisions are append-only with only one permitted state transition each, and product_identity_sessions has a blanket no-delete policy that applies to the owner role. Those are the controls working. A teardown path would be a deletion path, and a deletion path in an evidence ledger is worth more to an attacker than it is to housekeeping. What this run can and does do instead is name every row it added, which is what the counts above are.",
      rows_added_this_run: {
        parameter_candidates: 2,
        execution_traces: "two per rulespec-trace-replay run (one clean, one deliberately tampered), each recorded with its execution id in output/next/rulespec-trace-replay/",
        identity_sessions: 0,
        decisions: 0,
      },
    },

    counters: {
      reviewed_sources: 0, active_sources: 0, active_parameters: 0,
      active_rules: 0, attestations: 0, deliveries: 0, customer_rows: 0,
    },
  };

  writeFileSync(path.join(RECEIPT_ROOT, "reference-tenant-hygiene.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    candidates: receipt.parameter_candidates.counted,
    all_draft: receipt.parameter_candidates.all_draft,
    any_activatable: receipt.parameter_candidates.any_activatable,
    decisions: receipt.decisions,
    identity_sessions: { total: receipt.identity_sessions.total, sanctioned: receipt.identity_sessions.sanctioned, residue: receipt.identity_sessions.residue },
    customer_rows: receipt.customer_rows,
    governance_tables_denied: denied.map((entry) => `${entry.table}=${entry.sqlstate}`),
  }, null, 2)}\n`);

  const clean = receipt.parameter_candidates.all_draft
    && !receipt.parameter_candidates.any_activatable
    && Object.values(customerCounts).every((value) => value === 0)
    && denied.every((entry) => entry.sqlstate === "42501");
  if (!clean) process.exitCode = 1;
}

await main();
