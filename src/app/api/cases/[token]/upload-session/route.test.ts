// Site S2.3 acceptance. Adding a document to a case after payment must not
// create a second way for a file to enter the product: this route accepts no
// file at all. It proves the identity owns the case and points the funnel's
// cookie at it, so the customer walks the same review screen — preview, page
// count, readability, month — that the funnel walks before a payment.
//
// The property under test is therefore ownership, not upload: whose case the
// cookie ends up naming, and what happens when the answer is "not yours".
import { beforeEach, describe, expect, it, vi } from "vitest";

// The session cookie module is marked `server-only`, a marker Next resolves and
// vitest does not. Stubbing it keeps the test honest about everything else.
vi.mock("server-only", () => ({}));

const cookieJar = new Map<string, string>();
const cookiesSet: Array<{ name: string; value: string }> = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookiesSet.push({ name, value }); cookieJar.set(name, value); },
  }),
}));

vi.mock("@/server/platform/capabilities/stable-http-entrypoint", () => ({
  guardStableHttpEntrypoint: async () => ({ outcome: "ALLOW" }),
}));

const OWN_CASE = "66666666-6666-4666-8666-666666666666";
const OTHER_CASE = "77777777-7777-4777-8777-777777777777";

function request(): Request {
  return new Request("http://localhost/api/cases/TV-S23TEST1/upload-session", { method: "POST" });
}

function fixtures() {
  return [
    // Unverified at the start: `signIn` below walks the real funnel verification,
    // which is the only thing in the product that links an identity to a case.
    { id: OWN_CASE, public_id: "TV-S23TEST1", email: "dana.test@example.com", phone: null, first_name: "דנה", status: "paid", payment_status: "verified", created_at: "2026-09-06T09:00:00.000Z", payment_verified: true, contact_verified_at: null, contact_verified_channel: null },
    { id: OTHER_CASE, public_id: "TV-S23OTHR2", email: "someone.else@example.com", phone: null, first_name: null, status: "paid", payment_status: "verified", created_at: "2026-09-06T09:00:00.000Z", payment_verified: true, contact_verified_at: Date.now(), contact_verified_channel: "email" },
  ];
}

/** A verified identity session for the first case, opened the way the funnel opens one. */
async function signIn(db: Awaited<ReturnType<typeof makeDb>>): Promise<void> {
  const { requestFunnelCode, verifyFunnelCode } = await import("@/server/product/case-access/service");
  const { installNotificationProviderForTests } = await import("@/server/product/case-access/notifications");
  let code = "";
  installNotificationProviderForTests({
    id: "test_capture",
    async send(message) { code = /(\d{6})/u.exec(message.body)?.[1] ?? code; return { ok: true }; },
  });
  await requestFunnelCode({ caseId: OWN_CASE, request: request() }, db);
  const verified = await verifyFunnelCode({ caseId: OWN_CASE, code }, db);
  if (verified.outcome !== "ok") throw new Error(`sign-in failed: ${verified.outcome}`);
  cookieJar.set("tivdoc_case_session", verified.session);
  installNotificationProviderForTests(null);
}

async function makeDb() {
  const { fakeCaseAccessDb } = await import("@/server/product/case-access/fake-db");
  const { installCaseAccessDbForTests } = await import("@/server/product/case-access/db");
  const db = fakeCaseAccessDb(fixtures());
  installCaseAccessDbForTests(db);
  return db;
}

describe("POST /api/cases/[id]/upload-session", () => {
  beforeEach(() => {
    cookieJar.clear();
    cookiesSet.length = 0;
    process.env.CASE_TOKEN_SECRET = ["s23", "test", "secret"].join("-").repeat(3);
    process.env.DELIVERY_RECIPIENT_ALLOWLIST = "dana.test@example.com";
  });

  it("refuses without a session, before it looks at the case", async () => {
    await makeDb();
    const { POST } = await import("./route.ts");
    const response = await POST(request(), { params: Promise.resolve({ token: "TV-S23TEST1" }) });
    expect(response.status).toBe(401);
    expect(cookiesSet).toHaveLength(0);
  });

  it("points the funnel at a case the session owns", async () => {
    const db = await makeDb();
    await signIn(db);
    cookiesSet.length = 0;

    const { POST } = await import("./route.ts");
    const response = await POST(request(), { params: Promise.resolve({ token: "TV-S23TEST1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, next: "/check/upload" });

    // The cookie names this case, and is signed — the funnel's guard re-checks it.
    const written = cookiesSet.find((entry) => entry.name === "tivdoc_salary_case");
    expect(written?.value.startsWith(`${OWN_CASE}.`)).toBe(true);
    const { readCaseIdFromCookie } = await import("@/lib/case-cookie");
    await expect(readCaseIdFromCookie()).resolves.toBe(OWN_CASE);
  });

  it("answers 404 for a case the session does not own, and writes no cookie", async () => {
    const db = await makeDb();
    await signIn(db);
    cookiesSet.length = 0;

    const { POST } = await import("./route.ts");
    const response = await POST(request(), { params: Promise.resolve({ token: "TV-S23OTHR2" }) });
    expect(response.status).toBe(404);
    // Not "you may not"; the same answer a case that does not exist gets.
    await expect(response.json()).resolves.toMatchObject({ code: "case_not_found" });
    expect(cookiesSet).toHaveLength(0);
  });

  it("answers 404 for a token that is not a case id at all", async () => {
    const db = await makeDb();
    await signIn(db);
    cookiesSet.length = 0;

    const { POST } = await import("./route.ts");
    const response = await POST(request(), { params: Promise.resolve({ token: "../../etc" }) });
    expect(response.status).toBe(404);
    expect(cookiesSet).toHaveLength(0);
  });
});
