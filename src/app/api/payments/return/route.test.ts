import { describe, expect, it } from "vitest";
import { paymentReturnDestination } from "@/lib/payment-return";

describe("Invoice4u return URL", () => {
  it("ignores browser-supplied success and transaction parameters", () => {
    const destination = paymentReturnDestination(
      "https://salary.example/api/payments/return?status=success&PaymentId=fake&amount=9.99&payment_return=attacker",
    );

    expect(destination.toString()).toBe("https://salary.example/check/received?returned=1");
    expect(destination.searchParams.has("PaymentId")).toBe(false);
    expect(destination.searchParams.has("status")).toBe(false);
    expect(destination.searchParams.has("payment_return")).toBe(false);
  });
});
