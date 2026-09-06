// Site S4 (ב.12) acceptance.
//
// A reminder is the one thing this product sends that nobody asked for, so the
// properties worth holding are all about restraint: it goes once, it stops when
// told to, and a refusal is not something to keep trying.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCaseAccessDb, type FakeCase } from "./fake-db.ts";
import { installNotificationProviderForTests, type NotificationMessage } from "./notifications.ts";
import { sweepAbandonedCases } from "./service.ts";
import { ABANDONMENT_AFTER_HOURS, abandonmentCandidates, optOutOfReminders } from "./abandonment.ts";

const CASE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function uploadedNotPaid(overrides: Partial<FakeCase> = {}): FakeCase {
  return {
    id: CASE_ID, public_id: "TV-S4ABAN1", email: "dana.test@example.com", phone: null, first_name: "דנה",
    status: "documents_uploaded", payment_status: "not_started",
    created_at: "2026-09-05T09:00:00.000Z", payment_verified: false,
    contact_verified_at: Date.parse("2026-09-05T09:05:00.000Z"), contact_verified_channel: "email",
    ...overrides,
  };
}

function capturingProvider(result: { ok: true } | { ok: false; error_code: string } = { ok: true }) {
  const sent: NotificationMessage[] = [];
  installNotificationProviderForTests({
    id: "test_capture",
    async send(message) { sent.push(message); return result; },
  });
  return sent;
}

beforeEach(() => {
  process.env.CASE_TOKEN_SECRET = ["s4", "test", "secret"].join("-").repeat(4);
  process.env.NEXT_PUBLIC_SITE_URL = "https://tivdoc.example";
  process.env.DELIVERY_RECIPIENT_ALLOWLIST = "dana.test@example.com";
});

afterEach(() => {
  delete process.env.DELIVERY_RECIPIENT_ALLOWLIST;
  installNotificationProviderForTests(null);
});

describe("S4 ב.12 — the one reminder", () => {
  it("sends once, and a second sweep sends nothing", async () => {
    const db = fakeCaseAccessDb([uploadedNotPaid()]);
    const sent = capturingProvider();

    const first = await sweepAbandonedCases({ afterHours: 0 }, db);
    expect(first).toMatchObject({ examined: 1, sent: 1, failed: 0, refused: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe("abandonment_reminder");

    // The cron runs twice; the customer hears from us once.
    const second = await sweepAbandonedCases({ afterHours: 0 }, db);
    expect(second).toMatchObject({ examined: 0, sent: 0 });
    expect(sent).toHaveLength(1);
  });

  it("carries the way back and the way out, and promises no second message", async () => {
    const db = fakeCaseAccessDb([uploadedNotPaid()]);
    const sent = capturingProvider();
    await sweepAbandonedCases({ afterHours: 0 }, db);

    const body = sent[0]!.body;
    expect(body).toMatch(/https:\/\/tivdoc\.example\/case\/[A-Za-z0-9_-]{22}/u);
    expect(body).toContain("/check/reminders/off?t=");
    expect(body).toContain("זו הודעה אחת");
    // Nothing about a discount, a deadline or an expiring offer.
    expect(body).not.toMatch(/הנחה|מבצע|יפוג|אחרונה/u);
    expect(db.tokens.at(-1)!.purpose).toBe("abandonment_reminder");
  });

  it("says nothing to someone who opted out, whatever else is true of the case", async () => {
    const db = fakeCaseAccessDb([uploadedNotPaid()]);
    expect(await optOutOfReminders(CASE_ID, db)).toBe(true);
    const sent = capturingProvider();
    expect(await sweepAbandonedCases({ afterHours: 0 }, db)).toMatchObject({ examined: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it("waits the configured hours before it counts a case as abandoned", async () => {
    // The fixture store's clock is frozen at 2026-09-05T10:00Z, so this case is
    // one hour old — past a zero wait and nowhere near twenty-four.
    const db = fakeCaseAccessDb([uploadedNotPaid()]);
    expect(ABANDONMENT_AFTER_HOURS).toBe(24);
    expect(await abandonmentCandidates({ afterHours: ABANDONMENT_AFTER_HOURS }, db)).toHaveLength(0);
    expect(await abandonmentCandidates({ afterHours: 0 }, db)).toHaveLength(1);

    // Advance past the wait and it becomes one.
    db.advance(25 * 60 * 60 * 1000);
    expect(await abandonmentCandidates({ afterHours: ABANDONMENT_AFTER_HOURS }, db)).toHaveLength(1);
  });

  it("leaves a paid case and an unverified contact alone", async () => {
    const paid = fakeCaseAccessDb([uploadedNotPaid({ payment_status: "verified", payment_verified: true })]);
    expect(await abandonmentCandidates({ afterHours: 0 }, paid)).toHaveLength(0);

    const unverified = fakeCaseAccessDb([uploadedNotPaid({ contact_verified_at: null, contact_verified_channel: null })]);
    expect(await abandonmentCandidates({ afterHours: 0 }, unverified)).toHaveLength(0);
  });

  it("never retries a refused recipient, and may retry a failed send", async () => {
    // S1.5's distinction: the allowlist refusing is a policy decision, and a
    // sweep that retried it would be arguing with ourselves forever.
    const refused = fakeCaseAccessDb([uploadedNotPaid({ email: "someone.else@example.com" })]);
    capturingProvider();
    const outcome = await sweepAbandonedCases({ afterHours: 0 }, refused);
    expect(outcome).toMatchObject({ examined: 1, sent: 0, refused: 1 });
    expect(await abandonmentCandidates({ afterHours: 0 }, refused)).toHaveLength(0);

    const failing = fakeCaseAccessDb([uploadedNotPaid()]);
    capturingProvider({ ok: false, error_code: "provider_down" });
    expect(await sweepAbandonedCases({ afterHours: 0 }, failing)).toMatchObject({ examined: 1, sent: 0, failed: 1 });
    // A provider outage is not the customer's answer: this one comes back.
    expect(await abandonmentCandidates({ afterHours: 0 }, failing)).toHaveLength(1);
  });

  it("without a store, sends nothing and claims nothing", async () => {
    expect(await sweepAbandonedCases({ afterHours: 0 }, null)).toMatchObject({ examined: 0, sent: 0 });
    expect(await abandonmentCandidates({}, null)).toEqual([]);
    expect(await optOutOfReminders(CASE_ID, null)).toBe(false);
  });
});
