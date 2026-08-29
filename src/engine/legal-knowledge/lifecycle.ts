import type { LegalSource } from "./contracts.ts";
import { legalSourceSchema } from "./contracts.ts";

const transitions: Readonly<Record<LegalSource["status"], readonly LegalSource["status"][]>> = {
  draft: ["fetched", "verified", "needs_review", "unavailable", "rejected"],
  fetched: ["parsed", "candidate", "needs_review", "unavailable", "rejected"],
  parsed: ["candidate", "needs_review", "rejected"],
  candidate: ["needs_review", "reviewed", "rejected"],
  verified: ["reviewed", "active", "needs_review", "rejected"],
  reviewed: ["active", "needs_review", "rejected"],
  active: ["superseded", "needs_review"],
  superseded: ["needs_review"],
  needs_review: ["reviewed", "verified", "rejected"],
  rejected: [],
  unavailable: ["fetched", "needs_review", "rejected"],
};

export function canTransitionLegalSourceStatus(from: LegalSource["status"], to: LegalSource["status"]) {
  return transitions[from].includes(to);
}

export function validateLegalSourceActivation(source: LegalSource) {
  const candidate = { ...source, status: "active" };
  const result = legalSourceSchema.safeParse(candidate);
  return result.success
    ? { passed: true as const, issues: [] as string[] }
    : { passed: false as const, issues: result.error.issues.map((issue) => issue.message) };
}
