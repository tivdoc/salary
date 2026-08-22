import { createHash, randomBytes } from "node:crypto";

export const INITIAL_CHECK_PRICE = 9.99;
export const INITIAL_CHECK_CURRENCY = "ILS";
export const INVOICE4U_CHECKOUT_TTL_MS = 10 * 60 * 1000;
export const PAYMENT_RETURN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function createPaymentReturnToken() {
  return randomBytes(32).toString("base64url");
}

export function isPaymentReturnToken(value: string | null): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function hashPaymentReturnToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isInvoice4uCheckoutReusable(
  url: string | null,
  createdAt: string | null,
  now = Date.now(),
) {
  if (!url || !createdAt) return false;

  const createdAtMs = Date.parse(createdAt);
  return (
    Number.isFinite(createdAtMs) &&
    createdAtMs <= now &&
    now - createdAtMs < INVOICE4U_CHECKOUT_TTL_MS
  );
}

export function invoice4uOrderIdForCase(caseId: string) {
  return `tivdoc-salary:${caseId}`;
}

export function getPaymentReturnUrl(paymentReturnToken: string) {
  const deploymentHost = process.env.VERCEL_URL;
  const siteUrl = deploymentHost
    ? `https://${deploymentHost}`
    : process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    throw new Error("A site URL is required to create an Invoice4u checkout");
  }

  const returnUrl = new URL("/api/payments/return", siteUrl);
  returnUrl.searchParams.set("payment_return", paymentReturnToken);
  return returnUrl.toString();
}
