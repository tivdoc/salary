import { frozen } from '../legal-operations/canonical.ts';
import { evaluateLegalReadiness, type LegalReadinessCandidate } from '../legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts';
import { JUNE2026_MINIMUM_WAGE_SOURCES, JUNE2026_MINIMUM_WAGE_POLICY } from './sources.ts';

export const JUNE2026_SOURCE_VERSION_IDS = Object.freeze(JUNE2026_MINIMUM_WAGE_SOURCES.map(source => source.source_version_id));

/** This is the same sole canonical evaluator's input, not a second admission
 * implementation. The current evidence package has no signed approvals.
 * Proposed scope/time below is not presented as reviewer-verified scope/time. */
export function june2026MinimumWageSourceCandidates(): readonly LegalReadinessCandidate[] {
  return frozen(JUNE2026_MINIMUM_WAGE_SOURCES.map(source => ({
    source_id: source.source_id, source_version_id: source.source_version_id,
    topics: ['minimum_wage'], parse_succeeded: source.parsed_sha256 !== null,
    citation_verified: source.parsed_sha256 !== null,
    operative_role_eligible: source.role === 'primary_binding',
    human_reviewed: false, effective_interval_verified: false,
    verified_sectors: [], verified_populations: [], active: false,
    acquisition_status: 'available' as const,
    technical_parse_status: source.parsed_sha256 !== null ? 'parsed' as const : 'missing' as const,
    instrument_boundary_status: 'resolved' as const,
    publication_status: 'review_candidate' as const,
    retrieval_visibility: 'visible' as const,
    retrieval_surface: source.role === 'primary_binding' ? 'canonical_review' as const : 'corroborative_review' as const,
    source_role: source.role === 'primary_binding' ? 'binding_role_candidate' as const : 'corroborative' as const,
    monetary_support_eligibility: source.role === 'primary_binding' ? 'eligible' as const : 'ineligible' as const,
    citation: {citation_id: `${source.source_id}.june2026.pinned.locators`, verified: source.parsed_sha256 !== null, source_version_id: source.source_version_id},
    valid_time: {...source.interval, verified: false},
    knowledge_time: {available_from: '2026-09-09', unavailable_from: null},
    sector_status: 'unverified' as const, population_status: 'unverified' as const,
    activation_status: 'inactive' as const, bound_source_version_id: source.source_version_id,
  })));
}

export function june2026MinimumWageAdmission(asOf = '2026-09-09') {
  return evaluateLegalReadiness({readinessCase: {
    case_id: 'JUNE2026_UNSIGNED_MINIMUM_WAGE', topic: 'minimum_wage', kind: 'historical',
    target_date: '2026-06-01', as_of: asOf,
    sector: JUNE2026_MINIMUM_WAGE_POLICY.sector, population: JUNE2026_MINIMUM_WAGE_POLICY.population,
    contract_version: 'v0.5.0', use_case: 'monetary_rule',
  }, candidates: june2026MinimumWageSourceCandidates()});
}
