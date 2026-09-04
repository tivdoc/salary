// L4-7 / D5 (BL-18). The system-import session is re-creatable, and here is the
// proof rather than the assurance.
//
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//     scripts/legal-review-projection/identity-session-recovery.mts
//
// BL-18 said the `session.legal.reference.system-import` row could not be
// recreated if lost, because A7-1's guard refuses `product_identity_session_register`
// for the reference tenant, and every governance write on that tenant runs under
// that session. That was true about the sanctioned register path and false about
// recovery: nothing about the row is secret or generated. Its sid, its jti, its
// subject, its reviewer-org label and its `session_sha256` are all derived from
// the tenant name and two fixed strings, and the row is written by an admin
// INSERT that the guard never sees.
//
// So this proves the loop end to end — create, use, lose, fail, recover, use —
// on the synthetic proof tenant, where losing a session costs nothing. The
// reference tenant's own row is never deleted here; what it gets is the same
// idempotent write, which is exactly what recovery would do.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TENANT as REFERENCE_TENANT } from "./pool-p-parameter-import.mts";
import { seedSessions, SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

const RECEIPT_ROOT = path.join("output", "next", "identity");

/**
 * The reference tenant's system-import session, derived rather than remembered.
 * Every field is a function of the tenant name; nothing here was generated once
 * and lost. This is the whole of what recovery needs to know.
 */
export const SYSTEM_IMPORT_SESSION = Object.freeze({
  sid: `session.${REFERENCE_TENANT}.system-import`.replace(`${REFERENCE_TENANT}.`, "legal.reference."),
  jti: "token.legal.reference.system-import",
  subject: "system_import",
});
const REFERENCE_ORG = `${REFERENCE_TENANT}.no-attestation-placeholder`;

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const identityUrl = env.get("TIVDOC_IDENTITY_POSTGRES_URL");
  if (!adminUrl || !operationsUrl || !identityUrl) throw new Error("L47_ENV_MISSING");

  const cases: Case[] = [];
  const record = (name: string, passed: boolean, observed: string) =>
    cases.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));

  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const drill = {
    sid: `session.synthetic.proof.recovery.${runId}`,
    jti: `token.synthetic.proof.recovery.${runId}`,
    subject: `synthetic.recovery.${runId}`,
  };
  const drillOrg = `synthetic.proof.org.recovery.${runId}`;

  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_l47_session_recovery",
    remote_dev_target: {
      host: parsed.hostname, port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//u, ""), project_ref: env.get("TIVDOC_DEV_PROJECT_REF") ?? "",
    },
  });

  /** Can the operations role open a runtime context under this session right now? */
  const install = async (sid: string, jti: string): Promise<string> => {
    const client = await factory.acquire();
    try {
      await client.query(statement("l47_begin", "begin", []));
      await client.query(statement("l47_context", "select * from private.runtime_context_install($1,$2,$3)",
        [sid, jti, `l47:${randomUUID().slice(0, 8)}`]));
      await client.query(statement("l47_rollback", "rollback", []));
      return "installed";
    } catch (error) {
      await client.query(statement("l47_rollback_error", "rollback", [])).catch(() => undefined);
      return String((error as { message?: string }).message ?? "unknown").slice(0, 90);
    } finally {
      client.release();
    }
  };

  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    // 1. Create it from the deterministic helper, and use it.
    await seedSessions(SYNTHETIC_PROOF_TENANT, drillOrg, [drill]);
    record("created_from_the_helper", (await install(drill.sid, drill.jti)) === "installed", drill.sid);

    // 2. Lose it — through the sanctioned revoke, as the identity runtime.
    //    The first version of this deleted the row as the admin and counted a
    //    zero-row DELETE as a successful loss: force-RLS on the sessions table
    //    silently matched nothing, and the next case then "passed" against a
    //    session that had never gone anywhere. Revocation is the loss this
    //    system actually has, and it reports what it did.
    const identity = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
    await identity.connect();
    let revoked = false;
    try {
      await identity.query("select set_config('tivdoc.tenant_id', $1, false)", [SYNTHETIC_PROOF_TENANT]);
      const result = await identity.query("select private.product_session_revoke($1, now()) as revoked", [drill.sid]);
      revoked = (result.rows[0] as { revoked: boolean }).revoked === true;
    } finally {
      await identity.end().catch(() => undefined);
    }
    record("lost", revoked, `revoked=${revoked}`);

    // 3. Confirm the loss is a real loss and not a soft one.
    const afterLoss = await install(drill.sid, drill.jti);
    record("refused_while_lost", afterLoss !== "installed", afterLoss);

    // 4. Re-seeding the revoked sid must NOT bring it back. Recovery is not a
    //    way to undo a revocation, and a helper that quietly cleared
    //    `revoked_at` would be exactly that. The upsert leaves it alone.
    await seedSessions(SYNTHETIC_PROOF_TENANT, drillOrg, [drill]);
    const resurrect = await install(drill.sid, drill.jti);
    record("the_helper_does_not_resurrect_a_revoked_session", resurrect !== "installed", resurrect);

    // 5. Recovery mints the next session instead, from the same three strings
    //    and one suffix, and it works immediately. That is the whole procedure:
    //    a lost or revoked session is a rename, not an incident.
    const recovered = { sid: `${drill.sid}.r2`, jti: `${drill.jti}.r2`, subject: drill.subject };
    await seedSessions(SYNTHETIC_PROOF_TENANT, drillOrg, [recovered]);
    const afterRecovery = await install(recovered.sid, recovered.jti);
    record("recovered_under_a_fresh_sid", afterRecovery === "installed", `${recovered.sid} -> ${afterRecovery}`);

    // 6. The reference tenant's own row: the same idempotent write, which is
    //    what recovery would be. Nothing is deleted and nothing is revoked.
    await seedSessions(REFERENCE_TENANT, REFERENCE_ORG, [SYSTEM_IMPORT_SESSION]);
    const reference = await install(SYSTEM_IMPORT_SESSION.sid, SYSTEM_IMPORT_SESSION.jti);
    record("reference_session_rewritten_idempotently", reference === "installed", reference);

    // 7. And the guard A7-1 puts on the sanctioned path is still there — the
    //    recovery route is the admin write, not a hole in the guard.
    // The probe runs as tivdoc_identity_runtime, the ONE role granted execute on
    // that function. Running it as any other role would earn a 42501 from the
    // ACL and prove nothing about A7-1, which is the mistake the earlier version
    // of this case made: it recorded "refused" without checking what refused it.
    const guarded = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
    await guarded.connect();
    let guardVerdict = "not refused";
    try {
      await guarded.query("select set_config('tivdoc.tenant_id', $1, false)", [REFERENCE_TENANT]);
      await guarded.query(
        "select * from private.product_identity_session_register($1,$2,$3,$4,now(),now() + interval '1 hour',$5,now())",
        [`session.legal.reference.probe.${runId}`, "probe", `token.legal.reference.probe.${runId}`, "1", REFERENCE_ORG]);
    } catch (error) {
      guardVerdict = String((error as { message?: string }).message ?? "unknown").slice(0, 120);
    } finally {
      await guarded.end().catch(() => undefined);
    }
    record("a7_1_guard_still_refuses_the_sanctioned_path",
      guardVerdict.includes("IDENTITY_SESSION_REFUSED_FOR_REFERENCE_TENANT"), guardVerdict);
    // And the same call on a tenant A7-1 does not name must succeed, or the
    // case above proves only that the function is broken.
    const control = new pg.Client({ connectionString: identityUrl, connectionTimeoutMillis: 20_000 });
    await control.connect();
    let controlVerdict = "refused";
    try {
      await control.query("select set_config('tivdoc.tenant_id', $1, false)", [SYNTHETIC_PROOF_TENANT]);
      await control.query(
        "select * from private.product_identity_session_register($1,$2,$3,$4,now(),now() + interval '1 hour',$5,now())",
        [`session.synthetic.proof.control.${runId}`, "control", `token.synthetic.proof.control.${runId}`, "1", drillOrg]);
      controlVerdict = "registered";
    } catch (error) {
      controlVerdict = String((error as { message?: string }).message ?? "unknown").slice(0, 120);
    } finally {
      await control.end().catch(() => undefined);
    }
    record("the_same_call_succeeds_on_a_tenant_the_guard_does_not_name", controlVerdict === "registered", controlVerdict);
  } finally {
    await admin.end().catch(() => undefined);
    await factory.shutdown?.();
  }

  const failed = cases.filter((entry) => entry.outcome === "fail");
  const receipt = {
    schema_version: "tivdoc-identity-session-recovery-v0.10.16",
    unit: "L4-7",
    blocker: "BL-18",
    recovery_procedure: [
      "The session row is derived, not remembered. Everything it needs is three fixed strings and the tenant name:",
      `  sid     = ${SYSTEM_IMPORT_SESSION.sid}`,
      `  jti     = ${SYSTEM_IMPORT_SESSION.jti}`,
      `  subject = ${SYSTEM_IMPORT_SESSION.subject}`,
      `  reviewer_org_id = ${REFERENCE_ORG}`,
      "  session_sha256  = sha256(`${tenant}|${sid}|${subject}|${jti}`)",
      "Recovery is one command, and it is idempotent — running it when the row already exists changes nothing:",
      "A REVOKED session is not resurrected by it, deliberately: revocation is a decision and recovery is not a way to undo one. If the system-import session is ever revoked rather than lost, recovery mints the next sid (append a suffix) and the fourteen scripts that name it are updated together. Proven below on the synthetic tenant.",
      "  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \\",
      "    scripts/legal-review-projection/identity-session-recovery.mts",
      "It writes as the admin role, which is why A7-1's refusal of the sanctioned register path does not block it. That refusal is intact and is checked above.",
    ],
    passed: cases.length - failed.length,
    total: cases.length,
    reference_session_deleted: false,
    reference_session_revoked: false,
    cases,
  };
  writeFileSync(path.join(RECEIPT_ROOT, "identity-session-recovery.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`L4_7_SESSION_RECOVERY ${JSON.stringify({ passed: receipt.passed, total: receipt.total })}`);
  if (failed.length > 0) process.exitCode = 3;
}

await main();
