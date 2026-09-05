import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliveryAllowlist,
  recipientRefusal,
  sendNotification,
  type NotificationProvider,
} from "./notifications.ts";
import type { ContactChannel } from "./crypto.ts";

// Site S1.5 / U2. The allowlist is what stands between a run and the seven
// dummy cases' contacts. Its acceptance is not "the right recipient gets
// through" — it is "the wrong recipient is refused, and nothing reaches a
// provider when it is".

const OWNER_PHONE = "0585960615";
const OWNER_EMAIL = "info@tivdoc.com";
const STRANGER = "someone-else@example.invalid";

/** A provider that records every call, so "zero network calls" is a measurement rather than a hope. */
function countingProvider(): NotificationProvider & { calls: number } {
  const provider = {
    id: "counting_test_provider",
    calls: 0,
    async send() {
      provider.calls += 1;
      return { ok: true as const };
    },
  };
  return provider;
}

const message = (to: string) => ({
  template: "case_link" as const,
  channel: (to.includes("@") ? "email" : "phone") as ContactChannel,
  to,
  subject: "נושא",
  body: "גוף ההודעה",
});

describe("site S1.5 / U2: the delivery allowlist", () => {
  const saved = { list: process.env.DELIVERY_RECIPIENT_ALLOWLIST, vercelEnv: process.env.VERCEL_ENV, vercel: process.env.VERCEL };

  beforeEach(() => {
    process.env.DELIVERY_RECIPIENT_ALLOWLIST = `${OWNER_PHONE}, ${OWNER_EMAIL}`;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL;
  });

  afterEach(() => {
    if (saved.list === undefined) delete process.env.DELIVERY_RECIPIENT_ALLOWLIST; else process.env.DELIVERY_RECIPIENT_ALLOWLIST = saved.list;
    if (saved.vercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.vercelEnv;
    if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel;
    vi.restoreAllMocks();
  });

  it("refuses a third recipient and calls no provider at all", async () => {
    const provider = countingProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const outcome = await sendNotification(message(STRANGER), provider);
    expect(outcome.state).toBe("refused");
    expect(outcome.error_code).toBe("recipient_not_allowlisted");
    expect(provider.calls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the owner's two channels through", async () => {
    for (const to of [OWNER_PHONE, OWNER_EMAIL]) {
      const provider = countingProvider();
      const outcome = await sendNotification(message(to), provider);
      expect(outcome.state, to).toBe("sent");
      expect(provider.calls).toBe(1);
    }
  });

  it("treats one phone line written two ways as the same recipient", () => {
    expect(recipientRefusal("+972585960615")).toBeNull();
    expect(recipientRefusal("058-596-0615")).toBeNull();
    expect(recipientRefusal("0585960616")).toBe("recipient_not_allowlisted");
  });

  it("is case-insensitive about an address but refuses a different one", () => {
    expect(recipientRefusal("INFO@Tivdoc.com")).toBeNull();
    expect(recipientRefusal("info@tivdoc.co")).toBe("recipient_not_allowlisted");
  });

  it("fails closed: with the variable unset, every recipient outside production is refused", async () => {
    delete process.env.DELIVERY_RECIPIENT_ALLOWLIST;
    expect(deliveryAllowlist()).toEqual([]);
    const provider = countingProvider();
    const outcome = await sendNotification(message(OWNER_EMAIL), provider);
    expect(outcome.state).toBe("refused");
    expect(outcome.error_code).toBe("delivery_allowlist_not_configured");
    expect(provider.calls).toBe(0);
  });

  it("does not consult the list in production, where the recipients are customers", () => {
    delete process.env.DELIVERY_RECIPIENT_ALLOWLIST;
    process.env.VERCEL_ENV = "production";
    expect(recipientRefusal("a-real-customer@example.com")).toBeNull();
  });

  it("records a refusal with the payload digest and no recipient in the outcome", async () => {
    const outcome = await sendNotification(message(STRANGER), countingProvider());
    expect(outcome.payload_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(outcome)).not.toContain(STRANGER);
  });
});
