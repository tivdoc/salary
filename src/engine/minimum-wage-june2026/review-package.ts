import {frozen, legalOperationsSha256} from '../legal-operations/canonical.ts';
import {reviewPacketSchema} from '../legal-operations/contracts.ts';
import {buildBlankDecisionTemplate} from '../legal-operations/review-packets.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {JUNE2026_MINIMUM_WAGE_SOURCES, JUNE2026_MINIMUM_WAGE_POLICY, JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';

/** A review handoff, never an attestation. Each PDF text file is one explicitly
 * identified full-document review chunk. No invented page-level hash or HTML
 * transcription is used. Existing trust/signature admission remains mandatory. */
export function buildJune2026MinimumWageReviewPackage() {
  const publications = [
    {publication_reference: 'Minimum Wage Law 1987; NII consolidated copy, section6(1) footnote4', published_at: null},
    {publication_reference: 'Yalkut Hapirsumim7732 pp6284-6285', published_at: '2018-03-19'},
    {publication_reference: 'Yalkut Hapirsumim14324 p4496; signed2026-03-03', published_at: '2026-03-04'},
    {publication_reference: 'NII adult minimum-wage table; effective2026-04-01', published_at: null},
  ];
  const seed = {
    schema_version: 'tivdoc-source-review-packet-v0.6.0',
    packet_id: 'IL_MINIMUM_WAGE_JUNE2026_SOURCE_REVIEW', packet_version: '1.0.0', topic: 'minimum_wage',
    generated_at: '2026-09-09T18:00:00.000Z', scope_complete_as_of: '2026-09-09', completeness_status: 'blocked',
    sources: JUNE2026_MINIMUM_WAGE_SOURCES.map((source, index) => ({
      source_version_id: source.source_version_id, immutable_source_record_sha256: legalOperationsSha256(source),
      artifact_sha256: source.artifact_sha256, chunk_sha256s: source.parsed_sha256 ? [source.parsed_sha256] : [],
      hash_availability: source.parsed_sha256 ? 'verified_hashes_present' : 'chunks_unavailable',
      authority_role: source.role, publication_metadata: publications[index],
      proposed_effective_periods: [{...source.interval, status: 'unverified'}],
      proposed_sectors: ['general_private'], proposed_populations: ['adult_general'],
      lifecycle_blockers: [
        'Human source decisions and signed attestations absent; activation inactive.',
        'June2026 validity, authority precedence and employee applicability have not been human-attested.',
        ...(source.parsed_sha256 ? [] : ['Official corroboration HTML has no pinned parsed review chunk and is not an operative parameter source.']),
        ...(source.source_id === 'IL_MIN_WAGE_NOTICE_2026' ? ['Primary notice reproduced on a nonofficial host; original-origin authenticity remains unattested.'] : []),
      ],
    })),
    known_conflicts: [
      'Law section1 retains186; proposed182 branch relies on the2018 extension order2.8 and requires the employee to be within its scope.',
      'Published hourly35.40 versus exact6443.85/182: candidate100h gap240.58 differs from engineering fixture240.00. No operative rounding mandate acquired.',
    ],
    quarantines: [], parse_failures: [],
    missing_official_material: [
      'Original-origin copy or authenticated provenance for Yalkut14324 p4496; current bytes are a reproduced primary instrument.',
      'Operative direction resolving hourly intermediate rounding versus exact182 division and final-agora rounding.',
      'June2026 continuation/no-repeal verification for the2018 order including its sunset provision.',
    ],
    reviewer_questions: [
      'Verify the exact archived artifact bytes and full-document text chunks, including Gazette column order and the law consolidation lineage.',
      'Confirm6443.85 from2026-04-01 and whether the2018 order182 divisor applies to the proposed June2026 hourly adult general-private scope.',
      'Resolve35.40 intermediate rounding versus full-precision182 division and justify final-agora half-up with its authority and examples.',
      'Approve or reject included/excluded component classes under law3(a)-(b), treatment of unknown commission/nonstandard remuneration under3(d), and the ordinary-hours-only boundary.',
      'Confirm the required employee evidence for age, all30(a) exceptions, adapted wage and better arrangements; a generic job-title answer cannot decide the legal classification.',
    ],
    decision_template_id: 'IL_MINIMUM_WAGE_JUNE2026_BLANK_DECISION', usable_for_rules: false,
  };
  const packet = reviewPacketSchema.parse({...seed, packet_sha256: legalOperationsSha256(seed)});
  const candidates = Array.from({length: 32}, (_, index) => createJune2026MinimumWageCandidate(index + 1));
  const bundle = {
    schema_version: 'tivdoc-june2026-minimum-wage-unsigned-review-bundle-v1',
    packet, blank_source_decision: buildBlankDecisionTemplate(packet),
    policy: JUNE2026_MINIMUM_WAGE_POLICY, policy_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
    source_chunks: JUNE2026_MINIMUM_WAGE_SOURCES.filter(source => source.parsed_sha256).map(source => ({
      source_version_id: source.source_version_id, file: `${source.file}.txt`, sha256: source.parsed_sha256,
      boundary: 'entire_pypdf_layout_text_including_explicit_pdf_page_markers',
    })),
    candidate_families: candidates.map((candidate, index) => ({
      component_count: index + 1, rule_spec_id: candidate.rule.rule_spec_id,
      rule_spec_version: candidate.rule.rule_spec_version, rule_spec_sha256: candidate.rule.content_sha256,
      golden_cases_sha256: candidate.goldenCases.content_sha256,
      parameter_candidates: candidate.parameters.map(parameter => ({parameter_id: parameter.parameter_id, parameter_version: parameter.parameter_version, candidate_sha256: parameter.candidate_sha256})),
      approval_status: 'unsigned',
    })),
    // Concrete artifacts for a one-component payroll are included for review;
    // every other arity is reproducible by its bounded, hash-pinned factory.
    one_component_artifacts: candidates[0],
    pending_parameter_reviews: {distinct_human_reviewers_per_candidate: 2, attestations: []},
    pending_rule_reviews: {semantic_approval: null, independent_golden_approval: null},
    activation: {approved_by: null, signed_envelope: null, allowed: false},
    customer_analysis_ready: false,
  };
  return frozen({...bundle, bundle_sha256: legalOperationsSha256(bundle)});
}
