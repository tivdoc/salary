// Wave 3 (C1 item 6). Executed as the identity runtime role against DEV.
//
// A caller that supplies or forges another tenant must read zero rows and must
// not be able to rotate or revoke. Read, rotate and revoke each get their own
// case, and each observes the row afterwards rather than trusting a return
// value: an effect asserter has to assert the effect.

import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave3";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TENANT = "tenant.synthetic.001";
const FORGED_TENANT = "tenant.synthetic.forged";
const SID = "session.identity.negative.wave3";
const FORGED_SID = "session.identity.forged.wave3";
const SUBJECT = "actor.identity.negative.wave3";
const TOKEN = "token.identity.negative.wave3";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const identityUrl = env.get("TIVDOC_IDENTITY_POSTGRES_URL");
  if (!adminUrl || !identityUrl) throw new Error("IDENTITY_MATRIX_ENV_MISSING");
  const { default: pg } = await import("pg");

  // A row belonging to the real tenant, planted by an admin that declares its
  // own tenant — the same rule the runtime obeys.
  const issuedAt = Math.floor(Date.now() / 1_000);
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,0,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         current_jti = excluded.current_jti, rotation_counter = 0,
         revoked_at = null, valid_after = excluded.valid_after, expires_at = excluded.expires_at`,
      [TENANT, SID, SUBJECT, TOKEN, issuedAt - 60, issuedAt + 3_600,
        "review_org_00001", sha256(`${TENANT}|${SID}|${SUBJECT}|${TOKEN}`)],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const identity = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
  await identity.connect();
  const observe = async () => {
    const row = await identity.query(
      "select * from private.product_identity_session_read($1)", [SID],
    );
    return (row.rows[0] ?? null) as Readonly<Record<string, unknown>> | null;
  };
  try {
    // READ — a forged session identifier resolves to nothing.
    const forged = await identity.query(
      "select * from private.product_identity_session_read($1)", [FORGED_SID],
    );
    record("read_forged_sid_returns_zero_rows", forged.rowCount === 0, `rows=${forged.rowCount}`);

    // READ — the real row carries its own tenant, which is what the caller
    // compares against the token claim. It never echoes a caller's tenant.
    const real = await observe();
    record("read_returns_the_rows_own_tenant",
      real?.tenant_id === TENANT, `tenant=${String(real?.tenant_id)}`);

    // ROTATE — under a forged tenant context, refused, and the row is unmoved.
    await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [FORGED_TENANT]);
    const rotateForged = await identity.query(
      "select private.product_session_rotate($1,$2,$3,$4::timestamptz) as accepted",
      [SID, "token.forged.wave3", 0, new Date().toISOString()],
    );
    const afterForgedRotate = await observe();
    record("rotate_under_forged_tenant_refused",
      (rotateForged.rows[0] as { accepted: boolean }).accepted === false
      && afterForgedRotate?.current_token_id === TOKEN
      && Number(afterForgedRotate?.rotation_counter) === 0,
      `accepted=${(rotateForged.rows[0] as { accepted: boolean }).accepted}`
      + ` token_unchanged=${afterForgedRotate?.current_token_id === TOKEN}`
      + ` counter=${String(afterForgedRotate?.rotation_counter)}`);

    // REVOKE — same, and the session is still active afterwards.
    const revokeForged = await identity.query(
      "select private.product_session_revoke($1,$2::timestamptz) as accepted",
      [SID, new Date().toISOString()],
    );
    const afterForgedRevoke = await observe();
    record("revoke_under_forged_tenant_refused",
      (revokeForged.rows[0] as { accepted: boolean }).accepted === false
      && afterForgedRevoke?.status === "active",
      `accepted=${(revokeForged.rows[0] as { accepted: boolean }).accepted}`
      + ` status=${String(afterForgedRevoke?.status)}`);

    // ROTATE and REVOKE with no tenant context at all — refused, not defaulted.
    await identity.query("select set_config('tivdoc.tenant_id', '', false)");
    const rotateBare = await identity.query(
      "select private.product_session_rotate($1,$2,$3,$4::timestamptz) as accepted",
      [SID, "token.bare.wave3", 0, new Date().toISOString()],
    );
    const revokeBare = await identity.query(
      "select private.product_session_revoke($1,$2::timestamptz) as accepted",
      [SID, new Date().toISOString()],
    );
    const afterBare = await observe();
    record("rotate_and_revoke_without_tenant_context_refused",
      (rotateBare.rows[0] as { accepted: boolean }).accepted === false
      && (revokeBare.rows[0] as { accepted: boolean }).accepted === false
      && afterBare?.current_token_id === TOKEN && afterBare?.status === "active",
      `rotate=${(rotateBare.rows[0] as { accepted: boolean }).accepted}`
      + ` revoke=${(revokeBare.rows[0] as { accepted: boolean }).accepted}`);

    // The caller cannot reach the table directly at all.
    let direct = "unexpected_success";
    try {
      await identity.query("update public.product_identity_sessions set revoked_at = now()");
    } catch (error) {
      direct = String((error as { code?: string }).code ?? "unknown");
    }
    record("direct_table_mutation_refused", direct === "42501", `sqlstate=${direct}`);

    // The tenant is no longer an argument anywhere in the signature.
    let arity = "unexpected_success";
    try {
      await identity.query(
        "select private.product_session_revoke($1,$2,$3::timestamptz) as accepted",
        [TENANT, SID, new Date().toISOString()],
      );
    } catch (error) {
      arity = String((error as { code?: string }).code ?? "unknown");
    }
    record("old_tenant_bearing_signature_is_gone", arity === "42883", `sqlstate=${arity}`);

    // The legitimate path still works: the real tenant rotates its own session.
    await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const rotateReal = await identity.query(
      "select private.product_session_rotate($1,$2,$3,$4::timestamptz) as accepted",
      [SID, "token.rotated.wave3", 0, new Date().toISOString()],
    );
    const afterReal = await observe();
    record("rotate_under_the_rows_own_tenant_succeeds",
      (rotateReal.rows[0] as { accepted: boolean }).accepted === true
      && afterReal?.current_token_id === "token.rotated.wave3"
      && Number(afterReal?.rotation_counter) === 1,
      `accepted=${(rotateReal.rows[0] as { accepted: boolean }).accepted}`
      + ` token=${String(afterReal?.current_token_id)} counter=${String(afterReal?.rotation_counter)}`);
  } finally {
    await identity.end().catch(() => undefined);
  }

  const failed = results.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "identity-negative-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-identity-negative-matrix-wave3",
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.case).join(",")}` : ""}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
