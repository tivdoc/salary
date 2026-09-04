// E3-2 (BL-11) and E3-3 (BL-12), proven by execution and then applied to the
// two real records that needed it.
//
// D2: a draft candidate is corrected by supersession, never in place. The
// candidate table is append-only — every state change is a new revision — so
// superseding appends a revision in state `superseded` naming the candidate
// that replaces it and why. The original revision stays exactly as written.
//
// D3: proof fixtures are segregated by a flag on the row, not by a string
// prefix convention living in one report generator.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "supersession");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const LEGAL_DECISION_PREFIX = `${TENANT}.decision.`;

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

const MIS_SCOPED = { id: "il.vacation.calendar_days_years_1_to_4", version: "2017.1.0" };
const REPLACEMENT = "il.vacation.calendar_days_years_1_to_5@2017.1.0";
const SUPERSEDE_REASON =
  "Wrong population. Annual Vacation Law amendment 15 moves the seniority band from the first four work-years to the first five in the same clause that moves 14 days to 16 — 'במקום \"מ־4\" יבוא \"מ־5\" ובמקום \"14\" יבוא \"16\"'. The figure is right and the scope is not, and the numeric-only citation check could not see it because the chunk does contain 16 and 14. Superseded by il.vacation.calendar_days_years_1_to_5@2017.1.0, whose citation carries the Hebrew anchor for that clause (E3-1).";

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!url) throw new Error("E32_ENV_MISSING");
  const parsed = new URL(url);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: url, max_connections: 4, connection_timeout_ms: 20_000,
    application_name: "tivdoc_e32_supersession",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  async function tx<T>(label: string, work: (client: import("pg").Client) => Promise<T>): Promise<T> {
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

  const sqlstateOf = (error: unknown): string => {
    const direct = (error as { sqlstate?: string | null }).sqlstate;
    if (direct) return direct;
    for (let cause: unknown = error; cause; cause = (cause as { cause?: unknown }).cause) {
      const code = (cause as { code?: string }).code;
      if (code && /^[0-9A-Z]{5}$/u.test(code)) return code;
    }
    return "unknown";
  };
  const refusal = async (work: () => Promise<unknown>) => {
    try { await work(); return "unexpectedly_succeeded"; } catch (error) { return sqlstateOf(error); }
  };

  const readCurrent = async (id: string, version: string) => tx("e32_read", (client) => client.query(statement(
    "e32_aggregate", "select state, revision, activation_allowed from private.governance_aggregate_read($1,$2,$3,$4)",
    [TENANT, "parameter_approval", id, version])));

  const supersede = async (id: string, version: string, revision: number, by: string, reason: string, key: string) =>
    tx("e32_supersede", (client) => client.query(statement(
      "e32_supersede_call",
      "select * from private.governance_parameter_supersede($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)",
      [TENANT, id, version, revision, by, reason, key, sha256(`supersede:${id}@${version}:${by}`), new Date().toISOString()])));

  // --- Case 1: the replacement must exist first.
  const unknownReplacement = await refusal(() => supersede(
    MIS_SCOPED.id, MIS_SCOPED.version, 1, "il.does.not.exist@1.0.0",
    "A replacement that does not exist would make a wrong row look resolved rather than wrong.",
    `e32.unknown.${randomUUID().slice(0, 8)}`));
  record("supersede_refuses_unknown_replacement", unknownReplacement.startsWith("P0001"), unknownReplacement);

  // --- Case 2: a reason is mandatory and must say something.
  const shortReason = await refusal(() => supersede(
    MIS_SCOPED.id, MIS_SCOPED.version, 1, REPLACEMENT, "wrong",
    `e32.short.${randomUUID().slice(0, 8)}`));
  record("supersede_refuses_a_reason_too_short_to_be_one", shortReason.startsWith("P0001"), shortReason);

  // --- Case 3: nothing may supersede itself.
  const itself = await refusal(() => supersede(
    MIS_SCOPED.id, MIS_SCOPED.version, 1, `${MIS_SCOPED.id}@${MIS_SCOPED.version}`,
    "A candidate superseding itself is a loop that reads as a correction and is not one.",
    `e32.self.${randomUUID().slice(0, 8)}`));
  record("supersede_refuses_self_reference", itself.startsWith("P0001"), itself);

  // --- Case 4: the real correction.
  const before = await readCurrent(MIS_SCOPED.id, MIS_SCOPED.version);
  const beforeState = (before.rows[0] as unknown as { state: string; revision: string } | undefined);
  const alreadyDone = beforeState?.state === "superseded";
  if (!alreadyDone) {
    const applied = await supersede(
      MIS_SCOPED.id, MIS_SCOPED.version, Number(beforeState?.revision ?? 1), REPLACEMENT, SUPERSEDE_REASON,
      `e32.supersede.${MIS_SCOPED.id}`);
    record("mis_scoped_vacation_parameter_superseded",
      (applied.rows[0] as unknown as { state: string })?.state === "superseded",
      `state=${(applied.rows[0] as unknown as { state: string })?.state}`);
  } else {
    record("mis_scoped_vacation_parameter_superseded", true, "already superseded by a previous run");
  }

  const after = await readCurrent(MIS_SCOPED.id, MIS_SCOPED.version);
  const afterRow = after.rows[0] as unknown as { state: string; revision: string; activation_allowed: boolean };
  record("superseded_row_is_current_and_still_inactive",
    afterRow?.state === "superseded" && afterRow?.activation_allowed === false,
    `state=${afterRow?.state} revision=${afterRow?.revision} activation_allowed=${afterRow?.activation_allowed}`);

  // --- Case 5: the replacement is untouched and still draft. A correction that
  // disturbed the corrected row would be an edit wearing a different name.
  const replacementRow = await readCurrent("il.vacation.calendar_days_years_1_to_5", "2017.1.0");
  record("replacement_is_untouched_and_draft",
    (replacementRow.rows[0] as unknown as { state: string })?.state === "draft",
    `state=${(replacementRow.rows[0] as unknown as { state: string })?.state}`);

  // --- Case 6: superseding twice is refused, not silently repeated.
  const twice = await refusal(() => supersede(
    MIS_SCOPED.id, MIS_SCOPED.version, Number(afterRow?.revision ?? 2), REPLACEMENT, SUPERSEDE_REASON,
    `e32.twice.${randomUUID().slice(0, 8)}`));
  record("supersede_refuses_an_already_superseded_candidate", twice.startsWith("P0001"), twice);

  // --- E3-3: mark the eight proof fixtures synthetic.
  const decisions = await tx("e32_decisions", (client) => client.query(statement(
    "e32_decision_read", "select * from private.legal_open_decision_read($1)", [TENANT])));
  const rows = decisions.rows as unknown as Array<{ decision_id: string; synthetic: boolean; resolution_state: string }>;
  const fixtures = rows.filter((row) => !row.decision_id.startsWith(LEGAL_DECISION_PREFIX));
  let marked = 0;
  for (const fixture of fixtures) {
    if (fixture.synthetic) continue;
    await tx("e32_mark", (client) => client.query(statement(
      "e32_mark_call",
      "select * from private.governance_legal_open_decision_mark_synthetic($1,$2,$3,$4,$5,$6::timestamptz)",
      [TENANT, fixture.decision_id,
        "Throwaway decision registered by A7-3's withdrawal proof to exercise the state machine. Not a legal question. legal_open_decisions is append-only with no delete path, so it is flagged rather than removed.",
        `e33.synthetic.${fixture.decision_id}`, sha256(`synthetic:${fixture.decision_id}`), new Date().toISOString()])));
    marked += 1;
  }
  const afterMark = await tx("e32_decisions2", (client) => client.query(statement(
    "e32_decision_read2", "select * from private.legal_open_decision_read($1)", [TENANT])));
  const afterRows = afterMark.rows as unknown as Array<{ decision_id: string; synthetic: boolean; resolution_state: string }>;
  const legal = afterRows.filter((row) => !row.synthetic);
  record("all_proof_fixtures_flagged_synthetic",
    afterRows.filter((row) => !row.decision_id.startsWith(LEGAL_DECISION_PREFIX)).every((row) => row.synthetic),
    `marked_now=${marked} fixtures=${fixtures.length}`);
  // L5-6 registered a fourth legal decision (the 2026 convalescence rate
  // period); L6-4 a fifth (rest-day overtime composition); L6-5 a sixth
  // (the 2011/2016 pension precedence).
  // L7-9: seven — the daily-threshold decision joined the six of long run 6.
  record("exactly_seven_legal_decisions_remain", legal.length === 7,
    `legal=${legal.length} of ${afterRows.length}: ${legal.map((row) => `${row.decision_id}=${row.resolution_state}`).join(" ")}`);

  // --- The flag is one-way. A fixture must never be laundered into a legal
  // decision, and that is enforced in the guard rather than by convention.
  const relaunder = await refusal(() => tx("e32_relaunder", (client) => client.query(statement(
    "e32_relaunder_call",
    "select * from private.governance_legal_open_decision_mark_synthetic($1,$2,$3,$4,$5,$6::timestamptz)",
    [TENANT, fixtures[0]?.decision_id ?? "none",
      "A second attempt on a row already flagged must be refused rather than replayed into a no-op.",
      `e33.relaunder.${randomUUID().slice(0, 8)}`, sha256("relaunder"), new Date().toISOString()]))));
  record("marking_an_already_synthetic_row_is_refused", relaunder.startsWith("P0001"), relaunder);

  const receipt = {
    schema_version: "tivdoc-parameter-supersession-proof-v0.10.15",
    units: ["E3-2 (BL-11)", "E3-3 (BL-12)"],
    tenant: TENANT,
    superseded: { parameter: `${MIS_SCOPED.id}@${MIS_SCOPED.version}`, superseded_by: REPLACEMENT },
    decisions_total: afterRows.length,
    decisions_legal: legal.length,
    decisions_synthetic: afterRows.length - legal.length,
    attestations: 0,
    cases: results,
    passed: results.every((entry) => entry.outcome === "pass"),
  };
  writeFileSync(path.join(RECEIPT_ROOT, "parameter-supersession.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: receipt.passed, cases: results.length, failed: results.filter((entry) => entry.outcome === "fail") }, null, 2)}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome.toUpperCase()} ${entry.case} — ${entry.observed}\n`);
  if (!receipt.passed) process.exitCode = 1;
}

await main();
