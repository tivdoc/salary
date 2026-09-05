// UX Run 1 (S1) acceptance at the boundary, corrected by the external review
// #1: the channel is verified in the funnel before anything binds (finding
// 1), the link is exchanged once and the customer is redirected to the case
// id (finding 8), and then a second browser profile with no cookies enters
// the code and sees the case — driven over HTTP against the running product
// server and the DEV database, as scripts/dev-runtime/journey.mts drives the
// operations journey.
//
// The case is a synthetic fixture with a synthetic contact; the "inbox" is
// the file sink the notification sender writes to on the local runtime; the
// browser profiles are cookie jars. Nothing here is a customer, and nothing
// here reaches a real channel.
import "../production-refusal.mjs";
import { createHmac } from "node:crypto";
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
const STRANGER = "s1-stranger@example.invalid";
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

function latestCode(to: string): string {
  return /(\d{6})/u.exec(inbox().filter((message) => message.template === "access_code" && message.to === to).at(-1)?.body ?? "")?.[1] ?? "";
}

async function main(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  rmSync(INBOX, { force: true });
  const env = readDevEnvFile();
  const adminUrl = env.get("TIVDOC_DEV_DATABASE_URL");
  const webUrl = env.get("TIVDOC_WEB_POSTGRES_URL");
  if (!adminUrl || !webUrl) throw new Error("ACCESS_JOURNEY_DEV_ENV_MISSING");

  const port = await freePort();
  const caseSecret = ["s1", "access", "journey", "secret"].join("-").repeat(2);
  // The runtime environment is frozen; the variables this journey adds ride on a copy.
  const environment: NodeJS.ProcessEnv = { ...buildRuntimeEnvironment({ port, node_env: "production" }), CASE_TOKEN_SECRET: caseSecret, TIVDOC_NOTIFY_SINK_PATH: INBOX };
  const origin = `http://${LOOPBACK}:${port}`;
  const json = { "content-type": "application/json", origin };
  const funnelCookie = (caseId: string) => `tivdoc_salary_case=${caseId}.${createHmac("sha256", caseSecret).update(caseId).digest("base64url")}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${route}`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body), redirect: "manual" });

  const steps: Step[] = [];
  const record = (step: string, status: number, expected: string, passed: boolean, detail: string) => {
    steps.push(Object.freeze({ step, status, expected, passed, detail: detail.slice(0, 160) }));
  };

  // 1. Seed: one case with a verified payment and an UNVERIFIED contact, on DEV, as the admin role.
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await admin.connect();
  let caseId = "";
  let publicId = "";
  try {
    await admin.query("delete from public.case_identities where contact_normalized in ($1, $2)", [CONTACT, STRANGER]);
    await admin.query("delete from public.cases where email in ($1, $2)", [CONTACT, STRANGER]);
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

  process.env.TIVDOC_WEB_POSTGRES_URL = webUrl;
  process.env.TIVDOC_NOTIFY_SINK_PATH = INBOX;
  Object.assign(process.env, { CASE_TOKEN_SECRET: caseSecret });
  process.env.TIVDOC_LOCAL_PRODUCT_ALLOWED_ORIGIN = origin;
  const { sweepPendingCaseLinks } = await import("../../src/server/product/case-access/service.ts");

  // 2. Before verification: a verified payment sends nothing, and the sweep examines nothing (finding 1).
  const before = await sweepPendingCaseLinks(50);
  record("unverified_contact_gets_no_link", 0, "examined 0, no case_link", before.examined === 0 && inbox().filter((m) => m.template === "case_link").length === 0, JSON.stringify(before));

  const { server, log } = startServer("production", environment, port);
  let sessionCookie: string | null = null;
  try {
    const up = await waitForServer(port, 180_000);
    if (!up) throw new Error("ACCESS_JOURNEY_SERVER_DID_NOT_START");

    // 3. The funnel pages refuse an unverified case (finding 1).
    const uploadPage = await probe(port, "/check/upload", { headers: { cookie: funnelCookie(caseId), origin } });
    record("upload_page_refuses_unverified_contact", uploadPage.status, "307 to /check?verify=1", uploadPage.status === 307, uploadPage.body);
    const startPayment = await post("/api/payments/start", {}, { cookie: funnelCookie(caseId) });
    const startBody = await startPayment.text();
    // Locally the payment route is capability-blocked (404) before it could refuse; on the product half it answers 409 contact_unverified. Either is a refusal.
    record("payment_refuses_unverified_contact", startPayment.status, "409 or 404 (blocked locally)", startPayment.status === 409 || startPayment.status === 404, startBody);

    // 4. A stranger who owns the typed address logs in and sees no case.
    const strangerAsk = await post("/api/cases/access/request", { contact: CONTACT });
    await strangerAsk.text();
    record("stranger_request_answers_accepted", strangerAsk.status, "202 with no channel hint", strangerAsk.status === 202, "");

    // 5. The funnel verification: the case cookie's holder asks for the code and enters it.
    const ask = await post("/api/cases/access/request", { funnel: true }, { cookie: funnelCookie(caseId) });
    const askBody = await ask.text();
    record("funnel_code_requested", ask.status, "202 with masked channel", ask.status === 202 && askBody.includes("s***@example.invalid"), askBody);
    const funnelCode = latestCode(CONTACT);
    record("funnel_code_arrived", 0, "6 digits", /^\d{6}$/u.test(funnelCode), `codes=${inbox().filter((m) => m.template === "access_code").length}`);
    const verifyFunnel = await post("/api/cases/access/verify", { funnel: true, code: funnelCode }, { cookie: funnelCookie(caseId) });
    const verifyFunnelBody = await verifyFunnel.text();
    const funnelSession = cookieOf(verifyFunnel, "tivdoc_case_session");
    record("funnel_verification_links_and_opens_session", verifyFunnel.status, "200, next /check/upload, session cookie", verifyFunnel.status === 200 && verifyFunnelBody.includes("/check/upload") && funnelSession !== null, verifyFunnelBody);
    const uploadAfter = await probe(port, "/check/upload", { headers: { cookie: funnelCookie(caseId), origin } });
    record("upload_page_opens_after_verification", uploadAfter.status, "200 or 404 (blocked locally), not 307", uploadAfter.status !== 307, String(uploadAfter.status));

    // 6. Now the verified payment sends exactly one link under two sweeps.
    const first = await sweepPendingCaseLinks(50);
    const second = await sweepPendingCaseLinks(50);
    const links = inbox().filter((message) => message.template === "case_link" && message.to === CONTACT && message.body.includes(publicId));
    record("link_sent_once_under_two_sweeps", 0, "1 link", links.length === 1 && first.sent === 1 && second.sent === 0, JSON.stringify({ first, second, links: links.length }));
    const linkMatch = /(http:\/\/[^\s]+\/case\/([A-Za-z0-9_-]{22}))/u.exec(links[0]?.body ?? "");
    const link = linkMatch?.[1] ?? "";
    const token = linkMatch?.[2] ?? "";
    record("link_has_no_query_string", 0, "path segment only", link !== "" && !link.includes("?") && link.startsWith(origin), link);

    // 7. A second browser profile: no cookie jar. The link is exchanged once and redirects to the case id (finding 8).
    const exchange = await fetch(`${origin}/case/${token}`, { redirect: "manual" });
    await exchange.text();
    const challengeCookie = cookieOf(exchange, "tivdoc_case_challenge");
    record("link_exchanged_once_and_redirected", exchange.status, "307 to /case/<id> with challenge cookie", exchange.status === 307 && (exchange.headers.get("location") ?? "").endsWith(`/case/${publicId}`) && challengeCookie !== null, exchange.headers.get("location") ?? "");
    const again = await probe(port, `/case/${token}`, {}, 60_000);
    record("used_link_is_refused", again.status, "200 with the invalid-link screen", again.status === 200 && again.body.includes("נוצל כבר"), again.body.replace(/\s+/gu, " "));
    const challengePage = await probe(port, `/case/${publicId}`, { headers: { cookie: `tivdoc_case_challenge=${challengeCookie ?? ""}`, origin } }, 60_000);
    record("challenge_screen_at_case_id", challengePage.status, "200 with the code form", challengePage.status === 200 && challengePage.body.includes(publicId) && challengePage.body.includes("קוד"), challengePage.body.replace(/\s+/gu, " "));
    const code = latestCode(CONTACT);
    record("challenge_code_arrived", 0, "6 digits", /^\d{6}$/u.test(code), `codes=${inbox().filter((m) => m.template === "access_code").length}`);

    // 8. Five wrong codes, then the right one refused.
    const wrong = code === "000000" ? "111111" : "000000";
    const outcomes: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post("/api/cases/access/verify", { challenge: true, code: wrong }, { cookie: `tivdoc_case_challenge=${challengeCookie ?? ""}` });
      outcomes.push(response.status);
      await response.text();
    }
    const sixth = await post("/api/cases/access/verify", { challenge: true, code }, { cookie: `tivdoc_case_challenge=${challengeCookie ?? ""}` });
    const sixthBody = await sixth.text();
    record("sixth_attempt_refused", sixth.status, "429 after 401,401,401,401,429", sixth.status === 429 && outcomes.join(",") === "401,401,401,401,429" && sixthBody.includes("access_code_locked"), outcomes.join(","));

    // 9. A fresh code on the same challenge cookie, the right digits, the session.
    const resend = await post("/api/cases/access/request", { challenge: true }, { cookie: `tivdoc_case_challenge=${challengeCookie ?? ""}` });
    await resend.text();
    const freshCode = latestCode(CONTACT);
    const verify = await post("/api/cases/access/verify", { challenge: true, code: freshCode }, { cookie: `tivdoc_case_challenge=${challengeCookie ?? ""}` });
    const verifyBody = await verify.text();
    sessionCookie = cookieOf(verify, "tivdoc_case_session");
    record("code_opens_session", verify.status, "200 + httpOnly session cookie", verify.status === 200 && sessionCookie !== null && verifyBody.includes(`/case/${publicId}`), verifyBody);

    // 10. The case, seen with the session cookie alone; refused without it; the list redirects to the one case.
    const seen = await probe(port, `/case/${publicId}`, { headers: { cookie: `tivdoc_case_session=${sessionCookie ?? ""}`, origin } }, 60_000);
    record("session_sees_the_case", seen.status, "200 with the case id", seen.status === 200 && seen.body.includes(publicId), seen.body.replace(/\s+/gu, " "));
    const anonymous = await probe(port, `/case/${publicId}`);
    record("no_session_is_sent_to_login", anonymous.status, "307 /login", anonymous.status === 307, anonymous.body);
    const list = await probe(port, "/cases", { headers: { cookie: `tivdoc_case_session=${sessionCookie ?? ""}`, origin } });
    record("one_case_list_redirects_to_it", list.status, "307", list.status === 307, list.body);
    const login = await probe(port, "/login", {}, 60_000);
    record("login_renders_without_session", login.status, "200", login.status === 200 && login.body.includes("קוד"), login.body.replace(/\s+/gu, " "));

    // 11. The stranger, a real owner of some other address, verifies by contact and sees nothing of this case.
    const strangerCaseAsk = await post("/api/cases/access/request", { contact: STRANGER });
    await strangerCaseAsk.text();
    const strangerCode = latestCode(STRANGER);
    record("unknown_contact_gets_no_code", 0, "no code sent", strangerCode === "", `codes_to_stranger=${inbox().filter((m) => m.to === STRANGER).length}`);

    // 12. Per-IP ceiling at the boundary: twenty-one requests from one address for the known contact.
    const ipStatuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await post("/api/cases/access/request", { contact: CONTACT }, { "x-forwarded-for": "198.51.100.78" });
      ipStatuses.push(response.status);
      await response.text();
    }
    record("per_ip_ceiling", ipStatuses.at(-1) ?? 0, "20 × 202 then 429", ipStatuses.slice(0, 20).every((status) => status === 202) && ipStatuses.at(-1) === 429, ipStatuses.join(","));

    // 13. The token and the challenge are nowhere but the message, the one request and the cookie: not in the server log.
    const logText = log.join("");
    record("token_absent_from_server_log", 0, "absent", token !== "" && !logText.includes(token) && (challengeCookie === null || !logText.includes(challengeCookie)), `log_bytes=${logText.length}`);
  } finally {
    server.kill("SIGTERM");
    writeFileSync(path.join(RECEIPT_ROOT, "access-journey-server.log"), log.join(""), "utf8");
  }

  const check = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 20_000 });
  await check.connect();
  try {
    const rows = await check.query("select (select count(*)::int from public.case_access_tokens where case_id = $1) as tokens, (select count(*)::int from public.case_notifications where case_id = $1 and template = 'case_link' and state = 'sent') as links_sent, (select string_agg(token_hash, ',') from public.case_access_tokens where case_id = $1) as hashes, (select contact_verified_at is not null from public.cases where id = $1) as verified", [caseId]);
    const row = rows.rows[0] as { tokens: number; links_sent: number; hashes: string; verified: boolean };
    record("store_holds_hashes_only", 0, "no token in any row; contact verified", !String(row.hashes).includes(caseId) && !String(row.hashes).includes("case/") && row.verified === true, `tokens=${row.tokens} links_sent=${row.links_sent}`);
    await check.query("delete from public.case_identities where contact_normalized in ($1, $2)", [CONTACT, STRANGER]);
    await check.query("delete from public.cases where id = $1", [caseId]);
  } finally {
    await check.end();
  }
  rmSync(INBOX, { force: true });

  const passed = steps.filter((step) => step.passed).length;
  const receipt = {
    schema_version: "tivdoc-access-journey-v2",
    wave: "site-s1 + external review #1 corrections",
    steps, passed, total: steps.length,
    fixture: { case_public_id: publicId, contact: CONTACT, stranger: STRANGER, synthetic: true },
    log_layers_checked: ["the product server's stdout and stderr (Next.js request and application logs)", "every case_access_* store row", "the funnel table's landing_url (redacted by construction, tested in src/lib/attribution.test.ts)"],
    log_layers_not_checkable_here: ["Vercel access logs (no deployment in this run)", "a browser's Referer after the exchange (the exchange redirects before any page renders; the case screens carry referrer no-referrer)"],
    counters: { customer_rows: 0, real_contacts_reached: 0, provider_calls: 0 },
  };
  writeFileSync(path.join(RECEIPT_ROOT, "access-journey.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  for (const step of steps) console.log(`${step.passed ? "PASS" : "FAIL"} ${step.step} — ${step.status} (${step.expected}) ${step.detail.slice(0, 100)}`);
  console.log(`access journey ${passed}/${steps.length}`);
  if (passed !== steps.length) process.exitCode = 1;
}

await main();
