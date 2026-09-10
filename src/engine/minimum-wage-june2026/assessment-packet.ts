import {z} from 'zod';
import {employmentSnapshotSchema, type EmploymentSnapshot} from '../facts/snapshot.ts';
import {canonicalSha256, deepFreeze} from '../rule-runtime/canonical.ts';
import type {June2026AdmittedContext} from './admitted-context.ts';
import {june2026WageEvidenceSchema, JUNE2026_APPLICABILITY_REQUESTS} from './evidence.ts';
import {prepareJune2026MinimumWage} from './executor.ts';

export const JUNE2026_ASSESSMENT_PACKET_VERSION = 'tivdoc-june2026-admission-assessment-v1';
type Resolution = June2026AdmittedContext['collection']['resolutions'][number];
type Subject = ReturnType<typeof targetOf>['subject'];
type GateState = 'missing' | 'stale' | 'expired' | 'unknown' | 'conflicted' | 'declared_unreviewed';
const targetOf = (row: Resolution) => 'declaration' in row ? row.declaration.target : row.target;

/** The input must come from the authenticated saved-run loader. A hash verifies
 * identity of that context, never the legal authority of a declaration. This
 * negative admission path intentionally accepts no approval-shaped argument. */
export function prepareJune2026AssessmentPacket(input: {context: June2026AdmittedContext; facts: EmploymentSnapshot}) {
  const {context} = input;
  const {context_sha256, ...contextBody} = context;
  if (canonicalSha256(contextBody) !== context_sha256) throw Error('JUNE_ASSESSMENT_CONTEXT_HASH');
  if (context.legal_activation !== false || context.publication_allowed !== false
    || context.component_legal_classification !== 'unreviewed'
    || context.legal_gates.length !== 9 || context.legal_gates.some(gate => gate.status !== 'not_admitted')) {
    throw Error('JUNE_ASSESSMENT_UNSUPPORTED_AUTHORITY');
  }
  const facts = employmentSnapshotSchema.parse(input.facts);
  if (facts.case_id !== context.current.case_id || facts.analysis_run_id !== context.current.analysis_run_id
    || canonicalSha256(facts) !== context.facts_snapshot_sha256) throw Error('JUNE_ASSESSMENT_FACTS_BINDING');
  const currentTarget = (row: Resolution) => {
    const target = targetOf(row);
    return target.case_id === context.current.case_id && target.month === context.current.month
      && target.product_document_id === context.document.product_document_id && target.version_id === context.document.version_id
      && target.source_sha256 === context.document.sha256 && target.extraction_result_sha256 === context.extraction_result_sha256
      && target.extraction_policy_version === context.extraction_policy_version && target.legal_policy_sha256 === context.legal_policy_sha256;
  };
  const gate = (field: string, matches: (subject: Subject) => boolean) => {
    const observations = context.collection.resolutions.filter(row => matches(targetOf(row).subject));
    const current = observations.filter(row => row.state !== 'stale' && currentTarget(row));
    if (current.length > 1) throw Error('JUNE_ASSESSMENT_AMBIGUOUS_CURRENT_GATE');
    const row = current[0];
    const state: GateState = !row ? observations.length ? 'stale' : 'missing' : row.state === 'declared' ? 'declared_unreviewed' : row.state;
    const declaration = row && 'declaration' in row ? row.declaration : null;
    return {field, state, admitted: false as const,
      required_action: state === 'declared_unreviewed' ? 'authenticated_assessment_or_approved_admission_policy_required'
        : state === 'conflicted' ? 'resolve_conflicting_source_evidence'
        : state === 'unknown' ? 'obtain_missing_source_evidence'
        : state === 'stale' || state === 'expired' ? 'obtain_current_source_answer' : 'obtain_identified_source_answer',
      current_target_sha256: row ? targetOf(row).target_sha256 : null,
      observed_declaration: declaration, observations,
      assertion: {status: state === 'conflicted' ? 'conflicted' as const : 'missing' as const,
        value: null, provenance: declaration?.provenance ?? []}};
  };
  const applicability = Object.keys(JUNE2026_APPLICABILITY_REQUESTS) as (keyof typeof JUNE2026_APPLICABILITY_REQUESTS)[];
  const gates = applicability.map(field => gate(`applicability.${field}`, subject => subject.kind === 'applicability' && subject.field === field));
  const completeness = gate('wage_components_complete', subject => subject.kind === 'earnings_completeness');
  const component = context.single_monetary_component;
  const classification = component ? gate('components.legal_classification', subject => subject.kind === 'component' && subject.component.component_id === component.component_id) : null;
  const componentObservations = context.collection.resolutions.filter(row => targetOf(row).subject.kind === 'component');
  // A matching amount is factual reconciliation only. Neither the OCR semantic
  // label nor the customer's substance choice is a legally confirmed class.
  const evidence = june2026WageEvidenceSchema.parse({schema_version: 'tivdoc-june2026-minimum-wage-evidence-v1',
    case_id: facts.case_id, analysis_run_id: facts.analysis_run_id, facts_snapshot_sha256: context.facts_snapshot_sha256,
    documents: [context.document], applicability: Object.fromEntries(gates.map((entry, index) => [applicability[index], entry.assertion])),
    wage_components_complete: completeness.assertion,
    components: component?.amount && component.source.text_fragment && classification ? [{component_id: component.component_id, classification: 'unclassified',
      classification_status: classification.assertion.status, classification_provenance: classification.assertion.provenance,
      amount_minor: component.amount.minor_units, currency: component.amount.currency, version_id: component.source.document_id,
      page: component.source.page, locator: component.source.text_fragment}] : [],
  });
  const preflight = prepareJune2026MinimumWage({facts, evidence, calculatedAt: z.iso.datetime({offset: true}).parse(context.collection.evaluated_at)});
  if (preflight.state === 'candidate_calculated') throw Error('JUNE_ASSESSMENT_UNEXPECTED_CALCULATION');
  const seed = {schema_version: JUNE2026_ASSESSMENT_PACKET_VERSION, authority: 'unadmitted_assessment_packet_only',
    current: context.current, document: context.document, factual_context_sha256: context_sha256,
    facts_snapshot_sha256: context.facts_snapshot_sha256, policy_sha256: context.legal_policy_sha256,
    extraction_result_sha256: context.extraction_result_sha256, rule_input: context.rule_input,
    gates: [...gates, completeness, ...(classification ? [classification] : [])],
    component_mapping: {state: classification ? 'documented_single_component_unclassified' : 'single_component_unavailable', observations: componentObservations},
    factual_issues: [...context.factual_issues, ...(component && !component.source.text_fragment
      ? [{field: 'components', reason: 'component_text_locator_required'}] : [])], evidence, evidence_sha256: canonicalSha256(evidence),
    preflight, active_catalog: {state: 'not_admitted', authority_supplied: false},
    candidate_calculation_performed: false, execution_allowed: false, publication_allowed: false};
  return deepFreeze({...seed, packet_sha256: canonicalSha256(seed)});
}
export type June2026AssessmentPacket = ReturnType<typeof prepareJune2026AssessmentPacket>;
