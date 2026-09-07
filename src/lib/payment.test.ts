import { afterEach, describe, expect, it } from "vitest";
import {
  INVOICE4U_CHECKOUT_TTL_MS,
  createPaymentReturnToken,
  getPaymentReturnUrl,
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

describe("payment return destination", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  afterEach(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
    if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  });

  it("uses the canonical public site in production", () => {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_URL = "protected-deployment.vercel.app";
    process.env.NEXT_PUBLIC_SITE_URL = "https://tivdoc.com";

    const returnUrl = new URL(getPaymentReturnUrl("a".repeat(43)));

    expect(returnUrl.origin).toBe("https://tivdoc.com");
    expect(returnUrl.pathname).toBe("/api/payments/return");
    expect(returnUrl.searchParams.get("payment_return")).toBe("a".repeat(43));
  });

  it("uses the current deployment host for previews", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_URL = "current-preview.vercel.app";
    process.env.NEXT_PUBLIC_SITE_URL = "https://stale-preview.vercel.app";

    expect(new URL(getPaymentReturnUrl("b".repeat(43))).origin).toBe(
      "https://current-preview.vercel.app",
    );
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
