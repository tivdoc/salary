// R-14. A synthetic rule execution persists its trace durably on DEV, and a
// FRESH Node process replays it from the database — not from memory, not from
// a file. Then one persisted input is altered and the replay is required to
// detect the mismatch and refuse.
//
// The replay is a real second process, spawned with execFileSync, sharing
// nothing with this one but the database. That is the whole point: a replay
// that ran in-process could pass on a value still sitting in a module-level
// map, and would prove nothing about durability.
//
//   node --experimental-strip-types scripts/legal-review-projection/rulespec-trace-replay.mts
//   node --experimental-strip-types scripts/legal-review-projection/rulespec-trace-replay.mts --replay <execution_id>
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeRuleSpec } from "../../src/engine/legal-operations/rulespec.ts";
import { SYNTHETIC_SEVEN_TOPIC_FIXTURES } from "../../src/engine/legal-operations/synthetic-fixtures.ts";
import { canonicalSha256, canonicalStringify } from "../../src/engine/rule-runtime/canonical.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "rulespec-trace-replay");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

// BigInt is all over the rule runtime's values. JSON cannot carry it, so the
// wire form is explicit and lossless in both directions — never Number(), which
// is the one conversion the money path forbids.
type Wire = { readonly ref_id: string; readonly value: Record<string, unknown> };
function toWire(entry: { ref_id: string; value: Record<string, unknown> }): Wire {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(entry.value)) value[key] = typeof raw === "bigint" ? `bigint:${raw}` : raw;
  return { ref_id: entry.ref_id, value };
}
function fromWire(entry: Wire): { ref_id: string; value: Record<string, unknown> } {
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(entry.value)) {
    value[key] = typeof raw === "string" && raw.startsWith("bigint:") ? BigInt(raw.slice(7)) : raw;
  }
  return { ref_id: entry.ref_id, value };
}
function traceToWire(execution: { trace: readonly unknown[]; output: unknown }) {
  return JSON.parse(JSON.stringify(
    { trace: execution.trace, output: execution.output },
    (_key, value) => typeof value === "bigint" ? `bigint:${value}` : value,
  )) as Record<string, unknown>;
}

function connect(url: string, env: Map<string, string>, applicationName: string) {
  const parsed = new URL(url);
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000, application_name: applicationName,
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });
}

async function withTransaction<T>(
  factory: ReturnType<typeof connect>, label: string, work: (client: import("pg").Client) => Promise<T>,
): Promise<T> {
  const client = await factory.acquire();
  try {
    await client.query(statement(`${label}_begin`, "begin", []));
    await client.query(statement(`${label}_context`, "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `${label}:${randomUUID().slice(0, 8)}`]));
    const value = await work(client);
    await client.query(statement(`${label}_commit`, "commit", []));
    return value;
  } catch (error) {
    await client.query(statement(`${label}_rollback`, "rollback", [])).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// The replay half. Runs in its own process. It knows an execution id and a
// connection string, and nothing else — every value it compares comes back out
// of the database.
// ---------------------------------------------------------------------------
async function replay(executionId: string): Promise<void> {
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("R14_REPLAY_ENV_MISSING");
  const factory = connect(url, env, "tivdoc_r14_replay");
  const row = await withTransaction(factory, "r14_replay", async (client) => {
    const read = await client.query(statement("r14_read",
      "select * from private.legal_operations_execution_trace_read($1,$2)", [TENANT, executionId]));
    if (read.row_count !== 1) throw new Error("R14_REPLAY_ROW_NOT_FOUND");
    return read.rows[0] as Record<string, string | boolean | Record<string, unknown>>;
  });

  const stored = row.execution_trace as Record<string, unknown>;
  const inputs = row.execution_inputs as { facts: Wire[]; parameters: Wire[] };
  const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES.find((entry) => entry.rule.rule_spec_id === row.rule_spec_id);
  if (!fixture) throw new Error("R14_REPLAY_RULE_NOT_FOUND");
  if (fixture.rule.content_sha256 !== row.rule_content_sha256) throw new Error("R14_REPLAY_RULE_CONTENT_DRIFT");

  // Recompute from the PERSISTED inputs. If a stored input was altered, the
  // recomputed trace differs from the stored one and this refuses. An altered
  // input can also make the rule itself refuse to run — a changed unit, a value
  // out of bounds — and that is a detection too, not a crash, so it is caught
  // and reported as one rather than allowed to kill the process with a stack
  // trace that says nothing about what was wrong.
  let recomputed: Record<string, unknown> | null = null;
  let recomputationError: string | null = null;
  try {
    recomputed = traceToWire(executeRuleSpec({
      rule: fixture.rule,
      facts: inputs.facts.map(fromWire) as never,
      parameters: inputs.parameters.map(fromWire) as never,
    }));
  } catch (error) {
    recomputationError = String((error as Error).message ?? "unknown").slice(0, 200);
  }
  const recomputedSha = recomputed === null ? null : canonicalSha256(recomputed);
  const storedSha = canonicalSha256(stored);
  // Byte-identical in the canonical form, which is this codebase's own notion
  // of trace identity everywhere else. Comparing raw JSON text would be
  // comparing Postgres's jsonb key ordering rather than the trace — jsonb
  // reorders keys on storage, so two identical traces can differ textually
  // after a round trip, while two different traces still cannot become equal.
  const byteIdentical = recomputed !== null && canonicalStringify(recomputed) === canonicalStringify(stored);
  const witnessIntact = row.trace_witness_sha256 === row.live_trace_witness_sha256;

  const verdict = {
    execution_id: executionId,
    byte_identical: byteIdentical,
    recomputation_error: recomputationError,
    recomputed_trace_sha256: recomputedSha,
    stored_trace_sha256: row.trace_sha256,
    caller_hash_matches: recomputedSha === row.trace_sha256,
    stored_blob_hash_matches: storedSha === row.trace_sha256,
    database_witness_intact: witnessIntact,
    operative: row.operative,
    accepted: byteIdentical && recomputedSha === row.trace_sha256 && witnessIntact,
  };
  process.stdout.write(`R14_REPLAY_VERDICT ${JSON.stringify(verdict)}\n`);
  if (!verdict.accepted) {
    process.stdout.write("R14_REPLAY_REFUSED\n");
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// The persist half, plus the tamper case.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("R14_PROOF_ENV_MISSING");
  const factory = connect(url, env, "tivdoc_r14_persist");

  const fixture = SYNTHETIC_SEVEN_TOPIC_FIXTURES[0];
  const execution = executeRuleSpec({ rule: fixture.rule, facts: fixture.facts, parameters: fixture.parameters });
  const traceWire = traceToWire(execution);
  const inputsWire = {
    facts: fixture.facts.map((entry) => toWire(entry as never)),
    parameters: fixture.parameters.map((entry) => toWire(entry as never)),
  };
  const traceSha = canonicalSha256(traceWire);
  const runSuffix = randomUUID().slice(0, 12);
  const executionId = `r14.execution.${runSuffix}`;
  const snapshotSha = canonicalSha256(inputsWire);

  const appendPayload = (id: string, inputs: unknown) => ({
    execution_id: id,
    topic: fixture.topic,
    rule_spec_id: fixture.rule.rule_spec_id,
    rule_spec_version: fixture.rule.rule_spec_version,
    rule_content_sha256: fixture.rule.content_sha256,
    snapshot_sha256: snapshotSha,
    execution_inputs: inputs,
    execution_trace: traceWire,
    trace_sha256: traceSha,
    result_sha256: canonicalSha256({ output: traceWire.output }),
  });

  const append = async (id: string, inputs: unknown, key: string) => withTransaction(factory, "r14_append", (client) =>
    client.query(statement("r14_append_call",
      "select * from private.legal_operations_execution_trace_append($1,$2::jsonb,$3,$4,$5::timestamptz)",
      [TENANT, JSON.stringify(appendPayload(id, inputs)), key, sha256(`${key}:${traceSha}`), new Date().toISOString()])));

  const sqlstateOf = (error: unknown): string => {
    const direct = (error as { sqlstate?: string | null }).sqlstate;
    if (direct) return direct;
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
      const code = (cause as { code?: string }).code;
      if (code && /^[0-9A-Z]{5}$/u.test(code)) return code;
    }
    return "unknown";
  };

  // --- Case 1: the trace persists.
  const appended = await append(executionId, inputsWire, `r14.append.${runSuffix}`);
  record("execution_trace_persists", appended.rows[0]?.state === "draft" && appended.rows[0]?.idempotent_replay === false,
    `state=${appended.rows[0]?.state} replay=${appended.rows[0]?.idempotent_replay}`);

  // --- Case 2: appending the same command again is an idempotent replay, not a duplicate row.
  const again = await append(executionId, inputsWire, `r14.append.${runSuffix}`);
  record("append_is_idempotent", again.rows[0]?.idempotent_replay === true,
    `replay=${again.rows[0]?.idempotent_replay}`);

  // --- Case 3: a FRESH process replays it from the database, byte-identical.
  const runReplay = (id: string) => {
    try {
      const stdout = execFileSync(process.execPath, [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types",
        "scripts/legal-review-projection/rulespec-trace-replay.mts", "--replay", id,
      ], { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? -1, stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };
  const clean = runReplay(executionId);
  const cleanVerdict = /R14_REPLAY_VERDICT (\{.*\})/u.exec(clean.stdout)?.[1];
  const cleanParsed = cleanVerdict ? JSON.parse(cleanVerdict) as Record<string, unknown> : null;
  record("fresh_process_replay_is_byte_identical",
    clean.code === 0 && cleanParsed?.accepted === true && cleanParsed?.byte_identical === true,
    `exit=${clean.code} accepted=${cleanParsed?.accepted} byte_identical=${cleanParsed?.byte_identical}`);
  record("replayed_row_is_never_operative", cleanParsed?.operative === false, `operative=${String(cleanParsed?.operative)}`);

  // --- Case 4: the row is immutable. No update, no delete, by anyone.
  let updateState = "unexpectedly_succeeded";
  try {
    await withTransaction(factory, "r14_update", (client) => client.query(statement("r14_update_attempt",
      "update private.legal_operations_execution_traces set result_sha256 = $1 where tenant_id = $2 and execution_id = $3",
      [sha256("tampered"), TENANT, executionId])));
  } catch (error) { updateState = sqlstateOf(error); }
  record("persisted_trace_cannot_be_updated", updateState === "42501", `sqlstate=${updateState}`);

  let deleteState = "unexpectedly_succeeded";
  try {
    await withTransaction(factory, "r14_delete", (client) => client.query(statement("r14_delete_attempt",
      "delete from private.legal_operations_execution_traces where tenant_id = $1 and execution_id = $2",
      [TENANT, executionId])));
  } catch (error) { deleteState = sqlstateOf(error); }
  record("persisted_trace_cannot_be_deleted", deleteState === "42501", `sqlstate=${deleteState}`);

  // --- Case 5: the mutation. One persisted input is altered while the trace and
  // its hash are kept exactly as they were. Because the row is immutable by
  // design, the tamper is expressed as a second row rather than an edit — which
  // is the same thing from the replayer's point of view and does not require
  // weakening the table to demonstrate.
  const tamperedId = `r14.tampered.${runSuffix}`;
  // Increment the first numeric field of the first fact by one. Same shape,
  // same units, same everything the schema can see — a value a careless reader
  // would not notice, which is exactly the kind of alteration replay has to
  // catch.
  // The rule-runtime input form carries integers as decimal strings and, on the
  // money path, as plain integers; the wire form adds a `bigint:` prefix where
  // the value really was a BigInt. All three are numeric fields and any of them
  // is a legitimate thing to alter, so all three are handled — and a shape with
  // none of them is a failure of this proof rather than something to shrug at.
  const bumpFirstNumber = (wire: Wire): Wire => {
    const value: Record<string, unknown> = { ...wire.value };
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === "string" && raw.startsWith("bigint:")) {
        value[key] = `bigint:${BigInt(raw.slice(7)) + BigInt(1)}`;
        return { ref_id: wire.ref_id, value };
      }
      if (typeof raw === "string" && /^-?\d+$/u.test(raw)) {
        value[key] = String(BigInt(raw) + BigInt(1));
        return { ref_id: wire.ref_id, value };
      }
      if (typeof raw === "number" && Number.isSafeInteger(raw)) {
        value[key] = raw + 1;
        return { ref_id: wire.ref_id, value };
      }
    }
    throw new Error("R14_TAMPER_NO_NUMERIC_FIELD");
  };
  const tamperedInputs = {
    facts: inputsWire.facts.map((entry, index) => index === 0 ? bumpFirstNumber(entry) : entry),
    parameters: inputsWire.parameters,
  };
  record("tampered_inputs_actually_differ", JSON.stringify(tamperedInputs) !== JSON.stringify(inputsWire),
    `differ=${JSON.stringify(tamperedInputs) !== JSON.stringify(inputsWire)}`);
  await append(tamperedId, tamperedInputs, `r14.append.tampered.${runSuffix}`);
  const tampered = runReplay(tamperedId);
  const tamperedVerdict = /R14_REPLAY_VERDICT (\{.*\})/u.exec(tampered.stdout)?.[1];
  const tamperedParsed = tamperedVerdict ? JSON.parse(tamperedVerdict) as Record<string, unknown> : null;
  record("replay_detects_altered_input_and_refuses",
    tampered.code === 3 && tamperedParsed?.accepted === false && tamperedParsed?.byte_identical === false
      && tampered.stdout.includes("R14_REPLAY_REFUSED"),
    `exit=${tampered.code} accepted=${tamperedParsed?.accepted} byte_identical=${tamperedParsed?.byte_identical}`);
  // And the refusal is specifically about the recomputation, not about the blob
  // having been damaged: the stored trace is still internally consistent.
  record("refusal_is_recomputation_not_blob_damage",
    tamperedParsed?.database_witness_intact === true && tamperedParsed?.stored_blob_hash_matches === true
      && tamperedParsed?.caller_hash_matches === false,
    `witness=${tamperedParsed?.database_witness_intact} blob=${tamperedParsed?.stored_blob_hash_matches} caller=${tamperedParsed?.caller_hash_matches}`);

  const receipt = {
    schema_version: "tivdoc-r14-trace-replay-proof-v0.10.14",
    tenant: TENANT,
    execution_id: executionId,
    tampered_execution_id: tamperedId,
    cases: results,
    passed: results.every((entry) => entry.outcome === "pass"),
  };
  writeFileSync(path.join(RECEIPT_ROOT, "r14-trace-replay.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: receipt.passed, cases: results.length, failed: results.filter((entry) => entry.outcome === "fail") }, null, 2)}\n`);
  if (!receipt.passed) process.exitCode = 1;
}

const replayIndex = process.argv.indexOf("--replay");
if (replayIndex >= 0) await replay(process.argv[replayIndex + 1]);
else await main();
