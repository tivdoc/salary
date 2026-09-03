// Wave 1 (§3.8). Proves grant coverage by executing, not by reading catalogs.
//
// Every command is invoked as the role the product path would use, inside a
// transaction that is always rolled back. Only SQLSTATE 42501 counts as a
// failure: a validation refusal such as P0001 means the statement was allowed
// to run and then rejected its arguments, which is exactly the proof wanted.
// A missing GRANT is the one thing that cannot be discovered any other way, and
// it has now shipped twice.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave1";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TENANT = "tenant.synthetic.001";
const SESSION_ID = "session.projection.wave1";
const TOKEN_ID = "token.projection.wave1";
const IDENTITY_SID = "session.grantproof.identity.wave3";

/** Command, executing role, and a call with the right arity. */
const COMMANDS = Object.freeze([
  ["operations", "governance_legal_review_queue_list", "select * from private.governance_legal_review_queue_list($1,$2)", [TENANT, 1]],
  ["operations", "governance_legal_review_action_append", "select * from private.governance_legal_review_action_append($1,$2::jsonb,$3,$4,$5,$6,$7::timestamptz)", [TENANT, "{}", "x", "x", "x", "x", new Date().toISOString()]],
  ["operations", "governance_legal_review_packet_enqueue", "select * from private.governance_legal_review_packet_enqueue($1,$2::jsonb,$3,$4::jsonb,$5,$6,$7::timestamptz)", [TENANT, "{}", 1, "[]", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_legal_review_observation_block_append", "select * from private.governance_legal_review_observation_block_append($1,$2,$3,$4::jsonb,$5,$6::timestamptz)", [TENANT, "PROBE:ONLY", "BYTES_PRESENT_NOT_PARSED", "{}", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_legal_review_projection_accounting", "select * from private.governance_legal_review_projection_accounting($1)", [TENANT]],
  ["operations", "governance_legal_review_projection_accounting_v2", "select * from private.governance_legal_review_projection_accounting_v2($1)", [TENANT]],
  ["operations", "governance_legal_review_observation_supersession_append", "select private.governance_legal_review_observation_supersession_append($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)", [TENANT, "PROBE:ONLY", "PROBE:PACKET", "0".repeat(64), "0".repeat(64), "probe-parser", "probe-normalizer", false, new Date().toISOString()]],
  ["worker", "governance_legal_review_projection_accounting_v2", "select * from private.governance_legal_review_projection_accounting_v2($1)", [TENANT]],
  ["operations", "governance_legal_observation_import", "select * from private.governance_legal_observation_import($1,$2::jsonb,$3,$4,$5::timestamptz)", [TENANT, "{}", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_parameter_import", "select * from private.governance_parameter_import($1,$2::jsonb,$3,$4,$5::timestamptz)", [TENANT, "{}", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_golden_case_set_import", "select * from private.governance_golden_case_set_import($1,$2::jsonb,$3,$4,$5::timestamptz)", [TENANT, "{}", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_rulespec_import", "select * from private.governance_rulespec_import($1,$2::jsonb,$3,$4,$5::timestamptz)", [TENANT, "{}", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_work_enqueue", "select * from private.governance_work_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::timestamptz)", [TENANT, "a", "b", "c", "d", "e", "f", "g", "h", "i", "{}", "j", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_aggregate_read", "select * from private.governance_aggregate_read($1,$2,$3,$4)", [TENANT, "a", "b", "c"]],
  ["worker", "governance_legal_review_packet_enqueue", "select * from private.governance_legal_review_packet_enqueue($1,$2::jsonb,$3,$4::jsonb,$5,$6,$7::timestamptz)", [TENANT, "{}", 1, "[]", "k", "0".repeat(64), new Date().toISOString()]],
  ["worker", "governance_legal_review_observation_block_append", "select * from private.governance_legal_review_observation_block_append($1,$2,$3,$4::jsonb,$5,$6::timestamptz)", [TENANT, "PROBE:ONLY", "BYTES_PRESENT_NOT_PARSED", "{}", "0".repeat(64), new Date().toISOString()]],
  ["worker", "claim_engine_platform_jobs", "select * from private.claim_engine_platform_jobs($1,$2::timestamptz,$3::interval,$4)", [TENANT, new Date().toISOString(), "1 minute", 1]],
  ["worker", "claim_engine_platform_outbox", "select * from private.claim_engine_platform_outbox($1,$2::timestamptz,$3::interval)", [TENANT, new Date().toISOString(), "1 minute"]],
  // Wave 3 (C1 item 5). The identity boundary lost its tenant parameter, so
  // every one of these calls also proves the new arity is the granted one.
  ["identity", "product_identity_session_read", "select * from private.product_identity_session_read($1)", [IDENTITY_SID]],
  ["identity", "product_identity_session_register", "select * from private.product_identity_session_register($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8::timestamptz)", [IDENTITY_SID, "actor.grantproof", "token.grantproof.wave3", 0, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), "review_org_00001", new Date().toISOString()]],
  ["identity", "product_session_rotate", "select private.product_session_rotate($1,$2,$3,$4::timestamptz)", [IDENTITY_SID, "token.grantproof.rotated", 0, new Date().toISOString()]],
  ["identity", "product_session_revoke", "select private.product_session_revoke($1,$2::timestamptz)", [IDENTITY_SID, new Date().toISOString()]],
] as const);

const URL_FOR: Readonly<Record<string, string>> = Object.freeze({
  operations: "TIVDOC_OPERATIONS_POSTGRES_URL",
  worker: "TIVDOC_WORKER_POSTGRES_URL",
  identity: "TIVDOC_IDENTITY_POSTGRES_URL",
});

// The identity boundary is the one path that runs *before* a runtime context
// exists — that is what it is for — so it establishes the tenant the way the
// runtime does at that point, through the session setting the definer functions
// resolve. Installing a runtime context here would prove the wrong thing.
const ESTABLISH_CONTEXT: Readonly<Record<string, Readonly<{ sql: string; params: readonly unknown[] }>>> =
  Object.freeze({
    operations: { sql: "select * from private.runtime_context_install($1,$2,$3)", params: [SESSION_ID, TOKEN_ID, "grantproof"] },
    worker: { sql: "select * from private.runtime_context_install($1,$2,$3)", params: [SESSION_ID, TOKEN_ID, "grantproof"] },
    identity: { sql: "select set_config('tivdoc.tenant_id', $1, true)", params: [TENANT] },
  });

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const { default: pg } = await import("pg");
  const results: Record<string, unknown>[] = [];

  for (const role of Object.keys(URL_FOR)) {
    const connectionString = env.get(URL_FOR[role] as string);
    if (!connectionString) throw new Error(`GRANT_PROOF_ENV_MISSING:${role}`);
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
    await client.connect();
    try {
      for (const [commandRole, name, sql, params] of COMMANDS) {
        if (commandRole !== role) continue;
        let sqlstate = "none";
        let contextFailure: string | null = null;
        try {
          const context = ESTABLISH_CONTEXT[role] as Readonly<{ sql: string; params: readonly unknown[] }>;
          await client.query("begin");
          // Establishing the context is setup, not the thing under test. It
          // raises 42501 of its own when the fixture session has lapsed, and
          // counting that as the command being denied turned one stale session
          // into eighteen false permission failures.
          try {
            await client.query(context.sql, [...context.params]);
          } catch (error) {
            contextFailure = `${(error as { code?: string }).code ?? "unknown"}:`
              + `${String((error as Error).message).slice(0, 60)}`;
            throw error;
          }
          await client.query(sql, [...params] as unknown[]);
          await client.query("rollback");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          sqlstate = String((error as { code?: string }).code ?? "unknown");
        }
        results.push({
          role, command: name, sqlstate, context_failure: contextFailure,
          permission_denied: sqlstate === "42501" && contextFailure === null,
        });
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const denied = results.filter((row) => row.permission_denied === true);
  const contextFailures = results.filter((row) => row.context_failure !== null);
  const receipt = Object.freeze({
    schema_version: "tivdoc-grant-execution-proof-wave1",
    commands_executed: results.length,
    permission_denied: denied.length,
    context_failures: contextFailures.length,
    context_failure_detail: [...new Set(contextFailures.map((row) => String(row.context_failure)))],
    denied,
    results,
  });
  writeFileSync(path.join(RECEIPT_ROOT, "grant-execution-proof.json"),
    `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`executed=${results.length} permission_denied=${denied.length}`
    + ` context_failures=${contextFailures.length}`
    + `${denied.length > 0 ? ` ${denied.map((d) => `${d.role}:${d.command}`).join(",")}` : ""}\n`);
  if (denied.length > 0 || contextFailures.length > 0) process.exitCode = 1;
}

await main();
