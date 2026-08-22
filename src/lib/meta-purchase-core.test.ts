import { describe, expect, it, vi } from "vitest";
import {
  processVerifiedMetaPurchase,
  type MetaPurchaseClaim,
  type MetaPurchaseDependencies,
} from "./meta-purchase-core";

function purchaseHarness(overrides: Partial<MetaPurchaseClaim> = {}) {
  let sent = false;
  let leased = false;
  const claim: MetaPurchaseClaim = {
    paymentId: "payment-1",
    eventId: "tivdoc:Purchase:payment-1",
    status: "verified",
    amount: 9.99,
    currency: "ILS",
    ...overrides,
  };
  const send = vi.fn(async () => "sent" as const);
  const dependencies: MetaPurchaseDependencies = {
    async claim() {
      if (sent || leased) return null;
      leased = true;
      return claim;
    },
    async loadCustomer() {
      return { email: "person@example.com" };
    },
    send,
    async complete() {
      sent = true;
      leased = false;
    },
    async release() {
      leased = false;
    },
  };
  return { dependencies, send };
}

describe("Meta Purchase delivery", () => {
  it("does not send Purchase before the payment is verified", async () => {
    const harness = purchaseHarness({ status: "pending" });
    const result = await processVerifiedMetaPurchase(
      "case-1",
      "https://tivdoc.com/check/received",
      {},
      harness.dependencies,
    );

    expect(result).toBe("not_verified");
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("sends the verified Purchase with 9.99 ILS", async () => {
    const harness = purchaseHarness();
    await processVerifiedMetaPurchase(
      "case-1",
      "https://tivdoc.com/check/received",
      {},
      harness.dependencies,
    );

    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "Purchase",
        eventId: "tivdoc:Purchase:payment-1",
        customData: { value: 9.99, currency: "ILS" },
      }),
    );
  });

  it("deduplicates duplicate provider callbacks through the atomic claim", async () => {
    const harness = purchaseHarness();
    await Promise.all([
      processVerifiedMetaPurchase(
        "case-1",
        "https://tivdoc.com/check/received",
        {},
        harness.dependencies,
      ),
      processVerifiedMetaPurchase(
        "case-1",
        "https://tivdoc.com/check/received",
        {},
        harness.dependencies,
      ),
    ]);

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("does not resend CAPI Purchase when received status is refreshed", async () => {
    const harness = purchaseHarness();
    await processVerifiedMetaPurchase(
      "case-1",
      "https://tivdoc.com/check/received",
      {},
      harness.dependencies,
    );
    await processVerifiedMetaPurchase(
      "case-1",
      "https://tivdoc.com/check/received",
      {},
      harness.dependencies,
    );

    expect(harness.send).toHaveBeenCalledTimes(1);
  });
});
