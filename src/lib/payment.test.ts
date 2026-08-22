import { describe, expect, it } from "vitest";
import {
  INVOICE4U_CHECKOUT_TTL_MS,
  createPaymentReturnToken,
  hashPaymentReturnToken,
  invoice4uOrderIdForCase,
  isInvoice4uCheckoutReusable,
  isPaymentReturnToken,
} from "./payment";

describe("Invoice4u payment identity", () => {
  it("binds the provider order to the public case identifier", () => {
    expect(invoice4uOrderIdForCase("case-123")).toBe("tivdoc-salary:case-123");
  });
});

describe("payment return identity", () => {
  it("creates an opaque 256-bit URL-safe token and stores only its hash", () => {
    const token = createPaymentReturnToken();
    expect(isPaymentReturnToken(token)).toBe(true);
    expect(hashPaymentReturnToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashPaymentReturnToken(token)).not.toContain(token);
  });

  it("rejects missing or attacker-controlled return values", () => {
    expect(isPaymentReturnToken(null)).toBe(false);
    expect(isPaymentReturnToken("success")).toBe(false);
    expect(isPaymentReturnToken("a".repeat(42))).toBe(false);
  });
});

describe("Invoice4u checkout expiry", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");

  it("reuses a checkout that is still fresh", () => {
    const createdAt = new Date(now - INVOICE4U_CHECKOUT_TTL_MS + 1).toISOString();
    expect(isInvoice4uCheckoutReusable("https://secure.example/checkout", createdAt, now)).toBe(
      true,
    );
  });

  it("regenerates a checkout once its TTL has elapsed", () => {
    const createdAt = new Date(now - INVOICE4U_CHECKOUT_TTL_MS).toISOString();
    expect(isInvoice4uCheckoutReusable("https://secure.example/checkout", createdAt, now)).toBe(
      false,
    );
  });

  it("does not reuse legacy or malformed checkout records", () => {
    expect(isInvoice4uCheckoutReusable("https://secure.example/checkout", null, now)).toBe(false);
    expect(isInvoice4uCheckoutReusable("https://secure.example/checkout", "invalid", now)).toBe(
      false,
    );
  });
});
