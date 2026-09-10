import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {employmentSnapshotSchema} from '../facts/snapshot.ts';
import {normalizedAdditionalComponentSchema, normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {createTopicRuleInputSnapshot} from '../rule-input/snapshot.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {createSourceCalculationTrace} from '../calculations/source-trace.ts';
import {prepareJune2026AdmittedContext, type June2026AdmittedContextInput} from './admitted-context.ts';
import {prepareJune2026AssessmentPacket} from './assessment-packet.ts';
import {createJune2026CollectionTarget, resolveJune2026CollectionAnswer, JUNE2026_COMPONENT_DECLARATIONS, JUNE2026_DECLARATION_OPTIONS,
  JUNE2026_UNKNOWN_ANSWER, JUNE2026_CONFLICTED_ANSWER, type June2026CollectionSelector} from './collection.ts';

const now = '2026-09-09T20:30:00.000Z';
const policy = 'saved-payslip-v21-p95-v1';
function fixture() {
  const original = buildSyntheticCaseFixture({fixture_id: 'june2026-factual-admission', mode: 'real'}), document = original.stored.documents[0];
  const extraction = normalizedPayslipExtractionSchema.parse(structuredClone(original.stored.extractions[0]));
  for (const field of extraction.fields) {
    if (field.field === 'salary_period') field.normalized_value = {year: 2026, month: 6, start_date: '2026-06-01', end_date: '2026-06-30'};
    if (field.field === 'salary_type') field.normalized_value = 'hourly';
    if (field.field === 'regular_hours') field.normalized_value = {amount: '100', unit: 'hours_per_month'};
    if (field.field === 'base_monthly_salary' || field.field === 'gross_salary') field.normalized_value = {currency: 'ILS', minor_units: 330000};
  }
  const component = normalizedAdditionalComponentSchema.parse({component_id: randomUUID(), source_label: 'שכר יסוד', normalized_label: null,
    semantic_kind: 'base_salary', quantity_raw: '100', rate_raw: '33', percentage_raw: null, amount_raw: '3300', confidence: 0.94,
    source: {document_id: document.document_id, page: 1, text_fragment: 'שכר יסוד 100 33 3300'}, extraction_method: 'fixture', warning_flags: [],
    quantity: '100', rate: {currency: 'ILS', minor_units: 3300}, percentage: null, amount: {currency: 'ILS', minor_units: 330000}, normalization_warnings: []});
  extraction.additional_components = [component];
  const checkpoint = {schema_version: 'tivdoc-saved-extraction-v1', case_id: document.case_id, product_document_id: randomUUID(), version_id: document.document_id,
    input_sha256: document.content_sha256, expected_month: '2026-06', period_mismatch: false, result_sha256: '', run: {result: {final_extraction: extraction}}};
  const paths = ['work.regular_hours', 'compensation.base_monthly_salary', 'compensation.gross_salary', 'compensation.salary_type', 'documents.period'] as const;
  const values = [{amount: '100', unit: 'hours_per_month'}, {currency: 'ILS', minor_units: 330000}, {currency: 'ILS', minor_units: 330000}, 'hourly',
    {document_id: document.document_id, period: {start_date: '2026-06-01', end_date: '2026-06-30'}}];
  const facts = employmentSnapshotSchema.parse({schema_version: '1.0.0', snapshot_id: randomUUID(), case_id: document.case_id, analysis_run_id: randomUUID(), created_at: now,
    facts: paths.map((path, index) => ({fact_id: randomUUID(), case_id: document.case_id, path, value: values[index], status: 'confirmed', confidence: 1,
      provenance: [{source_type: 'documented', source_reference: {kind: 'document', document_id: document.document_id, locator: {page: 1}}, read_by: 'machine', verified: false}],
      conflicting_fact_ids: [], resolution: null, created_at: now}))});
  const saved = {case_id: document.case_id, analysis_run_id: facts.analysis_run_id, input_revision: 3, input_sha256: 'e'.repeat(64), order_id: randomUUID(), month: '2026-06' as const};
  const input: June2026AdmittedContextInput = {current: {...saved, topics: ['minimum_wage'], document: {product_document_id: checkpoint.product_document_id,
    version_id: document.document_id, sha256: document.content_sha256, page_count: extraction.quality_metrics.page_count}}, saved,
    canonicalStage: {facts, facts_snapshot_sha256: ''}, ruleInput: {snapshot_id: '', snapshot_version: '', snapshot_sha256: ''}, checkpoint,
    extractionPolicyVersion: policy, collection: {schema_version: 'saved-june2026-collection-evidence-v1', case_id: document.case_id, month: '2026-06', evaluated_at: now,
      resolutions: [], legal_confirmation: false, rule_activation: false}};
  function repin() {
    checkpoint.result_sha256 = canonicalSha256(checkpoint.run.result);
    input.canonicalStage.facts_snapshot_sha256 = canonicalSha256(facts);
    Object.assign(input.ruleInput, createTopicRuleInputSnapshot(facts, 'minimum_wage'));
  }
  repin();
  const collection = input.collection as {resolutions: unknown[]};
  function addAnswer(subject: June2026CollectionSelector, answer: string) {
    const target = createJune2026CollectionTarget({checkpoint, policyVersion: policy, subject});
    const resolution = resolveJune2026CollectionAnswer({target, currentCheckpoint: checkpoint, policyVersion: policy, caseId: document.case_id, month: '2026-06',
      requestId: randomUUID(), answerRevision: 1, identityId: randomUUID(), answeredAt: now, answer});
    collection.resolutions.push(resolution); return resolution;
  }
  return {input, facts, extraction, component, checkpoint, collection, repin, addAnswer};
}

describe('June2026 current-source factual admission context', () => {
  it('materializes exact same-run operand refs without promoting OCR, declarations, component labels or catalog readiness', () => {
    const f = fixture(), before = structuredClone(f.input);
    f.addAnswer({kind: 'component', componentId: f.component.component_id}, JUNE2026_COMPONENT_DECLARATIONS.base_salary);
    const result = prepareJune2026AdmittedContext(f.input);
    expect(result.state).toBe('factual_context_ready');
    expect(result.bound_facts).toHaveLength(5); expect(result.source_fact_bindings).toHaveLength(2);
    expect(result.legal_gates).toHaveLength(9);
    expect(result.legal_gates.every(gate => gate.status === 'not_admitted')).toBe(true);
    expect(result).toMatchObject({authority: 'current_source_factual_mapping_only', component_legal_classification: 'unreviewed', legal_activation: false, publication_allowed: false});
    expect(result.collection.resolutions[0]).toMatchObject({state: 'declared', declaration: {legal_classification_status: 'unreviewed', candidate_evidence_admitted: false}});
    expect(result).not.toHaveProperty('amount'); expect(result).not.toHaveProperty('gapMinor');
    expect(f.input.canonicalStage).toEqual(before.canonicalStage); expect(Object.isFrozen(result)).toBe(true);
  });

  it('provides usable existing v1 trace operands with an independent24058agora arithmetic oracle, still unsigned', () => {
    const f = fixture(), context = prepareJune2026AdmittedContext(f.input), candidate = createJune2026MinimumWageCandidate(1);
    const trace = createSourceCalculationTrace({calculationId: randomUUID(), caseId: f.facts.case_id, analysisRunId: f.facts.analysis_run_id, calculatedAt: now,
      catalogSha256: 'a'.repeat(64), facts: f.facts, rule: candidate.rule, parameters: candidate.parameters,
      bindings: [...context.source_fact_bindings, {input_id: 'parameter.monthly.floor', source: {kind: 'parameter', parameter_id: candidate.parameters[0].parameter_id, parameter_version: candidate.parameters[0].parameter_version}},
        {input_id: 'parameter.month.hours', source: {kind: 'parameter', parameter_id: candidate.parameters[1].parameter_id, parameter_version: candidate.parameters[1].parameter_version}}]});
    expect(trace.execution_output).toEqual({kind: 'money', currency: 'ILS', minor_units: 24058});
    expect(trace.authority).toBe('arithmetic_provenance_only');
    expect(context.legal_activation).toBe(false);
  });

  it.each(['case_id', 'analysis_run_id', 'input_revision', 'input_sha256', 'order_id'] as const)('refuses a changed persisted%s even if individual hashes are well formed', key => {
    const f = fixture(), saved = {...f.input.saved, [key]: key === 'input_revision' ? 4 : key === 'input_sha256' ? 'f'.repeat(64) : randomUUID()};
    expect(() => prepareJune2026AdmittedContext({...f.input, saved})).toThrow('JUNE_CONTEXT_CURRENT_PIN_MISMATCH');
  });
  it('refuses an unpurchased topic and another month', () => {
    const f = fixture();
    expect(() => prepareJune2026AdmittedContext({...f.input, current: {...f.input.current, topics: ['travel']}})).toThrow('JUNE_CONTEXT_PURCHASED_TOPIC_REQUIRED');
    expect(() => prepareJune2026AdmittedContext({...f.input, saved: {...f.input.saved, month: '2026-07'}} as unknown as June2026AdmittedContextInput)).toThrow();
  });
  it('refuses a foreign canonical stage, edited snapshot or a different topic reference', () => {
    const f = fixture();
    expect(() => prepareJune2026AdmittedContext({...f.input, canonicalStage: {...f.input.canonicalStage, facts: {...f.facts, analysis_run_id: randomUUID()}}})).toThrow('JUNE_CONTEXT_CANONICAL_STAGE_MISMATCH');
    expect(() => prepareJune2026AdmittedContext({...f.input, canonicalStage: {...f.input.canonicalStage, facts_snapshot_sha256: 'a'.repeat(64)}})).toThrow('JUNE_CONTEXT_CANONICAL_STAGE_MISMATCH');
    expect(() => prepareJune2026AdmittedContext({...f.input, ruleInput: {...f.input.ruleInput, snapshot_id: `rule-input:${f.facts.analysis_run_id}:travel`}})).toThrow('JUNE_CONTEXT_RULE_INPUT_MISMATCH');
  });
  it.each(['product_document_id', 'version_id', 'sha256', 'page_count'] as const)('refuses a changed current source%s', key => {
    const f = fixture(), document = {...f.input.current.document, [key]: key === 'page_count' ? 2 : key === 'sha256' ? 'b'.repeat(64) : randomUUID()};
    expect(() => prepareJune2026AdmittedContext({...f.input, current: {...f.input.current, document}})).toThrow('JUNE_CONTEXT_SOURCE_BINDING_MISMATCH');
  });
  it('refuses provider-supplied customer readings or changed checkpoint result bytes', () => {
    const f = fixture(); f.extraction.warnings.push('changed');
    expect(() => prepareJune2026AdmittedContext(f.input)).toThrow('JUNE_COLLECTION_CHECKPOINT_MISMATCH');
    f.extraction.customer_readings = []; f.repin();
    expect(() => prepareJune2026AdmittedContext(f.input)).toThrow('JUNE_COLLECTION_PROVIDER_CONFIRMATION_FORBIDDEN');
  });
  it.each(['candidate', 'needs_confirmation', 'missing', 'rejected', 'conflicted'] as const)('retains unconfirmed canonical status%s and emits no runnable operands', status => {
    const f = fixture(); f.facts.facts[0].status = status;
    if (status === 'missing' || status === 'conflicted') f.facts.facts[0].value = null;
    if (status === 'conflicted') f.facts.facts[0].conflicting_fact_ids = [randomUUID(), randomUUID()];
    f.repin();
    const result = prepareJune2026AdmittedContext(f.input);
    expect(result).toMatchObject({state: 'factual_context_blocked', source_fact_bindings: [], factual_issues: [{field: 'work.regular_hours'}]});
    expect(f.facts.facts[0].status).toBe(status);
  });
  it('refuses an invented confirmed amount after the attacker recomputes canonical hashes', () => {
    const f = fixture(), base = f.facts.facts.find(fact => fact.path === 'compensation.base_monthly_salary')!;
    if (base.path !== 'compensation.base_monthly_salary') throw Error('fixture'); base.value = {currency: 'ILS', minor_units: 340000}; f.repin();
    expect(prepareJune2026AdmittedContext(f.input).factual_issues).toContainEqual({field: base.path, reason: 'current_document_fact_binding_required'});
  });
  it.each(['none', 'case_id', 'document_id', 'source_sha256', 'candidate_sha256', 'normalized_extraction_sha256', 'extraction_result_sha256'] as const)(
    'validates existing customer-reading metadata: %s', tampered => {
      const f = fixture(), fact = f.facts.facts[0], candidate = f.extraction.fields.find(field => field.field === 'regular_hours')!;
      const source = fact.provenance[0]; if (source.source_type !== 'documented') throw Error('fixture');
      source.verified = true;
      source.customer_confirmation = {actor_kind: 'customer', case_id: f.facts.case_id, document_id: f.checkpoint.version_id, candidate_id: candidate.candidate_id,
        source_sha256: f.checkpoint.input_sha256, normalized_extraction_sha256: canonicalSha256(f.extraction), candidate_sha256: canonicalSha256(candidate),
        extraction_result_sha256: f.checkpoint.result_sha256, target_sha256: 'd'.repeat(64), month: '2026-06', request_id: randomUUID(), answer_revision: 1,
        identity_id: randomUUID(), confirmed_at: now};
      if (tampered !== 'none') source.customer_confirmation[tampered] = tampered === 'case_id' || tampered === 'document_id' ? randomUUID() : 'f'.repeat(64);
      f.repin();
      const result = prepareJune2026AdmittedContext(f.input);
      expect(result.state).toBe(tampered === 'none' ? 'factual_context_ready' : 'factual_context_blocked');
      expect(result.legal_activation).toBe(false); expect(result.component_legal_classification).toBe('unreviewed');
    });
  it.each(['foreign_document', 'page', 'declared', 'conflict_ids'] as const)('refuses%s on an otherwise confirmed source fact', change => {
    const f = fixture(), fact = f.facts.facts[0];
    if (change === 'conflict_ids') {
      fact.conflicting_fact_ids = [randomUUID(), randomUUID()];
      fact.resolution = {method: 'deterministic_precedence', resolved_by: 'synthetic-fixture', selected_fact_ids: [fact.conflicting_fact_ids[0]],
        rationale: 'Retained conflicting sources do not satisfy the strict initial context.', resolved_at: now};
    }
    else if (change === 'declared') fact.provenance = [{source_type: 'declared', source_reference: {kind: 'case_request_answer', request_id: randomUUID(), answer_revision: 1}}];
    else if (fact.provenance[0].source_type === 'documented') {
      if (change === 'foreign_document') fact.provenance[0].source_reference.document_id = randomUUID();
      else fact.provenance[0].source_reference.locator = {page: 2};
    }
    f.repin(); expect(prepareJune2026AdmittedContext(f.input)).toMatchObject({state: 'factual_context_blocked', source_fact_bindings: []});
  });
  it.each(['0', '182.0001', '183', '0.00001'] as const)('refuses unsupported%s hours even when the source and fact agree', hours => {
    const f = fixture(), candidate = f.extraction.fields.find(field => field.field === 'regular_hours')!;
    if (candidate.field !== 'regular_hours' || f.facts.facts[0].path !== 'work.regular_hours') throw Error('fixture');
    candidate.normalized_value = {amount: hours, unit: 'hours_per_month'}; f.facts.facts[0].value = {...candidate.normalized_value}; f.repin();
    expect(prepareJune2026AdmittedContext(f.input).factual_issues).toContainEqual({field: 'work.regular_hours', reason: 'supported_positive_hours_required'});
  });
  it('requires one reconciled monetary row and does not classify even a perfect-looking base label', () => {
    const f = fixture(); f.extraction.additional_components.push({...f.component, component_id: randomUUID(), amount: {currency: 'ILS', minor_units: 0}}); f.repin();
    expect(prepareJune2026AdmittedContext(f.input).factual_issues).toContainEqual({field: 'components', reason: 'single_monetary_component_required'});
    f.extraction.additional_components.pop(); f.component.semantic_kind = 'overtime_125'; f.component.source_label = 'שעות נוספות'; f.repin();
    const result = prepareJune2026AdmittedContext(f.input);
    expect(result.state).toBe('factual_context_ready'); expect(result.component_legal_classification).toBe('unreviewed'); expect(result.legal_activation).toBe(false);
  });
  it.each([[JUNE2026_UNKNOWN_ANSWER, 'unknown'], [JUNE2026_CONFLICTED_ANSWER, 'conflicted'], [JUNE2026_DECLARATION_OPTIONS[0], 'declared']] as const)(
    'preserves%s without satisfying a legal gate', (answer, state) => {
      const f = fixture(); f.addAnswer({kind: 'applicability', field: 'age_18_entire_month'}, answer);
      const result = prepareJune2026AdmittedContext(f.input);
      expect(result.collection.resolutions[0].state).toBe(state); expect(result.legal_gates.every(gate => gate.status === 'not_admitted')).toBe(true);
    });
  it('refuses forged declarations and duplicate current request/target receipts', () => {
    const f = fixture(), resolution = f.addAnswer({kind: 'applicability', field: 'age_18_entire_month'}, JUNE2026_DECLARATION_OPTIONS[0]);
    f.collection.resolutions.push(resolution);
    expect(() => prepareJune2026AdmittedContext(f.input)).toThrow('JUNE_CONTEXT_COLLECTION_AMBIGUOUS'); f.collection.resolutions.pop();
    f.collection.resolutions[0] = {...resolution, declaration: {...resolution.declaration, candidate_evidence_admitted: true}};
    expect(() => prepareJune2026AdmittedContext(f.input)).toThrow('JUNE_CONTEXT_DECLARATION_REPLAY_MISMATCH');
  });
  it('keeps replaced/expired unanswered targets blocked and replays deterministically without clock access', () => {
    const f = fixture(), target = createJune2026CollectionTarget({checkpoint: f.checkpoint, policyVersion: policy, subject: {kind: 'earnings_completeness'}});
    f.collection.resolutions.push({state: 'missing', request_id: randomUUID(), target, expires_at: '2026-09-08T20:30:00.000Z', legal_classification_status: 'unreviewed', candidate_evidence_admitted: false});
    const expired = prepareJune2026AdmittedContext(f.input);
    expect(expired.collection.resolutions[0].state).toBe('expired'); expect(prepareJune2026AdmittedContext(f.input).context_sha256).toBe(expired.context_sha256);
    f.extraction.warnings.push('new_extraction_revision'); f.repin();
    expect(prepareJune2026AdmittedContext(f.input).collection.resolutions[0].state).toBe('stale');
  });
});

describe('same-run unadmitted assessment packet', () => {
  const packet = (f: ReturnType<typeof fixture>) => prepareJune2026AssessmentPacket({context: prepareJune2026AdmittedContext(f.input), facts: f.facts});
  it('maps known customer answers to observed evidence without granting legal authority or running arithmetic', () => {
    const f = fixture();
    for (const field of ['age_18_entire_month', 'regular_hours_exclude_absence_overtime_rest'] as const)
      f.addAnswer({kind: 'applicability', field}, JUNE2026_DECLARATION_OPTIONS[0]);
    f.addAnswer({kind: 'earnings_completeness'}, JUNE2026_DECLARATION_OPTIONS[0]);
    f.addAnswer({kind: 'component', componentId: f.component.component_id}, JUNE2026_COMPONENT_DECLARATIONS.base_salary);
    const result = packet(f);
    expect(result.gates).toHaveLength(8);
    expect(result.gates.find(g => g.field === 'applicability.age_18_entire_month')).toMatchObject({state: 'declared_unreviewed',
      assertion: {status: 'missing', value: null}, observed_declaration: {interpretation: {value: true}, answer_revision: 1}, admitted: false});
    expect(result.evidence.components).toMatchObject([{classification: 'unclassified', classification_status: 'missing', amount_minor: 330000}]);
    expect(result.evidence.applicability.age_18_entire_month.provenance).toHaveLength(1);
    expect(result.preflight.state).toBe('missing_input');
    expect(result).toMatchObject({candidate_calculation_performed: false, execution_allowed: false, publication_allowed: false});
    expect(packet(f).packet_sha256).toBe(result.packet_sha256);
  });
  it.each([[JUNE2026_UNKNOWN_ANSWER, 'unknown', 'missing'], [JUNE2026_CONFLICTED_ANSWER, 'conflicted', 'conflicted']] as const)(
    'preserves %s as a distinct unadmitted state', (answer, state, status) => {
      const f = fixture(); f.addAnswer({kind: 'applicability', field: 'age_18_entire_month'}, answer);
      const result = packet(f), entry = result.gates.find(g => g.field === 'applicability.age_18_entire_month')!;
      expect(entry).toMatchObject({state, assertion: {status, value: null}, admitted: false});
      expect(result.evidence.applicability.age_18_entire_month.status).toBe(status);
    });
  it('preserves missing, expired and stale evidence without treating an old declaration as current', () => {
    const f = fixture();
    expect(packet(f).gates.find(g => g.field === 'wage_components_complete')?.state).toBe('missing');
    const target = createJune2026CollectionTarget({checkpoint: f.checkpoint, policyVersion: policy, subject: {kind: 'earnings_completeness'}});
    f.collection.resolutions.push({state: 'missing', request_id: randomUUID(), target, expires_at: '2026-09-08T20:30:00.000Z',
      legal_classification_status: 'unreviewed', candidate_evidence_admitted: false});
    expect(packet(f).gates.find(g => g.field === 'wage_components_complete')?.state).toBe('expired');
    f.extraction.warnings.push('source_changed'); f.repin();
    const result = packet(f), entry = result.gates.find(g => g.field === 'wage_components_complete')!;
    expect(entry).toMatchObject({state: 'stale', current_target_sha256: null, observed_declaration: null});
    expect(entry.observations).toHaveLength(1);
  });
  it('does not invent component amounts or suppress factual failures when reconciliation fails', () => {
    const f = fixture(); f.component.amount!.minor_units = 329999; f.repin();
    const result = packet(f);
    expect(result.evidence.components).toEqual([]);
    expect(result.factual_issues).toContainEqual({field: 'components', reason: 'documented_base_gross_component_reconciliation_required'});
    expect(result.component_mapping.state).toBe('single_component_unavailable');
    expect(result.preflight.state).toBe('missing_input');
  });
  it('keeps a component with no text locator out of evidence instead of fabricating a printed location', () => {
    const f = fixture(); delete f.component.source.text_fragment; f.repin();
    const result = packet(f);
    expect(result.evidence.components).toEqual([]);
    expect(result.factual_issues).toContainEqual({field: 'components', reason: 'component_text_locator_required'});
  });
  it('refuses changed context/facts and approval-shaped authority even with a recomputed hash', () => {
    const f = fixture(), context = prepareJune2026AdmittedContext(f.input);
    expect(() => prepareJune2026AssessmentPacket({context: {...context, context_sha256: 'a'.repeat(64)}, facts: f.facts})).toThrow('JUNE_ASSESSMENT_CONTEXT_HASH');
    const foreignCase = randomUUID();
    expect(() => prepareJune2026AssessmentPacket({context, facts: {...f.facts, case_id: foreignCase,
      facts: f.facts.facts.map(fact => ({...fact, case_id: foreignCase}))}})).toThrow('JUNE_ASSESSMENT_FACTS_BINDING');
    const {context_sha256: ignored, ...body} = context; void ignored;
    const changed = {...body, legal_activation: true};
    expect(() => prepareJune2026AssessmentPacket({context: {...changed, context_sha256: canonicalSha256(changed)} as unknown as typeof context,
      facts: f.facts})).toThrow('JUNE_ASSESSMENT_UNSUPPORTED_AUTHORITY');
  });
});
