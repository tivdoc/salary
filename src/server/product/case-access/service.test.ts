// UX Run 1 acceptance at the service, corrected by the external review #1:
// the channel is verified in the funnel before anything binds (finding 1);
// the link is exchanged once and lives hours (finding 8); the link goes out
// once under a cron that runs twice; the sixth attempt is refused; the per-IP
// ceiling holds; an unknown contact answers like a known one; the token is in
// the message alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "./crypto.ts";
import { fakeCaseAccessDb, type FakeCase } from "./fake-db.ts";
import { installNotificationProviderForTests, type NotificationMessage } from "./notifications.ts";
import {
  describeChallenge, exchangeLinkToken, issueAndSendCaseLink, listIdentityCases, requestAccessCode, requestFunnelCode, resendCaseLink,
  resolveIdentitySession, sweepPendingCaseLinks, verifyAccessCode, verifyChallengeCode, verifyFunnelCode,
} from "./service.ts";

const NOW = Date.parse("2026-09-05T09:30:00.000Z");
const CASE: FakeCase = {
  id: "11111111-1111-4111-8111-111111111111", public_id: "TV-S1TEST01", email: "Dana.Test@Example.com", phone: "0501234567",
  first_name: "דנה", status: "under_review", payment_status: "verified", created_at: "2026-09-05T09:00:00.000Z", payment_verified: true,
  contact_verified_at: NOW, contact_verified_channel: "email",
};
const UNVERIFIED: FakeCase = { ...CASE, id: "22222222-2222-4222-8222-222222222222", public_id: "TV-S1TEST02", email: "typo.owner@example.com", contact_verified_at: null, contact_verified_channel: null };

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

describe("the funnel verifies the channel before anything binds (review finding 1)", () => {
  it("an address typed by mistake never shows its owner the payslip: nothing links until the case cookie's holder proves the channel", async () => {
    const db = fakeCaseAccessDb([UNVERIFIED]);
    const sent = capturingProvider();
    // The payment is verified, yet no link goes out to an unverified contact, and the sweep leaves it alone.
    expect((await issueAndSendCaseLink(UNVERIFIED.id, "payment_verified", db)).outcome).toBe("contact_unverified");
    expect(await sweepPendingCaseLinks(50, db)).toMatchObject({ examined: 0 });
    expect(sent).toHaveLength(0);
    // The funnel asks for the code: the identity row exists, unverified and unlinked.
    const asked = await requestFunnelCode({ caseId: UNVERIFIED.id, request: requestWithIp("203.0.113.1") }, db);
    expect(asked).toMatchObject({ accepted: true, case_found: true, already_verified: false, masked_channel: "email", masked_to: "t***@example.com" });
    expect(db.identity_cases).toHaveLength(0);
    // The address's real owner logs in with the code that reached them — and sees no case.
    const code = codeFrom(sent.at(-1)!);
    const owner = await verifyAccessCode({ contact: "typo.owner@example.com", code }, db);
    expect(owner.outcome).toBe("ok");
    if (owner.outcome !== "ok") return;
    expect(owner.next).toBe("/cases");
    expect(await listIdentityCases(owner.identity_id, db)).toEqual([]);
  });

  it("the case cookie's holder verifies the code: the case is marked, the identity linked, a session opened, and the funnel continues to the upload", async () => {
    const db = fakeCaseAccessDb([UNVERIFIED]);
    const sent = capturingProvider();
    await requestFunnelCode({ caseId: UNVERIFIED.id, request: requestWithIp("203.0.113.2") }, db);
    const wrong = await verifyFunnelCode({ caseId: UNVERIFIED.id, code: "000000" }, db);
    expect(["invalid", "locked"]).toContain(wrong.outcome);
    await requestFunnelCode({ caseId: UNVERIFIED.id, request: requestWithIp("203.0.113.2") }, db);
    const verified = await verifyFunnelCode({ caseId: UNVERIFIED.id, code: codeFrom(sent.at(-1)!) }, db);
    expect(verified.outcome).toBe("ok");
    if (verified.outcome !== "ok") return;
    expect(verified.next).toBe("/check/upload");
    expect(db.cases[0]!.contact_verified_at).not.toBeNull();
    expect(db.identity_cases).toHaveLength(1);
    const session = await resolveIdentitySession(verified.session, db);
    expect((await listIdentityCases(session!.identity_id, db)).map((item) => item.public_id)).toEqual(["TV-S1TEST02"]);
    // Only now does a verified payment send the link.
    expect((await issueAndSendCaseLink(UNVERIFIED.id, "payment_verified", db)).outcome).toBe("sent");
    expect((await requestFunnelCode({ caseId: UNVERIFIED.id, request: requestWithIp("203.0.113.2") }, db)).already_verified).toBe(true);
  });

  it("a typo is corrected before verification, and a verified contact cannot be replaced", async () => {
    const db = fakeCaseAccessDb([UNVERIFIED]);
    const sent = capturingProvider();
    const corrected = await requestFunnelCode({ caseId: UNVERIFIED.id, contact: "real.owner@example.com", request: requestWithIp("203.0.113.3") }, db);
    expect(corrected.masked_to).toBe("r***@example.com");
    expect(db.cases[0]!.email).toBe("real.owner@example.com");
    await verifyFunnelCode({ caseId: UNVERIFIED.id, code: codeFrom(sent.at(-1)!) }, db);
    await requestFunnelCode({ caseId: UNVERIFIED.id, contact: "someone.else@example.com", request: requestWithIp("203.0.113.3") }, db);
    expect(db.cases[0]!.email).toBe("real.owner@example.com");
  });
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
    expect((await issueAndSendCaseLink(CASE.id, "payment_verified", db)).outcome).toBe("already_sent");
    expect(sent).toHaveLength(1);
    expect(db.tokens.filter((token) => token.purpose === "payment_verified")).toHaveLength(1);
  });

  it("records a failed send, blocks nothing, and the sweep retries it until it goes out", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const failing = capturingProvider(true);
    expect((await issueAndSendCaseLink(CASE.id, "payment_verified", db)).outcome).toBe("send_failed");
    expect(db.notifications.map((row) => row.state)).toEqual(["failed"]);
    expect(failing).toHaveLength(1);
    const working = capturingProvider();
    expect((await sweepPendingCaseLinks(50, db)).sent).toBe(1);
    expect(working).toHaveLength(1);
    expect(await sweepPendingCaseLinks(50, db)).toMatchObject({ examined: 0 });
  });

  it("the token is in the message and the link's path only — hashed in the store, absent from logs, never a query string, and it lives hours", async () => {
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
    expect(db.tokens[0]!.token_hash).toBe(hashToken(token));
    expect(db.tokens[0]!.expires_at - db.now()).toBe(24 * 3_600 * 1_000);
  });
});

describe("the one-time exchange and the challenge (review finding 8)", () => {
  it("exchanges a valid token once — code sent, token spent, challenge opened — and refuses it the second time", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const token = tokenFrom(sent[0]!);
    const exchanged = await exchangeLinkToken({ token, request: requestWithIp("203.0.113.7") }, db);
    expect(exchanged.outcome).toBe("challenge");
    if (exchanged.outcome !== "challenge") return;
    expect(exchanged.public_id).toBe("TV-S1TEST01");
    expect(exchanged.challenge_ttl_seconds).toBe(15 * 60);
    expect(db.tokens[0]!.used_at).not.toBeNull();
    expect(sent.at(-1)!.template).toBe("access_code");
    expect((await exchangeLinkToken({ token, request: requestWithIp("203.0.113.7") }, db)).outcome).toBe("invalid");
    const described = await describeChallenge(exchanged.challenge, db);
    expect(described).toMatchObject({ live: true, public_id: "TV-S1TEST01", masked_to: "d***@example.com", channel: "email" });
    const verified = await verifyChallengeCode({ challenge: exchanged.challenge, code: codeFrom(sent.at(-1)!) }, db);
    expect(verified.outcome).toBe("ok");
    if (verified.outcome !== "ok") return;
    expect(verified.next).toBe("/case/TV-S1TEST01");
    expect(JSON.stringify(db.calls)).not.toContain(exchanged.challenge);
    expect((await describeChallenge(exchanged.challenge, db)).live).toBe(false);
  });

  it("refuses the sixth attempt on a challenge regardless of the digits", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const exchanged = await exchangeLinkToken({ token: tokenFrom(sent[0]!), request: requestWithIp("203.0.113.8") }, db);
    if (exchanged.outcome !== "challenge") throw new Error("exchange failed");
    const code = codeFrom(sent.at(-1)!);
    const wrong = code === "000000" ? "111111" : "000000";
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) outcomes.push((await verifyChallengeCode({ challenge: exchanged.challenge, code: wrong }, db)).outcome);
    expect(outcomes).toEqual(["invalid", "invalid", "invalid", "invalid", "locked"]);
    expect((await verifyChallengeCode({ challenge: exchanged.challenge, code }, db)).outcome).toBe("locked");
  });
});

describe("login and recovery by contact (U2)", () => {
  it("holds the per-IP ceiling uniformly, and answers an unknown contact exactly like a known one", async () => {
    const db = fakeCaseAccessDb([CASE]);
    capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    const unknown = await requestAccessCode({ contact: "nobody@example.com", request: requestWithIp("198.51.100.1") }, db);
    expect(unknown).toEqual({ accepted: true, masked_channel: null, masked_to: null, refused: null });
    const known = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.2") }, db);
    expect(known).toEqual(unknown);
    for (let index = 0; index < 20; index += 1) {
      const result = await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.3") }, db);
      expect(result.refused, `request ${index + 1}`).toBeNull();
    }
    expect((await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("198.51.100.3") }, db)).refused).toBe("ip_rate_limited");
    expect((await requestAccessCode({ contact: "nobody@example.com", request: requestWithIp("198.51.100.3") }, db)).refused).toBe("ip_rate_limited");
  });

  it("limits code requests per identity silently, and a known identity without a live code answers like a wrong code", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    expect((await verifyAccessCode({ contact: "dana.test@example.com", code: "123456" }, db)).outcome).toBe("invalid");
    expect((await verifyAccessCode({ contact: "nobody@example.com", code: "123456" }, db)).outcome).toBe("invalid");
    for (let index = 0; index < 5; index += 1) await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp(`192.0.2.${index + 1}`) }, db);
    const before = sent.length;
    expect((await requestAccessCode({ contact: "dana.test@example.com", request: requestWithIp("192.0.2.9") }, db)).accepted).toBe(true);
    expect(sent.length).toBe(before);
  });

  it("login by contact lands on the one verified case, and a resend is limited per case", async () => {
    const db = fakeCaseAccessDb([CASE]);
    const sent = capturingProvider();
    await issueAndSendCaseLink(CASE.id, "payment_verified", db);
    // The payment-time link made no identity link: only the funnel verification does. Seed the verified link as the funnel would.
    await db.rpc("case_access_funnel_verify", { target_case: CASE.id, target_identity: db.identities[0]!.id, target_channel: "email" });
    await requestAccessCode({ contact: "DANA.TEST@example.com", request: requestWithIp("203.0.113.9") }, db);
    const verified = await verifyAccessCode({ contact: "dana.test@example.com", code: codeFrom(sent.at(-1)!) }, db);
    expect(verified.outcome).toBe("ok");
    if (verified.outcome === "ok") expect(verified.next).toBe("/case/TV-S1TEST01");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("sent");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("sent");
    expect((await resendCaseLink(CASE.id, db)).outcome).toBe("resend_limited");
  });
});
