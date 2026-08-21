export const verifiedPaymentStatuses = new Set(["paid", "verified"]);

export function isPaymentVerified(status: string | null | undefined) {
  return status ? verifiedPaymentStatuses.has(status) : false;
}

export function isReviewInProgress(caseStatus: string | null | undefined) {
  return ["paid", "under_review", "completed"].includes(caseStatus ?? "");
}
