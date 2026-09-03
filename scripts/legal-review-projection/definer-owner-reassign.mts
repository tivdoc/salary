// Pool B. Reassign a definer function's owner, with the same behaviour proven
// before and after.
//
// C1 is the standing evidence that this is not cosmetic: giving the identity
// functions an explicit owner moved the authority for their writes to a role
// holding only SELECT and UPDATE, and registration started failing with a bare
// `permission denied for table`. So each function is executed as its real
// caller, reassigned, and executed again; if the second result differs from the
// first, that function alone is reverted.
//
// This unit takes the four pure refusal triggers. They raise and never write,
// so ownership cannot change what they do — and the proof is exact rather than
// approximate, because the observable is a specific SQLSTATE and message from a
// mutation the trigger exists to forbid. The `enforce_*_history` triggers are
// deliberately not here: they compare rows rather than refusing outright, and
// proving those needs a fixture per trigger rather than one forbidden write.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TARGET_OWNER = "tivdoc_governance_owner";

/**
 * Each entry: the trigger function, and a mutation it must refuse. The probe
 * runs inside a savepoint that is always released back, so nothing is written
 * even when the refusal does not fire.
 */
const PROBES = Object.freeze([
  Object.freeze({
    fn: "private.reject_engine_append_only_mutation()",
    name: "reject_engine_append_only_mutation",
    sql: "update public.engine_case_lifecycle_revisions set event_kind = event_kind",
    expect: "append-only",
  }),
  Object.freeze({
    fn: "private.product_forbid_delete()",
    name: "product_forbid_delete",
    sql: "delete from public.product_case_owners where true",
    expect: "",
  }),
  Object.freeze({
    fn: "private.product_forbid_privacy_mutation()",
    name: "product_forbid_privacy_mutation",
    sql: "update public.product_privacy_request_versions set tenant_id = tenant_id",
    expect: "",
  }),
  Object.freeze({
    fn: "private.controlled_import_forbid_mutation()",
    name: "controlled_import_forbid_mutation",
    sql: "update private.controlled_import_audit_events set event_kind = event_kind",
    expect: "",
  }),
  // The history guards compare rows rather than refusing outright, so their
  // bodies are not unconditional raises and a probe that does not fire is not
  // evidence of anything. They are listed so the harness says so out loud: on an
  // empty table each comes back `reverted_probe_vacuous` and its owner is left
  // alone, which is the correct outcome and not a failure to make green.
  Object.freeze({
    fn: "private.enforce_engine_analysis_run_history()",
    name: "enforce_engine_analysis_run_history",
    sql: "update public.analysis_runs set status = status",
    expect: "",
  }),
  Object.freeze({
    fn: "private.enforce_analysis_job_history()",
    name: "enforce_analysis_job_history",
    sql: "update public.analysis_jobs set status = status",
    expect: "",
  }),
  Object.freeze({
    fn: "private.enforce_case_confirmation_history()",
    name: "enforce_case_confirmation_history",
    sql: "update public.case_confirmations set status = status",
    expect: "",
  }),
  Object.freeze({
    fn: "private.enforce_case_conversation_history()",
    name: "enforce_case_conversation_history",
    sql: "update public.case_conversations set tenant_id = tenant_id",
    expect: "",
  }),
  Object.freeze({
    fn: "private.enforce_document_extraction_history()",
    name: "enforce_document_extraction_history",
    sql: "update public.document_extractions set tenant_id = tenant_id",
    expect: "",
  }),
  Object.freeze({
    fn: "private.enforce_engine_case_scope()",
    name: "enforce_engine_case_scope",
    sql: "update public.case_messages set tenant_id = tenant_id",
    expect: "",
  }),
]);

/**
 * Non-trigger definers the harness will not touch, each with the reason. A
 * SECURITY DEFINER function runs with its OWNER's table privileges, and
 * `tivdoc_governance_owner` holds none — not SELECT, not INSERT, not UPDATE,
 * not DELETE — on any table these bodies write. Reassigning any of them would
 * fail exactly as identity registration failed in Wave 3, and the "correct the
 * grant" step that D4 asks for first would mean granting governance_owner DML
 * on the customer `payments` and `cases` tables, or on the controlled-import
 * ledger. The definer surface matrix measures the benefit of the reassignment
 * as nil: no site is ungated by ownership, and the migrator is neither
 * superuser nor BYPASSRLS. A widening of a governance role into customer
 * payment tables for no measured gain is recorded, not done.
 */
const NOT_REASSIGNED: Readonly<Record<string, string>> = Object.freeze({
  "private.append_controlled_import_audit": "internally_called_only: PERFORMed by the five controlled-import definers; governance_owner holds no privilege on controlled_import_audit_events",
  "private.claim_controlled_import_recovery": "open_grant_would_widen: governance_owner holds nothing on controlled_import_requests",
  "private.controlled_import_publish": "open_grant_would_widen: governance_owner holds nothing on controlled_import_requests, controlled_import_publication_markers, controlled_import_artifacts",
  "private.controlled_import_reject": "open_grant_would_widen: governance_owner holds nothing on controlled_import_requests",
  "private.controlled_import_reserve": "open_grant_would_widen: governance_owner holds nothing on controlled_import_requests",
  "private.controlled_import_stage_exact_bytes": "open_grant_would_widen: governance_owner holds nothing on controlled_import_requests, controlled_import_artifacts",
  "private.open_controlled_import_published_bytes": "open_grant_would_widen: governance_owner holds nothing on the three controlled-import tables",
  "public.claim_salary_ga4_purchase": "open_grant_would_widen: governance_owner holds nothing on payments, cases",
  "public.claim_salary_meta_purchase": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.claim_salary_payment_completed": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.complete_salary_ga4_purchase": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.complete_salary_meta_purchase": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.release_salary_ga4_purchase": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.release_salary_meta_purchase": "open_grant_would_widen: governance_owner holds nothing on payments",
  "public.verify_salary_payment": "open_grant_would_widen: governance_owner holds nothing on payments, cases",
});

type Client = Readonly<{ query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> }>;

async function refusal(client: Client, sql: string): Promise<string> {
  await client.query("savepoint probe");
  try {
    await client.query(sql);
    return "no_refusal";
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    return `${code}:${String((error as Error).message).slice(0, 80)}`;
  } finally {
    await client.query("rollback to savepoint probe");
  }
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const connectionString = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!connectionString) throw new Error("DEFINER_REASSIGN_ENV_MISSING");
  const { default: pg } = await import("pg");
  const raw = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await raw.connect();
  const client = raw as unknown as Client;

  const results: Record<string, unknown>[] = [];
  try {
    for (const probe of PROBES) {
      await client.query("begin");
      let outcome = "unknown";
      let before = "";
      let after = "";
      let ownerBefore = "";
      let unconditionalRaise = false;
      try {
        const meta = (await client.query(
          `select r.rolname, pg_get_functiondef(p.oid) as definition from pg_proc p
             join pg_roles r on r.oid = p.proowner
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname || '.' || p.proname || '()' = $1`, [probe.fn],
        )).rows[0] ?? {};
        ownerBefore = String(meta.rolname ?? "absent");
        // A body that only raises cannot behave differently under a different
        // owner, because it never touches a table. Recording that separately
        // keeps a vacuous probe from reading as a behavioural proof.
        const body = String(meta.definition ?? "").split("$function$")[1] ?? "";
        unconditionalRaise = /^\s*begin\s+raise exception[^;]*;\s*end;\s*$/u.test(body);
        // Declaring a tenant so a forced table does not refuse the probe for
        // the wrong reason: what is being measured is the trigger, not RLS.
        await client.query("select set_config('tivdoc.tenant_id', $1, true)",
          ["tenant:synthetic:definer-probe"]);
        before = await refusal(client, probe.sql);
        if (ownerBefore === TARGET_OWNER) {
          outcome = "already_owned";
        } else {
          await client.query(`alter function ${probe.fn} owner to ${TARGET_OWNER}`);
          after = await refusal(client, probe.sql);
          outcome = before !== after ? "reverted_behaviour_changed"
            : before === "no_refusal"
              ? (unconditionalRaise ? "reassigned_probe_vacuous_body_only_raises" : "reverted_probe_vacuous")
              : "reassigned";
        }
        if (outcome === "reassigned" || outcome === "reassigned_probe_vacuous_body_only_raises") {
          await client.query("commit");
        }
        else await client.query("rollback");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        outcome = "failed";
        after = `${(error as { code?: string }).code ?? ""} ${String((error as Error).message).slice(0, 120)}`;
      }
      results.push({
        function: probe.name, owner_before: ownerBefore, outcome,
        body_is_unconditional_raise: unconditionalRaise,
        refusal_before: before, refusal_after: after,
      });
    }

    const owners = await client.query(
      `select count(*)::int as n from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_roles r on r.oid = p.proowner
        where p.prosecdef and n.nspname in ('public','private')
          and r.rolname <> $1`, [TARGET_OWNER]);
    const remaining = owners.rows[0].n as number;

    const notReassigned = Object.entries(NOT_REASSIGNED).map(([fn, reason]) => ({ function: fn, outcome: "not_reassigned", reason }));
    writeFileSync(path.join(RECEIPT_ROOT, "definer-owner-reassign.json"), `${JSON.stringify({
      schema_version: "tivdoc-definer-owner-reassign-poolb",
      target_owner: TARGET_OWNER, attempted: results.length,
      not_reassigned_with_reason: notReassigned.length,
      pool_accounted: results.length + notReassigned.length,
      not_reassigned: notReassigned,
      reassigned: results.filter((row) => String(row.outcome).startsWith("reassigned")).length,
      definer_functions_not_owned_by_target: remaining,
      results,
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`attempted=${results.length}`
      + ` reassigned=${results.filter((row) => String(row.outcome).startsWith("reassigned")).length}`
      + ` remaining_other_owner=${remaining}\n`);
    for (const row of results) {
      process.stdout.write(`  ${row.function} ${row.outcome} before=${row.refusal_before} after=${row.refusal_after}\n`);
    }
    if (results.some((row) => String(row.outcome) === "failed"
      || String(row.outcome).startsWith("reverted"))) {
      process.exitCode = 1;
    }
  } finally {
    await raw.end().catch(() => undefined);
  }
}

await main();
