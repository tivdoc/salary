// E3-7's replay half, in its own process. It is handed one execution id and
// nothing else: the rule, the inputs and the trace all come back out of the
// database, and the computation is redone from the persisted inputs rather
// than compared with itself.
//
//   node --experimental-strip-types scripts/legal-review-projection/sensitivity-trace-replay.mts <execution_id>
import { randomUUID } from "node:crypto";
import { executeRuleSpec } from "../../src/engine/legal-operations/rulespec.ts";
import { SENSITIVITY_SPECS } from "../../src/engine/legal-quality/sensitivity-rulespecs.ts";
import { canonicalSha256, canonicalStringify } from "../../src/engine/rule-runtime/canonical.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const executionId = process.argv[2];
if (!executionId) throw new Error("E37_REPLAY_EXECUTION_ID_REQUIRED");

const env = readDevEnvFile();
const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
if (!url) throw new Error("E37_REPLAY_ENV_MISSING");
const parsed = new URL(url);
const factory = NodePostgresConnectionFactory.fromConnectionUrl({
  connection_url: url, max_connections: 2, connection_timeout_ms: 20_000,
  application_name: "tivdoc_e37_replay",
  remote_dev_target: {
    host: parsed.hostname, port: Number(parsed.port),
    database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
  },
});

const client = await factory.acquire();
let row: Record<string, unknown>;
try {
  await client.query(statement("e37r_begin", "begin", []));
  await client.query(statement("e37r_context", "select * from private.runtime_context_install($1,$2,$3)",
    [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `e37r:${randomUUID().slice(0, 8)}`]));
  const read = await client.query(statement("e37r_read",
    "select * from private.legal_operations_execution_trace_read($1,$2)", [TENANT, executionId]));
  if (read.row_count !== 1) throw new Error("E37_REPLAY_ROW_NOT_FOUND");
  row = read.rows[0] as Record<string, unknown>;
  await client.query(statement("e37r_rollback", "rollback", []));
} finally {
  client.release();
}

const stored = row.execution_trace as Record<string, unknown>;
const inputs = row.execution_inputs as { facts: unknown[]; parameters: unknown[] };
const entry = SENSITIVITY_SPECS.find((candidate) => candidate.spec.rule_spec_id === row.rule_spec_id);
if (!entry) throw new Error("E37_REPLAY_RULE_NOT_FOUND");
if (entry.spec.content_sha256 !== row.rule_content_sha256) throw new Error("E37_REPLAY_RULE_CONTENT_DRIFT");

let recomputed: Record<string, unknown> | null = null;
let recomputationError: string | null = null;
try {
  const execution = executeRuleSpec({ rule: entry.spec, facts: inputs.facts as never, parameters: inputs.parameters as never });
  recomputed = JSON.parse(JSON.stringify({ trace: execution.trace, output: execution.output },
    (_key, value) => typeof value === "bigint" ? `bigint:${value}` : value)) as Record<string, unknown>;
} catch (error) {
  recomputationError = String((error as Error).message ?? "unknown").slice(0, 200);
}

const recomputedSha = recomputed === null ? null : canonicalSha256(recomputed);
const byteIdentical = recomputed !== null && canonicalStringify(recomputed) === canonicalStringify(stored);
const witnessIntact = row.trace_witness_sha256 === row.live_trace_witness_sha256;
const verdict = {
  execution_id: executionId,
  byte_identical: byteIdentical,
  recomputation_error: recomputationError,
  caller_hash_matches: recomputedSha === row.trace_sha256,
  database_witness_intact: witnessIntact,
  operative: row.operative,
  accepted: byteIdentical && recomputedSha === row.trace_sha256 && witnessIntact && row.operative === false,
};
process.stdout.write(`E37_REPLAY_VERDICT ${JSON.stringify(verdict)}\n`);
if (!verdict.accepted) process.exitCode = 3;
