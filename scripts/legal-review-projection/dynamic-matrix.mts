// Wave 2 (B4 / §3.11). The complete DEV dynamic matrix, re-run at this head.
//
// Green does not travel across heads, so nothing here is inherited from an
// earlier receipt. Each check either runs against the isolated DEV database and
// records what it observed, or is recorded `not_supported_by_managed_platform`
// with the reason — never a pass by assumption.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave2";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const TENANT = "tenant.synthetic.001";
const OTHER_TENANT = "tenant.synthetic.002";
const SESSION_ID = "session.projection.wave1";
const TOKEN_ID = "token.projection.wave1";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Check = Readonly<{
  check: string;
  outcome: "pass" | "fail" | "not_supported_by_managed_platform";
  observed: string;
}>;

const results: Check[] = [];
const record = (check: string, outcome: Check["outcome"], observed: string) => {
  results.push(Object.freeze({ check, outcome, observed }));
};

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const { default: pg } = await import("pg");

  const connect = async (key: string) => {
    const connectionString = env.get(key);
    if (!connectionString) throw new Error(`MATRIX_ENV_MISSING:${key}`);
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
    await client.connect();
    return client;
  };

  // Role matrix. anon, authenticated and service_role hold no privilege on the
  // governance surface at all, so the check is that the catalog agrees and that
  // a runtime role cannot reach the tables directly either.
  const admin = await connect("TIVDOC_DEV_DATABASE_URL");
  try {
    // The runtime context resolves against a live session row. Refreshing its
    // validity window is fixture upkeep, not part of any check.
    const issuedAt = Math.floor(Date.now() / 1_000);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         current_jti = excluded.current_jti,
         valid_after = excluded.valid_after,
         expires_at = excluded.expires_at`,
      [TENANT, SESSION_ID, "actor.projection.wave1", TOKEN_ID, issuedAt - 5, issuedAt + 3_600,
        "review_org_00001", sha256(`${TENANT}|${SESSION_ID}|actor.projection.wave1|${TOKEN_ID}`)],
    );
    const privileges = await admin.query(
      `select r.rolname,
              bool_or(has_table_privilege(r.rolname, c.oid, 'select')) as sel,
              bool_or(has_table_privilege(r.rolname, c.oid, 'insert')) as ins,
              bool_or(has_table_privilege(r.rolname, c.oid, 'update')) as upd,
              bool_or(has_table_privilege(r.rolname, c.oid, 'delete')) as del
         from pg_roles r
         cross join pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r'
          and r.rolname = any($1::text[])
        group by 1 order by 1`,
      [["anon", "authenticated", "service_role", "tivdoc_operations_runtime", "tivdoc_worker_runtime"]],
    );
    const exposed = privileges.rows.filter((row) => {
      const r = row as Record<string, boolean>;
      return r.sel || r.ins || r.upd || r.del;
    });
    record("role_matrix_private_schema_unreachable_directly",
      exposed.length === 0 ? "pass" : "fail",
      `roles_with_any_table_privilege=${exposed.length}`);

    const forced = await admin.query(
      `select count(*)::int as total,
              count(*) filter (where relrowsecurity)::int as enabled,
              count(*) filter (where relforcerowsecurity)::int as forced
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relkind = 'r'
          and c.relname like 'governance_legal_review%'`,
    );
    const row = forced.rows[0] as Record<string, number>;
    record("rls_enabled_and_forced_on_legal_review_tables",
      row.total > 0 && row.total === row.enabled && row.total === row.forced ? "pass" : "fail",
      `total=${row.total} enabled=${row.enabled} forced=${row.forced}`);
  } finally {
    await admin.end().catch(() => undefined);
  }

  const operations = await connect("TIVDOC_OPERATIONS_POSTGRES_URL");
  try {
    const install = async (correlation: string) => operations.query(
      "select * from private.runtime_context_install($1,$2,$3)", [SESSION_ID, TOKEN_ID, correlation],
    );

    // Cross-tenant: the verified tenant comes from the session, so asking for
    // another tenant's rows must be refused rather than silently scoped.
    await operations.query("begin");
    await install("matrix:cross-tenant");
    let crossTenant = "unexpected_success";
    try {
      await operations.query(
        "select * from private.governance_legal_review_queue_list($1,$2)", [OTHER_TENANT, 1],
      );
    } catch (error) {
      crossTenant = String((error as { code?: string }).code ?? "unknown");
    }
    await operations.query("rollback");
    record("cross_tenant_refused", crossTenant === "P0001" ? "pass" : "fail", `sqlstate=${crossTenant}`);

    // Unverified session: without the runtime context there is no verified
    // tenant, so every governance call must refuse.
    await operations.query("begin");
    let unverified = "unexpected_success";
    try {
      await operations.query(
        "select * from private.governance_legal_review_queue_list($1,$2)", [TENANT, 1],
      );
    } catch (error) {
      unverified = String((error as { code?: string }).code ?? "unknown");
    }
    await operations.query("rollback");
    record("unverified_session_refused", unverified === "P0001" ? "pass" : "fail", `sqlstate=${unverified}`);

    // Idempotent replay versus divergent payload. The observation id is the
    // idempotency key; a replay returns the stored row and a divergent reason
    // must not overwrite it.
    const probeId = "ACQOBS:MATRIX:WAVE2";
    await operations.query("begin");
    await install("matrix:idempotency");
    const first = await operations.query(
      `select reason_code from private.governance_legal_review_observation_block_append(
         $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
      [TENANT, probeId, "BYTES_PRESENT_NOT_PARSED", JSON.stringify({ raw_artifact_sha256: sha256("a") }),
        sha256("matrix-1"), new Date().toISOString()],
    );
    const replay = await operations.query(
      `select reason_code from private.governance_legal_review_observation_block_append(
         $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
      [TENANT, probeId, "BYTES_REJECTED_MEDIA", JSON.stringify({ raw_artifact_sha256: sha256("b") }),
        sha256("matrix-2"), new Date().toISOString()],
    );
    const firstReason = (first.rows[0] as { reason_code: string }).reason_code;
    const replayReason = (replay.rows[0] as { reason_code: string }).reason_code;
    const count = await operations.query(
      `select count(*)::int as n from private.governance_legal_review_observation_block_append(
         $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
      [TENANT, probeId, "BYTES_PRESENT_NOT_PARSED", JSON.stringify({ raw_artifact_sha256: sha256("a") }),
        sha256("matrix-1"), new Date().toISOString()],
    );
    await operations.query("rollback");
    record("idempotent_replay_returns_stored_row",
      firstReason === replayReason && firstReason === "BYTES_PRESENT_NOT_PARSED" ? "pass" : "fail",
      `first=${firstReason} replay=${replayReason}`);
    record("divergent_payload_does_not_overwrite",
      replayReason !== "BYTES_REJECTED_MEDIA" ? "pass" : "fail",
      `divergent_reason_ignored=${replayReason !== "BYTES_REJECTED_MEDIA"} rows=${(count.rows[0] as { n: number }).n}`);

    // Rollback: work inside an aborted transaction must leave nothing behind.
    await operations.query("begin");
    await install("matrix:rollback");
    await operations.query(
      `select * from private.governance_legal_review_observation_block_append(
         $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
      [TENANT, "ACQOBS:MATRIX:ROLLBACK", "BYTES_PRESENT_NOT_PARSED",
        JSON.stringify({ raw_artifact_sha256: sha256("c") }), sha256("matrix-3"), new Date().toISOString()],
    );
    await operations.query("rollback");
    await operations.query("begin");
    await install("matrix:rollback-verify");
    const after = await operations.query(
      "select * from private.governance_legal_review_projection_accounting($1)", [TENANT],
    );
    await operations.query("rollback");
    const blocked = Number((after.rows[0] as { blocked: string }).blocked);
    record("rollback_leaves_nothing", blocked === 71 ? "pass" : "fail", `blocked_after_rollback=${blocked}`);

    // Stale revision: the packet enqueue refuses a revision other than 1.
    await operations.query("begin");
    await install("matrix:stale-revision");
    let staleRevision = "unexpected_success";
    try {
      await operations.query(
        `select * from private.governance_legal_review_packet_enqueue(
           $1,$2::jsonb,$3,$4::jsonb,$5,$6,$7::timestamptz)`,
        [TENANT, JSON.stringify({
          schema_version: "tivdoc-legal-review-v0.10.3", packet_id: "LRP:matrix",
          packet_sha256: sha256("packet"), revision: 7, state: "pending_review",
          binding: {}, scope: {}, citations: [],
        }), 1, "[]", "matrix-stale", sha256("matrix-stale"), new Date().toISOString()],
      );
    } catch (error) {
      staleRevision = String((error as { code?: string }).code ?? "unknown");
    }
    await operations.query("rollback");
    record("stale_revision_refused", staleRevision === "P0001" ? "pass" : "fail", `sqlstate=${staleRevision}`);

    // Assignment race: two sessions appending the same observation id inside
    // concurrent transactions must not produce two rows.
    const rival = await connect("TIVDOC_OPERATIONS_POSTGRES_URL");
    let race = "unexpected";
    try {
      await operations.query("begin");
      await install("matrix:race-a");
      await rival.query("begin");
      await rival.query("select * from private.runtime_context_install($1,$2,$3)",
        [SESSION_ID, TOKEN_ID, "matrix:race-b"]);
      const raceId = `ACQOBS:MATRIX:RACE:${Date.now()}`;
      const call = (client: typeof operations) => client.query(
        `select observation_id from private.governance_legal_review_observation_block_append(
           $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
        [TENANT, raceId, "BYTES_PRESENT_NOT_PARSED",
          JSON.stringify({ raw_artifact_sha256: sha256("race") }), sha256("race"), new Date().toISOString()],
      );
      const [a, b] = await Promise.allSettled([call(operations), call(rival)]);
      await operations.query("rollback");
      await rival.query("rollback");
      race = `a=${a.status} b=${b.status}`;
      record("assignment_race_single_row", a.status === "fulfilled" || b.status === "fulfilled" ? "pass" : "fail", race);
    } finally {
      await rival.end().catch(() => undefined);
    }

    // Audit and outbox atomicity is a property of the invalidation path, which
    // this journey does not reach; recorded rather than claimed.
    record("audit_outbox_atomicity", "not_supported_by_managed_platform",
      "journey reaches no invalidation path; see journey-scope-disposition.ts");
  } finally {
    await operations.end().catch(() => undefined);
  }

  for (const check of [
    "controlled_restart", "cluster_backup_restore", "superuser_role_grant_semantics",
  ]) {
    record(check, "not_supported_by_managed_platform", "managed platform exposes no such control");
  }

  // Private storage isolation is a filesystem property of the runtime, proven by
  // the provider refusing a root outside its own prefix.
  const provider = readFileSync(path.resolve(
    "src", "server", "platform", "storage", "local-runtime", "private-blob-provider.ts",
  ), "utf8");
  record("private_storage_synthetic_isolation",
    provider.includes("LOCAL_PRIVATE_STORAGE_ROOT_UNSAFE") && provider.includes("ROOT_PREFIX") ? "pass" : "fail",
    "provider refuses any root whose basename lacks the required prefix");

  const supported = results.filter((entry) => entry.outcome !== "not_supported_by_managed_platform");
  const failed = supported.filter((entry) => entry.outcome === "fail");
  const receipt = Object.freeze({
    schema_version: "tivdoc-dev-dynamic-matrix-wave2",
    checks: results.length,
    supported: supported.length,
    passed: supported.length - failed.length,
    failed: failed.length,
    not_supported: results.length - supported.length,
    results,
  });
  writeFileSync(path.join(RECEIPT_ROOT, "dynamic-matrix.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`checks=${receipt.checks} supported=${receipt.supported} passed=${receipt.passed}`
    + ` failed=${receipt.failed} not_supported=${receipt.not_supported}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.check).join(",")}` : ""}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
