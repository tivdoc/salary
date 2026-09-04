// E3-4 (BL-13). The pre-guard identity session is revoked, not ignored.
//
// `private.product_session_revoke` exists and is granted to
// `tivdoc_identity_runtime`, so this is done as the runtime role through the
// sanctioned path rather than by an admin UPDATE.
//
// One thing this unit found that the instruction could not have known. D4 asks
// for an assertion that no ACTIVE session predates the A7-1 guard. Taken
// literally that would require revoking both sessions on this tenant, because
// A7-1's guard refuses *every* identity-session registration for
// `legal.reference.il` — including the system-import session every governance
// write runs under. That session necessarily predates the guard, cannot be
// recreated, and revoking it would leave the tenant permanently unwritable.
//
// So the assertion made here is the one that is both true and safe: exactly one
// active session remains, it is the named system-import session, and every
// other session on this tenant is revoked. The unrecreatability of that one
// session is recorded as a finding rather than acted on.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT } from "./pool-p-parameter-import.mts";

const RECEIPT_ROOT = path.join("output", "next", "identity");
const SANCTIONED_SID = "session.legal.reference.system-import";

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const identityUrl = env.get("TIVDOC_IDENTITY_POSTGRES_URL");
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  if (!identityUrl || !adminUrl) throw new Error("E34_ENV_MISSING");

  // --- Census before, on the admin connection, which is the only identity that
  // can read this table directly.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  const census = async () => {
    const rows = await admin.query(
      "select sid, subject, revoked_at, created_at from public.product_identity_sessions where tenant_id = $1 order by created_at",
      [TENANT],
    );
    return rows.rows as Array<{ sid: string; subject: string; revoked_at: Date | null; created_at: Date }>;
  };

  let before: Awaited<ReturnType<typeof census>>;
  let after: Awaited<ReturnType<typeof census>>;
  const revoked: string[] = [];
  try {
    before = await census();
    const residue = before.filter((row) => row.sid !== SANCTIONED_SID && row.revoked_at === null);
    record("residue_sessions_found", true,
      `total=${before.length} active_before=${before.filter((row) => row.revoked_at === null).length} residue=${residue.length}`);

    // --- Revoke each, as the identity runtime, through the definer.
    const identity = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
    await identity.connect();
    try {
      for (const row of residue) {
        await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
        const result = await identity.query(
          "select private.product_session_revoke($1, now()) as revoked",
          [row.sid],
        );
        const ok = (result.rows[0] as { revoked: boolean }).revoked === true;
        record(`revoked_${row.sid}`, ok, `revoked=${ok}`);
        if (ok) revoked.push(row.sid);
      }
      // Revoking again is idempotent, not an error: the function returns true
      // for a session already revoked at that instant, and false otherwise —
      // either way it must not throw and must not resurrect anything.
      if (residue.length > 0) {
        await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
        const again = await identity.query("select private.product_session_revoke($1, now()) as revoked", [residue[0].sid]);
        record("revoking_an_already_revoked_session_does_not_throw", true,
          `returned=${(again.rows[0] as { revoked: boolean }).revoked}`);
      }
      // And a session on another tenant is invisible to this one: the definer
      // resolves the tenant from context, never from the caller's argument.
      await identity.query("select set_config('tivdoc.tenant_id', $1, false)", ["tenant.that.does.not.exist"]);
      const foreign = await identity.query("select private.product_session_revoke($1, now()) as revoked", [SANCTIONED_SID]);
      record("revoke_is_tenant_scoped_by_context_not_argument",
        (foreign.rows[0] as { revoked: boolean }).revoked === false,
        `returned=${(foreign.rows[0] as { revoked: boolean }).revoked}`);
    } finally {
      await identity.end().catch(() => undefined);
    }

    after = await census();
    const active = after.filter((row) => row.revoked_at === null);
    record("exactly_one_active_session_remains", active.length === 1,
      `active=${active.length}: ${active.map((row) => row.sid).join(",")}`);
    record("the_remaining_active_session_is_the_sanctioned_one",
      active.length === 1 && active[0].sid === SANCTIONED_SID,
      active[0]?.sid ?? "none");
    record("every_other_session_is_revoked",
      after.filter((row) => row.sid !== SANCTIONED_SID).every((row) => row.revoked_at !== null),
      after.filter((row) => row.sid !== SANCTIONED_SID).map((row) => `${row.sid}=${row.revoked_at ? "revoked" : "ACTIVE"}`).join(" ") || "none");
    // Nothing was deleted. The table is a ledger; revocation is a state, not a
    // removal, and a run that quietly shrank it would be destroying evidence.
    record("no_session_row_was_deleted", after.length === before.length,
      `before=${before.length} after=${after.length}`);
  } finally {
    await admin.end().catch(() => undefined);
  }

  const receipt = {
    schema_version: "tivdoc-identity-session-revocation-v0.10.15",
    unit: "E3-4 (BL-13)",
    tenant: TENANT,
    sessions_total: after.length,
    sessions_active: after.filter((row) => row.revoked_at === null).length,
    revoked_this_run: revoked,
    rows_deleted: 0,
    finding_the_instruction_could_not_have_known: {
      claim: "D4 asks for an assertion that no active session predates the A7-1 guard. That assertion cannot be made true safely.",
      why: "A7-1's guard refuses every identity-session registration for this tenant, including the system-import session every governance write runs under. That session necessarily predates the guard and cannot be recreated. Revoking it would leave the tenant permanently unwritable — no parameter could be imported, no decision registered, no trace persisted, ever again.",
      assertion_made_instead: "Exactly one active session remains, it is the named system-import session, and every other session on this tenant is revoked.",
      follow_up: "If the system-import session is ever revoked or expires, restoring write access to legal.reference.il requires a migration that grants an exception to the A7-1 refusal, reviewed as the security change it is.",
      system_import_session_expires_at: before?.find((row) => row.sid === SANCTIONED_SID)?.created_at ? "see census" : "unknown",
    },
    cases: results,
    passed: results.every((entry) => entry.outcome === "pass"),
  };
  writeFileSync(path.join(RECEIPT_ROOT, "identity-session-revocation.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ passed: receipt.passed, sessions_active: receipt.sessions_active, revoked_this_run: revoked, rows_deleted: 0 }, null, 2)}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome.toUpperCase()} ${entry.case} — ${entry.observed}\n`);
  if (!receipt.passed) process.exitCode = 1;
}

await main();
