import { describe, expect, it } from "vitest";
import { Invoice4uHostedPaymentAdapter } from "./payment";

describe("Invoice4uHostedPaymentAdapter", () => {
  it("returns the configured hosted page without hardcoded credentials", () => {
    const handoff = new Invoice4uHostedPaymentAdapter("https://example.invoice4u.test/pay/product").createHandoff();
    expect(handoff).toEqual({ provider: "invoice4u", url: "https://example.invoice4u.test/pay/product" });
  });

  it("fails closed when no hosted payment URL exists", () => {
    expect(() => new Invoice4uHostedPaymentAdapter("").createHandoff()).toThrow(/not configured/);
  });

  it("rejects non-HTTP protocols", () => {
    expect(() => new Invoice4uHostedPaymentAdapter("javascript:alert(1)").createHandoff()).toThrow(/HTTP/);
  });
});
