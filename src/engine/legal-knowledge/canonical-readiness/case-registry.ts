import registry from "./readiness-case-registry.v0.4.2.json" with { type: "json" };
import type { LegalReadinessCase } from "./evaluate-legal-readiness.ts";

export const LEGAL_READINESS_CASES = Object.freeze(registry.cases as readonly LegalReadinessCase[]);
export const LEGAL_READINESS_CASE_EXPECTATION = Object.freeze({
  status: registry.expected_status_for_all_cases,
  reason_codes: Object.freeze([...registry.expected_reason_codes_for_all_cases]),
  date_semantics: registry.date_semantics,
});
export function legalReadinessCase(caseId: string) {
  const result = LEGAL_READINESS_CASES.find((entry) => entry.case_id === caseId);
  if (!result) throw new Error(`legal_readiness_case_not_found:${caseId}`);
  return result;
}
