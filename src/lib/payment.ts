export const INITIAL_CHECK_PRICE = 9.99;
export const INITIAL_CHECK_CURRENCY = "ILS";

export function invoice4uOrderIdForCase(caseId: string) {
  return `tivdoc-salary:${caseId}`;
}

export function getPaymentReturnUrl() {
  const deploymentHost = process.env.VERCEL_URL;
  const siteUrl = deploymentHost
    ? `https://${deploymentHost}`
    : process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    throw new Error("A site URL is required to create an Invoice4u checkout");
  }

  return new URL("/api/payments/return", siteUrl).toString();
}
