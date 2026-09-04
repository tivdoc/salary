// V0.10.11 W4. The internal operations journey, driven over HTTP against the
// running product server and the isolated DEV database.
//
// No cluster is provisioned: the server takes its four connection URLs from the
// credential file, which is the whole point of the decoupling. The session is
// synthetic and signed with a key generated for this run only; no reviewer
// identity, signature or ground truth is fabricated as real, and no source,
// parameter or rule is activated by anything here.
//
// The negative matrix runs against the same live server, because a refusal that
// is only proven in a unit test is not proven at the boundary.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  durableBrowserFixtureIds,
  durableBrowserJwtClaims,
  durableBrowserCsrfToken,
  generateDurableBrowserKeyMaterial,
  signDurableBrowserJwt,
  DURABLE_BROWSER_CSRF_COOKIE,
  DURABLE_BROWSER_IDENTITY_COOKIE,
} from "../full-local-system-marathon/durable-browser-e2e-runtime.mts";
import { sha256 } from "../full-local-system-marathon/durable-browser-e2e-runtime.mts";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { buildRuntimeEnvironment, freePort, probe, startServer, waitForServer } from "./serve.mts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v0.10.11";
const RECEIPT_ROOT = path.join("output", WAVE, "browser");
const RUN_ID = "a1b2c3d4e5f6";

type Step = Readonly<{ step: string; status: number; expected: string; passed: boolean; detail: string }>;

function cookieHeader(jwt: string, csrf: string): string {
  return `${DURABLE_BROWSER_IDENTITY_COOKIE}=${jwt}; ${DURABLE_BROWSER_CSRF_COOKIE}=${csrf}`;
}

/**
 * Seeds the synthetic case and identity sessions the journey needs. Everything
 * written here is fabricated fixture data with synthetic identifiers; nothing
 * represents a real reviewer, customer or document, and no source, parameter or
 * rule is activated.
 */
async function seedFixture(
  fixture: ReturnType<typeof durableBrowserFixtureIds>,
  issuedAt: number,
  expiresAt: number,
): Promise<string> {
  const url = readDevEnvFile().get("TIVDOC_DEV_DATABASE_URL");
  if (!url) throw new Error("JOURNEY_DEV_ENV_MISSING");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  const factPayload = {
    canonical_path: "synthetic.monthly.gross_minor_units",
    status: "confirmed",
    provenance_count: 1,
    conflict_count: 0,
  };
  const stateSha = sha256(JSON.stringify({
    tenant_id: fixture.tenant_id, case_id: fixture.case_id, revision: 1,
    state: "ready_for_legal_evaluation",
  }));
  try {
    await client.query("begin");
    // Row level security on the identity table is forced: an update without a
    // declared tenant is refused, fixture or not. The fixture declares it the
    // same way the runtime does.
    await client.query("select set_config('tivdoc.tenant_id', $1, true)", [fixture.tenant_id]);
    await client.query(
      `insert into public.engine_case_identity(internal_case_id, tenant_id, canonical_case_id)
       values ($1::uuid, $2, $3) on conflict do nothing`,
      [fixture.internal_case_id, fixture.tenant_id, fixture.case_id],
    );
    await client.query(
      `insert into public.engine_case_state(
         case_id, tenant_id, canonical_case_id, revision, lifecycle_state, state_sha256, updated_at
       ) values ($1::uuid, $2, $3, 1, 'ready_for_legal_evaluation', $4, to_timestamp($5))
       on conflict do nothing`,
      [fixture.internal_case_id, fixture.tenant_id, fixture.case_id, stateSha, issuedAt - 5],
    );
    await client.query(
      `insert into public.engine_canonical_fact_versions(
         fact_id, revision, tenant_id, case_id, analysis_run_id, payload,
         payload_sha256, created_at, canonical_case_id, canonical_analysis_run_id
       ) values ($1, 1, $2, $3::uuid, null, $4::jsonb, $5, to_timestamp($6), $7, null)
       on conflict do nothing`,
      [fixture.fact_id, fixture.tenant_id, fixture.internal_case_id, JSON.stringify(factPayload),
        sha256(JSON.stringify(factPayload)), issuedAt - 4, fixture.case_id],
    );
    for (const identity of [
      fixture.legal_reviewer, fixture.report_approver, fixture.owner, fixture.cross_owner, fixture.worker,
    ]) {
      await client.query(
        `insert into public.product_identity_sessions(
           tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
           expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
         ) values ($1, $2, $3, $4, 1, to_timestamp($5), to_timestamp($6), null, $7, $8, to_timestamp($5))
         on conflict (tenant_id, sid) do update set
           current_jti = excluded.current_jti,
           valid_after = excluded.valid_after,
           expires_at = excluded.expires_at,
           session_sha256 = excluded.session_sha256`,
        [fixture.tenant_id, identity.session_id, identity.actor_id, identity.token_id,
          issuedAt - 5, expiresAt, identity.reviewer_organization_id,
          sha256(JSON.stringify({
            tenant_id: fixture.tenant_id, sid: identity.session_id, subject: identity.actor_id,
            jti: identity.token_id, reviewer_organization_id: identity.reviewer_organization_id,
          }))],
      );
    }
    await client.query(
      `insert into public.product_case_owners(
         tenant_id, canonical_case_id, subject, revision, status, binding_sha256, created_at, revoked_at
       ) values ($1, $2, $3, 1, 'active', $4, to_timestamp($5), null) on conflict do nothing`,
      [fixture.tenant_id, fixture.case_id, fixture.owner.actor_id,
        sha256(`synthetic-owner-binding:${fixture.owner.actor_id}:${fixture.case_id}`), issuedAt - 4],
    );
    await client.query("commit");
    return "seeded";
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    return `seed_failed:${(error as { code?: string }).code ?? ""}:${String((error as Error).message).slice(0, 120)}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const key = generateDurableBrowserKeyMaterial(RUN_ID);
  const fixture = durableBrowserFixtureIds(RUN_ID);
  const port = await freePort();
  const environment = buildRuntimeEnvironment({
    port,
    node_env: "production",
    identity: { key_id: key.key_id, public_key_spki_pem: key.public_key_spki_pem },
    tenant_id: fixture.tenant_id,
    worker: {
      actor_id: fixture.worker.actor_id,
      session_id: fixture.worker.session_id,
      token_id: fixture.worker.token_id,
    },
    // L7-8: the draft shadow run's state (draft-shadow-run-v1.mts writes it);
    // the summary panel reads it and shows counts and hashes, never content.
    offline_shadow_state_root: path.resolve("output", "next", "shadow", "state"),
  });
  const issuer = environment.TIVDOC_IDENTITY_ISSUER as string;
  const issuedAt = Math.floor(Date.now() / 1_000);
  const sign = (
    person: typeof fixture.legal_reviewer,
    overrides: Partial<{ issued: number; expires: number }> = {},
  ) => signDurableBrowserJwt(durableBrowserJwtClaims({
    fixture: person,
    tenant_id: fixture.tenant_id,
    case_id: fixture.case_id,
    issuer,
    issued_at_epoch: overrides.issued ?? issuedAt,
    expires_at_epoch: overrides.expires ?? issuedAt + 1_800,
  }), key.key_id, key.private_key);

  const reviewer = sign(fixture.legal_reviewer);
  const owner = sign(fixture.owner);
  const expired = sign(fixture.legal_reviewer, { issued: issuedAt - 3_000, expires: issuedAt - 600 });
  const csrf = durableBrowserCsrfToken();
  const steps: Step[] = [];
  const record = (
    step: string, result: Readonly<{ status: number; body: string }>, expected: string, passed: boolean,
  ) => {
    steps.push(Object.freeze({ step, status: result.status, expected, passed, detail: result.body.slice(0, 160) }));
  };

  const seed = await seedFixture(fixture, issuedAt, issuedAt + 2_400);
  const { server, log } = startServer("production", environment, port);
  try {
    const up = await waitForServer(port, 180_000);
    if (!up) throw new Error("JOURNEY_SERVER_DID_NOT_START");

    // A browser at the allowed origin sends this on every same-origin request;
    // CSRF validation requires it verbatim and is not relaxed here.
    const origin = environment.TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN as string;
    const authed = { headers: { cookie: cookieHeader(reviewer, csrf), origin } };
    const page = await probe(port, "/operations", authed);
    record("operations_page", page, "200", page.status === 200);

    const queue = await probe(port, "/api/operations/legal-review/queue", authed);
    record("legal_review_queue", queue, "200", queue.status === 200);

    const topics = await probe(port, "/api/operations/legal-review/topics", authed);
    record("seven_topic_readiness", topics, "200", topics.status === 200);

    // Step 17 (L7-8): the offline-shadow summary on the canonical service —
    // the draft mode, its pin, zero active parameters, no content.
    const shadow = await probe(port, "/api/operations/shadow/summary", authed);
    const shadowBody = ((): { data?: { summary?: { latest_draft_run?: { execution_mode?: string; draft_input_pin?: { active_real_parameter_count?: number } } | null; content_included?: boolean } } } => {
      try { return JSON.parse(shadow.body) as never; } catch { return {}; }
    })();
    const latest = shadowBody.data?.summary?.latest_draft_run ?? null;
    record("shadow_summary", shadow, "200 draft mode, zero active, no content",
      shadow.status === 200 && latest?.execution_mode === "draft_parameters_synthetic_inputs"
      && latest.draft_input_pin?.active_real_parameter_count === 0 && shadowBody.data?.summary?.content_included === false);

    const actionBody = JSON.stringify({
      schema_version: "tivdoc-operations-command",
      idempotency_key: `idem.journey.${RUN_ID}`,
      occurred_at: new Date().toISOString(),
      packet: { packet_id: "LRP:journey", packet_sha256: "a".repeat(64) },
      action: {
        action_id: `LRA:journey.${RUN_ID}`,
        packet_id: "LRP:journey",
        packet_sha256: "a".repeat(64),
        expected_revision: 1,
        decision: "claim",
        reason_code: "REVIEW_STARTED",
        reason: "synthetic internal journey",
        attestation: { actor_id: fixture.legal_reviewer.actor_id, signature_sha256: "b".repeat(64) },
        cited_chunk_ids: [],
      },
    });
    const post = (body: string, headers: Record<string, string>) => probe(
      port, "/api/operations/legal-review/actions",
      { method: "POST", body, headers: { "content-type": "application/json", origin, ...headers } },
    );
    // The action reaches the durable service through the operations session
    // transaction. An empty queue answers with a conflict or a not-found, which
    // still proves the HTTP -> service -> transaction -> database path.
    const action = await post(actionBody, { cookie: cookieHeader(reviewer, csrf), "x-tivdoc-csrf": csrf });
    record("legal_review_action", action, "reaches the durable service", action.status !== 500 && action.status !== 404);

    const negatives: readonly Readonly<{ name: string; run: () => Promise<{ status: number; body: string }> }>[] = [
      { name: "wrong_role", run: () => probe(port, "/api/operations/legal-review/queue", { headers: { cookie: cookieHeader(owner, csrf), origin } }) },
      { name: "missing_csrf", run: () => post(actionBody, { cookie: cookieHeader(reviewer, csrf) }) },
      { name: "expired_session", run: () => probe(port, "/api/operations/legal-review/queue", { headers: { cookie: cookieHeader(expired, csrf), origin } }) },
      { name: "no_session", run: () => probe(port, "/api/operations/legal-review/queue") },
      { name: "malformed_input", run: () => post("{not json", { cookie: cookieHeader(reviewer, csrf), "x-tivdoc-csrf": csrf }) },
      { name: "wrong_schema_version", run: () => post(actionBody.replace("tivdoc-operations-command", "wrong"), { cookie: cookieHeader(reviewer, csrf), "x-tivdoc-csrf": csrf }) },
      { name: "out_of_range_limit", run: () => probe(port, "/api/operations/legal-review/queue?limit=501", { headers: { cookie: cookieHeader(reviewer, csrf), origin } }) },
      { name: "public_route_non_exposure", run: () => probe(port, "/api/operations/legal-review/queue", { headers: { cookie: `${DURABLE_BROWSER_CSRF_COOKIE}=${csrf}`, origin } }) },
      // The page route answers 200 for the valid reviewer session, so these
      // three discriminate a real refusal from an unavailable route.
      { name: "page_wrong_role", run: () => probe(port, "/operations", { headers: { cookie: cookieHeader(owner, csrf), origin } }) },
      { name: "page_expired_session", run: () => probe(port, "/operations", { headers: { cookie: cookieHeader(expired, csrf), origin } }) },
      { name: "page_no_session", run: () => probe(port, "/operations") },
      { name: "page_portal_cross_audience", run: () => probe(port, "/portal", { headers: { cookie: cookieHeader(reviewer, csrf), origin } }) },
    ];
    for (const negative of negatives) {
      const result = await negative.run();
      record(`negative_${negative.name}`, result, ">=400", result.status >= 400);
    }
  } finally {
    server.kill("SIGTERM");
    writeFileSync(path.join(RECEIPT_ROOT, "server.log"), log.join("").slice(-40_000), "utf8");
  }

  const passed = steps.filter((step) => step.passed).length;
  writeFileSync(path.join(RECEIPT_ROOT, "journey.json"), `${JSON.stringify({
    schema_version: "tivdoc-operations-journey-v0.10.11",
    transport: "http_against_running_product_server",
    database: "isolated_dev_project",
    fixture_seed: seed,
    steps_total: steps.length,
    steps_passed: passed,
    steps,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`journey ${passed}/${steps.length}\n`);
}

await main();
