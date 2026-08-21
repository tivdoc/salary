import { describe, expect, it } from "vitest";
import { isPaymentVerified, isReviewInProgress } from "./case-status";

describe("payment status decisions", () => {
  it("does not treat a pending return as payment success", () => {
    expect(isPaymentVerified("pending")).toBe(false);
    expect(isReviewInProgress("payment_pending")).toBe(false);
  });

  it("accepts only server-verified payment states", () => {
    expect(isPaymentVerified("verified")).toBe(true);
    expect(isReviewInProgress("under_review")).toBe(true);
  });
});
