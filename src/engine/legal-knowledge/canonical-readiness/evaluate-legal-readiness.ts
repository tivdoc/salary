import { createHash } from "node:crypto";

const LEGACY_REASON_CODES = Object.freeze([
  "PARSE_MISSING_OR_FAILED",
  "CITATION_MISSING_OR_UNVERIFIED",
  "SOURCE_ROLE_INELIGIBLE",
  "HUMAN_LEGAL_REVIEW_MISSING",
  "EFFECTIVE_INTERVAL_MISSING_OR_UNVERIFIED",
  "SECTOR_MISSING_OR_UNVERIFIED",
  "POPULATION_MISSING_OR_UNVERIFIED",
  "ACTIVATION_MISSING",
] as const);

/** Frozen V0.5.0 fail-closed reason contract. */
export const LEGAL_READINESS_REASON_CODES = Object.freeze([
  "PARSE_MISSING_OR_FAILED",
  "SOURCE_QUARANTINED_OR_NOT_RETRIEVABLE",
  "SOURCE_ROLE_INELIGIBLE",
  "CITATION_MISSING_OR_UNVERIFIED",
  "HUMAN_LEGAL_REVIEW_MISSING",
  "EFFECTIVE_INTERVAL_MISSING_INVALID_OR_UNVERIFIED",
  "SECTOR_MISSING_UNKNOWN_MISMATCH_OR_UNVERIFIED",
  "POPULATION_MISSING_MISMATCH_OR_UNVERIFIED",
  "ACTIVATION_MISSING",
  "MONETARY_SUPPORT_INELIGIBLE",
  "STALE_SOURCE_VERSION_BINDING",
] as const);

// Kept open for V0.4 report-shaping adapters; V0.5 values are frozen above.
export type LegalReadinessReasonCode = string;
export type LegalReadinessCase = Readonly<{
  case_id: string;
  topic: string;
  kind: "historical" | "current" | "missing_sector" | "sector_placeholder" | "adapter" | "synthetic";
  target_date: string;
  as_of: string;
  sector: string | null;
  population: string | null;
  contract_version?: "v0.5.0";
  use_case?: "monetary_rule" | "non_monetary_review";
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
  source_id?: string;
  acquisition_status?: "available" | "missing";
  technical_parse_status?: "parsed" | "missing" | "failed";
  instrument_boundary_status?: "resolved" | "ambiguous" | "unresolved";
  publication_status?: "review_candidate" | "quarantined" | "unpublished";
  retrieval_visibility?: "visible" | "hidden";
  retrieval_surface?: "canonical_review" | "corroborative_review" | "explanatory_review" | "none";
  source_role?: "binding_role_candidate" | "corroborative" | "secondary_explanatory" | "role_pending";
  monetary_support_eligibility?: "eligible" | "ineligible";
  citation?: Readonly<{ citation_id: string; verified: boolean; source_version_id: string }>;
  review_attestation?: Readonly<{
    attestation_id: string;
    status: "reviewed" | "needs_review";
    source_version_id: string;
    reviewed_at: string;
  }>;
  valid_time?: Readonly<{ from: string; to: string | null; verified: boolean }>;
  knowledge_time?: Readonly<{ available_from: string; unavailable_from: string | null }>;
  sector_status?: "verified" | "unverified" | "unknown";
  population_status?: "verified" | "unverified";
  activation_status?: "active" | "inactive";
  bound_source_version_id?: string;
}>;

export type LegalReadinessDecision = Readonly<{
  schema_version: string;
  decision_source: "evaluateLegalReadiness";
  status: "READY" | "BLOCKED_NOT_READY";
  reason_codes: readonly string[];
  decision_sha256: string;
  usable_for_rules: boolean;
  operative_candidate_source_version_ids: readonly string[];
  normalized_input_sha256: string | null;
}>;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function canonicalReadinessJson(value: unknown) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalReadinessJson(value)).digest("hex");
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function legacyEvaluation(input: Readonly<{ readinessCase: LegalReadinessCase; candidates: readonly LegalReadinessCandidate[] }>) {
  const relevant = input.candidates.filter((candidate) => candidate.topics.includes(input.readinessCase.topic));
  const operative = relevant.filter((candidate) => candidate.operative_role_eligible);
  const reasons = new Set<string>();
  if (!operative.some((candidate) => candidate.parse_succeeded)) reasons.add("PARSE_MISSING_OR_FAILED");
  if (!operative.some((candidate) => candidate.parse_succeeded && candidate.citation_verified)) reasons.add("CITATION_MISSING_OR_UNVERIFIED");
  if (operative.length === 0) reasons.add("SOURCE_ROLE_INELIGIBLE");
  if (!operative.some((candidate) => candidate.human_reviewed)) reasons.add("HUMAN_LEGAL_REVIEW_MISSING");
  if (!operative.some((candidate) => candidate.effective_interval_verified)) reasons.add("EFFECTIVE_INTERVAL_MISSING_OR_UNVERIFIED");
  if (!input.readinessCase.sector || input.readinessCase.kind === "sector_placeholder" || !operative.some((candidate) => candidate.verified_sectors.includes(input.readinessCase.sector!))) reasons.add("SECTOR_MISSING_OR_UNVERIFIED");
  if (!input.readinessCase.population || !operative.some((candidate) => candidate.verified_populations.includes(input.readinessCase.population!))) reasons.add("POPULATION_MISSING_OR_UNVERIFIED");
  if (!operative.some((candidate) => candidate.active)) reasons.add("ACTIVATION_MISSING");
  const reasonCodes = LEGACY_REASON_CODES.filter((reason) => reasons.has(reason));
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
    operative_candidate_source_version_ids: Object.freeze(operative.map((candidate) => candidate.source_version_id).sort()),
    normalized_input_sha256: null,
    usable_for_rules: reasonCodes.length === 0,
  });
  return Object.freeze({ ...decision, decision_sha256: sha256(decision) });
}

function normalizeV050Input(input: Readonly<{ readinessCase: LegalReadinessCase; candidates: readonly LegalReadinessCandidate[] }>) {
  const readinessCase = {
    case_id: input.readinessCase.case_id,
    topic: input.readinessCase.topic,
    kind: input.readinessCase.kind,
    target_date: input.readinessCase.target_date,
    as_of: input.readinessCase.as_of,
    sector: input.readinessCase.sector,
    population: input.readinessCase.population,
    contract_version: input.readinessCase.contract_version,
    use_case: input.readinessCase.use_case ?? "monetary_rule",
  };
  const candidates = input.candidates.map((candidate) => ({
    source_version_id: candidate.source_version_id,
    source_id: candidate.source_id ?? null,
    topics: [...candidate.topics].sort(),
    acquisition_status: candidate.acquisition_status ?? null,
    technical_parse_status: candidate.technical_parse_status ?? null,
    instrument_boundary_status: candidate.instrument_boundary_status ?? null,
    publication_status: candidate.publication_status ?? null,
    retrieval_visibility: candidate.retrieval_visibility ?? null,
    retrieval_surface: candidate.retrieval_surface ?? null,
    source_role: candidate.source_role ?? null,
    monetary_support_eligibility: candidate.monetary_support_eligibility ?? null,
    citation: candidate.citation ?? null,
    review_attestation: candidate.review_attestation ?? null,
    valid_time: candidate.valid_time ?? null,
    knowledge_time: candidate.knowledge_time ?? null,
    sector_status: candidate.sector_status ?? null,
    verified_sectors: [...candidate.verified_sectors].sort(),
    population_status: candidate.population_status ?? null,
    verified_populations: [...candidate.verified_populations].sort(),
    activation_status: candidate.activation_status ?? null,
    bound_source_version_id: candidate.bound_source_version_id ?? null,
  })).sort((a, b) => a.source_version_id.localeCompare(b.source_version_id, "en"));
  return Object.freeze({ readiness_case: Object.freeze(readinessCase), candidates: Object.freeze(candidates) });
}

type NormalizedCandidate = ReturnType<typeof normalizeV050Input>["candidates"][number];

function v050Reasons(readinessCase: ReturnType<typeof normalizeV050Input>["readiness_case"], candidate: NormalizedCandidate) {
  const reasons = new Set<LegalReadinessReasonCode>();
  if (candidate.acquisition_status !== "available" || candidate.technical_parse_status !== "parsed") reasons.add("PARSE_MISSING_OR_FAILED");
  if (candidate.instrument_boundary_status !== "resolved" || candidate.publication_status !== "review_candidate" || candidate.retrieval_visibility !== "visible" || candidate.retrieval_surface !== "canonical_review") reasons.add("SOURCE_QUARANTINED_OR_NOT_RETRIEVABLE");
  if (candidate.source_role !== "binding_role_candidate") reasons.add("SOURCE_ROLE_INELIGIBLE");
  if (!candidate.citation?.verified || candidate.citation.source_version_id !== candidate.source_version_id) reasons.add("CITATION_MISSING_OR_UNVERIFIED");
  if (candidate.review_attestation?.status !== "reviewed" || candidate.review_attestation.source_version_id !== candidate.source_version_id || !validIsoDate(candidate.review_attestation.reviewed_at) || candidate.review_attestation.reviewed_at > readinessCase.as_of) reasons.add("HUMAN_LEGAL_REVIEW_MISSING");
  const interval = candidate.valid_time;
  const knowledge = candidate.knowledge_time;
  if (!validIsoDate(readinessCase.target_date) || !validIsoDate(readinessCase.as_of) || !interval?.verified || !validIsoDate(interval.from) || (interval.to !== null && (!validIsoDate(interval.to) || interval.to < interval.from)) || readinessCase.target_date < (interval?.from ?? "") || (interval?.to !== null && readinessCase.target_date > interval.to) || !knowledge || !validIsoDate(knowledge.available_from) || readinessCase.as_of < knowledge.available_from || (knowledge.unavailable_from !== null && (!validIsoDate(knowledge.unavailable_from) || readinessCase.as_of >= knowledge.unavailable_from))) reasons.add("EFFECTIVE_INTERVAL_MISSING_INVALID_OR_UNVERIFIED");
  if (!readinessCase.sector || readinessCase.sector === "SYN_UNKNOWN" || candidate.sector_status !== "verified" || !candidate.verified_sectors.includes(readinessCase.sector)) reasons.add("SECTOR_MISSING_UNKNOWN_MISMATCH_OR_UNVERIFIED");
  if (!readinessCase.population || candidate.population_status !== "verified" || !candidate.verified_populations.includes(readinessCase.population)) reasons.add("POPULATION_MISSING_MISMATCH_OR_UNVERIFIED");
  if (candidate.activation_status !== "active") reasons.add("ACTIVATION_MISSING");
  if (readinessCase.use_case === "monetary_rule" && candidate.monetary_support_eligibility !== "eligible") reasons.add("MONETARY_SUPPORT_INELIGIBLE");
  if (!candidate.bound_source_version_id || candidate.bound_source_version_id !== candidate.source_version_id || (candidate.citation !== null && candidate.citation.source_version_id !== candidate.source_version_id) || (candidate.review_attestation !== null && candidate.review_attestation.source_version_id !== candidate.source_version_id)) reasons.add("STALE_SOURCE_VERSION_BINDING");
  return LEGAL_READINESS_REASON_CODES.filter((reason) => reasons.has(reason));
}

function v050Evaluation(input: Readonly<{ readinessCase: LegalReadinessCase; candidates: readonly LegalReadinessCandidate[] }>) {
  const normalizedInput = normalizeV050Input(input);
  const relevant = normalizedInput.candidates.filter((candidate) => candidate.topics.includes(normalizedInput.readiness_case.topic));
  const evaluated = relevant.map((candidate) => ({ candidate, reasons: v050Reasons(normalizedInput.readiness_case, candidate) }));
  evaluated.sort((a, b) => a.reasons.length - b.reasons.length || a.candidate.source_version_id.localeCompare(b.candidate.source_version_id, "en"));
  const selected = evaluated[0] ?? null;
  const reasonCodes = selected ? selected.reasons : [...LEGAL_READINESS_REASON_CODES];
  const normalizedInputSha256 = sha256(normalizedInput);
  const decision = Object.freeze({
    schema_version: "tivdoc-legal-readiness-decision-v0.5.0" as const,
    evaluator_version: "evaluateLegalReadiness@v0.5.0" as const,
    decision_source: "evaluateLegalReadiness" as const,
    normalized_input: normalizedInput,
    normalized_input_sha256: normalizedInputSha256,
    status: (reasonCodes.length === 0 ? "READY" : "BLOCKED_NOT_READY") as "READY" | "BLOCKED_NOT_READY",
    reason_codes: Object.freeze(reasonCodes),
    selected_source_version_id: selected?.candidate.source_version_id ?? null,
    considered_source_version_ids: Object.freeze(relevant.map((candidate) => candidate.source_version_id)),
    operative_candidate_source_version_ids: Object.freeze(relevant.filter((candidate) => candidate.source_role === "binding_role_candidate").map((candidate) => candidate.source_version_id)),
    usable_for_rules: reasonCodes.length === 0,
    test_only_synthetic: normalizedInput.readiness_case.kind === "synthetic",
  });
  return Object.freeze({ ...decision, decision_sha256: sha256(decision) });
}

/** The sole domain decision source for legal readiness and admission. */
export function evaluateLegalReadiness(input: Readonly<{ readinessCase: LegalReadinessCase; candidates: readonly LegalReadinessCandidate[] }>): LegalReadinessDecision {
  return input.readinessCase.contract_version === "v0.5.0" ? v050Evaluation(input) : legacyEvaluation(input);
}
