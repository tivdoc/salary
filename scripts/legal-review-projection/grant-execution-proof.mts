// Wave 1 (§3.8). Proves grant coverage by executing, not by reading catalogs.
//
// Every command is invoked as the role the product path would use, inside a
// transaction that is always rolled back. Only SQLSTATE 42501 counts as a
// failure: a validation refusal such as P0001 means the statement was allowed
// to run and then rejected its arguments, which is exactly the proof wanted.
// A missing GRANT is the one thing that cannot be discovered any other way, and
// it has now shipped twice.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave1";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TENANT = "tenant.synthetic.001";
const SESSION_ID = "session.projection.wave1";
const TOKEN_ID = "token.projection.wave1";

/** Command, executing role, and a call with the right arity. */
const COMMANDS = Object.freeze([
  ["operations", "governance_legal_review_queue_list", "select * from private.governance_legal_review_queue_list($1,$2)", [TENANT, 1]],
  ["operations", "governance_legal_review_action_append", "select * from private.governance_legal_review_action_append($1,$2::jsonb,$3,$4,$5,$6,$7::timestamptz)", [TENANT, "{}", "x", "x", "x", "x", new Date().toISOString()]],
  ["operations", "governance_legal_review_packet_enqueue", "select * from private.governance_legal_review_packet_enqueue($1,$2::jsonb,$3,$4::jsonb,$5,$6,$7::timestamptz)", [TENANT, "{}", 1, "[]", "k", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_legal_review_observation_block_append", "select * from private.governance_legal_review_observation_block_append($1,$2,$3,$4::jsonb,$5,$6::timestamptz)", [TENANT, "PROBE:ONLY", "BYTES_PRESENT_NOT_PARSED", "{}", "0".repeat(64), new Date().toISOString()]],
  ["operations", "governance_legal_review_projection_accounting", "select * from private.governance_legal_review_projection_accounting($1)", [TENANT]],
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
] as const);

const URL_FOR: Readonly<Record<string, string>> = Object.freeze({
  operations: "TIVDOC_OPERATIONS_POSTGRES_URL",
  worker: "TIVDOC_WORKER_POSTGRES_URL",
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
        try {
          await client.query("begin");
          await client.query("select * from private.runtime_context_install($1,$2,$3)",
            [SESSION_ID, TOKEN_ID, `grantproof:${name}`]);
          await client.query(sql, [...params] as unknown[]);
          await client.query("rollback");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          sqlstate = String((error as { code?: string }).code ?? "unknown");
        }
        results.push({ role, command: name, sqlstate, permission_denied: sqlstate === "42501" });
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const denied = results.filter((row) => row.permission_denied === true);
  const receipt = Object.freeze({
    schema_version: "tivdoc-grant-execution-proof-wave1",
    commands_executed: results.length,
    permission_denied: denied.length,
    denied,
    results,
  });
  writeFileSync(path.join(RECEIPT_ROOT, "grant-execution-proof.json"),
    `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`executed=${results.length} permission_denied=${denied.length}`
    + `${denied.length > 0 ? ` ${denied.map((d) => `${d.role}:${d.command}`).join(",")}` : ""}\n`);
  if (denied.length > 0) process.exitCode = 1;
}

await main();
