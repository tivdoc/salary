import { describe, expect, it } from 'vitest';
import { employmentSnapshotSchema } from '../facts/snapshot.ts';
import { canonicalSha256 } from '../rule-runtime/canonical.ts';
import { executeRuleSpec } from '../legal-operations/rulespec.ts';
import { june2026WageEvidenceSchema, type June2026WageComponent } from './evidence.ts';
import { prepareJune2026MinimumWage, verifyJune2026MinimumWageCandidateReceipt } from './executor.ts';
import { createJune2026MinimumWageCandidate } from './candidate.ts';
import { june2026MinimumWageAdmission } from './admission.ts';

const caseId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const now = '2026-09-09T18:00:00Z';
const reading = {source_type: 'documented', source_reference: {kind: 'document', document_id: documentId, locator: {page: 1, text_span: 'Independent synthetic payroll reading'}}, read_by: 'machine', verified: false} as const;
const answer = {source_type: 'declared', source_reference: {kind: 'case_request_answer', request_id: '44444444-4444-4444-8444-444444444444', answer_revision: 1}} as const;

// Synthetic fixture assertions model authenticated answers, not legal-source
// attestations, an actual person's review, OCR or a database ownership proof.
function fixture(hours = '100', base = 330000, extra: Partial<June2026WageComponent>[] = []) {
  const gross = base + extra.reduce((sum, item) => sum + (item.amount_minor ?? 0), 0);
  const facts = employmentSnapshotSchema.parse({snapshot_id: '55555555-5555-4555-8555-555555555555', case_id: caseId,
    analysis_run_id: runId, schema_version: '1.0.0', created_at: now, facts: [
      {path: 'work.regular_hours', value: {amount: hours, unit: 'hours_per_month'}},
      {path: 'compensation.base_monthly_salary', value: {currency: 'ILS', minor_units: base}},
      {path: 'compensation.gross_salary', value: {currency: 'ILS', minor_units: gross}},
      {path: 'compensation.salary_type', value: 'hourly'},
      {path: 'documents.period', value: {document_id: documentId, period: {start_date: '2026-06-01', end_date: '2026-06-30'}}},
    ].map((entry, index) => ({...entry, fact_id: `66666666-6666-4666-8666-66666666666${index}`, case_id: caseId,
      status: 'confirmed', confidence: 0.99, provenance: [reading], conflicting_fact_ids: [], resolution: null, created_at: now}))});
  const confirmed = <T>(value: T) => ({status: 'confirmed', value, provenance: [answer]});
  const evidence = june2026WageEvidenceSchema.parse({schema_version: 'tivdoc-june2026-minimum-wage-evidence-v1', case_id: caseId,
    analysis_run_id: runId, facts_snapshot_sha256: canonicalSha256(facts),
    documents: [{product_document_id: '88888888-8888-4888-8888-888888888888', version_id: documentId, sha256: 'a'.repeat(64), page_count: 1}],
    applicability: {age_18_entire_month: confirmed(true), sector: confirmed('general_private'), hours_rest_law_applies: confirmed(true),
      no_better_minimum_wage_arrangement: confirmed(true), no_adapted_minimum_wage: confirmed(true), regular_hours_exclude_absence_overtime_rest: confirmed(true)},
    wage_components_complete: confirmed(true), components: [
      {component_id: 'base', classification: 'base_salary', amount_minor: base}, ...extra,
    ].map((entry, index) => ({classification_status: 'confirmed', classification_provenance: [answer], currency: 'ILS', version_id: documentId,
      page: 1, locator: `earnings row ${index + 1}`, ...entry})),
  });
  return {facts, evidence, calculatedAt: now};
}

function calculate(input = fixture()) {
  const result = prepareJune2026MinimumWage(input);
  expect(result.state).toBe('candidate_calculated');
  if (result.state !== 'candidate_calculated') throw new Error(JSON.stringify(result));
  return result;
}

function changeFact(input: ReturnType<typeof fixture>, path: string, update: Record<string, unknown>) {
  const facts = employmentSnapshotSchema.parse({...input.facts, facts: input.facts.facts.map(f => f.path === path ? {...f, ...update} : f)});
  return {...input, facts, evidence: {...input.evidence, facts_snapshot_sha256: canonicalSha256(facts)}};
}

describe('June2026 source-bound unsigned canonical candidate', () => {
  it.each([
    ['100', 330000, 354058, 24058],
    ['182', 644385, 644385, 0],
    ['0.5', 1600, 1770, 170],
    ['18.2', 60000, 64439, 4439],
    ['100', 360000, 354058, -5942],
  ])('uses independent exact-rational oracle %sh and recorded%s', (hours, base, expected, gap) => {
    const result = calculate(fixture(hours, base));
    expect([result.expectedMinor, result.recordedMinor, result.gapMinor]).toEqual([expected, base, gap]);
    expect(result.activationAllowed).toBe(false);
    expect(result.pricingAllowed).toBe(false);
  });

  it('makes the58-agorot disagreement with the earlier engineering example observable', () => {
    const result = calculate();
    expect(result.expectedMinor - 3540 * 100).toBe(58);
    const scale = result.execution.trace.find(step => step.step_id === 'regular.month.fraction');
    expect(scale?.result).toMatchObject({kind: 'rational', numerator: '50', denominator: '91'});
  });

  it('includes fixed ordinary-pay and cost-of-living supplements but excludes travel and seniority', () => {
    const result = calculate(fixture('100', 300000, [
      {component_id: 'fixed', classification: 'fixed_work_supplement', amount_minor: 20000},
      {component_id: 'cola', classification: 'cost_of_living', amount_minor: 10000},
      {component_id: 'travel', classification: 'expense_reimbursement', amount_minor: 50000},
      {component_id: 'seniority', classification: 'seniority', amount_minor: 40000},
    ]));
    expect(result.recordedMinor).toBe(330000);
    expect(result.gapMinor).toBe(24058);
    expect(result.sourceBindings.components.filter(c => c.included)).toHaveLength(3);
    expect(result.sourceBindings.components.every(c => c.document_sha256 === 'a'.repeat(64))).toBe(true);
    expect(result.execution.trace.find(step => step.step_id === 'recorded.eligible.pay')?.input_refs).toHaveLength(3);
  });

  it.each(['family', 'shift_premium', 'productivity_premium', 'thirteenth_salary', 'annual_bonus', 'overtime', 'weekly_rest', 'paid_absence'] as const)(
    'does not silently use gross including %s', classification => {
      const result = calculate(fixture('100', 330000, [{component_id: 'extra', classification, amount_minor: 120000}]));
      expect(result.recordedMinor).toBe(330000);
      expect(result.gapMinor).toBe(24058);
    });

  it('asks for only missing hours, accepts a sourced answer and preserves original input', () => {
    const complete = fixture();
    const missing = changeFact(complete, 'work.regular_hours', {value: null, status: 'missing'});
    expect(prepareJune2026MinimumWage(missing)).toMatchObject({state: 'missing_input', requests: [{field: 'work.regular_hours'}]});
    const answered = changeFact(missing, 'work.regular_hours', {value: {amount: '100', unit: 'hours_per_month'}, status: 'confirmed', provenance: [answer]});
    expect(calculate(answered).gapMinor).toBe(24058);
    expect(missing.facts.facts[0].value).toBeNull();
  });

  it.each(['age_18_entire_month', 'sector', 'hours_rest_law_applies', 'no_better_minimum_wage_arrangement', 'no_adapted_minimum_wage', 'regular_hours_exclude_absence_overtime_rest'] as const)(
    'does not assume applicability when %s is unknown', field => {
      const input = fixture();
      const result = prepareJune2026MinimumWage({...input, evidence: {...input.evidence, applicability: {...input.evidence.applicability,
        [field]: {status: 'missing', value: null, provenance: []}}}} as typeof input);
      expect(result).toMatchObject({state: 'missing_input', requests: [{field: `applicability.${field}`}]});
      expect(result).not.toHaveProperty('gapMinor');
    });

  it('refuses unresolved component classification even if its value would remove a gap', () => {
    const input = fixture('100', 330000, [{component_id: 'bonus', classification: 'unclassified', amount_minor: 30000}]);
    expect(prepareJune2026MinimumWage(input)).toMatchObject({state: 'missing_input', requests: [{field: 'components.bonus.classification'}]});
  });

  it('requires both earnings completeness and reconciliation to actual saved gross/base', () => {
    const input = fixture();
    const incomplete = {...input, evidence: {...input.evidence, wage_components_complete: {status: 'confirmed', value: false, provenance: [answer]}}} as typeof input;
    expect(prepareJune2026MinimumWage(incomplete)).toMatchObject({state: 'missing_input', requests: [{field: 'wage_components_complete'}]});
    expect(prepareJune2026MinimumWage(changeFact(input, 'compensation.gross_salary', {value: {currency: 'ILS', minor_units: 400000}}))).toMatchObject({state: 'missing_input', requests: [{reason: 'earnings_inventory_does_not_reconcile_with_saved_gross'}]});
    expect(prepareJune2026MinimumWage(changeFact(input, 'compensation.base_monthly_salary', {value: {currency: 'ILS', minor_units: 320000}}))).toMatchObject({state: 'missing_input', requests: [{reason: 'base_components_do_not_reconcile_with_saved_base'}]});
  });

  it.each(['0', '182.0001', '183', '0.00001'])('does not expand the hourly scope:%s', hours => {
    expect(prepareJune2026MinimumWage(fixture(hours))).toMatchObject({state: 'out_of_scope'});
  });

  it('refuses other periods, monthly pay, sector rules and section30(a) exclusions', () => {
    const input = fixture();
    expect(prepareJune2026MinimumWage(changeFact(input, 'documents.period', {value: {document_id: documentId, period: {start_date: '2026-05-01', end_date: '2026-05-31'}}}))).toMatchObject({state: 'out_of_scope', blockers: ['unsupported_period']});
    expect(prepareJune2026MinimumWage(changeFact(input, 'compensation.salary_type', {value: 'monthly'}))).toMatchObject({state: 'out_of_scope'});
    for (const [field, value] of [['sector', 'other'], ['hours_rest_law_applies', false], ['no_adapted_minimum_wage', false]] as const) {
      expect(prepareJune2026MinimumWage({...input, evidence: {...input.evidence, applicability: {...input.evidence.applicability,
        [field]: {...input.evidence.applicability[field], value}}}} as typeof input)).toMatchObject({state: 'out_of_scope'});
    }
  });

  it('refuses a foreign case/run, changed facts snapshot, wrong version/page and duplicate source line', () => {
    const input = fixture();
    for (const change of [{case_id: runId}, {analysis_run_id: caseId}, {facts_snapshot_sha256: 'f'.repeat(64)}]) {
      expect(() => prepareJune2026MinimumWage({...input, evidence: {...input.evidence, ...change}})).toThrow('JUNE2026_EVIDENCE_SNAPSHOT_BINDING_MISMATCH');
    }
    for (const change of [{version_id: caseId}, {page: 2}, {version_id: 1}]) {
      expect(() => prepareJune2026MinimumWage({...input, evidence: {...input.evidence, components: [{...input.evidence.components[0], ...change}]}} as typeof input)).toThrow();
    }
    expect(() => prepareJune2026MinimumWage({...input, evidence: {...input.evidence, components: [input.evidence.components[0], {...input.evidence.components[0], component_id: 'duplicated'}]}})).toThrow();
  });

  it('replays exactly and rejects a recomputed hash over tampered money, rule, source and classifier', () => {
    const result = calculate();
    expect(calculate()).toEqual(result);
    expect(verifyJune2026MinimumWageCandidateReceipt(result)).toEqual(result);
    for (const change of [{gapMinor: 24000}, {policySha256: 'f'.repeat(64)}, {sourceBindings: {}}, {rule: {...result.rule, output_ref: 'recorded.eligible.pay'}}]) {
      const {receiptSha256: _old, ...seed} = {...result, ...change}; void _old;
      expect(() => verifyJune2026MinimumWageCandidateReceipt({...seed, receiptSha256: canonicalSha256(seed)})).toThrow('JUNE2026_CANDIDATE_RECEIPT_REPLAY_MISMATCH');
    }
    const freshVersion = '99999999-9999-4999-8999-999999999999';
    const original = fixture();
    const changedFacts = employmentSnapshotSchema.parse({...original.facts, facts: original.facts.facts.map(fact => ({...fact,
      provenance: [{...reading, source_reference: {...reading.source_reference, document_id: freshVersion}}],
      ...(fact.path === 'documents.period' ? {value: {...fact.value, document_id: freshVersion}} : {}),
    }))});
    const changedInput = {...original, facts: changedFacts, evidence: {...original.evidence, facts_snapshot_sha256: canonicalSha256(changedFacts),
      documents: [{...original.evidence.documents[0], version_id: freshVersion, sha256: 'b'.repeat(64)}],
      components: [{...original.evidence.components[0], version_id: freshVersion}]}};
    expect(calculate(changedInput).receiptSha256).not.toBe(result.receiptSha256);
  });

  it('executes all32 bounded arity packages against independently written expected outputs', () => {
    const versions = new Set<string>();
    for (let count = 1; count <= 32; count++) {
      const candidate = createJune2026MinimumWageCandidate(count);
      versions.add(`${candidate.parameters[0].parameter_id}@${candidate.parameters[0].parameter_version}`);
      expect(candidate.activationAllowed).toBe(false);
      for (const golden of candidate.goldenCases.cases) expect(executeRuleSpec({rule: candidate.rule, facts: golden.facts, parameters: golden.parameters}).output).toEqual(golden.expected_output);
    }
    expect(versions.size).toBe(32);
  });

  it('keeps genuine human attestation and activation missing after successful arithmetic', () => {
    calculate();
    const admission = june2026MinimumWageAdmission();
    expect(admission.status).toBe('BLOCKED_NOT_READY');
    expect(admission.reason_codes).toContain('HUMAN_LEGAL_REVIEW_MISSING');
    expect(admission.reason_codes).toContain('ACTIVATION_MISSING');
  });
});
