// F4. Every parsed observation becomes a packet, and its blocked record gains a
// sibling supersession row. The blocked record itself is never touched.
//
// Runs as the operations runtime role with a real runtime context, through the
// same definer functions the product uses. Every write carries the observation
// id as its idempotency key, so a second run adds nothing, and the three-state
// accounting is read back from the database afterwards — not recomputed here —
// and asserted in the exact form the invariant is stated in:
//
//   accounted = projected + blocked_active + blocked_superseded = 71
//   packets_from_supersession = blocked_superseded
//
// A disagreement between those last two is the failure the supersession table
// exists to catch, and this reports it rather than reconciling it by hand.
//
// Nothing becomes reviewed, signed, active or delivered. Every packet is
// enqueued `pending_review` with `activation_allowed` constrained false by the
// table itself, and every artifact keeps `review_state: needs_review`.

import "../production-refusal.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const ARTIFACTS = path.join("output", WAVE, "observations", "summary.json");
const TENANT = "tenant.synthetic.001";
const SESSION_ID = "session.projection.wave1";
const TOKEN_ID = "token.projection.wave1";
// The enqueue attributes the mutation to `system_projection` and the runtime
// asserts that name against the verified actor, so the fixture session must
// carry it as its subject. The earlier fixture actor never reached that assert
// because nothing had enqueued a valid packet before.
const ACTOR_ID = "system_projection";
const DENOMINATOR = 71;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Artifact = Readonly<{
  observation_id: string; outcome: string;
  raw_artifact_sha256: string; normalized_text_sha256: string;
  parser_version: string; normalizer_version: string; ocr_derived: boolean;
  source_url: string; chunk_count: number; page_count: number;
  pages_with_text: number; visual_order: boolean;
}>;

/** A canonical, order-stable serialization so the same artifact hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!adminUrl || !operationsUrl) throw new Error("SUPERSEDE_DEV_ENV_MISSING");
  const summary = JSON.parse(readFileSync(ARTIFACTS, "utf8")) as { results: Artifact[] };
  const parsed = summary.results.filter((row) => row.outcome === "parsed");
  const { default: pg } = await import("pg");

  // The fixture session the runtime context resolves against.
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
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
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
    let packetsWritten = 0;
    let packetsReplayed = 0;
    let supersessionsWritten = 0;
    let supersessionsConflicted = 0;
    try {
      await client.query("begin");
      await client.query("select * from private.runtime_context_install($1,$2,$3)",
        [SESSION_ID, TOKEN_ID, `supersede:${label}`]);
      for (const artifact of parsed) {
        const packetId = `packet:${artifact.observation_id}`;
        const manifest = {
          observation_id: artifact.observation_id,
          raw_artifact_sha256: artifact.raw_artifact_sha256,
          normalized_text_sha256: artifact.normalized_text_sha256,
          parser_version: artifact.parser_version,
          normalizer_version: artifact.normalizer_version,
          ocr_derived: artifact.ocr_derived,
          chunk_count: artifact.chunk_count,
        };
        const manifestSha256 = sha256(canonical(manifest));
        const binding = {
          source_version_id: `${artifact.observation_id}@${artifact.raw_artifact_sha256.slice(0, 16)}`,
          raw_artifact_sha256: artifact.raw_artifact_sha256,
          normalized_text_sha256: artifact.normalized_text_sha256,
          manifest_sha256: manifestSha256,
          parser_version: artifact.parser_version,
          normalizer_version: artifact.normalizer_version,
          // Carried into the packet so a reader of the packet alone sees which
          // path produced it; derived text needs human attestation.
          ocr_derived: artifact.ocr_derived,
          visual_order: artifact.visual_order,
        };
        const scope = {
          topic: "working_time_permits",
          source_url: artifact.source_url,
          page_count: artifact.page_count,
          pages_with_text: artifact.pages_with_text,
        };
        const body = {
          schema_version: "tivdoc-legal-review-v0.10.3",
          packet_id: packetId, revision: 1, state: "pending_review",
          binding, scope, citations: [] as unknown[],
        };
        const packetSha256 = sha256(canonical(body));
        const packet = { ...body, packet_sha256: packetSha256 };
        const receipt = await client.query(
          `select * from private.governance_legal_review_packet_enqueue(
             $1,$2::jsonb,$3,$4::jsonb,$5,$6,$7::timestamptz)`,
          [TENANT, JSON.stringify(packet), 500, JSON.stringify([]),
            `supersede:${artifact.observation_id}`,
            sha256(`enqueue|${artifact.observation_id}|${packetSha256}`), new Date().toISOString()],
        );
        if ((receipt.rows[0] as { idempotent_replay?: boolean }).idempotent_replay) packetsReplayed += 1;
        else packetsWritten += 1;

        try {
          await client.query("savepoint supersession");
          await client.query(
            `select private.governance_legal_review_observation_supersession_append(
               $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz)`,
            [TENANT, artifact.observation_id, packetId, manifestSha256,
              artifact.normalized_text_sha256, artifact.parser_version,
              artifact.normalizer_version, artifact.ocr_derived, new Date().toISOString()],
          );
          await client.query("release savepoint supersession");
          supersessionsWritten += 1;
        } catch (error) {
          await client.query("rollback to savepoint supersession");
          // One supersession per observation is the primary key; a second run
          // hits it and that is the idempotency, not a failure.
          if ((error as { code?: string }).code === "23505") supersessionsConflicted += 1;
          else throw error;
        }
      }
      const totals = (await client.query(
        "select * from private.governance_legal_review_projection_accounting_v2($1)", [TENANT],
      )).rows[0] as Record<string, string>;
      await client.query("commit");
      return { packetsWritten, packetsReplayed, supersessionsWritten, supersessionsConflicted, totals };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw new Error(`SUPERSEDE_${label.toUpperCase()}_FAILED:${
        (error as { code?: string }).code ?? ""}:${String((error as Error).message).slice(0, 160)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  const first = await write("apply");
  const replay = await write("replay");

  const t = first.totals;
  const projected = Number(t.projected);
  const active = Number(t.blocked_active);
  const superseded = Number(t.blocked_superseded);
  const accounted = Number(t.accounted);
  const packets = Number(t.packets_from_supersession);
  const invariantHolds = projected + active + superseded === accounted && accounted === DENOMINATOR;
  const linkHolds = packets === superseded;
  const replayAddedNothing = replay.packetsWritten === 0 && replay.supersessionsWritten === 0;

  writeFileSync(path.join(RECEIPT_ROOT, "observation-supersede.json"), `${JSON.stringify({
    schema_version: "tivdoc-observation-supersede-f4",
    parsed_artifacts: parsed.length,
    first, replay,
    three_state: `projected ${projected} + blocked_active ${active} + blocked_superseded ${superseded} = ${accounted}`,
    packet_link: `packets_from_supersession = ${packets}`,
    invariant_holds: invariantHolds, packet_link_holds: linkHolds,
    replay_added_nothing: replayAddedNothing,
    ocr_derived_packets: parsed.filter((row) => row.ocr_derived).length,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`projected ${projected} + blocked_active ${active} + blocked_superseded ${superseded} = ${accounted}\n`
    + `packets_from_supersession = ${packets}\n`
    + `invariant=${invariantHolds} link=${linkHolds} replay_added_nothing=${replayAddedNothing}`
    + ` first=${JSON.stringify({ p: first.packetsWritten, s: first.supersessionsWritten })}`
    + ` ocr_packets=${parsed.filter((row) => row.ocr_derived).length}\n`);
  if (!invariantHolds || !linkHolds || !replayAddedNothing) process.exitCode = 1;
}

await main();
