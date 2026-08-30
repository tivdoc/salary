import { createHash } from "node:crypto";

export const LEGAL_READINESS_REASON_CODES = Object.freeze([
  "PARSE_MISSING_OR_FAILED",
  "CITATION_MISSING_OR_UNVERIFIED",
  "SOURCE_ROLE_INELIGIBLE",
  "HUMAN_LEGAL_REVIEW_MISSING",
  "EFFECTIVE_INTERVAL_MISSING_OR_UNVERIFIED",
  "SECTOR_MISSING_OR_UNVERIFIED",
  "POPULATION_MISSING_OR_UNVERIFIED",
  "ACTIVATION_MISSING",
] as const);

export type LegalReadinessReasonCode = typeof LEGAL_READINESS_REASON_CODES[number];
export type LegalReadinessCase = Readonly<{
  case_id: string;
  topic: string;
  kind: "historical" | "current" | "missing_sector" | "sector_placeholder" | "adapter";
  target_date: string;
  as_of: string;
  sector: string | null;
  population: string | null;
}>;
export type LegalReadinessCandidate = Readonly<{
  source_version_id: string;
  topics: readonly string[];
  parse_succeeded: boolean;
  citation_verified: boolean;
  operative_role_eligible: boolean;
  human_reviewed: boolean;
  effective_interval_verified: boolean;
  verified_sectors: readonly string[];
  verified_populations: readonly string[];
  active: boolean;
}>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
export function canonicalReadinessJson(value: unknown) { return `${JSON.stringify(stable(value), null, 2)}\n`; }

/** The sole domain decision source for legal readiness and admission. */
export function evaluateLegalReadiness(input: Readonly<{ readinessCase: LegalReadinessCase; candidates: readonly LegalReadinessCandidate[] }>) {
  const relevant = input.candidates.filter((candidate) => candidate.topics.includes(input.readinessCase.topic));
  const operative = relevant.filter((candidate) => candidate.operative_role_eligible);
  const reasons = new Set<LegalReadinessReasonCode>();
  if (!operative.some((candidate) => candidate.parse_succeeded)) reasons.add("PARSE_MISSING_OR_FAILED");
  if (!operative.some((candidate) => candidate.parse_succeeded && candidate.citation_verified)) reasons.add("CITATION_MISSING_OR_UNVERIFIED");
  if (operative.length === 0) reasons.add("SOURCE_ROLE_INELIGIBLE");
  if (!operative.some((candidate) => candidate.human_reviewed)) reasons.add("HUMAN_LEGAL_REVIEW_MISSING");
  if (!operative.some((candidate) => candidate.effective_interval_verified)) reasons.add("EFFECTIVE_INTERVAL_MISSING_OR_UNVERIFIED");
  if (!input.readinessCase.sector || input.readinessCase.kind === "sector_placeholder" || !operative.some((candidate) => candidate.verified_sectors.includes(input.readinessCase.sector!))) reasons.add("SECTOR_MISSING_OR_UNVERIFIED");
  if (!input.readinessCase.population || !operative.some((candidate) => candidate.verified_populations.includes(input.readinessCase.population!))) reasons.add("POPULATION_MISSING_OR_UNVERIFIED");
  if (!operative.some((candidate) => candidate.active)) reasons.add("ACTIVATION_MISSING");
  const reasonCodes = LEGAL_READINESS_REASON_CODES.filter((reason) => reasons.has(reason));
  const selectedCandidateIds = operative.map((candidate) => candidate.source_version_id).sort();
  const decision = Object.freeze({
    schema_version: "canonical-legal-readiness-decision-v0.4.2" as const,
    decision_source: "evaluateLegalReadiness" as const,
    case_id: input.readinessCase.case_id,
    topic: input.readinessCase.topic,
    target_date: input.readinessCase.target_date,
    as_of: input.readinessCase.as_of,
    sector: input.readinessCase.sector,
    population: input.readinessCase.population,
    status: (reasonCodes.length === 0 ? "READY" : "BLOCKED_NOT_READY") as "READY" | "BLOCKED_NOT_READY",
    reason_codes: Object.freeze(reasonCodes),
    operative_candidate_source_version_ids: Object.freeze(selectedCandidateIds),
    usable_for_rules: reasonCodes.length === 0,
  });
  return Object.freeze({ ...decision, decision_sha256: createHash("sha256").update(canonicalReadinessJson(decision)).digest("hex") });
}
