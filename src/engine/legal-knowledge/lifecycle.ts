import type { LegalSource } from "./contracts.ts";
import { legalSourceSchema } from "./contracts.ts";

const transitions: Readonly<Record<LegalSource["status"], readonly LegalSource["status"][]>> = {
  draft: ["verified", "needs_review", "rejected"],
  verified: ["active", "needs_review", "rejected"],
  active: ["superseded", "needs_review"],
  superseded: ["needs_review"],
  needs_review: ["verified", "rejected"],
  rejected: [],
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
