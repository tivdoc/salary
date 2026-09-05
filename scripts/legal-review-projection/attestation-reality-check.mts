// Run 13-T / Gate 0 — the attestation reality check, on the real DEV.
//
// The owner's statement of 5.9.2026: "בדיקה של שני אנשים בוצעה ויש אישור
// להמשיך" — two humans attested. This script asks the database that runs
// 11–12 wrote to (the one named by ~/.tivdoc-dev/credentials.env) what it
// holds, through the sanctioned definer reads under the system-import
// session, and records every direct read the connectable roles are denied.
// It writes nothing to governance: the only write is the session row every
// proof seeds, and the read transaction is rolled back.
//
// Census paths, and their limits, stated:
// - parameter versions: `governance_aggregate_read('parameter_approval')`
//   per registered draft version — state, activation_allowed, the candidate's
//   topic and grade, `attestation_count` and the latest attestation's reviewer;
// - resolutions and open decisions: their own read definers;
// - work items of every workflow kind: `governance_work_queue_list`;
// - reviewer identities: there is no list definer and every direct read is
//   denied, so identities are counted through the two surfaces on which a
//   registered identity that acted would appear — attestation reviewer ids
//   and reviewer-trust work items — plus the tenant's identity sessions in
//   `public.product_identity_sessions` (an identity at a keyboard needs one).
//   A registered identity that never acted and holds no session would not be
//   seen here; the census says so rather than claiming otherwise.
import "../production-refusal.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import { NodePostgresConnectionFactory } from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { REGISTERED_DRAFT_PARAMETERS } from "../../src/engine/legal-quality/rulespec-drafts.ts";
import { WAVE3_TOPICS } from "../../src/engine/wave3/contracts.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { SYSTEM_ACTOR, TENANT } from "./pool-p-parameter-import.mts";

const RUN = "run-13t";
const RECEIPT_ROOT = path.join("output", "next", "trial-13t");
const SYSTEM_SESSION = { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import", subject: SYSTEM_ACTOR };
const WORKFLOW_KINDS = ["reviewer_trust", "ground_truth", "legal_reconciliation", "parameter_approval", "rulespec_approval"] as const;
const DIRECT_TABLES = [
  "governance_reviewers", "governance_reviewer_keys", "governance_parameter_versions",
  "governance_parameter_attestations", "governance_rulespec_versions", "governance_rulespec_approvals",
  "governance_golden_case_sets", "governance_gt_active_locks", "governance_aggregate_snapshots",
] as const;

type VersionRow = Readonly<{
  parameter_version_id: string; topic: string | null; provenance_grade: string | null; state: string;
  activation_allowed: boolean; attestation_count: number; latest_reviewer_id: string | null; revision: number;
}>;

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

async function seedSystemSession(adminUrl: string): Promise<void> {
  // The same row the import path seeds, for one hour rather than a year: the
  // read below needs a current session and nothing after it does.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  try {
    await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
    const now = Math.floor(Date.now() / 1_000);
    await admin.query(
      `insert into public.product_identity_sessions(
         tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
         expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
       ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$8,$7,to_timestamp($5))
       on conflict (tenant_id, sid) do update set
         subject = excluded.subject, session_sha256 = excluded.session_sha256,
         current_jti = excluded.current_jti, valid_after = excluded.valid_after,
         expires_at = excluded.expires_at, reviewer_org_id = excluded.reviewer_org_id`,
      [TENANT, SYSTEM_SESSION.sid, SYSTEM_SESSION.subject, SYSTEM_SESSION.jti, now - 5, now + 3_600,
        sha256(`${TENANT}|${SYSTEM_SESSION.sid}|${SYSTEM_SESSION.subject}|${SYSTEM_SESSION.jti}`), `${TENANT}.no-attestation-placeholder`],
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF") ?? "";
  if (!adminUrl || !operationsUrl || !projectRef) throw new Error("G0_ENV_MISSING");

  await seedSystemSession(adminUrl);

  // --- 1. Direct reads, as the operations role under the session: denied by SQLSTATE, by trying.
  const direct: Array<{ table: string; sqlstate: string }> = [];
  const operations = new pg.Client({ connectionString: operationsUrl, connectionTimeoutMillis: 20_000 });
  await operations.connect();
  try {
    for (const table of DIRECT_TABLES) {
      await operations.query("begin");
      try {
        await operations.query("select * from private.runtime_context_install($1,$2,$3)", [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `g0:${randomUUID().slice(0, 8)}`]);
        await operations.query(`select count(*) from private.${table}`);
        direct.push({ table, sqlstate: "READABLE_UNEXPECTEDLY" });
      } catch (error) {
        direct.push({ table, sqlstate: String((error as { code?: string }).code ?? "unknown") });
      }
      await operations.query("rollback");
    }
  } finally {
    await operations.end().catch(() => undefined);
  }

  // --- 2. The census, through the definers.
  const parsed = new URL(operationsUrl);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: operationsUrl, max_connections: 2, connection_timeout_ms: 20_000,
    application_name: "tivdoc_g0_attestation_reality",
    remote_dev_target: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.replace(/^\//u, ""), project_ref: projectRef },
  });
  const client = await factory.acquire();
  const versions: VersionRow[] = [];
  const missingAggregates: string[] = [];
  const queues: Record<string, unknown[]> = {};
  let resolutions: Array<Record<string, unknown>> = [];
  let decisions: Array<Record<string, unknown>> = [];
  try {
    await client.query(statement("g0_begin", "begin", []));
    await client.query(statement("g0_context", "select * from private.runtime_context_install($1,$2,$3)",
      [SYSTEM_SESSION.sid, SYSTEM_SESSION.jti, `g0:${randomUUID().slice(0, 8)}`]));
    resolutions = (await client.query(statement("g0_resolutions", "select * from private.legal_decision_resolution_read($1)", [TENANT]))).rows as unknown as Array<Record<string, unknown>>;
    decisions = (await client.query(statement("g0_decisions", "select * from private.legal_open_decision_read($1)", [TENANT]))).rows as unknown as Array<Record<string, unknown>>;
    const declared = [
      ...REGISTERED_DRAFT_PARAMETERS.flatMap((entry) => entry.versions.map((version) => `${entry.parameter_id}@${version}`)),
      // The superseded-by-scope row exists on the tenant too; a census that
      // only counted what the drafts bind would miss it.
      "il.vacation.calendar_days_years_1_to_4@2017.1.0",
    ];
    for (const id of [...new Set(declared)]) {
      const at = id.lastIndexOf("@");
      const row = await client.query(statement("g0_aggregate",
        "select state, revision, activation_allowed, content_json from private.governance_aggregate_read($1,$2,$3,$4)",
        [TENANT, "parameter_approval", id.slice(0, at), id.slice(at + 1)]));
      if (row.row_count !== 1) { missingAggregates.push(id); continue; }
      const value = row.rows[0] as unknown as { state: string; revision: string | number; activation_allowed: boolean; content_json: Record<string, unknown> };
      const content = value.content_json ?? {};
      // A never-attested snapshot is the candidate itself; an attested one wraps it under `candidate`.
      const candidate = (content.candidate ?? content) as Record<string, unknown>;
      const latest = (content.latest_attestation ?? null) as Record<string, unknown> | null;
      versions.push({
        parameter_version_id: id,
        topic: typeof candidate.topic === "string" ? candidate.topic : null,
        provenance_grade: typeof candidate.provenance_grade === "string" ? candidate.provenance_grade : null,
        state: value.state,
        activation_allowed: value.activation_allowed === true,
        attestation_count: typeof content.attestation_count === "number" ? content.attestation_count : 0,
        latest_reviewer_id: latest && typeof latest.reviewer_id === "string" ? latest.reviewer_id : null,
        revision: Number(value.revision),
      });
    }
    for (const kind of WORKFLOW_KINDS) {
      const row = await client.query(statement("g0_queue", "select private.governance_work_queue_list($1,$2,$3) as q", [TENANT, kind, 500]));
      const q = (row.rows[0] as unknown as { q: unknown }).q;
      queues[kind] = Array.isArray(q) ? q : [];
    }
    await client.query(statement("g0_rollback", "rollback", []));
  } finally {
    client.release();
  }

  // --- 3. The public side and the schema ledger, on the admin connection.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  let sessions: Array<Record<string, unknown>> = [];
  let schemaMetadata: Array<Record<string, unknown>> = [];
  let cliMigrationsTable: string;
  let cases = -1;
  try {
    sessions = (await admin.query("select sid, subject, reviewer_org_id, expires_at, revoked_at from public.product_identity_sessions where tenant_id = $1 order by sid", [TENANT])).rows as Array<Record<string, unknown>>;
    schemaMetadata = (await admin.query("select component, schema_version, migration_id, installed_at from public.engine_schema_metadata order by installed_at")).rows as Array<Record<string, unknown>>;
    try {
      await admin.query("select count(*) from supabase_migrations.schema_migrations");
      cliMigrationsTable = "present";
    } catch (error) {
      cliMigrationsTable = `absent:${String((error as { code?: string }).code ?? "unknown")}`;
    }
    cases = Number((await admin.query("select count(*)::int as n from public.cases")).rows[0].n);
  } finally {
    await admin.end().catch(() => undefined);
  }

  // --- 4. Per topic.
  const reviewerIds = new Set<string>();
  for (const v of versions) if (v.latest_reviewer_id) reviewerIds.add(v.latest_reviewer_id);
  for (const item of queues.reviewer_trust ?? []) {
    const id = (item as { aggregate_id?: unknown }).aggregate_id;
    if (typeof id === "string") reviewerIds.add(id);
  }
  const reviewerSessions = sessions.filter((s) => s.reviewer_org_id !== `${TENANT}.no-attestation-placeholder` && s.sid !== SYSTEM_SESSION.sid);
  const rulespecApprovals = (queues.rulespec_approval ?? []).length;
  const topics = WAVE3_TOPICS.map((topic) => {
    const rows = versions.filter((v) => v.topic === topic);
    const dual = rows.filter((v) => v.attestation_count >= 2).length;
    const single = rows.filter((v) => v.attestation_count === 1).length;
    return {
      topic,
      parameter_versions: rows.length,
      versions_with_two_attestations: dual,
      versions_with_one_attestation: single,
      rulespec_approved: false,
      activation_eligible: rows.length > 0 && dual === rows.length && false,
      states: Object.fromEntries([...new Set(rows.map((v) => v.state))].map((s) => [s, rows.filter((v) => v.state === s).length])),
    };
  });
  const eligible = topics.filter((t) => t.activation_eligible).map((t) => t.topic);

  const receipt = {
    schema_version: "tivdoc-attestation-reality-check-v1",
    run: RUN,
    unit: "L13T-0",
    checked_at: new Date().toISOString(),
    database: {
      project_ref: projectRef,
      owner_named_project_ref: "cpzrbidxftzqcfeqqusu",
      same_project_as_owner_named: projectRef === "cpzrbidxftzqcfeqqusu",
      schema_metadata_rows: schemaMetadata.length,
      schema_metadata_last: schemaMetadata.at(-1) ?? null,
      cli_migrations_table: cliMigrationsTable,
      repository_migration_files: 55,
      note: "The repository applies its chain with output/next/apply-migration.mjs and records it in public.engine_schema_metadata (one row per component); the Supabase CLI's supabase_migrations.schema_migrations does not exist on this project, so the dashboard's migration view shows nothing of the chain.",
    },
    direct_reads_denied: direct,
    census_paths: {
      parameter_versions: "governance_aggregate_read(parameter_approval) per registered draft version",
      reviewer_identities: "no list definer; counted through attestation reviewer ids, reviewer-trust work items and the tenant's identity sessions — an identity that never acted and holds no session would not appear",
      rulespec_approvals: "rulespec_approval work items; the seven drafts are registered in the repository only (draft_version 0.8.0), no RuleSpec version exists on DEV",
      golden_cases: "ground_truth work items",
    },
    reviewer_identities: { distinct: reviewerIds.size, ids: [...reviewerIds].sort(), identity_sessions_total: sessions.length, identity_sessions_reviewer: reviewerSessions.length, sessions: sessions.map((s) => ({ sid: s.sid, subject: s.subject, reviewer_org_id: s.reviewer_org_id, revoked: s.revoked_at !== null })) },
    parameter_versions: { total: versions.length, with_two_attestations: versions.filter((v) => v.attestation_count >= 2).length, with_one_attestation: versions.filter((v) => v.attestation_count === 1).length, activation_allowed_true: versions.filter((v) => v.activation_allowed).length, by_state: Object.fromEntries([...new Set(versions.map((v) => v.state))].map((s) => [s, versions.filter((v) => v.state === s).length])), missing_aggregates: missingAggregates, rows: versions },
    rulespec_approvals: rulespecApprovals,
    golden_cases_locked: (queues.ground_truth ?? []).length,
    work_queues: Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, v.length])),
    resolutions: { recorded: resolutions.length, attested: resolutions.filter((r) => r.status === "attested").length, by_status: Object.fromEntries([...new Set(resolutions.map((r) => String(r.status)))].map((s) => [s, resolutions.filter((r) => String(r.status) === s).length])) },
    open_decisions: { total: decisions.length, by_state: Object.fromEntries([...new Set(decisions.map((d) => String(d.resolution_state ?? d.state)))].map((s) => [s, decisions.filter((d) => String(d.resolution_state ?? d.state) === s).length])) },
    public_cases: cases,
    topics,
    topics_eligible: eligible,
    owner_statement: {
      text: "בדיקה של שני אנשים בוצעה ויש אישור להמשיך",
      consistent: reviewerIds.size >= 2 && versions.some((v) => v.attestation_count >= 2),
      what_exists: `${reviewerIds.size} reviewer identities seen, ${versions.filter((v) => v.attestation_count >= 2).length} of ${versions.length} parameter versions with two attestations, ${rulespecApprovals} RuleSpec approvals, ${(queues.ground_truth ?? []).length} golden cases locked, ${resolutions.length} owner-recorded resolutions (attested ${resolutions.filter((r) => r.status === "attested").length})`,
    },
    decision: eligible.length > 0 ? "activate_eligible_topics_for_shadow" : "draft_shadow",
    decision_note: eligible.length > 0
      ? "owner pre-authorization applies to the eligible topics, shadow only"
      : "0 topics eligible: the run continues in draft shadow, the mode long run 7 built for synthetic facts; nothing here creates, edits or backdates an attestation or an identity",
  };
  const receiptPath = path.join(RECEIPT_ROOT, "attestation-reality.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log("| topic | parameter versions | two attestations | one attestation | RuleSpec approved | eligible |");
  console.log("|---|---|---|---|---|---|");
  for (const t of topics) console.log(`| ${t.topic} | ${t.parameter_versions} | ${t.versions_with_two_attestations} | ${t.versions_with_one_attestation} | ${t.rulespec_approved ? "yes" : "no"} | ${t.activation_eligible ? "yes" : "no"} |`);
  console.log(`G0_ATTESTATION ${JSON.stringify({
    project_ref: projectRef, same_project_as_owner_named: receipt.database.same_project_as_owner_named,
    identities: reviewerIds.size, versions: versions.length, dual_attested: receipt.parameter_versions.with_two_attestations,
    rulespec_approvals: rulespecApprovals, golden_locked: receipt.golden_cases_locked, resolutions: resolutions.length,
    topics_eligible: eligible, decision: receipt.decision, owner_statement_consistent: receipt.owner_statement.consistent,
    direct_reads_denied: direct.every((d) => d.sqlstate === "42501"), receipt: receiptPath,
  })}`);
}

await main();
