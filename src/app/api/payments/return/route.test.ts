import { describe, expect, it } from "vitest";
import { paymentReturnDestination } from "./route";

describe("Invoice4u return URL", () => {
  it("ignores browser-supplied success and transaction parameters", () => {
    const destination = paymentReturnDestination(
      "https://salary.example/api/payments/return?status=success&PaymentId=fake&amount=9.99",
    );

    expect(destination.toString()).toBe("https://salary.example/check/received?returned=1");
    expect(destination.searchParams.has("PaymentId")).toBe(false);
    expect(destination.searchParams.has("status")).toBe(false);
  });
});
