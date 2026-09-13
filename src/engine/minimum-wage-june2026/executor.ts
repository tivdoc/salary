import { z } from 'zod';
import type { CanonicalFact } from '../facts/contracts.ts';
import { employmentSnapshotSchema, type EmploymentSnapshot } from '../facts/snapshot.ts';
import { canonicalSha256 } from '../rule-runtime/canonical.ts';
import { frozen } from '../legal-operations/canonical.ts';
import { executeRuleSpec, type RuleSpecInputValue } from '../legal-operations/rulespec.ts';
import { june2026WageEvidenceSchema, JUNE2026_APPLICABILITY_REQUESTS, type June2026WageEvidence } from './evidence.ts';
import { createJune2026MinimumWageCandidate, componentInputId } from './candidate.ts';
import { JUNE2026_MINIMUM_WAGE_POLICY as policy, JUNE2026_MINIMUM_WAGE_POLICY_SHA256 as policySha256 } from './sources.ts';

export type June2026InputRequest = Readonly<{field: string; reason: string; prompt: string}>;
const required = ['work.regular_hours', 'compensation.salary_type', 'compensation.base_monthly_salary', 'compensation.gross_salary', 'documents.period'] as const;
const included = new Set<string>(policy.included_components);

function evidenced(provenance: CanonicalFact['provenance'], evidence: June2026WageEvidence) {
  return provenance.some(source => {
    if (source.source_type === 'declared') {
      return source.source_reference.kind === 'case_request_answer' || source.source_reference.kind === 'questionnaire_response';
    }
    if (source.source_type !== 'documented') return false;
    const document = evidence.documents.find(d => d.version_id === source.source_reference.document_id);
    const page = source.source_reference.locator?.page;
    return document && page !== undefined && page >= 1 && page <= document.page_count;
  });
}

function documentedOn(fact: CanonicalFact, documentId: string, evidence: June2026WageEvidence) {
  return fact.provenance.some(source => source.source_type === 'documented'
    && source.source_reference.document_id === documentId && evidenced([source], evidence));
}

/** The caller must load this sidecar and document versions through its existing
 * case/session ownership and current-revision checks. This pure adapter binds
 * the supplied facts, bytes/version manifest and assessments; it cannot attest
 * that a request ID was authorized in the database. No inference is promoted. */
export function prepareJune2026MinimumWage(input: {
  facts: EmploymentSnapshot; evidence: June2026WageEvidence; calculatedAt: string;
}) {
  const facts = employmentSnapshotSchema.parse(input.facts);
  const evidence = june2026WageEvidenceSchema.parse(input.evidence);
  const calculatedAt = z.iso.datetime({offset: true}).parse(input.calculatedAt);
  const factsSnapshotSha256 = canonicalSha256(facts);
  if (evidence.case_id !== facts.case_id || evidence.analysis_run_id !== facts.analysis_run_id
      || evidence.facts_snapshot_sha256 !== factsSnapshotSha256) throw new Error('JUNE2026_EVIDENCE_SNAPSHOT_BINDING_MISMATCH');
  const requests: June2026InputRequest[] = [];
  const blockers: string[] = [];
  const request = (field: string, reason: string, prompt = 'נדרש נתון מהימן לתקופת יוני 2026.') => requests.push({field, reason, prompt});
  const byPath = new Map(facts.facts.map(fact => [fact.path, fact]));
  for (const path of required) {
    const fact = byPath.get(path);
    if (!fact || fact.status !== 'confirmed' || fact.value === null || fact.conflicting_fact_ids.length > 0) {
      request(path, fact?.status === 'conflicted' || (fact?.conflicting_fact_ids.length ?? 0) > 0 ? 'conflicting_fact' : 'confirmed_fact_required');
    } else if (!evidenced(fact.provenance, evidence)) request(path, 'document_or_identified_answer_source_required');
  }
  for (const field of Object.keys(JUNE2026_APPLICABILITY_REQUESTS) as (keyof typeof JUNE2026_APPLICABILITY_REQUESTS)[]) {
    const assertion = evidence.applicability[field];
    if (assertion.status !== 'confirmed' || !evidenced(assertion.provenance, evidence)) {
      request(`applicability.${field}`, assertion.status === 'conflicted' ? 'conflicting_assessment' : 'applicability_evidence_required', JUNE2026_APPLICABILITY_REQUESTS[field]);
    } else if (assertion.value !== (field === 'sector' ? 'general_private' : true)) {
      blockers.push(`unsupported_applicability:${field}`);
    }
  }
  if (evidence.wage_components_complete.status !== 'confirmed' || evidence.wage_components_complete.value !== true
      || !evidenced(evidence.wage_components_complete.provenance, evidence)) {
    request('wage_components_complete', 'complete_earnings_inventory_required', 'נדרש פירוט מלא של רכיבי התשלום בתלוש וסיווגם, ללא ניכויים או קיזוזים בין תקופות.');
  }
  if (evidence.components.length === 0) request('components', 'documented_components_required');
  for (const component of evidence.components) {
    if (component.classification === 'unclassified' || component.classification_status !== 'confirmed'
      || !evidenced(component.classification_provenance, evidence)) {
      request(`components.${component.component_id}.classification`, component.classification_status === 'conflicted' ? 'conflicting_component_classification' : 'component_classification_required', `נדרש לברר את מהות רכיב השכר ${component.component_id}; שם הרכיב לבדו אינו קובע אם הוא נכלל.`);
    }
  }
  const population = byPath.get('employment.population');
  if (population?.status === 'confirmed' && population.path === 'employment.population' && population.value?.population !== 'general') blockers.push('unsupported_applicability:canonical_population');
  const birthYear = byPath.get('person.birth_year');
  // A year alone cannot establish an exact birthday in2008; it can expose a
  // contradiction. The whole-month adulthood assessment remains necessary.
  if (birthYear?.status === 'confirmed' && birthYear.path === 'person.birth_year' && birthYear.value !== null && birthYear.value > 2008) blockers.push('unsupported_applicability:canonical_birth_year');
  const managerial = byPath.get('employment.managerial_or_trust_role_declared');
  if (managerial?.status === 'confirmed' && managerial.value === true && evidence.applicability.hours_rest_law_applies.value === true) {
    request('applicability.hours_rest_law_applies', 'managerial_or_trust_role_requires_resolved_applicability');
  }
  if (blockers.length > 0) return frozen({state: 'out_of_scope' as const, blockers, requests, activationAllowed: false, pricingAllowed: false});
  if (requests.length > 0) return frozen({state: 'missing_input' as const, requests, activationAllowed: false, pricingAllowed: false});
  const hours = byPath.get('work.regular_hours')!;
  const salaryType = byPath.get('compensation.salary_type')!;
  const base = byPath.get('compensation.base_monthly_salary')!;
  const gross = byPath.get('compensation.gross_salary')!;
  const period = byPath.get('documents.period')!;
  if (hours.path !== 'work.regular_hours' || !hours.value || base.path !== 'compensation.base_monthly_salary' || !base.value
      || gross.path !== 'compensation.gross_salary' || !gross.value || period.path !== 'documents.period' || !period.value) {
    throw new Error('JUNE2026_REQUIRED_FACT_SHAPE');
  }
  if (salaryType.value !== 'hourly') blockers.push('unsupported_salary_type');
  if (period.value.period.start_date !== policy.period.start_date || period.value.period.end_date !== policy.period.end_date) blockers.push('unsupported_period');
  if (base.value.currency !== 'ILS' || gross.value.currency !== 'ILS') blockers.push('unsupported_currency');
  const decimal = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?$/u.exec(hours.value.amount);
  if (!decimal || hours.value.unit !== 'hours_per_month') blockers.push('unsupported_hours_precision_or_unit');
  if (blockers.length > 0 || !decimal) return frozen({state: 'out_of_scope' as const, blockers, requests, activationAllowed: false, pricingAllowed: false});
  const numerator = BigInt(decimal[1] + (decimal[2] ?? ''));
  const denominator = BigInt(10) ** BigInt((decimal[2] ?? '').length);
  if (numerator <= BigInt(0) || numerator > BigInt(policy.maximum_regular_hours) * denominator) {
    return frozen({state: 'out_of_scope' as const, blockers: ['unsupported_regular_hours_range'], requests, activationAllowed: false, pricingAllowed: false});
  }
  const documentId = period.value.document_id;
  if (!evidence.documents.some(document => document.version_id === documentId)) throw new Error('JUNE2026_PERIOD_DOCUMENT_MISSING');
  if (evidence.components.some(component => component.version_id !== documentId)) throw new Error('JUNE2026_COMPONENT_PERIOD_DOCUMENT_MISMATCH');
  for (const fact of [base, gross, period]) if (!documentedOn(fact, documentId, evidence)) {
    request(fact.path, 'same_payslip_document_source_required');
  }
  for (const fact of [hours, salaryType]) if (!documentedOn(fact, documentId, evidence)
      && !fact.provenance.some(source => source.source_type === 'declared' && source.source_reference.kind === 'case_request_answer')) {
    request(fact.path, 'same_payslip_or_month_bound_identified_answer_required');
  }
  const sum = (components: typeof evidence.components) => components.reduce((total, component) => total + BigInt(component.amount_minor), BigInt(0));
  const baseComponents = evidence.components.filter(component => component.classification === 'base_salary');
  if (sum(baseComponents) !== BigInt(base.value.minor_units) || baseComponents.length === 0) {
    request('components', 'base_components_do_not_reconcile_with_saved_base');
  }
  if (sum(evidence.components) !== BigInt(gross.value.minor_units)) request('components', 'earnings_inventory_does_not_reconcile_with_saved_gross');
  if (requests.length > 0) return frozen({state: 'missing_input' as const, requests, activationAllowed: false, pricingAllowed: false});
  const eligible = evidence.components.filter(component => included.has(component.classification)).sort((a, b) => a.component_id.localeCompare(b.component_id, 'en'));
  const candidate = createJune2026MinimumWageCandidate(eligible.length);
  const operands: RuleSpecInputValue[] = [
    {ref_id: 'fact.regular.hours', value: {kind: 'rational', numerator: numerator.toString(), denominator: denominator.toString(), unit: 'hours_per_month'}},
    ...eligible.map((component, index) => ({ref_id: componentInputId(index), value: {kind: 'money' as const, currency: 'ILS', minor_units: component.amount_minor}})),
  ];
  const execution = executeRuleSpec({rule: candidate.rule, facts: operands, parameters: candidate.parameterInputs});
  const amountAt = (ref: string) => {
    const result = execution.trace.find(step => step.step_id === ref)?.result;
    if (result?.kind !== 'money' || result.currency !== 'ILS') throw new Error('JUNE2026_EXECUTION_MONEY_REQUIRED');
    return result.minor_units;
  };
  const expectedMinor = amountAt('expected.regular.pay');
  const recordedMinor = amountAt('recorded.eligible.pay');
  const gapMinor = amountAt('expected.minus.recorded');
  const evidenceSha256 = canonicalSha256(evidence);
  const sourceBindings = {
    hours: {input_id: 'fact.regular.hours', fact_id: hours.fact_id, fact_sha256: canonicalSha256(hours), provenance: hours.provenance},
    components: evidence.components.map(component => ({
      component, included: included.has(component.classification),
      input_id: included.has(component.classification) ? componentInputId(eligible.findIndex(item => item.component_id === component.component_id)) : null,
      document_sha256: evidence.documents.find(document => document.version_id === component.version_id)!.sha256,
      product_document_id: evidence.documents.find(document => document.version_id === component.version_id)!.product_document_id,
      interpretation_policy_sha256: policySha256,
    })),
  };
  const seed = {
    schema_version: 'tivdoc-june2026-minimum-wage-candidate-result-v1',
    state: 'candidate_calculated' as const, case_id: facts.case_id, analysis_run_id: facts.analysis_run_id, calculatedAt,
    period: policy.period, expectedMinor, recordedMinor, gapMinor,
    policySha256, rule: candidate.rule, parameters: candidate.parameters, execution,
    factsSnapshotSha256, evidenceSha256, sourceBindings,
    // Kept for exact independently replayable source/amount binding. This is
    // review evidence, not a customer report or publication authorization.
    facts, evidence, activationAllowed: false, pricingAllowed: false,
  };
  return frozen({...seed, receiptSha256: canonicalSha256(seed)});
}

export type June2026MinimumWagePreparation = ReturnType<typeof prepareJune2026MinimumWage>;
export type June2026MinimumWageCandidateResult = Extract<June2026MinimumWagePreparation, {state: 'candidate_calculated'}>;

/** Re-execute source inputs. Checking a user-recomputed hash alone would allow
 * a changed amount or classification to masquerade as an old saved receipt. */
export function verifyJune2026MinimumWageCandidateReceipt(candidate: unknown): June2026MinimumWageCandidateResult {
  const envelope = z.object({facts: employmentSnapshotSchema, evidence: june2026WageEvidenceSchema, calculatedAt: z.iso.datetime({offset: true})}).passthrough().parse(candidate);
  const replayed = prepareJune2026MinimumWage(envelope);
  if (replayed.state !== 'candidate_calculated' || canonicalSha256(candidate) !== canonicalSha256(replayed)) {
    throw new Error('JUNE2026_CANDIDATE_RECEIPT_REPLAY_MISMATCH');
  }
  return replayed;
}
