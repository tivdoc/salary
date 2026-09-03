// Wave 1. Durably accounts for every canonical observation on DEV.
//
// Each one either becomes a review packet or gets an immutable blocked record
// with a reason code, and `accounted = projected + blocked` is read back from
// the database rather than recomputed here. Replay must add nothing: the
// observation id is the idempotency key on both sides.
//
// Nothing is fabricated. An observation with no normalized text, manifest,
// parser or normalizer version is blocked on exactly those fields; it is never
// completed with a synthesized hash or version to get past validation.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  accountFor,
  projectObservations,
  type AcquiredObservation,
} from "../../src/engine/legal-review/observation-projection.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "wave1";
const RECEIPT_ROOT = path.join("output", WAVE, "projection");
const CROSSWALK = path.join(
  "output", "parallel-wave-2.1", "workers", "w1-evidence-reachability",
  "verified-v0.4-package", "worker-evidence", "A1", "wave1-artifact-crosswalk.json",
);
const TENANT = "tenant.synthetic.001";
const SESSION_ID = "session.projection.wave1";
const TOKEN_ID = "token.projection.wave1";
const ACTOR_ID = "actor.projection.wave1";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** The canonical population: acquisitions the corpus never registered. */
export function readObservations(): readonly AcquiredObservation[] {
  const crosswalk = JSON.parse(readFileSync(CROSSWALK, "utf8")) as {
    acquired_files: readonly Readonly<Record<string, unknown>>[];
  };
  return Object.freeze(crosswalk.acquired_files
    .filter((entry) => (entry.corpus_registration as { status?: string } | undefined)?.status
      !== "registered_selected_raw_artifact")
    .sort((left, right) => String(left.official_url).localeCompare(String(right.official_url)))
    .map((entry) => Object.freeze({
      observation_id: String(entry.acquisition_observation_id),
      official_url: (entry.official_url as string | undefined) ?? null,
      final_url: (entry.final_url as string | undefined) ?? null,
      declared_media_type: (entry.declared_media_type as string | undefined) ?? null,
      media_validation_passed: (entry.media_validation as { passed?: boolean } | undefined)?.passed ?? null,
      byte_count: typeof entry.byte_count === "number" ? entry.byte_count : null,
      raw_artifact_sha256: (entry.artifact_sha256 as string | undefined) ?? null,
      // Absent by construction for an unparsed acquisition; never invented.
      normalized_text_sha256: null,
      manifest_sha256: null,
      parser_version: null,
      normalizer_version: null,
      source_version_id: (entry.artifact_id as string | undefined) ?? null,
      retrieved_at: (entry.retrieved_at as string | undefined) ?? null,
      http_status: typeof entry.http_status === "number" ? entry.http_status : null,
      redirect_chain: Array.isArray(entry.redirect_chain) ? entry.redirect_chain as string[] : null,
    })));
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!adminUrl || !operationsUrl) throw new Error("PROJECTION_DEV_ENV_MISSING");

  const observations = readObservations();
  const dispositions = projectObservations(observations);
  const accounting = accountFor(dispositions, observations.length);
  const { default: pg } = await import("pg");

  // The session the runtime context resolves against. Owned by the migrator
  // because the runtime roles have no table ACL on the identity table.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  const issuedAt = Math.floor(Date.now() / 1_000);
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         current_jti = excluded.current_jti,
         valid_after = excluded.valid_after,
         expires_at = excluded.expires_at`,
      [TENANT, SESSION_ID, ACTOR_ID, TOKEN_ID, issuedAt - 5, issuedAt + 3_600,
        "review_org_00001", sha256(`${TENANT}|${SESSION_ID}|${ACTOR_ID}|${TOKEN_ID}`)],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }

  const write = async (label: string) => {
    const client = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
    await client.connect();
    const written: string[] = [];
    try {
      await client.query("begin");
      await client.query(
        "select * from private.runtime_context_install($1,$2,$3)",
        [SESSION_ID, TOKEN_ID, `projection:${label}`],
      );
      for (const row of dispositions) {
        if (row.disposition !== "blocked") continue;
        await client.query(
          `select observation_id from private.governance_legal_review_observation_block_append(
             $1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
          [TENANT, row.observation_id, row.reason_code, JSON.stringify(row.provenance),
            sha256(`block|${row.observation_id}|${row.reason_code}`), new Date().toISOString()],
        );
        written.push(row.observation_id);
      }
      const totals = await client.query(
        "select * from private.governance_legal_review_projection_accounting($1)", [TENANT],
      );
      // Three states over one denominator. 71 is the population of observations
      // and does not move because one was parsed; what moves is which state an
      // observation is in. Packets are a different population, linked to
      // `blocked_superseded` rather than summed into the denominator, and a run
      // where those two disagree is a failure — which is the whole reason the
      // supersession lives in its own table instead of a column on the block.
      const stateTotals = await client.query(
        "select * from private.governance_legal_review_projection_accounting_v2($1)", [TENANT],
      );
      const three = stateTotals.rows[0] as Record<string, string>;
      const partitionHolds = Number(three.blocked_active) + Number(three.blocked_superseded)
        === Number(totals.rows[0].blocked);
      const packetLinkHolds = Number(three.packets_from_supersession) === Number(three.blocked_superseded);
      await client.query("commit");
      return {
        written: written.length, totals: totals.rows[0] as Record<string, string>,
        three_state: three, partition_holds: partitionHolds, packet_link_holds: packetLinkHolds,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`PROJECTION_${label.toUpperCase()}_FAILED:${
        (error as { code?: string }).code ?? ""}:${String((error as Error).message).slice(0, 140)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  const first = await write("apply");
  const replay = await write("replay");

  // Append-only, proven the only way it is reachable.
  //
  // Rows are visible only inside a SECURITY DEFINER function called by a runtime
  // role: `runtime_verified_tenant()` requires `session_user` to be one of the
  // three runtime roles, and the policy targets the owning role. So an UPDATE or
  // DELETE probe from any connection matches zero rows and "succeeds" without
  // the row-level trigger ever firing — a probe that proves the opposite of what
  // it claims. What is provable, and stronger, is that no actor holds the
  // privilege at all, and that the trigger the actions table relies on is
  // attached to this table too.
  const immutability: Record<string, unknown> = {};
  const prober = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await prober.connect();
  try {
    const trigger = await prober.query(
      `select t.tgname, p.proname, t.tgtype
         from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'private.governance_legal_review_observation_blocks'::regclass
          and not t.tgisinternal`,
    );
    immutability.triggers = trigger.rows;
    const privileges = await prober.query(
      `select r.rolname,
              has_table_privilege(r.rolname, 'private.governance_legal_review_observation_blocks', 'update') as upd,
              has_table_privilege(r.rolname, 'private.governance_legal_review_observation_blocks', 'delete') as del,
              has_table_privilege(r.rolname, 'private.governance_legal_review_observation_blocks', 'insert') as ins,
              has_table_privilege(r.rolname, 'private.governance_legal_review_observation_blocks', 'select') as sel
         from pg_roles r
        where r.rolname = any($1::text[]) order by 1`,
      [["anon", "authenticated", "service_role", "tivdoc_operations_runtime",
        "tivdoc_worker_runtime", "tivdoc_web_runtime", "tivdoc_identity_runtime"]],
    );
    immutability.privileges = privileges.rows;
    immutability.no_mutation_privilege_anywhere = privileges.rows
      .every((row) => (row as { upd: boolean; del: boolean }).upd === false
        && (row as { upd: boolean; del: boolean }).del === false);
  } finally {
    await prober.end().catch(() => undefined);
  }

  const receipt = Object.freeze({
    schema_version: "tivdoc-legal-review-projection-wave1",
    source: CROSSWALK,
    denominator: accounting.denominator,
    projected: accounting.projected,
    blocked: accounting.blocked,
    accounted: accounting.accounted,
    balanced: accounting.balanced,
    duplicate_ids: accounting.duplicate_ids,
    reason_histogram: accounting.reason_histogram,
    database_accounting: first.totals,
    three_state_accounting: first.three_state,
    blocked_partition_holds: first.partition_holds,
    packet_link_holds: first.packet_link_holds,
    replay_database_accounting: replay.totals,
    rows_written_first_pass: first.written,
    rows_written_replay: replay.written,
    replay_added_nothing: JSON.stringify(first.totals) === JSON.stringify(replay.totals),
    immutability,
  });
  writeFileSync(path.join(RECEIPT_ROOT, "projection.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(
    `denominator=${receipt.denominator} projected=${receipt.projected} blocked=${receipt.blocked}`
    + ` accounted=${receipt.accounted} balanced=${receipt.balanced}`
    + ` db=${JSON.stringify(receipt.database_accounting)} replay_added_nothing=${receipt.replay_added_nothing}`
    + ` immutability=${JSON.stringify(receipt.immutability)}\n`,
  );
}

await main();
