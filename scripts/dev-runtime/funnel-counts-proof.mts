// Site S4 / D-11 acceptance on DEV: the counting rule, against the real table.
//
// The operations journey proves M01 REACHES its sources — a real query against
// `funnel_events`, which on this database is empty, so every number is honestly
// a dash. What it cannot prove is that the counting is right, because nothing
// on DEV writes funnel events: the journey's cases are created through the
// operations service, not by walking the funnel.
//
// So this seeds events inside a transaction, asks the function what it counts,
// and rolls back. Nothing is left behind — the last check re-reads the table
// outside the transaction and asserts it is empty again, because a proof that
// littered the database would be worse than no proof.
//
// The rule under test is the one that is easy to get wrong and impossible to
// notice: DISTINCT sessions before a case exists, DISTINCT cases after. A
// person who reloads the landing five times is one person considering one
// check, and counting rows would make the first conversion look five times
// worse than it is.
import "../production-refusal.mjs";
import pg from "pg";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

type Check = Readonly<{ check: string; expected: string; actual: string; passed: boolean }>;

const SESSION_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const SESSION_B = "22222222-aaaa-4aaa-8aaa-222222222222";

async function main(): Promise<void> {
  const env = readDevEnvFile();
  const url = env.get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("DEV_URL_MISSING:TIVDOC_DEV_DATABASE_URL");

  const checks: Check[] = [];
  const record = (check: string, expected: string, actual: string) =>
    checks.push({ check, expected, actual, passed: expected === actual });

  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const before = await client.query<{ count: string }>("select count(*)::text as count from public.funnel_events");
    record("the table starts empty", "0", before.rows[0]?.count ?? "missing");

    await client.query("begin");
    try {
      await client.query(
        "insert into public.funnel_sessions (id, last_seen_at) values ($1, now()), ($2, now())",
        [SESSION_A, SESSION_B],
      );
      // Session A lands three times and starts once; session B lands once and
      // never starts. Counted by session that is 2 landings and 1 start.
      await client.query(
        `insert into public.funnel_events (session_id, case_id, event_name, idempotency_key) values
           ($1, null, 'landing_view', 'proof:a:1'),
           ($1, null, 'landing_view', 'proof:a:2'),
           ($1, null, 'landing_view', 'proof:a:3'),
           ($1, null, 'start_check',  'proof:a:4'),
           ($2, null, 'landing_view', 'proof:b:1')`,
        [SESSION_A, SESSION_B],
      );

      const counted = await client.query<{ event_name: string; cases: string }>(
        "select event_name, cases::text as cases from public.case_funnel_event_counts(null)",
      );
      const byName = new Map(counted.rows.map((row) => [row.event_name, row.cases]));
      record("three landings from one session count once", "2", byName.get("landing_view") ?? "missing");
      record("the start is counted", "1", byName.get("start_check") ?? "missing");
      record("nothing else is invented", "2", String(counted.rows.length));

      // A window that begins after the rows were written sees none of them.
      const windowed = await client.query<{ event_name: string }>(
        "select event_name from public.case_funnel_event_counts(now() + interval '1 hour')",
      );
      record("the since window is honoured", "0", String(windowed.rows.length));
    } finally {
      await client.query("rollback");
    }

    const after = await client.query<{ count: string }>("select count(*)::text as count from public.funnel_events");
    record("the proof left nothing behind", "0", after.rows[0]?.count ?? "missing");
  } finally {
    await client.end();
  }

  for (const check of checks) {
    process.stdout.write(`${check.passed ? "PASS" : "FAIL"} | ${check.check} | expected=${check.expected} actual=${check.actual}\n`);
  }
  const failed = checks.filter((check) => !check.passed).length;
  process.stdout.write(`checks=${checks.length} failed=${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
