import { describe, expect, it, vi } from "vitest";
import {
  buildGa4PurchasePayload,
  processVerifiedGa4Purchase,
  stableGa4ClientId,
  type Ga4PurchaseClaim,
} from "./ga4-server-core";

const validClaim: Ga4PurchaseClaim = {
  paymentId: "payment-1",
  eventId: "tivdoc:payment_completed:payment-1",
  status: "verified",
  amount: 9.99,
  currency: "ILS",
};

function dependencies(claim: Ga4PurchaseClaim | null = validClaim) {
  return {
    claim: vi.fn().mockResolvedValue(claim),
    loadClientId: vi.fn().mockResolvedValue("123.456"),
    send: vi.fn().mockResolvedValue("sent" as const),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("processVerifiedGa4Purchase", () => {
  it("sends an authenticated payment once with the required value and currency", async () => {
    const deps = dependencies();
    await expect(processVerifiedGa4Purchase("case-1", deps)).resolves.toBe("sent");
    expect(deps.send).toHaveBeenCalledWith({
      clientId: "123.456",
      eventId: validClaim.eventId,
      transactionId: validClaim.paymentId,
      value: 9.99,
      currency: "ILS",
    });
    expect(deps.complete).toHaveBeenCalledOnce();
  });

  it("does not send before the payment is verified", async () => {
    const deps = dependencies({ ...validClaim, status: "pending" });
    await expect(processVerifiedGa4Purchase("case-1", deps)).resolves.toBe("not_verified");
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it("does not send again when the atomic claim returns no row", async () => {
    const deps = dependencies(null);
    await expect(processVerifiedGa4Purchase("case-1", deps)).resolves.toBe("not_claimed");
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("uses a stable valid fallback client id", () => {
    expect(stableGa4ClientId("case-1")).toMatch(/^\d+\.\d+$/);
    expect(stableGa4ClientId("case-1")).toBe(stableGa4ClientId("case-1"));
  });
});

describe("buildGa4PurchasePayload", () => {
  it("sends payment_completed and purchase together with the verified transaction", () => {
    const payload = buildGa4PurchasePayload({
      clientId: "123.456",
      eventId: validClaim.eventId,
      transactionId: validClaim.paymentId,
      value: 9.99,
      currency: "ILS",
    });

    expect(payload.client_id).toBe("123.456");
    expect(payload.events.map((event) => event.name)).toEqual([
      "payment_completed",
      "purchase",
    ]);
    for (const event of payload.events) {
      expect(event.params).toMatchObject({
        transaction_id: "payment-1",
        event_id: validClaim.eventId,
        value: 9.99,
        currency: "ILS",
      });
      expect(event.params).not.toHaveProperty("email");
      expect(event.params).not.toHaveProperty("phone");
      expect(event.params).not.toHaveProperty("name");
    }
  });
});
