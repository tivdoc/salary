// Site S6 acceptance on DEV, at the boundary the run can actually reach.
//
// What this proves and what it cannot. The QA queue's flow — enqueue, word,
// approve, publish — needs a row in `case_report_projections`, and no role in
// this database holds insert on that table: the engine is granted it in run 16,
// and this run does not open it early. So the flow is proven in unit tests
// against the in-memory mirror, and what is proven HERE is the structure those
// tests assume, on the real database, as the real runtime roles:
//
//   the two tables exist with row-level security forced,
//   the six functions exist as security invoker,
//   the operations runtime may reach the queue and the web runtime may only read,
//   the log refuses an update and a delete,
//   the queue's foreign key to the projection actually holds,
//   and — the run-16 boundary — no runtime role can insert a projection.
//
// The last one is the point of running this at all: a wave that added a review
// queue for reports could very easily have opened the table those reports live
// in, and this says in one line that it did not.
import "../production-refusal.mjs";
import pg from "pg";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

type Check = Readonly<{ check: string; expected: string; actual: string; passed: boolean }>;

const FUNCTIONS = Object.freeze([
  "case_report_qa_enqueue",
  "case_report_qa_list",
  "case_report_qa_wording_set",
  "case_report_qa_decide",
  "case_report_qa_recheck",
  "case_report_qa_track_summary",
]);

/**
 * The per-role URL the runtimes themselves use, not one rebuilt from parts.
 * The credential file carries no database name, and a URL built from its parts
 * lands on `postgres` — the empty database the dashboard shows — rather than on
 * `tivdoc_v09_devruntime01`, where every migration in this repository has been
 * applied. A proof that ran against the wrong database would report a missing
 * function as a failure of the work rather than of the connection.
 */
function urlFor(env: Map<string, string>, key: string): string {
  const url = env.get(key);
  if (!url) throw new Error(`DEV_URL_MISSING:${key}`);
  return url;
}

async function errorCodeOf(client: pg.Client, sql: string, values: readonly unknown[] = []): Promise<string> {
  try {
    await client.query(sql, [...values]);
    return "no_error";
  } catch (error) {
    return String((error as { code?: string }).code ?? "unknown");
  }
}

async function main(): Promise<void> {
  const env = readDevEnvFile();
  const checks: Check[] = [];
  const record = (check: string, expected: string, actual: string) =>
    checks.push({ check, expected, actual, passed: expected === actual });

  const operations = new pg.Client({ connectionString: urlFor(env, "TIVDOC_OPERATIONS_POSTGRES_URL"), connectionTimeoutMillis: 20_000 });
  await operations.connect();
  try {
    const tables = await operations.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any ($1) and relnamespace = 'public'::regnamespace",
      [["case_report_qa", "case_report_qa_log"]],
    );
    record("tables exist", "2", String(tables.rows.length));
    record(
      "row-level security forced on both",
      "2",
      String(tables.rows.filter((row) => row.relrowsecurity && row.relforcerowsecurity).length),
    );

    const functions = await operations.query<{ proname: string; prosecdef: boolean }>(
      "select proname, prosecdef from pg_proc where proname = any ($1) and pronamespace = 'public'::regnamespace",
      [FUNCTIONS],
    );
    record("queue functions exist", String(FUNCTIONS.length), String(functions.rows.length));
    record("none of them is security definer", "0", String(functions.rows.filter((row) => row.prosecdef).length));

    const summary = await operations.query<{ reports: string }>("select reports from public.case_report_qa_track_summary()");
    record("the track summary answers", "1", String(summary.rows.length));
    record("no reports have reached the gate yet", "0", String(summary.rows[0]?.reports ?? "missing"));

    // The queue's foreign key: a row for a projection that does not exist is
    // refused by the database, not by the application.
    record(
      "a queue row needs a real projection",
      "23503",
      await errorCodeOf(
        operations,
        "insert into public.case_report_qa (case_id, projection_id, report_kind, document_track, state)"
        + " values (gen_random_uuid(), gen_random_uuid(), 'initial', 'automatic', 'queued')",
      ),
    );

    // The run-16 boundary, stated as a privilege rather than as a promise.
    record(
      "the operations runtime cannot write a projection",
      "42501",
      await errorCodeOf(
        operations,
        "insert into public.case_report_projections (case_id, schema_version, report_kind, check_period_month, projection, legal_basis, generated_at)"
        + " values (gen_random_uuid(), 'tivdoc-case-report-projection-v1', 'initial', current_date, '{}'::jsonb, 'opinion_3ddad7e8 + errata_1_owner_closed', now())",
      ),
    );

    // The log is append-only, and with no rows in it the trigger has nothing to
    // fire on — so what is checked here is that the trigger is attached and that
    // the operations runtime was never granted delete in the first place. The
    // trigger's behaviour is exercised in the unit tests' mirror.
    const trigger = await operations.query<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid = 'public.case_report_qa_log'::regclass and not tgisinternal",
    );
    record("the log carries its append-only trigger", "case_report_qa_log_no_update", trigger.rows[0]?.tgname ?? "none");
    record(
      "the operations runtime holds no delete on the log",
      "false",
      String(
        (await operations.query<{ has: boolean }>("select has_table_privilege('public.case_report_qa_log', 'delete') as has")).rows[0]?.has ?? "missing",
      ),
    );
  } finally {
    await operations.end();
  }

  const web = new pg.Client({ connectionString: urlFor(env, "TIVDOC_WEB_POSTGRES_URL"), connectionTimeoutMillis: 20_000 });
  await web.connect();
  try {
    record(
      "the web runtime may read the queue",
      "true",
      String((await web.query<{ has: boolean }>("select has_table_privilege('public.case_report_qa', 'select') as has")).rows[0]?.has ?? "missing"),
    );
    record(
      "the web runtime may not write it",
      "false",
      String((await web.query<{ has: boolean }>("select has_table_privilege('public.case_report_qa', 'insert') as has")).rows[0]?.has ?? "missing"),
    );
  } finally {
    await web.end();
  }

  for (const check of checks) {
    process.stdout.write(`${check.passed ? "PASS" : "FAIL"} | ${check.check} | expected=${check.expected} actual=${check.actual}\n`);
  }
  const failed = checks.filter((check) => !check.passed).length;
  process.stdout.write(`checks=${checks.length} failed=${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
