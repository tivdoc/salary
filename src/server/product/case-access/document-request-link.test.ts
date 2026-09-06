// Site S2.4 acceptance at the delivery seam: the link that brings a customer
// back with the payslip they said they would find later.
//
// The interesting property is the one it does NOT share with every other link
// in this file's neighbour: it is not gated on payment. A case waiting for a
// document has not paid and cannot start, so holding its link until payment
// would ask for money before the check could begin. What it is still gated on
// is the contact — an access link to an address nobody proved they own is the
// exact failure the access system was rebuilt to remove.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCaseAccessDb, type FakeCase } from "./fake-db.ts";
import { installNotificationProviderForTests, type NotificationMessage } from "./notifications.ts";
import { sendDocumentRequestLink, verifyFunnelCode } from "./service.ts";
import { beginAwaitingDocument } from "../reports/awaiting-document.ts";
import { REQUEST_TIMING } from "../reports/refusal-requests.ts";

const NOW = Date.parse("2026-09-05T09:30:00.000Z");
const WAITING: FakeCase = {
  id: "44444444-4444-4444-8444-444444444444", public_id: "TV-S24TEST", email: "dana.test@example.com", phone: null,
  first_name: "דנה", status: "questionnaire_completed", payment_status: "not_started",
  created_at: "2026-09-05T09:00:00.000Z", payment_verified: false,
  contact_verified_at: NOW, contact_verified_channel: "email",
};
const UNVERIFIED: FakeCase = { ...WAITING, id: "55555555-5555-4555-8555-555555555555", public_id: "TV-S24TES2", contact_verified_at: null, contact_verified_channel: null };

function capturingProvider() {
  const sent: NotificationMessage[] = [];
  installNotificationProviderForTests({
    id: "test_capture",
    async send(message) { sent.push(message); return { ok: true }; },
  });
  return sent;
}

beforeEach(() => {
  process.env.CASE_TOKEN_SECRET = ["s1", "test", "secret"].join("-").repeat(3);
  process.env.NEXT_PUBLIC_SITE_URL = "https://tivdoc.example";
  // S1.5 / U2: delivery fails closed outside production; this is a fixture address.
  process.env.DELIVERY_RECIPIENT_ALLOWLIST = "dana.test@example.com";
});

afterEach(() => {
  delete process.env.DELIVERY_RECIPIENT_ALLOWLIST;
  installNotificationProviderForTests(null);
});

describe("S2.4 — the upload link", () => {
  it("goes out to a verified contact on an unpaid case, and carries the ten days the thread enforces", async () => {
    const db = fakeCaseAccessDb([WAITING]);
    const sent = capturingProvider();
    const result = await sendDocumentRequestLink(WAITING.id, db);

    expect(result.outcome).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template).toBe("document_request");
    expect(sent[0]!.to).toBe("dana.test@example.com");
    expect(sent[0]!.body).toContain(String(REQUEST_TIMING.expiry_days));
    expect(sent[0]!.body).toMatch(/https:\/\/tivdoc\.example\/case\/[A-Za-z0-9_-]{22}/u);
    // The link is in the message and nowhere else: the row keeps a digest.
    expect(db.notifications[0]).toMatchObject({ template: "document_request", state: "sent" });
    expect(JSON.stringify(db.notifications[0])).not.toContain(sent[0]!.body);
    expect(db.tokens[0]!.purpose).toBe("document_request");
  });

  it("says nothing about a check that has not run", async () => {
    const db = fakeCaseAccessDb([WAITING]);
    const sent = capturingProvider();
    await sendDocumentRequestLink(WAITING.id, db);
    // No finding, no amount, no certainty — nothing has been read yet.
    expect(sent[0]!.body).not.toMatch(/₪|\d+\s*ש"ח|ודאות/u);
  });

  it("refuses an unverified contact", async () => {
    const db = fakeCaseAccessDb([UNVERIFIED]);
    const sent = capturingProvider();
    const result = await sendDocumentRequestLink(UNVERIFIED.id, db);
    expect(result.outcome).toBe("contact_unverified");
    expect(sent).toHaveLength(0);
    expect(db.tokens).toHaveLength(0);
  });

  it("is sent by the funnel's verification, but only for a case that is actually waiting", async () => {
    const db = fakeCaseAccessDb([{ ...WAITING, contact_verified_at: null, contact_verified_channel: null }]);
    await beginAwaitingDocument(WAITING.id, db);

    const sent = capturingProvider();
    // The funnel's own verification path: request a code, read it, verify it.
    const { requestFunnelCode } = await import("./service.ts");
    await requestFunnelCode({ caseId: WAITING.id, request: new Request("http://localhost/api/cases/access/request", { method: "POST" }) }, db);
    const code = /(\d{6})/u.exec(sent.find((message) => message.template === "access_code")!.body)![1]!;
    const verified = await verifyFunnelCode({ caseId: WAITING.id, code }, db);

    expect(verified.outcome).toBe("ok");
    expect(sent.filter((message) => message.template === "document_request")).toHaveLength(1);
  });

  it("is not sent when the funnel verifies a case with nothing outstanding", async () => {
    const db = fakeCaseAccessDb([{ ...WAITING, contact_verified_at: null, contact_verified_channel: null }]);
    const sent = capturingProvider();
    const { requestFunnelCode } = await import("./service.ts");
    await requestFunnelCode({ caseId: WAITING.id, request: new Request("http://localhost/api/cases/access/request", { method: "POST" }) }, db);
    const code = /(\d{6})/u.exec(sent.find((message) => message.template === "access_code")!.body)![1]!;
    await verifyFunnelCode({ caseId: WAITING.id, code }, db);
    expect(sent.filter((message) => message.template === "document_request")).toHaveLength(0);
  });
});
