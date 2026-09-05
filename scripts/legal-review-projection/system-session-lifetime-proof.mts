// External review #1, finding 8 (second half): "prove the source of the
// concurrency conflict in the parallel matrix". The three governance proofs
// that failed with SQLSTATE 42501 during the S1 freeze (withdrawal,
// draft-binding, supersession) and passed when re-run were recorded as a
// concurrency artifact of running the matrix beside the operations journey.
// That explanation does not survive its own timestamps, and this proof
// replaces it with the mechanism, shown three ways:
//
//   1. Census (static). Exactly which scripts WRITE the one shared row every
//      governance proof runs under — `session.legal.reference.system-import`
//      on the reference tenant — and with what lifetime; and which scripts
//      only CONSUME it through `private.runtime_context_install`. Two write
//      it: the Pool P import (a year) and Gate 0, the attestation reality
//      check (an hour). Thirty-odd consume it and seed nothing. Gate 0's
//      upsert overwrote `expires_at`, so one Gate 0 run shortened a year-long
//      session to an hour, and every consumer that ran more than an hour
//      later, with no import in between, was refused. The fix is asserted
//      here: no seeder may shorten the row (`greatest` on expiry).
//   2. Execution (DEV, synthetic tenant, rolled back or deleted). A live
//      session installs; the same row with `expires_at` in the past raises
//      42501 RUNTIME_CONTEXT_SESSION_NOT_CURRENT from a plpgsql RAISE —
//      `routine = exec_stmt_raise`, the very routine the S1 matrix log
//      recorded; re-seeding recovers it. And the concurrency hypothesis is
//      tested directly: a same-token upsert issued while another connection
//      holds the row under `for share` WAITS on the row lock (55P03 under a
//      lock timeout) and then succeeds; it cannot produce 42501. A seed with
//      the same sid and jti never makes a session non-current — only expiry,
//      revocation, or a different jti can.
//   3. Timeline (recorded). The modification times of the S1 and 13-T logs
//      on this machine, when present: Gate 0's one-hour seed, the operations
//      journey's end, the matrix's failures, the matrix's own Gate 0 re-seed,
//      and the passing re-runs — in that order.
//
// Nothing here touches the reference tenant's row except to read it; the
// receipt states its current lifetime.
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

const RECEIPT_ROOT = path.join("output", "next", "pool-p");
const REFERENCE_TENANT = "legal.reference.il";
const SYSTEM_SID = "session.legal.reference.system-import";
const SCRIPT_ROOTS = ["scripts/legal-review-projection", "scripts/dev-runtime", "scripts/shadow"];
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed: observed.slice(0, 240) }));
};

type SeederRow = Readonly<{ script: string; role: "seeder" | "consumer" | "names_only"; installs: number; window_seconds: number | null; never_shortens: boolean | null }>;

function census(): readonly SeederRow[] {
  const rows: SeederRow[] = [];
  for (const root of SCRIPT_ROOTS) {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".mts")).sort()) {
      const file = path.join(root, name);
      if (file.replaceAll("\\", "/") === "scripts/legal-review-projection/system-session-lifetime-proof.mts") continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes(SYSTEM_SID)) continue;
      const installs = (text.match(/runtime_context_install/gu) ?? []).length;
      const seeds = (text.match(/insert into public\.product_identity_sessions/gu) ?? []).length;
      if (seeds === 0) { rows.push({ script: file.replaceAll("\\", "/"), role: installs > 0 ? "consumer" : "names_only", installs, window_seconds: null, never_shortens: null }); continue; }
      // The window: the seconds added to `now` on the seed's expiry argument.
      const window = /now(?:\s*-\s*5)?,\s*now\s*\+\s*([0-9_]+(?:\s*\*\s*[0-9_]+)*)/u.exec(text);
      const seconds = window ? window[1].split("*").map((part) => Number(part.replace(/_/gu, "").trim())).reduce((a, b) => a * b, 1) : null;
      const neverShortens = /expires_at\s*=\s*greatest\(/u.test(text);
      rows.push({ script: file.replaceAll("\\", "/"), role: "seeder", installs, window_seconds: seconds, never_shortens: neverShortens });
    }
  }
  return rows;
}

function mtimeOf(file: string): string | null {
  try { return statSync(file).mtime.toISOString(); } catch { return null; }
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!adminUrl || !operationsUrl) throw new Error("SESSION_LIFETIME_PROOF_ENV_MISSING");
  const { default: pg } = await import("pg");

  // 1. Census.
  const rows = census();
  const seeders = rows.filter((row) => row.role === "seeder");
  const consumers = rows.filter((row) => row.role === "consumer");
  record("census_two_seeders_many_consumers", seeders.length === 2 && consumers.length >= 20,
    `seeders=${seeders.map((row) => `${path.basename(row.script)}:${row.window_seconds ?? "?"}s`).join(",")} consumers=${consumers.length}`);
  const shortener = seeders.filter((row) => (row.window_seconds ?? 0) < 3_600 * 24 * 365 && !row.never_shortens);
  record("no_seeder_shortens_the_shared_session", shortener.length === 0,
    shortener.length === 0 ? "every seeder either seeds a year or keeps the longer expiry (greatest)" : `shortens: ${shortener.map((row) => path.basename(row.script)).join(",")}`);

  // 2. Execution on DEV.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  const run = randomUUID().slice(0, 8);
  const sid = `session.proof.lifetime.${run}`;
  const jti = `token.proof.lifetime.${run}`;
  const subject = "system_import";
  const org = `${SYNTHETIC_PROOF_TENANT}.no-attestation-placeholder`;
  const seed = async (client: import("pg").Client, expiresIn: number, form: "overwrite" | "greatest") => {
    const now = Math.floor(Date.now() / 1_000);
    await client.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = least(public.product_identity_sessions.valid_after, excluded.valid_after),
         expires_at = ${form === "greatest" ? "greatest(public.product_identity_sessions.expires_at, excluded.expires_at)" : "excluded.expires_at"},
         reviewer_org_id = excluded.reviewer_org_id`,
      [SYNTHETIC_PROOF_TENANT, sid, subject, jti, now - 5, now + expiresIn, org, sha256(`${SYNTHETIC_PROOF_TENANT}|${sid}|${subject}|${jti}`)],
    );
  };
  const expiryOf = async () => {
    const row = await admin.query("select extract(epoch from expires_at)::bigint as e from public.product_identity_sessions where tenant_id = $1 and sid = $2", [SYNTHETIC_PROOF_TENANT, sid]);
    return Number(row.rows[0]?.e ?? 0);
  };
  const install = async (client: import("pg").Client): Promise<Readonly<{ ok: boolean; sqlstate: string; message: string; routine: string }>> => {
    try {
      await client.query("select * from private.runtime_context_install($1,$2,$3)", [sid, jti, `lifetime:${run}`]);
      return { ok: true, sqlstate: "none", message: "installed", routine: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string; routine?: string };
      return { ok: false, sqlstate: e.code ?? "unknown", message: String(e.message ?? "").slice(0, 80), routine: e.routine ?? "" };
    }
  };
  const operationsA = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
  const operationsB = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
  await operationsA.connect();
  await operationsB.connect();
  let live: Record<string, unknown> | null = null;
  let skew = 0;
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [REFERENCE_TENANT]);
    const clock = await admin.query("select extract(epoch from clock_timestamp())::numeric as db_epoch");
    skew = Date.now() / 1_000 - Number(clock.rows[0].db_epoch);
    const reference = await admin.query(
      "select sid, subject, current_jti, revoked_at is not null as revoked, extract(epoch from valid_after)::bigint as valid_after, extract(epoch from expires_at)::bigint as expires_at, (expires_at > now()) as live from public.product_identity_sessions where tenant_id = $1 and sid = $2",
      [REFERENCE_TENANT, SYSTEM_SID],
    );
    live = reference.rows[0] ?? null;
    record("reference_row_read_only", true, live ? `live=${String(live.live)} expires_in_hours=${((Number(live.expires_at) - Date.now() / 1_000) / 3_600).toFixed(1)} revoked=${String(live.revoked)}` : "absent");
    record("clock_skew_within_seed_margin", Math.abs(skew) < 5, `local_minus_db_seconds=${skew.toFixed(3)} (a seed's valid_after is now-5)`);

    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [SYNTHETIC_PROOF_TENANT]);
    await seed(admin, 3_600, "overwrite");
    await operationsA.query("begin");
    const first = await install(operationsA);
    await operationsA.query("rollback");
    record("live_session_installs", first.ok, first.message);

    // The row expired: the consumer's failure, as recorded in the S1 matrix log (exec_stmt_raise).
    await admin.query("update public.product_identity_sessions set expires_at = now() - interval '1 second' where tenant_id = $1 and sid = $2", [SYNTHETIC_PROOF_TENANT, sid]);
    await operationsA.query("begin");
    const expired = await install(operationsA);
    await operationsA.query("rollback");
    record("expired_session_refused_by_raise", !expired.ok && expired.sqlstate === "42501" && expired.message.includes("RUNTIME_CONTEXT_SESSION_NOT_CURRENT") && expired.routine === "exec_stmt_raise",
      `${expired.sqlstate} ${expired.message} routine=${expired.routine}`);

    // Re-seeding recovers it — what the matrix's own Gate 0 did before the S1 re-run.
    await seed(admin, 3_600, "overwrite");
    await operationsA.query("begin");
    const recovered = await install(operationsA);
    await operationsA.query("rollback");
    record("reseed_recovers", recovered.ok, recovered.message);

    // The concurrency hypothesis: a same-token seed while the row is held under `for share` waits, it does not refuse.
    await operationsA.query("begin");
    const held = await install(operationsA);
    let concurrent = "none";
    try {
      await admin.query("set lock_timeout = '1500ms'");
      await seed(admin, 3_600, "overwrite");
      concurrent = "seed_completed_without_waiting";
    } catch (error) {
      concurrent = String((error as { code?: string }).code ?? "unknown");
    } finally {
      await admin.query("set lock_timeout = 0").catch(() => undefined);
    }
    await operationsB.query("begin");
    const besides = await install(operationsB);
    await operationsB.query("rollback");
    await operationsA.query("commit");
    // After the holder commits, the very same seed goes through and the token is still current.
    await seed(admin, 3_600, "overwrite");
    await operationsA.query("begin");
    const afterSeed = await install(operationsA);
    await operationsA.query("rollback");
    record("concurrent_same_token_seed_waits_never_refuses", held.ok && concurrent === "55P03" && besides.ok && afterSeed.ok,
      `held=${held.ok} concurrent_seed=${concurrent} (55P03 = waited on the row lock) second_reader=${besides.ok} after_holder_commits=${afterSeed.ok}`);

    // The shortening upsert versus the one that keeps the longer expiry.
    await seed(admin, 3_600 * 24 * 365, "overwrite");
    const year = await expiryOf();
    await seed(admin, 3_600, "overwrite");
    const shortened = await expiryOf();
    await seed(admin, 3_600 * 24 * 365, "overwrite");
    await seed(admin, 3_600, "greatest");
    const kept = await expiryOf();
    record("overwrite_shortens_greatest_keeps", shortened < year - 3_600 * 24 * 300 && kept >= year - 5,
      `year=${year} after_one_hour_overwrite=${shortened} after_one_hour_greatest=${kept}`);
  } finally {
    await admin.query("delete from public.product_identity_sessions where tenant_id = $1 and sid = $2", [SYNTHETIC_PROOF_TENANT, sid]).catch(() => undefined);
    await operationsA.end().catch(() => undefined);
    await operationsB.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }

  // 3. The recorded timeline, from this machine's untracked logs when present.
  const timeline = {
    gate0_one_hour_seed_13t: mtimeOf(path.join("output", "next", "trial-13t-gate0.log")),
    operations_journey_end_s1: mtimeOf(path.join("output", "next", "freezeS1-journey.txt")),
    grant_execution_s1: mtimeOf(path.join("output", "next", "freezeS1-grant-execution.log")),
    matrix_done_s1: mtimeOf(path.join("output", "next", "freezeS1-matrix.txt")),
    gate0_reseed_inside_matrix_s1: mtimeOf(path.join("output", "next", "freezeS1-gate0-attestation.log")),
    withdrawal_rerun_pass_s1: mtimeOf(path.join("output", "next", "freezeS1-withdrawal.log")),
    draft_binding_rerun_pass_s1: mtimeOf(path.join("output", "next", "freezeS1-draft-binding.log")),
    supersession_rerun_pass_s1: mtimeOf(path.join("output", "next", "freezeS1-supersession.log")),
    matrix_first_pass_failure_routine: (() => {
      try { return /routine=(\w+)/u.exec(readFileSync(path.join("output", "next", "freezeS1-matrix.txt"), "utf8").split("=== withdrawal")[1] ?? "")?.[1] ?? null; } catch { return null; }
    })(),
  };

  const failed = results.filter((row) => row.outcome === "fail");
  const receipt = {
    schema_version: "tivdoc-system-session-lifetime-proof-v1",
    unit: "external review #1, finding 8 (the source of the S1 matrix failures)",
    finding: "not a concurrency conflict: the shared system-import session is written by two scripts (the Pool P import for a year, Gate 0 for an hour) and consumed by the rest; Gate 0's upsert shortened the session, and every consumer that ran more than an hour later without an import in between was refused RUNTIME_CONTEXT_SESSION_NOT_CURRENT; a concurrent same-token seed waits on the row lock and cannot refuse",
    reference_row: live,
    clock_skew_seconds: Number(skew.toFixed(3)),
    census: rows,
    timeline,
    cases: results,
    passed: results.length - failed.length,
    failed: failed.length,
    verdict: failed.length === 0 ? "PASS" : "FAIL",
  };
  writeFileSync(path.join(RECEIPT_ROOT, "system-session-lifetime-proof.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  for (const row of results) console.log(`${row.outcome.toUpperCase()} ${row.case} — ${row.observed}`);
  console.log(`SYSTEM_SESSION_LIFETIME_PROOF ${receipt.verdict} ${receipt.passed}/${results.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
