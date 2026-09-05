// UX Run 1 acceptance, at the service: the link goes out once under a cron
// that runs twice; a code opens a session; the sixth attempt is refused; the
// per-IP ceiling holds; an unknown contact answers like a known one; and the
// token appears in the message alone — not in a log line, not in a query
// string, not in what the store or the analytics are handed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./crypto.ts";
import { fakeCaseAccessDb, type FakeCase } from "./fake-db.ts";
import { installNotificationProviderForTests, type NotificationMessage } from "./notifications.ts";
import {
  issueAndSendCaseLink, listIdentityCases, requestAccessCode, resendCaseLink, resolveIdentitySession, sweepPendingCaseLinks, verifyAccessCode,
} from "./service.ts";

const CASE: FakeCase = {
  id: "11111111-1111-4111-8111-111111111111", public_id: "TV-S1TEST01", email: "Dana.Test@Example.com", phone: "0501234567",
  first_name: "דנה", status: "under_review", payment_status: "verified", created_at: "2026-09-05T09:00:00.000Z", payment_verified: true,
};

function capturingProvider(fail = false) {
  const sent: NotificationMessage[] = [];
  installNotificationProviderForTests({
    id: "test_capture",
    async send(message) {
      sent.push(message);
      return fail ? { ok: false, error_code: "test_failure" } : { ok: true };
    },
  });
  return sent;
}

function requestWithIp(ip: string): Request {
  return new Request("http://localhost/api/cases/access/request", { method: "POST", headers: { "x-forwarded-for": ip } });
}

function codeFrom(message: NotificationMessage): string {
  const match = /(\d{6})/u.exec(message.body);
  if (!match) throw new Error("code missing from the message");
  return match[1]!;
}

function tokenFrom(message: NotificationMessage): string {
  const match = /\/case\/([A-Za-z0-9_-]{22})/u.exec(message.body);
  if (!match) throw new Error("link missing from the message");
  return match[1]!;
}

beforeEach(() => {
  process.env.CASE_TOKEN_SECRET = ["s1", "test", "secret"].join("-").repeat(3);
  process.env.NEXT_PUBLIC_SITE_URL = "https://tivdoc.example";
});

afterEach(() => {
  installNotificationProviderForTests(null);
  vi.restoreAllMocks();
});

describe("the case link on a verified payment (U4)", () => {
  it("sends exactly one link when the reconcile sweep runs twice, and never a second one after that", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    const first = await sweepPendingCaseLinks(50, db);
    const second = await sweepPendingCaseLinks(50, db);
    expect(first).toEqual({ examined: 1, sent: 1, failed: 0, already_sent: 0 });
    expect(second).toEqual({ examined: 0, sent: 0, failed: 0, already_sent: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe("case_link");
    expect(sent[0]!.to).toBe("dana.test@example.com");
    // A direct verification after the sweep is "already sent", not a second message.
    expect((await issueAndSendCaseLink(CASE.id, "payment_verified", db)).outcome).toBe("already_sent");
    expect(sent).toHaveLength(1);
    expect(db.tokens.filter((token) => token.purpose === "payment_verified")).toHaveLength(1);
  });

  it("records a failed send, blocks nothing, and the sweep retries it until it goes out", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const failing = capturingProvider(true);
    const result = await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    expect(result.outcome).toBe("send_failed");
    expect(db.notifications.map((row) => row.state)).toEqual(["failed"]);
    expect(failing).toHaveLength(1);
    const working = capturingProvider();
    const sweep = await sweepPendingCaseLinks(50, db);
    expect(sweep.sent).toBe(1);
    expect(working).toHaveLength(1);
    expect(await sweepPendingCaseLinks(50, db)).toMatchObject({ examined: 0 });
  });

  it("the token is in the message and the link's path only — hashed in the store, absent from logs, never a query string", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); });
    }
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const token = tokenFrom(sent[0]!);
    const link = new URL(`https://tivdoc.example/case/${token}`);
    expect(sent[0]!.body).toContain(link.toString());
    expect(link.search).toBe("");
    expect(logged.join("\n")).not.toContain(token);
    expect(JSON.stringify(db.calls)).not.toContain(token);
    expect(JSON.stringify(db.tokens)).not.toContain(token);
    expect(JSON.stringify(db.notifications)).not.toContain(token);
    expect(db.tokens[0]!.token_hash).toBe(hashToken(token));
  });
});

describe("the code challenge and the session (U2)", () => {
  it("a link token asks for a code, the code opens a session bound to the identity, and the session sees the case", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const token = tokenFrom(sent[0]!);
    const requested = await requestAccessCode({ token, request: requestWithIp("203.0.113.7") }, db);
    expect(requested).toMatchObject({ accepted: true, masked_channel: "email", masked_to: "d***@example.com", refused: null });
    const code = codeFrom(sent[1]!);
    const verified = await verifyAccessCode({ token, code }, db);
    expect(verified.outcome).toBe("ok");
    if (verified.outcome !== "ok") return;
    expect(verified.next).toBe("/case/TV-S1TEST01");
    const session = await resolveIdentitySession(verified.session, db);
    expect(session?.channel).toBe("email");
    const cases = await listIdentityCases(session!.identity_id, db);
    expect(cases.map((item) => item.public_id)).toEqual(["TV-S1TEST01"]);
    expect(JSON.stringify(db.sessions)).not.toContain(verified.session);
  });

  it("refuses the sixth attempt regardless of the digits", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const token = tokenFrom(sent[0]!);
    await requestAccessCode({ token, request: requestWithIp("203.0.113.8") }, db);
    const code = codeFrom(sent[1]!);
    const wrong = code === "000000" ? "111111" : "000000";
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) outcomes.push((await verifyAccessCode({ token, code: wrong }, db)).outcome);
    expect(outcomes).toEqual(["invalid", "invalid", "invalid", "invalid", "locked"]);
    // The sixth, with the right digits, is refused without being looked at.
    expect((await verifyAccessCode({ token, code }, db)).outcome).toBe("locked");
  });

  it("holds the per-IP ceiling uniformly, and answers an unknown contact exactly like a known one", async () => {
    const db = fakeCaseAccessDb([CASE]);
    capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const unknown = await requestAccessCode({ contact: "nobody@example.com", request: requestWithIp("198.51.100.1") }, db);
    expect(unknown).toEqual({ accepted: true, masked_channel: null, masked_to: null, refused: null });
    const known = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.2") }, db);
    // Lane B: a typed contact — known or not — gets the very same answer; only a link token earns the masked channel.
    expect(known).toEqual(unknown);
    // Twenty requests from one address are the ceiling; the twenty-first is refused for everyone the same way.
    for (let index = 0; index < 20; index += 1) {
      const result = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.3") }, db);
      expect(result.refused, `request ${index + 1}`).toBeNull();
    }
    const over = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.3") }, db);
    expect(over.refused).toBe("ip_rate_limited");
    const overUnknown = await requestAccessCode({ contact: "nobody@example.com", request: requestWithIp("198.51.100.3") }, db);
    expect(overUnknown.refused).toBe("ip_rate_limited");
  });

  it("limits code requests per identity silently: the sixth in the window is accepted and not sent", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    for (let index = 0; index < 5; index += 1) await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp(`192.0.2.${index + 1}`) }, db);
    const before = sent.length;
    const sixth = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("192.0.2.9") }, db);
    expect(sixth.accepted).toBe(true);
    expect(sent.length).toBe(before);
  });

  it("login by contact lands on the one case, and a resend is limited per case", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    await requestAccessCode({ contact: "050-123-4567", request: requestWithIp("203.0.113.9") }, db);
    // The phone normalizes to the same identity only if the case's channel was the phone; here the case's channel is the email, so the phone is unknown and no code went out.
    expect(sent.filter((message) => message.template === "access_code")).toHaveLength(0);
    await requestAccessCode({ contact: "DANA.TEST@example.com", request: requestWithIp("203.0.113.9") }, db);
    const code = codeFrom(sent.at(-1)!);
    const verified = await verifyAccessCode({ contact: "dana.test@example.com", code }, db);
    expect(verified.outcome).toBe("ok");
    if (verified.outcome === "ok") expect(verified.next).toBe("/case/TV-S1TEST01");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("sent");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("sent");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("resend_limited");
  });
});
