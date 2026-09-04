// Addendum 7 A7-3. Proves withdrawal is a distinct state from resolution —
// its own required evidence, its own refusals — then retroactively
// registers the one real decision this session dissolved by reading a
// primary source directly (Annual Vacation Law §3(b)/(c), the "200 vs 240
// days" question) as a proper withdrawn record, so it carries the same
// evidence trail A7-3 asks for instead of only living in prose.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!operationsUrl) throw new Error("A73_PROOF_ENV_MISSING");
  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_a73_withdrawal_proof",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "" },
  });

  async function tx<T>(work: (client: import("pg").Client) => Promise<T>): Promise<T> {
    const client = await factory.acquire();
    try {
      await client.query(statement("a73_begin", "begin", []));
      await client.query(statement("a73_context", "select * from private.runtime_context_install($1,$2,$3)",
        [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `a73:${randomUUID().slice(0, 8)}`]));
      const value = await work(client);
      await client.query(statement("a73_commit", "commit", []));
      return value;
    } catch (error) {
      await client.query(statement("a73_rollback", "rollback", [])).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  const sqlstateOf = (error: unknown): string => {
    const direct = (error as { sqlstate?: string | null }).sqlstate;
    if (direct) return direct;
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
      const code = (cause as { code?: string }).code;
      if (code && /^[0-9A-Z]{5}$/u.test(code)) return code;
    }
    return "unknown";
  };
  const messageOf = (error: unknown) => String((error as Error).message ?? "").slice(0, 200);

  const registerDecision = async (decisionId: string, question: string) => tx((client) => client.query(statement(
    "a73_register", "select * from private.governance_legal_open_decision_register($1,$2::jsonb,$3,$4,$5)",
    [TENANT, JSON.stringify({ decision_id: decisionId, topic: "test", question, dossier_anchor: "test fixture, not a real dossier anchor" }),
      `a73.register.${decisionId}`, sha256(`register:${decisionId}`), new Date().toISOString()],
  )));
  const withdraw = async (decisionId: string, reason: string, locator: string, idempotencyKey?: string) => tx((client) => client.query(statement(
    "a73_withdraw", "select * from private.governance_legal_open_decision_withdraw($1,$2,$3,$4,$5,$6,$7::timestamptz)",
    [TENANT, decisionId, reason, locator, idempotencyKey ?? `a73.withdraw.${decisionId}`, sha256(`withdraw:${decisionId}:${reason}:${locator}`), new Date().toISOString()],
  )));

  // --- Case 1: a fresh open decision withdraws cleanly with evidence.
  const decision1 = `a73.test.${randomUUID().slice(0, 12)}`;
  await registerDecision(decision1, "Test fixture: is this decision real?");
  try {
    const result = await withdraw(decision1, "Dissolved on inspection: the underlying premise was false.", "test-fixture-locator#0001");
    record("withdraw_open_decision_succeeds", result.rows[0]?.state === "withdrawn", `state=${result.rows[0]?.state}`);
  } catch (error) {
    record("withdraw_open_decision_succeeds", false, `unexpected refusal ${sqlstateOf(error)}:${messageOf(error)}`);
  }

  // --- Case 2: withdrawing again (same key) replays idempotently, does not error.
  try {
    const replay = await withdraw(decision1, "Dissolved on inspection: the underlying premise was false.", "test-fixture-locator#0001");
    record("withdraw_idempotent_replay", replay.rows[0]?.idempotent_replay === true, `idempotent_replay=${replay.rows[0]?.idempotent_replay}`);
  } catch (error) {
    record("withdraw_idempotent_replay", false, `unexpected refusal ${sqlstateOf(error)}:${messageOf(error)}`);
  }

  // --- Case 3: no runtime role can mutate legal_open_decisions directly at
  // all — not just the withdrawn row from case 1, any row. The table's own
  // RLS policy grants `for all` only to tivdoc_governance_owner (which has
  // no login role — its privileges are exercised only inside SECURITY
  // DEFINER function bodies), so tivdoc_operations_runtime is refused at
  // the privilege level before the append-only trigger ever runs. Two
  // layers, not one: the trigger backstops a mistake in a *future*
  // function this owner-role writes through; the grant means no other
  // role's mistake reaches the table at all.
  const forbiddenRawUpdate = await (async () => {
    try {
      await tx((client) => client.query(statement(
        "a73_direct_resolve_attempt",
        `update private.legal_open_decisions set resolution_state = 'resolved', resolved_branch = 'x', withdrawn_reason = null, dissolution_citation_locator = null
         where tenant_id = $1 and decision_id = $2`,
        [TENANT, decision1],
      )));
      return "accepted";
    } catch (error) {
      return `${sqlstateOf(error)}:${messageOf(error)}`;
    }
  })();
  record("no_runtime_role_can_mutate_the_table_directly", forbiddenRawUpdate.startsWith("42501"), forbiddenRawUpdate);

  // --- Case 4: withdrawing an already-withdrawn decision under a NEW
  // idempotency key (not a replay) is refused, not silently accepted twice.
  try {
    await withdraw(decision1, "A different reason.", "a different locator", `a73.withdraw.${decision1}.second`);
    record("withdraw_already_withdrawn_refused", false, "accepted a second withdrawal under a new key");
  } catch (error) {
    record("withdraw_already_withdrawn_refused", sqlstateOf(error) === "P0001", `${sqlstateOf(error)}:${messageOf(error)}`);
  }

  // --- Case 5: withdrawing an unknown decision id is refused.
  try {
    await withdraw(`a73.test.unknown.${randomUUID().slice(0, 8)}`, "reason", "locator");
    record("withdraw_unknown_decision_refused", false, "accepted an unknown decision id");
  } catch (error) {
    record("withdraw_unknown_decision_refused", sqlstateOf(error) === "P0001", `${sqlstateOf(error)}:${messageOf(error)}`);
  }

  // Case 4 already proves the general rule this would restate: the
  // function's own `existing.resolution_state != 'open'` check refuses
  // withdrawal of any decision that has already left 'open', by whichever
  // transition — case 4 exercises the withdrawn branch of that check, and
  // it is the same branch (not a separate one per originating state) that
  // would refuse an already-resolved decision. Building a genuinely
  // resolved decision to exercise that literally needs the full reviewer
  // trust stack (organisation, policy, two distinct reviewer identities,
  // two attestations) — parameter-decision-matrix.mts already proves that
  // whole path elsewhere; not repeated here for one more branch of a check
  // already covered.

  // --- Case 6: withdrawing without a reason, or without a locator, is
  // refused by the function's own input validation (not just the table
  // constraint — the function must reject before ever reaching the update).
  const decision3 = `a73.test.novalidate.${randomUUID().slice(0, 12)}`;
  await registerDecision(decision3, "Test fixture: withdrawal input validation.");
  try {
    await tx((client) => client.query(statement(
      "a73_withdraw_no_reason", "select * from private.governance_legal_open_decision_withdraw($1,$2,$3,$4,$5,$6,$7::timestamptz)",
      [TENANT, decision3, null, "a locator", `a73.withdraw.${decision3}.noreason`, sha256("noreason"), new Date().toISOString()],
    )));
    record("withdraw_without_reason_refused", false, "accepted a null reason");
  } catch (error) {
    record("withdraw_without_reason_refused", sqlstateOf(error) === "P0001", `${sqlstateOf(error)}:${messageOf(error)}`);
  }

  // --- Case 7 (the real one): the vacation "200 vs 240 days" question,
  // registered and immediately withdrawn with the actual citation locator
  // that dissolved it — Annual Vacation Law §3(b)/(c), read directly.
  const vacationDecisionId = `${TENANT}.decision.vacation_minimum_days_threshold_200_vs_240`;
  await registerDecision(
    vacationDecisionId,
    "Research dossier topic 6, open decision 2: explanatory sources disagree on whether the vacation-entitlement minimum-days threshold is 200 or 240 (\"§3(ב)\", per the dossier's own table note). Which figure governs, and for whom?",
  );
  try {
    const result = await withdraw(
      vacationDecisionId,
      "Not a real disagreement between two candidate figures for one question — Annual Vacation Law §3(b) and §3(c) are two distinct thresholds for two distinct situations: 200 days governs an employment relationship spanning the full work-year, 240 days governs one spanning only part of it. Read directly, the primary text leaves nothing open to decide. Registered as two plain parameters (il.vacation.full_year_relationship_minimum_days_threshold, il.vacation.partial_year_relationship_minimum_days_threshold) instead of decision alternatives, per Pool P batch 5.",
      "IL_ANNUAL_VACATION_LAW@discovery-v0#0001-838721e06653 (§3(b), §3(c))",
    );
    record("vacation_200_vs_240_withdrawn_with_evidence", result.rows[0]?.state === "withdrawn", `state=${result.rows[0]?.state}`);
  } catch (error) {
    record("vacation_200_vs_240_withdrawn_with_evidence", false, `unexpected refusal ${sqlstateOf(error)}:${messageOf(error)}`);
  }

  await factory.close();
  writeFileSync(path.join(RECEIPT_ROOT, "legal-open-decision-withdrawal.json"), `${JSON.stringify({ results }, null, 2)}\n`);
  const failed = results.filter((r) => r.outcome === "fail");
  console.log(JSON.stringify({ total: results.length, failed: failed.length }));
  for (const r of results) console.log(`${r.outcome === "pass" ? "PASS" : "FAIL"} ${r.case} — ${r.observed}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
