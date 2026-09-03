// Wave 4 (4B-1). The invalidation effects, observed in the database.
//
// The nine effect assertions in `postgres-port.test.ts` and
// `global-invalidation.test.ts` read values a scripted client was told to
// return. They are honest tests of the port's arithmetic given a database
// response, and no evidence that a database ever produced one. This runs the
// real port, as the real operations role, against DEV, and then reads every
// effect field back out of the tables rather than out of the receipt.
//
// Everything here is synthetic: a fabricated tenant, a fabricated case, a
// fabricated reviewer session and a fabricated job lease. No customer data, no
// reviewer identity, no source, parameter or rule is created or activated.
//
// Teardown removes what the schema permits removing. It does not remove the
// lifecycle revision, the invalidation history row or the dependency state row,
// because those carry append-only triggers — deleting evidence to tidy a
// fixture is the opposite of what this repository enforces everywhere else, so
// the receipt names what remains instead of pretending it was cleaned.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { VerifiedActor } from "../../src/engine/wave4/contracts.ts";
import { statement } from "../../src/server/platform/persistence/postgres/contracts.ts";
import type { PostgresClient } from "../../src/server/platform/persistence/postgres/contracts.ts";
import {
  NodePostgresConnectionFactory,
} from "../../src/server/platform/persistence/postgres/runtime/node-pg-driver.ts";
import { bindDurableProductActor } from "../../src/server/product/auth/identity-session.ts";
import {
  createDurablePostgresGlobalDependencyInvalidationService,
} from "../../src/server/product/dependency-invalidation/postgres-port.ts";
import type {
  GlobalDependencyMutation,
} from "../../src/server/product/dependency-invalidation/global-invalidation.ts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const RUN = process.env.TIVDOC_INVALIDATION_RUN_ID ?? randomUUID().replaceAll("-", "").slice(0, 12);

const TENANT = "tenant:synthetic:invalidation";
const CASE = `case:synthetic:invalidation:${RUN}`;
const INTERNAL_CASE = randomUUID();
const ACTOR = `legal:synthetic:invalidation:${RUN}`;
const SESSION = `session:synthetic:invalidation:${RUN}`;
const TOKEN = `token:synthetic:invalidation:${RUN}`;
const REVIEWER_ORG = `reviewer-org:synthetic:invalidation:${RUN}`;
const CORRELATION = `correlation:synthetic:invalidation:${RUN}`;
const JOB = `job:synthetic:invalidation:${RUN}`;
const WORKER = `worker:synthetic:invalidation:${RUN}`;
const ANALYSIS_RUN = randomUUID();
const REPORT = `report:synthetic:invalidation:${RUN}`;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const BEFORE_SHA = sha256(`dependency-before:${RUN}`);
const AFTER_SHA = sha256(`dependency-after:${RUN}`);

type Case = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Case[] = [];
const record = (name: string, passed: boolean, observed: string) => {
  results.push(Object.freeze({ case: name, outcome: passed ? "pass" : "fail", observed }));
};

type Pg = Awaited<ReturnType<typeof openPg>>;
async function openPg(connectionString: string) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 20_000 });
  await client.connect();
  return client;
}

/**
 * The operations connection, through the product's own driver rather than a
 * hand-rolled client. That matters beyond convenience: the driver normalizes
 * `Date` values to ISO strings (node-pg-driver.ts:298), and the port's decoders
 * read `updated_at` as a string. A fixture client that skipped that step failed
 * with POSTGRES_ROW_MALFORMED — the fixture, not the port, was wrong. Going
 * through the real factory also exercises the remote-target validation the
 * runtime performs before it will open a connection at all.
 */
function operationsFactory(connectionUrl: string, remote: Readonly<{
  host: string; port: number; database: string; project_ref: string;
}>): NodePostgresConnectionFactory {
  return NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: connectionUrl,
    max_connections: 4,
    connection_timeout_ms: 20_000,
    application_name: "tivdoc_invalidation_effect_matrix",
    remote_dev_target: remote,
  });
}

async function seed(admin: Pg, issuedAt: number): Promise<void> {
  await admin.query("begin");
  await admin.query("select set_config('tivdoc.tenant_id', $1, true)", [TENANT]);
  await admin.query(
    `insert into public.product_identity_sessions(
       tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
       expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
     ) values ($1,$2,$3,$4,1,to_timestamp($5),to_timestamp($6),null,$7,$8,to_timestamp($5))
     on conflict (tenant_id, sid) do update set
       current_jti = excluded.current_jti, valid_after = excluded.valid_after,
       expires_at = excluded.expires_at, revoked_at = null`,
    [TENANT, SESSION, ACTOR, TOKEN, issuedAt - 60, issuedAt + 3_600, REVIEWER_ORG,
      sha256(`${TENANT}|${SESSION}|${ACTOR}|${TOKEN}`)],
  );
  await admin.query(
    `insert into public.engine_case_identity(internal_case_id, tenant_id, canonical_case_id)
     values ($1::uuid,$2,$3) on conflict do nothing`,
    [INTERNAL_CASE, TENANT, CASE],
  );
  // Inserting the case state fires `global_dependency_state_initialize`, which
  // creates the dependency row; the update below only moves it to a baseline
  // this run can name.
  await admin.query(
    `insert into public.engine_case_state(
       case_id, tenant_id, canonical_case_id, revision, lifecycle_state, state_sha256, updated_at
     ) values ($1::uuid,$2,$3,1,'awaiting_report_approval',$4,to_timestamp($5))`,
    [INTERNAL_CASE, TENANT, CASE, sha256(`case-state:${RUN}`), issuedAt - 30],
  );
  await admin.query(
    `update public.engine_global_dependency_state set
       case_revision = 1, dependency_epoch = 2, cache_epoch = 3, download_grant_epoch = 4,
       current_dependency_sha256 = $3, stale_stages = '{}'::text[], release_hold = false,
       dependencies_approved = true,
       execution_binding_sha256 = $4, approval_binding_sha256 = $5, download_binding_sha256 = $6,
       latest_invalidation_sha256 = null, updated_at = to_timestamp($7)
     where tenant_id = $1 and canonical_case_id = $2`,
    [TENANT, CASE, BEFORE_SHA, sha256(`execution:${RUN}`), sha256(`approval:${RUN}`),
      sha256(`download:${RUN}`), issuedAt - 30],
  );
  await admin.query(
    `insert into public.engine_durable_jobs(
       job_id, tenant_id, case_id, canonical_case_id, job_kind, idempotency_key, payload,
       payload_sha256, state, revision, attempt_count, max_attempts, available_at,
       lease_owner, lease_expires_at, fencing_token, created_at, updated_at
     ) values ($1,$2,$3::uuid,$4,'synthetic_invalidation_fence',$5,'{}'::jsonb,$6,'running',1,0,3,
               to_timestamp($7),$8,to_timestamp($9),$10,to_timestamp($7),to_timestamp($7))`,
    [JOB, TENANT, INTERNAL_CASE, CASE, `idem:${RUN}`, sha256(`payload:${RUN}`),
      issuedAt - 30, WORKER, issuedAt + 600, 7],
  );
  // An approved report-approval task, so `approval_invalidated` has something
  // to invalidate. Without one the field is honestly false while the dependency
  // row's approval flag still clears — two different effects that the first run
  // of this matrix wrongly asserted as one.
  //
  // The task cannot stand alone: a check constraint requires a report binding
  // whenever `release_state` is set, and that binding is a foreign key into
  // `engine_report_versions`, which in turn needs an analysis run. All three
  // are synthetic and none touches the customer `cases` table — the run chain
  // keys on `engine_case_identity`, which this fixture already created.
  await admin.query(
    `insert into public.analysis_runs(
       id, case_id, canonical_case_id, canonical_analysis_run_id, tenant_id, run_type, status,
       trigger_reason, engine_version, engine_git_sha, contract_version, ontology_version,
       input_snapshot, input_snapshot_hash, idempotency_key, command_sha256, command_payload,
       case_revision, created_at, started_at, completed_at
     ) values ($1::uuid,$2::uuid,$3,$4,$5,'shadow','completed','synthetic.fixture',
               '0.0.0-synthetic',repeat('0',40),'0','0','{}'::jsonb,$6,$7,$8,'{}'::jsonb,1,
               to_timestamp($9),to_timestamp($9),to_timestamp($9))`,
    [ANALYSIS_RUN, INTERNAL_CASE, CASE, `run:synthetic:${RUN}`, TENANT,
      sha256(`snapshot:${RUN}`), `run-idem:${RUN}`, sha256(`command:${RUN}`), issuedAt - 25],
  );
  await admin.query(
    `insert into public.engine_report_versions(
       report_id, revision, tenant_id, case_id, canonical_case_id, analysis_run_id,
       canonical_analysis_run_id, analysis_result_sha256, report_sha256, manifest_sha256,
       object_version_id, visible, review_eligible, created_at
     ) values ($1,1,$2,$3::uuid,$4,$5::uuid,$6,$7,$8,$9,null,false,false,to_timestamp($10))`,
    [REPORT, TENANT, INTERNAL_CASE, CASE, ANALYSIS_RUN, `run:synthetic:${RUN}`,
      sha256(`analysis:${RUN}`), sha256(`report:${RUN}`), sha256(`manifest:${RUN}`), issuedAt - 22],
  );
  await admin.query(
    `insert into public.engine_review_task_versions(
       task_id, revision, tenant_id, case_id, canonical_case_id, task_kind,
       input_sha256, output_sha256, task_sha256, decision_payload, decision_sha256,
       invalidated_at, created_at, report_id, report_revision, report_sha256, release_state
     ) values ($1,1,$2,$3::uuid,$4,'report_approval',$5,$6,$7,$8::jsonb,$9,null,
               to_timestamp($10),$11,1,$12,'approved')`,
    [`task:synthetic:approval:${RUN}`, TENANT, INTERNAL_CASE, CASE,
      sha256(`input:${RUN}`), sha256(`output:${RUN}`), sha256(`task:${RUN}`),
      JSON.stringify({ decision: "approved" }), sha256(`decision:${RUN}`),
      issuedAt - 20, REPORT, sha256(`report:${RUN}`)],
  );
  await admin.query("commit");
}

/** Reads the epoch-millisecond lease the fence has to match exactly. */
async function leaseExpiry(admin: Pg): Promise<number> {
  const row = await admin.query(
    `select (extract(epoch from lease_expires_at) * 1000)::bigint::text as ms
       from public.engine_durable_jobs where tenant_id = $1 and job_id = $2`, [TENANT, JOB]);
  return Number(row.rows[0].ms);
}

async function observe(admin: Pg) {
  // `engine_global_dependency_invalidations` forces RLS and its policies key on
  // a declared or verified tenant, so an admin connection that has not declared
  // one reads zero rows from it and reports the history row as missing. The
  // first run of this matrix did exactly that and accused the port of not
  // writing evidence it had written.
  await admin.query("select set_config('tivdoc.tenant_id', $1, false)", [TENANT]);
  const dependency = await admin.query(
    `select case_revision::text, dependency_epoch::text, cache_epoch::text,
            download_grant_epoch::text, current_dependency_sha256, stale_stages,
            dependencies_approved, approval_binding_sha256, latest_invalidation_sha256
       from public.engine_global_dependency_state where tenant_id = $1 and canonical_case_id = $2`,
    [TENANT, CASE]);
  const state = await admin.query(
    `select revision::text, lifecycle_state from public.engine_case_state
      where tenant_id = $1 and canonical_case_id = $2`, [TENANT, CASE]);
  const history = await admin.query(
    `select count(*)::int as n from public.engine_global_dependency_invalidations
      where tenant_id = $1 and canonical_case_id = $2`, [TENANT, CASE]);
  const lifecycle = await admin.query(
    `select count(*)::int as n from public.engine_case_lifecycle_revisions
      where tenant_id = $1 and case_id = $2::uuid`, [TENANT, INTERNAL_CASE]);
  // Review tasks are append-only: invalidation writes a new revision rather
  // than changing the approved one, so counting every row reports the prior
  // approval forever. The state of a task is its latest revision, which is
  // exactly how APPROVALS_INVALIDATE_SQL selects its candidates.
  const tasks = await admin.query(
    `with latest as (
       select distinct on (task_id) task_id, release_state, invalidated_at
         from public.engine_review_task_versions
        where tenant_id = $1 and canonical_case_id = $2
        order by task_id, revision desc
     )
     select count(*) filter (where release_state = 'approved' and invalidated_at is null)::int as approved,
            count(*) filter (where release_state = 'invalidated')::int as invalidated
       from latest`, [TENANT, CASE]);
  return {
    approved_tasks: tasks.rows[0].approved as number,
    invalidated_tasks: tasks.rows[0].invalidated as number,
    dependency: dependency.rows[0] as Record<string, unknown> | undefined,
    state: state.rows[0] as Record<string, unknown> | undefined,
    invalidations: history.rows[0].n as number,
    lifecycle_revisions: lifecycle.rows[0].n as number,
  };
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const operationsUrl = env.get("TIVDOC_OPERATIONS_POSTGRES_URL");
  if (!adminUrl || !operationsUrl) throw new Error("INVALIDATION_MATRIX_ENV_MISSING");

  const projectRef = env.get("TIVDOC_DEV_PROJECT_REF");
  if (!projectRef) throw new Error("INVALIDATION_MATRIX_PROJECT_REF_MISSING");
  const parsed = new URL(operationsUrl);
  const factory = operationsFactory(operationsUrl, Object.freeze({
    host: parsed.hostname,
    port: Number(parsed.port),
    database: parsed.pathname.replace(/^\//u, ""),
    project_ref: projectRef,
  }));

  const admin = await openPg(adminUrl);
  const operations = await factory.acquire();
  const issuedAt = Math.floor(Date.now() / 1_000);
  let receipt: Record<string, unknown> | null = null;
  let failure: string | null = null;

  try {
    await seed(admin, issuedAt);
    const before = await observe(admin);

    // The proof class is computed, not declared: the connection has to actually
    // be the operations runtime role, without BYPASSRLS and without the service
    // role, or this fixture is claiming a property it does not have.
    const identity = await operations.query(statement("invalidation_principal_probe",
      `select current_user as role,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls,
              pg_catalog.has_function_privilege(current_user, 'private.runtime_context_install(text,text,text)', 'execute') as can_install`, []));
    const principal = identity.rows[0] as Record<string, unknown>;
    const leastPrivilege = principal.role === "tivdoc_operations_runtime"
      && principal.bypasses_rls === false && principal.can_install === true;
    record("connection_is_least_privilege_operations_role", leastPrivilege,
      `role=${String(principal.role)} bypassrls=${String(principal.bypasses_rls)}`);
    if (!leastPrivilege) throw new Error("INVALIDATION_MATRIX_PRINCIPAL_INVALID");

    const actor = bindDurableProductActor({
      actor: Object.freeze({
        actor_id: ACTOR, role: "legal_reviewer", tenant_id: TENANT,
        assigned_case_ids: Object.freeze([CASE]), verified_server_side: true,
      }) as VerifiedActor,
      issuer: "tivdoc-synthetic-invalidation",
      audience: "operations",
      product_audience: "operations",
      session_id: SESSION, token_id: TOKEN, rotation_counter: 1,
      reviewer_organization_id: REVIEWER_ORG,
      issued_at_epoch: issuedAt - 60, expires_at_epoch: issuedAt + 3_600,
    });

    const service = createDurablePostgresGlobalDependencyInvalidationService({
      session_context: Object.freeze({
        proof_class: "LEAST_PRIVILEGE_VERIFIED_SESSION_CONTEXT" as const,
        uses_service_role: false as const,
        bypasses_rls: false as const,
        postgres: undefined as never,
        async transaction<T>(_input: unknown, operation: (bundle: {
          context: { client: PostgresClient; transaction_id: string };
        }) => Promise<T>): Promise<T> {
          await operations.query(statement("invalidation_begin", "begin", []));
          try {
            await operations.query(statement("invalidation_context_install",
              "select * from private.runtime_context_install($1,$2,$3)",
              [SESSION, TOKEN, CORRELATION]));
            const value = await operation({
              context: { client: operations as PostgresClient, transaction_id: `synthetic:${RUN}` },
            });
            await operations.query(statement("invalidation_commit", "commit", []));
            return value;
          } catch (error) {
            await operations.query(statement("invalidation_rollback", "rollback", [])).catch(() => undefined);
            throw error;
          }
        },
      }) as never,
      actor,
      correlation_id: CORRELATION,
    });

    const mutation: GlobalDependencyMutation = Object.freeze({
      schema_version: "tivdoc-global-dependency-invalidation-v0.10.2",
      tenant_id: TENANT,
      case_id: CASE,
      expected_case_revision: 1,
      mutation_kind: "fact_correction",
      dependency_id: `dependency:synthetic:${RUN}`,
      previous_dependency_sha256: BEFORE_SHA,
      next_dependency_sha256: AFTER_SHA,
      actor,
      reason_code: "SYNTHETIC_FIXTURE_INVALIDATION",
      idempotency_key: `invalidation:${RUN}`,
      occurred_at: new Date().toISOString(),
      worker_fence: Object.freeze({
        job_id: JOB, worker_id: WORKER, fencing_token: 7,
        now_ms: Date.now(), lease_expires_at_ms: await leaseExpiry(admin),
      }),
    }) as GlobalDependencyMutation;

    receipt = await service.invalidate(mutation) as unknown as Record<string, unknown>;
    const after = await observe(admin);

    // Each effect field, checked against the tables rather than the receipt.
    record("cache_versioned_observed",
      receipt.cache_versioned === true
      && Number(after.dependency?.cache_epoch) === Number(before.dependency?.cache_epoch) + 1,
      `receipt=${String(receipt.cache_versioned)} cache_epoch ${String(before.dependency?.cache_epoch)}->${String(after.dependency?.cache_epoch)}`);

    record("dependency_epoch_advanced",
      Number(after.dependency?.dependency_epoch) === Number(before.dependency?.dependency_epoch) + 1
      && after.dependency?.current_dependency_sha256 === AFTER_SHA,
      `epoch ${String(before.dependency?.dependency_epoch)}->${String(after.dependency?.dependency_epoch)} sha=${String(after.dependency?.current_dependency_sha256).slice(0, 12)}`);

    record("case_revision_advanced",
      Number(after.state?.revision) === Number(before.state?.revision) + 1
      && Number(receipt.case_revision) === Number(after.state?.revision),
      `revision ${String(before.state?.revision)}->${String(after.state?.revision)} receipt=${String(receipt.case_revision)}`);

    // `approval_invalidated` names the review-task effect: a new invalidated
    // revision appended for every approved report_approval task. The dependency
    // row's approval flag is a separate effect of the same transaction, and
    // conflating the two is how a false receipt reads as correct.
    record("approval_invalidated_observed",
      receipt.approval_invalidated === true
      && after.approved_tasks === 0
      && after.invalidated_tasks === before.invalidated_tasks + 1,
      `receipt=${String(receipt.approval_invalidated)}`
      + ` approved_tasks ${before.approved_tasks}->${after.approved_tasks}`
      + ` invalidated_tasks ${before.invalidated_tasks}->${after.invalidated_tasks}`);

    record("dependency_approval_flag_cleared",
      after.dependency?.dependencies_approved === false
      && after.dependency?.approval_binding_sha256 === null,
      `approved=${String(after.dependency?.dependencies_approved)} binding=${String(after.dependency?.approval_binding_sha256)}`);

    record("historical_evidence_preserved_observed",
      receipt.historical_evidence_preserved === true
      && receipt.historical_versions_deleted === 0
      && after.lifecycle_revisions === before.lifecycle_revisions + 1
      && after.invalidations === before.invalidations + 1,
      `lifecycle ${before.lifecycle_revisions}->${after.lifecycle_revisions}`
      + ` invalidations ${before.invalidations}->${after.invalidations}`
      + ` deleted=${String(receipt.historical_versions_deleted)}`);

    record("invalidation_history_row_matches_receipt",
      after.dependency?.latest_invalidation_sha256 === receipt.invalidation_sha256,
      `state=${String(after.dependency?.latest_invalidation_sha256).slice(0, 12)} receipt=${String(receipt.invalidation_sha256).slice(0, 12)}`);

    record("stale_effects_remain_unknown",
      receipt.stale_execution_blocked === "unknown"
      && receipt.stale_approval_blocked === "unknown"
      && receipt.stale_download_blocked === "unknown",
      "no enforcement computes these; the honest value is unknown");

    // The replay path, observed: a second identical call must change nothing.
    const replayBefore = await observe(admin);
    const replay = await service.invalidate(mutation) as unknown as Record<string, unknown>;
    const replayAfter = await observe(admin);
    record("idempotent_replay_changes_nothing",
      replay.idempotent_replay === true
      && replay.receipt_sha256 === receipt.receipt_sha256
      && replayAfter.lifecycle_revisions === replayBefore.lifecycle_revisions
      && replayAfter.invalidations === replayBefore.invalidations
      && Number(replayAfter.dependency?.dependency_epoch) === Number(replayBefore.dependency?.dependency_epoch),
      `replay=${String(replay.idempotent_replay)} epochs unchanged=${Number(replayAfter.dependency?.dependency_epoch) === Number(replayBefore.dependency?.dependency_epoch)}`);
  } catch (error) {
    failure = `${(error as { code?: string }).code ?? (error as Error).name}: ${String((error as Error).message).slice(0, 200)}`;
    record("matrix_completed", false, failure);
    // A failed seed leaves its transaction open, and every teardown after it
    // would report the abort rather than its own result.
    await admin.query("rollback").catch(() => undefined);
  } finally {
    // Only what the schema allows removing. Append-only rows stay.
    for (const [name, sql, params] of [
      ["idempotency", "delete from public.engine_idempotency_records where tenant_id = $1 and canonical_case_id = $2", [TENANT, CASE]],
      ["durable_job", "delete from public.engine_durable_jobs where tenant_id = $1 and job_id = $2", [TENANT, JOB]],
      ["outbox", "delete from public.engine_outbox_events where tenant_id = $1 and canonical_case_id = $2", [TENANT, CASE]],
      ["identity_session", "delete from public.product_identity_sessions where tenant_id = $1 and sid = $2", [TENANT, SESSION]],
    ] as const) {
      await admin.query(sql, [...params]).catch((error: { message: string }) => {
        record(`teardown_${name}`, false, String(error.message).slice(0, 120));
      });
    }
    await admin.end().catch(() => undefined);
    try { operations.release(); } catch { /* already released */ }
    await factory.close().catch(() => undefined);
  }

  const failed = results.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "invalidation-effect-matrix.json"), `${JSON.stringify({
    schema_version: "tivdoc-invalidation-effect-matrix-wave4",
    run_id: RUN, tenant: TENANT, case_id: CASE,
    cases: results.length, passed: results.length - failed.length, failed: failed.length,
    receipt, failure,
    append_only_rows_left_behind: [
      "public.engine_case_lifecycle_revisions",
      "public.engine_global_dependency_invalidations",
      "public.engine_global_dependency_state",
      "public.engine_case_state",
      "public.engine_case_identity",
      "public.engine_review_task_versions",
    ],
    results,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((entry) => entry.case).join(",")}` : ""}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
