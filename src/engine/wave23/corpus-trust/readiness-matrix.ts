import {
  futureLegalActivationAdmission,
  futureLegalShadowAdmission,
  legalCorpusTopicGate,
  legalReadinessDiagnostic,
  legalReadinessStrict,
  legalServerResolverAdmission,
} from "../../legal-knowledge/canonical-readiness/delegates.ts";
import { LEGAL_READINESS_REASON_CODES, type LegalReadinessCandidate, type LegalReadinessCase, type LegalReadinessReasonCode } from "../../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";
import { SYNTHETIC_READY_CANDIDATE, SYNTHETIC_READY_CASE, SYNTHETIC_READY_FIXTURE_CONTROLS } from "./synthetic-ready.fixture.ts";

type Mutation = Readonly<{
  case_id: string;
  expected_reason_codes: readonly LegalReadinessReasonCode[];
  mutate: (readinessCase: LegalReadinessCase, candidate: LegalReadinessCandidate) => Readonly<{ readinessCase: LegalReadinessCase; candidate: LegalReadinessCandidate }>;
}>;

const candidateChange = (change: Partial<LegalReadinessCandidate>) => (_readinessCase: LegalReadinessCase, candidate: LegalReadinessCandidate) => ({ readinessCase: SYNTHETIC_READY_CASE, candidate: { ...candidate, ...change } });
const caseChange = (change: Partial<LegalReadinessCase>) => (readinessCase: LegalReadinessCase, candidate: LegalReadinessCandidate) => ({ readinessCase: { ...readinessCase, ...change }, candidate });

export const READINESS_MUTATIONS: readonly Mutation[] = Object.freeze([
  { case_id: "READINESS_MUTATION_001_PARSE_MISSING", expected_reason_codes: ["PARSE_MISSING_OR_FAILED"], mutate: candidateChange({ acquisition_status: "missing", technical_parse_status: "missing" }) },
  { case_id: "READINESS_MUTATION_002_PARSE_FAILED", expected_reason_codes: ["PARSE_MISSING_OR_FAILED"], mutate: candidateChange({ technical_parse_status: "failed" }) },
  { case_id: "READINESS_MUTATION_003_QUARANTINED", expected_reason_codes: ["SOURCE_QUARANTINED_OR_NOT_RETRIEVABLE"], mutate: candidateChange({ publication_status: "quarantined" }) },
  { case_id: "READINESS_MUTATION_004_NOT_RETRIEVABLE", expected_reason_codes: ["SOURCE_QUARANTINED_OR_NOT_RETRIEVABLE"], mutate: candidateChange({ retrieval_visibility: "hidden" }) },
  { case_id: "READINESS_MUTATION_005_SOURCE_ROLE", expected_reason_codes: ["SOURCE_ROLE_INELIGIBLE"], mutate: candidateChange({ source_role: "role_pending" }) },
  { case_id: "READINESS_MUTATION_006_CITATION_MISSING", expected_reason_codes: ["CITATION_MISSING_OR_UNVERIFIED"], mutate: candidateChange({ citation: undefined }) },
  { case_id: "READINESS_MUTATION_007_UNREVIEWED", expected_reason_codes: ["HUMAN_LEGAL_REVIEW_MISSING"], mutate: candidateChange({ review_attestation: { ...SYNTHETIC_READY_CANDIDATE.review_attestation!, status: "needs_review" } }) },
  { case_id: "READINESS_MUTATION_008_INVALID_INTERVAL", expected_reason_codes: ["EFFECTIVE_INTERVAL_MISSING_INVALID_OR_UNVERIFIED"], mutate: candidateChange({ valid_time: { from: "2030-12-31", to: "2030-01-01", verified: true } }) },
  { case_id: "READINESS_MUTATION_009_SECTOR_MISMATCH", expected_reason_codes: ["SECTOR_MISSING_UNKNOWN_MISMATCH_OR_UNVERIFIED"], mutate: candidateChange({ verified_sectors: ["SYN_SECTOR_BETA"] }) },
  { case_id: "READINESS_MUTATION_010_SECTOR_MISSING", expected_reason_codes: ["SECTOR_MISSING_UNKNOWN_MISMATCH_OR_UNVERIFIED"], mutate: caseChange({ sector: null }) },
  { case_id: "READINESS_MUTATION_011_SECTOR_UNKNOWN", expected_reason_codes: ["SECTOR_MISSING_UNKNOWN_MISMATCH_OR_UNVERIFIED"], mutate: caseChange({ sector: "SYN_UNKNOWN" }) },
  { case_id: "READINESS_MUTATION_012_POPULATION_MISMATCH", expected_reason_codes: ["POPULATION_MISSING_MISMATCH_OR_UNVERIFIED"], mutate: candidateChange({ verified_populations: ["SYN_POPULATION_BETA"] }) },
  { case_id: "READINESS_MUTATION_013_INACTIVE", expected_reason_codes: ["ACTIVATION_MISSING"], mutate: candidateChange({ activation_status: "inactive" }) },
  { case_id: "READINESS_MUTATION_014_MONETARY_INELIGIBLE", expected_reason_codes: ["MONETARY_SUPPORT_INELIGIBLE"], mutate: candidateChange({ monetary_support_eligibility: "ineligible" }) },
  { case_id: "READINESS_MUTATION_015_SECONDARY_ONLY_MONETARY", expected_reason_codes: ["SOURCE_ROLE_INELIGIBLE", "MONETARY_SUPPORT_INELIGIBLE"], mutate: candidateChange({ source_role: "secondary_explanatory", monetary_support_eligibility: "ineligible" }) },
  { case_id: "READINESS_MUTATION_016_CORROBORATIVE_ONLY_MONETARY", expected_reason_codes: ["SOURCE_ROLE_INELIGIBLE", "MONETARY_SUPPORT_INELIGIBLE"], mutate: candidateChange({ source_role: "corroborative", monetary_support_eligibility: "ineligible" }) },
  { case_id: "READINESS_MUTATION_017_STALE_BINDING", expected_reason_codes: ["STALE_SOURCE_VERSION_BINDING"], mutate: candidateChange({ bound_source_version_id: "SYN_SOURCE_ALPHA@stale" }) },
  { case_id: "READINESS_MUTATION_018_AMBIGUOUS_BOUNDARY", expected_reason_codes: ["SOURCE_QUARANTINED_OR_NOT_RETRIEVABLE"], mutate: candidateChange({ instrument_boundary_status: "ambiguous" }) },
]);

export function readinessDelegateMatrix() {
  const outputs = [
    legalReadinessDiagnostic(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
    legalReadinessStrict(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
    legalCorpusTopicGate(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
    legalServerResolverAdmission(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
    futureLegalActivationAdmission(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
    futureLegalShadowAdmission(SYNTHETIC_READY_CASE, [SYNTHETIC_READY_CANDIDATE]),
  ];
  return Object.freeze({
    fixture_controls: SYNTHETIC_READY_FIXTURE_CONTROLS,
    outputs: Object.freeze(outputs),
    totals: Object.freeze({ delegate_count: outputs.length, ready_count: outputs.filter((output) => output.decision.status === "READY").length, unique_decision_hash_count: new Set(outputs.map((output) => output.decision.decision_sha256)).size }),
  });
}

export function readinessMutationMatrix() {
  const cases = READINESS_MUTATIONS.map((mutation) => {
    const changed = mutation.mutate(SYNTHETIC_READY_CASE, SYNTHETIC_READY_CANDIDATE);
    const first = legalCorpusTopicGate(changed.readinessCase, [changed.candidate]).decision;
    const replay = legalCorpusTopicGate(changed.readinessCase, [changed.candidate]).decision;
    const passed = first.status === "BLOCKED_NOT_READY" && JSON.stringify(first.reason_codes) === JSON.stringify(mutation.expected_reason_codes) && first.decision_sha256 === replay.decision_sha256;
    return Object.freeze({ case_id: mutation.case_id, expected_status: "BLOCKED_NOT_READY" as const, expected_reason_codes: mutation.expected_reason_codes, actual_status: first.status, actual_reason_codes: first.reason_codes, decision_sha256: first.decision_sha256, replay_decision_sha256: replay.decision_sha256, passed });
  });
  const coveredReasons = new Set(cases.flatMap((entry) => entry.actual_reason_codes));
  return Object.freeze({ schema_version: "tivdoc-readiness-mutation-matrix-v0.5.0" as const, cases: Object.freeze(cases), totals: Object.freeze({ case_count: cases.length, passed_count: cases.filter((entry) => entry.passed).length, required_reason_code_count: LEGAL_READINESS_REASON_CODES.length, covered_reason_code_count: LEGAL_READINESS_REASON_CODES.filter((reason) => coveredReasons.has(reason)).length }), passed: cases.every((entry) => entry.passed) && LEGAL_READINESS_REASON_CODES.every((reason) => coveredReasons.has(reason)) });
}
