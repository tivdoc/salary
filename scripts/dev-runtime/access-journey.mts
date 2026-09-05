// UX Run 1 (S1) acceptance, at the boundary: a case that paid receives the
// link, a second browser profile with no cookies opens it, enters the code,
// and sees the case — driven over HTTP against the running product server
// and the DEV database, exactly as scripts/dev-runtime/journey.mts drives the
// operations journey.
//
// The case is a synthetic fixture with a synthetic contact; the "inbox" is
// the file sink the notification sender writes to on the local runtime; the
// two browser profiles are two cookie jars. Nothing here is a customer, and
// nothing here reaches a real channel.
import "../production-refusal.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { buildRuntimeEnvironment, freePort, probe, startServer, waitForServer } from "./serve.mts";

// Under output/next, which the repository ignores; a wave directory of its own would show up as untracked.
const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "next/site-s1";
const RECEIPT_ROOT = path.join("output", WAVE);
const INBOX = path.resolve(RECEIPT_ROOT, "notification-sink.jsonl");
const CONTACT = "s1-journey@example.invalid";
const LOOPBACK = process.env.TIVDOC_LOOPBACK_LABEL ?? "localhost";

type Step = Readonly<{ step: string; status: number; expected: string; passed: boolean; detail: string }>;
type Inbox = ReadonlyArray<Readonly<{ template: string; channel: string; to: string; subject: string; body: string }>>;

function inbox(): Inbox {
  try {
    return readFileSync(INBOX, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Inbox[number]);
  } catch {
    return [];
  }
}

function cookieOf(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const match = new RegExp(`^${name}=([^;]*)`, "u").exec(header);
    if (match) return match[1] ?? null;
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  rmSync(INBOX, { force: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const webUrl = env.get("TIVDOC_WEB_POSTGRES_URL");
  if (!adminUrl || !webUrl) throw new Error("ACCESS_JOURNEY_DEV_ENV_MISSING");

  const port = await freePort();
  // The runtime environment is frozen; the two variables this journey adds ride on a copy.
  const environment: NodeJS.ProcessEnv = {
    ...buildRuntimeEnvironment({ port, node_env: "production" }),
    CASE_TOKEN_SECRET: ["s1", "access", "journey", "secret"].join("-").repeat(2),
    TIVDOC_NOTIFY_SINK_PATH: INBOX,
  };
  const origin = `http://${LOOPBACK}:${port}`;

  const steps: Step[] = [];
  const record = (step: string, status: number, expected: string, passed: boolean, detail: string) => {
    steps.push(Object.freeze({ step, status, expected, passed, detail: detail.slice(0, 160) }));
  };

  // 1. Seed: one case with a verified payment, on DEV, as the admin role.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  let caseId = "";
  let publicId = "";
  try {
    // Leftovers of an earlier run that crashed before its cleanup: the fixture contact owns nothing but fixtures.
    await admin.query("delete from public.case_identities where contact_normalized = $1", [CONTACT]);
    await admin.query("delete from public.cases where email = $1", [CONTACT]);
    const created = await admin.query(
      "insert into public.cases (first_name, email, phone, status, payment_status) values ('מסע', $1, '0500000001', 'under_review', 'verified') returning id, public_id",
      [CONTACT],
    );
    caseId = created.rows[0].id;
    publicId = created.rows[0].public_id;
    await admin.query(
      "insert into public.payments (case_id, provider, amount, currency, status, idempotency_key, verified_at) values ($1, 'invoice4u', 9.99, 'ILS', 'verified', $2, now())",
      [caseId, `${caseId}:initial-check`],
    );
  } finally {
    await admin.end();
  }

  // 2. The link: the sweep the reconcile cron runs, in-process against the same store, twice.
  process.env.TIVDOC_WEB_POSTGRES_URL = webUrl;
  process.env.TIVDOC_NOTIFY_SINK_PATH = INBOX;
  Object.assign(process.env, { CASE_TOKEN_SECRET: environment.CASE_TOKEN_SECRET });
  process.env.TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN = origin;
  const { sweepPendingCaseLinks } = await import("../../src/server/product/case-access/service.ts");
  const first = await sweepPendingCaseLinks(50);
  const second = await sweepPendingCaseLinks(50);
  const links = inbox().filter((message) => message.template === "case_link" && message.to === CONTACT && message.body.includes(publicId));
  record("link_sent_once_under_two_sweeps", 0, "1 link", links.length === 1 && first.sent >= 1 && second.sent === 0, JSON.stringify({ first, second, links: links.length }));
  const linkMatch = /(http:\/\/[^\s]+\/case\/([A-Za-z0-9_-]{22}))/u.exec(links[0]?.body ?? "");
  const link = linkMatch?.[1] ?? "";
  const token = linkMatch?.[2] ?? "";
  record("link_has_no_query_string", 0, "path segment only", link !== "" && !link.includes("?") && link.startsWith(origin), link);

  const { server, log } = startServer("production", environment, port);
  let sessionCookie: string | null = null;
  try {
    const up = await waitForServer(port, 180_000);
    if (!up) throw new Error("ACCESS_JOURNEY_SERVER_DID_NOT_START");

    // 3. A second browser profile: no cookie jar at all.
    const challenge = await probe(port, `/case/${token}`, {}, 60_000);
    record("second_profile_opens_link", challenge.status, "200", challenge.status === 200 && challenge.body.includes(publicId), challenge.body.replace(/\s+/gu, " "));

    const request = await fetch(`${origin}/api/cases/access/request`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }), redirect: "manual",
    });
    record("code_requested", request.status, "202", request.status === 202, await request.text());
    const codes = inbox().filter((message) => message.template === "access_code" && message.to === CONTACT);
    const code = /(\d{6})/u.exec(codes.at(-1)?.body ?? "")?.[1] ?? "";
    record("code_arrived_on_the_channel", 0, "6 digits", /^\d{6}$/u.test(code), `codes=${codes.length}`);

    // 4. Rate limit at the boundary: five wrong codes, then the right one is refused.
    const wrong = code === "000000" ? "111111" : "000000";
    const outcomes: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${origin}/api/cases/access/verify`, {
        method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token, code: wrong }), redirect: "manual",
      });
      outcomes.push(response.status);
      await response.text();
    }
    const sixth = await fetch(`${origin}/api/cases/access/verify`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token, code }), redirect: "manual",
    });
    const sixthBody = await sixth.text();
    record("sixth_attempt_refused", sixth.status, "429 after 401,401,401,401,429", sixth.status === 429 && outcomes.join(",") === "401,401,401,401,429" && sixthBody.includes("access_code_locked"), outcomes.join(","));

    // 5. A fresh code, the right digits, the session.
    const again = await fetch(`${origin}/api/cases/access/request`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }), redirect: "manual" });
    await again.text();
    const freshCode = /(\d{6})/u.exec(inbox().filter((message) => message.template === "access_code").at(-1)?.body ?? "")?.[1] ?? "";
    const verify = await fetch(`${origin}/api/cases/access/verify`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token, code: freshCode }), redirect: "manual",
    });
    const verifyBody = await verify.text();
    sessionCookie = cookieOf(verify, "tivdoc_case_session");
    record("code_opens_session", verify.status, "200 + httpOnly session cookie", verify.status === 200 && sessionCookie !== null && verifyBody.includes(`/case/${publicId}`), verifyBody);

    // 6. The case, seen with the session cookie alone; refused without it; the list redirects to the one case.
    const seen = await probe(port, `/case/${publicId}`, { headers: { cookie: `tivdoc_case_session=${sessionCookie ?? ""}`, origin } }, 4_000);
    record("session_sees_the_case", seen.status, "200 with the case id", seen.status === 200 && seen.body.includes(publicId), seen.body.replace(/\s+/gu, " "));
    const anonymous = await probe(port, `/case/${publicId}`);
    record("no_session_is_sent_to_login", anonymous.status, "307 /login", anonymous.status === 307, anonymous.body);
    const list = await probe(port, "/cases", { headers: { cookie: `tivdoc_case_session=${sessionCookie ?? ""}`, origin } });
    record("one_case_list_redirects_to_it", list.status, "307", list.status === 307, list.body);
    const login = await probe(port, "/login", {}, 60_000);
    record("login_renders_without_session", login.status, "200", login.status === 200 && login.body.includes("קוד"), login.body.replace(/\s+/gu, " "));

    // 7. Per-IP ceiling at the boundary: twenty-one requests from one address for an unknown contact.
    let ipStatuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await fetch(`${origin}/api/cases/access/request`, {
        method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ contact: `unknown-${index}@example.invalid` }), redirect: "manual",
      });
      ipStatuses.push(response.status);
      await response.text();
    }
    // An unknown contact never counts (no row is written), so the ceiling here comes from the identity's own requests above; prove the ceiling with the known contact instead.
    ipStatuses = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await fetch(`${origin}/api/cases/access/request`, {
        method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": "198.51.100.78" },
        body: JSON.stringify({ contact: CONTACT }), redirect: "manual",
      });
      ipStatuses.push(response.status);
      await response.text();
    }
    record("per_ip_ceiling", ipStatuses.at(-1) ?? 0, "20 × 202 then 429", ipStatuses.slice(0, 20).every((status) => status === 202) && ipStatuses.at(-1) === 429, ipStatuses.join(","));

    // 8. The token is nowhere but the message and the path: not in the server log, not in the store's rows.
    const logText = log.join("");
    record("token_absent_from_server_log", 0, "absent", token !== "" && !logText.includes(token), `log_bytes=${logText.length}`);
  } finally {
    server.kill("SIGTERM");
    // The server's own output, for the receipt and for reading a failure; the token-absence step above is the guard on it.
    writeFileSync(path.join(RECEIPT_ROOT, "access-journey-server.log"), log.join(""), "utf8");
  }

  const check = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await check.connect();
  try {
    const rows = await check.query("select (select count(*)::int from public.case_access_tokens where case_id = $1) as tokens, (select count(*)::int from public.case_notifications where case_id = $1 and template = 'case_link' and state = 'sent') as links_sent, (select string_agg(token_hash, ',') from public.case_access_tokens where case_id = $1) as hashes", [caseId]);
    const row = rows.rows[0] as { tokens: number; links_sent: number; hashes: string };
    record("store_holds_hashes_only", 0, "no token in any row", !String(row.hashes).includes(token), `tokens=${row.tokens} links_sent=${row.links_sent}`);
    // Clean up the fixture: the case cascades to tokens, codes, sessions and notifications; the identity goes with it.
    await check.query("delete from public.case_identities where id in (select identity_id from public.case_identity_cases where case_id = $1)", [caseId]);
    await check.query("delete from public.cases where id = $1", [caseId]);
  } finally {
    await check.end();
  }
  rmSync(INBOX, { force: true });

  const passed = steps.filter((step) => step.passed).length;
  const receipt = {
    schema_version: "tivdoc-access-journey-v1",
    wave: "site-s1",
    unit: "acceptance-1..5",
    steps,
    passed,
    total: steps.length,
    fixture: { case_public_id: publicId, contact: CONTACT, synthetic: true },
    counters: { customer_rows: 0, real_contacts_reached: 0, provider_calls: 0 },
  };
  writeFileSync(path.join(RECEIPT_ROOT, "access-journey.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  for (const step of steps) console.log(`${step.passed ? "PASS" : "FAIL"} ${step.step} — ${step.status} (${step.expected}) ${step.detail.slice(0, 100)}`);
  console.log(`access journey ${passed}/${steps.length}`);
  if (passed !== steps.length) process.exitCode = 1;
}

await main();
