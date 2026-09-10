import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {normalizedAdditionalComponentSchema, normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';
import {createJune2026CollectionTarget, june2026CollectionTargetSchema, june2026CollectionQuestion, resolveJune2026CollectionAnswer,
  JUNE2026_DECLARATION_OPTIONS, JUNE2026_COMPONENT_DECLARATIONS, JUNE2026_COMPONENT_OPTIONS,
  JUNE2026_UNKNOWN_ANSWER, JUNE2026_CONFLICTED_ANSWER, type June2026CollectionSelector} from './collection.ts';

function fixture(subject: June2026CollectionSelector = {kind: 'applicability', field: 'age_18_entire_month'}) {
  const original = buildSyntheticCaseFixture({fixture_id: 'june2026-typed-collection', mode: 'real'}), document = original.stored.documents[0];
  const extraction = normalizedPayslipExtractionSchema.parse(structuredClone(original.stored.extractions[0]));
  for (const candidate of extraction.fields) if (candidate.field === 'salary_period') candidate.normalized_value = {year: 2026, month: 6, start_date: '2026-06-01', end_date: '2026-06-30'};
  const component = normalizedAdditionalComponentSchema.parse({component_id: randomUUID(), source_label: 'שכר רגיל', normalized_label: null,
    semantic_kind: 'base_salary', quantity_raw: '100', rate_raw: '33', percentage_raw: null, amount_raw: '3300', confidence: 0.94,
    source: {document_id: document.document_id, page: 1, text_fragment: 'שכר רגיל 100 33 3300'}, extraction_method: 'fixture', warning_flags: [],
    quantity: '100', rate: {currency: 'ILS', minor_units: 3300}, percentage: null, amount: {currency: 'ILS', minor_units: 330000}, normalization_warnings: []});
  extraction.additional_components.push(component);
  const checkpoint = {schema_version: 'tivdoc-saved-extraction-v1', case_id: document.case_id, product_document_id: randomUUID(), version_id: document.document_id,
    input_sha256: document.content_sha256, expected_month: '2026-06', period_mismatch: false, result_sha256: '', run: {result: {final_extraction: extraction}}};
  const rehash = () => {checkpoint.result_sha256 = canonicalSha256(checkpoint.run.result);}; rehash();
  const selected = subject.kind === 'component' ? {kind: 'component', componentId: component.component_id} as const : subject;
  const target = () => createJune2026CollectionTarget({checkpoint, policyVersion: 'saved-payslip-v21-p95-v1', subject: selected});
  const requestId = randomUUID(), identityId = randomUUID();
  const input = (answer: string = JUNE2026_DECLARATION_OPTIONS[0]) => ({target: target(), currentCheckpoint: checkpoint,
    policyVersion: 'saved-payslip-v21-p95-v1', caseId: checkpoint.case_id, month: '2026-06', requestId, answerRevision: 1,
    identityId, answeredAt: '2026-09-09T18:00:00.000Z', answer});
  return {checkpoint, extraction, component, rehash, target, input};
}
const componentSelector = {kind: 'component', componentId: '11111111-1111-4111-8111-111111111111'} as const;

describe('June2026 exact-source customer declarations', () => {
  it('retains independent identical header/range observations without selecting or modifying either one', () => {
    const f = fixture(), period = f.extraction.fields.find(candidate => candidate.field === 'salary_period')!;
    f.extraction.fields.push({...structuredClone(period), candidate_id: randomUUID(), source: {...period.source, text_fragment: 'June 1 through June 30, 2026'}});
    f.rehash(); const before = structuredClone(f.checkpoint), target = f.target();
    expect(target.extraction_result_sha256).toBe(canonicalSha256(f.checkpoint.run.result));
    expect(resolveJune2026CollectionAnswer(f.input()).state).toBe('declared');
    expect(f.checkpoint).toEqual(before);
    expect(f.extraction.fields.filter(candidate => candidate.field === 'salary_period')).toHaveLength(2);
  });
  it.each(['missing', 'null', 'conflict', 'foreign', 'page', 'duplicate_id'] as const)('refuses %s in a set of period observations', change => {
    const f = fixture(), period = f.extraction.fields.find(candidate => candidate.field === 'salary_period')!;
    if (period.field !== 'salary_period' || !period.normalized_value) throw Error('EXPECTED_PERIOD');
    const second = {...structuredClone(period), candidate_id: String(randomUUID()), source: {...period.source, text_fragment: 'Another printed period'}};
    if (change === 'missing') f.extraction.fields = f.extraction.fields.filter(candidate => candidate.field !== 'salary_period');
    else {
      if (change === 'null') second.normalized_value = null;
      if (change === 'conflict') second.normalized_value = {...period.normalized_value, start_date: '2026-06-02'};
      if (change === 'foreign') second.source.document_id = randomUUID();
      if (change === 'page') second.source.page = f.extraction.quality_metrics.page_count + 1;
      if (change === 'duplicate_id') second.candidate_id = period.candidate_id;
      f.extraction.fields.push(second);
    }
    f.rehash(); expect(f.target).toThrow('JUNE_COLLECTION_PERIOD_UNSUPPORTED');
  });
  it.skipIf(process.env.TIVDOC_JUNE_LIVE_EQUIVALENT_REPLAY !== '1')('opens a collection target from the actual retained Sol checkpoint with both identical periods intact', () => {
    const path = 'output/release-completion/june-regular/clear-6d31d6ee/checkpoint.json', bytes = readFileSync(path);
    const checkpoint = JSON.parse(bytes.toString('utf8'));
    const periods = checkpoint.run.result.final_extraction.fields.filter((candidate: {field: string}) => candidate.field === 'salary_period');
    expect(periods).toHaveLength(2);
    expect(periods[0].candidate_id).not.toBe(periods[1].candidate_id);
    expect(periods[0].normalized_value).toEqual(periods[1].normalized_value);
    expect(createJune2026CollectionTarget({checkpoint, policyVersion: 'saved-payslip-v21-p95-v1', subject: {kind: 'earnings_completeness'}}))
      .toMatchObject({extraction_result_sha256: checkpoint.result_sha256, version_id: checkpoint.version_id});
    expect(readFileSync(path)).toEqual(bytes);
  });
  it('binds the real immutable version/checkpoint/period/policy without manufacturing a legal confirmation', () => {
    const f = fixture(), before = structuredClone(f.checkpoint), input = f.input(), target = f.target();
    expect(target).toMatchObject({case_id: f.checkpoint.case_id, product_document_id: f.checkpoint.product_document_id,
      version_id: f.checkpoint.version_id, source_sha256: f.checkpoint.input_sha256, month: '2026-06',
      extraction_result_sha256: f.checkpoint.result_sha256, legal_policy_sha256: JUNE2026_MINIMUM_WAGE_POLICY_SHA256});
    expect(june2026CollectionQuestion(target)).toMatchObject({code: `minimum_wage_june2026:${target.target_sha256}`, answer_kind: 'choice', options: JUNE2026_DECLARATION_OPTIONS, blocking: false});
    const result = resolveJune2026CollectionAnswer(input);
    expect(result).toMatchObject({state: 'declared', declaration: {actor_kind: 'customer_declaration', evidence_status: 'needs_confirmation',
      legal_classification_status: 'unreviewed', candidate_evidence_admitted: false, interpretation: {kind: 'boolean_declaration', value: true}}});
    expect(result.declaration.provenance).toEqual([{source_type: 'declared', source_reference: {kind: 'case_request_answer', request_id: input.requestId, answer_revision: 1}}]);
    expect(f.checkpoint).toEqual(before); expect(Object.isFrozen(result.declaration.target)).toBe(true);
  });

  it.each(['sector', 'hours_rest_law_applies'] as const)('collects %s factual text without converting it into a legal selector', field => {
    const f = fixture({kind: 'applicability', field}), text = field === 'sector' ? 'מעסיק בתחום המסחר; אין בידי פרטי ההסכם' : 'אני עובד לפי משמרות והממונה מתעד את זמני העבודה';
    expect(june2026CollectionQuestion(f.target())).toMatchObject({answer_kind: 'text', options: null});
    expect(resolveJune2026CollectionAnswer(f.input(text))).toMatchObject({state: 'declared', declaration: {
      interpretation: {kind: 'text_declaration', value: text}, evidence_status: 'needs_confirmation', legal_classification_status: 'unreviewed'}});
  });

  it.each(['no_better_minimum_wage_arrangement', 'no_adapted_minimum_wage'] as const)('preserves exception existence polarity for %s', field => {
    const f = fixture({kind: 'applicability', field});
    expect(resolveJune2026CollectionAnswer(f.input(JUNE2026_DECLARATION_OPTIONS[0])).declaration.interpretation).toEqual({kind: 'boolean_declaration', value: false});
    expect(resolveJune2026CollectionAnswer(f.input(JUNE2026_DECLARATION_OPTIONS[1])).declaration.interpretation).toEqual({kind: 'boolean_declaration', value: true});
  });

  it.each(Object.entries(JUNE2026_COMPONENT_DECLARATIONS))('retains %s solely as a customer description', (kind, label) => {
    const f = fixture(componentSelector), target = f.target();
    expect(target.subject).toEqual({kind: 'component', component: {component_id: f.component.component_id, source_label: f.component.source_label,
      source: {document_id: f.component.source.document_id, page: f.component.source.page}, amount: f.component.amount}});
    expect(june2026CollectionQuestion(target).options).toEqual(JUNE2026_COMPONENT_OPTIONS);
    expect(resolveJune2026CollectionAnswer(f.input(label))).toMatchObject({state: 'declared', declaration: {
      interpretation: {kind: 'component_substance_declaration', value: kind}, evidence_status: 'needs_confirmation', candidate_evidence_admitted: false}});
  });

  it.each([
    {kind: 'applicability', field: 'age_18_entire_month'}, {kind: 'applicability', field: 'sector'}, {kind: 'applicability', field: 'hours_rest_law_applies'},
    {kind: 'earnings_completeness'}, componentSelector,
  ] satisfies June2026CollectionSelector[])('retains unknown/conflicted without a false numeric or scope default: $kind', subject => {
    const f = fixture(subject);
    for (const [answer, state] of [[JUNE2026_UNKNOWN_ANSWER, 'unknown'], [JUNE2026_CONFLICTED_ANSWER, 'conflicted']] as const) {
      const result = resolveJune2026CollectionAnswer(f.input(answer));
      expect(result).toMatchObject({state, declaration: {interpretation: {kind: state, value: null}, candidate_evidence_admitted: false}});
      expect(result.declaration).not.toHaveProperty('gapMinor');
    }
  });

  it.each(['case', 'product', 'version', 'bytes', 'result', 'component_amount', 'component_page', 'component_id', 'component_confidence', 'component_geometry', 'policy', 'month', 'legal_policy'] as const)(
    'never treats an answer as current after %s changes', change => {
      const f = fixture(componentSelector), input = f.input(JUNE2026_COMPONENT_DECLARATIONS.base_salary);
      switch (change) {
        case 'case': f.checkpoint.case_id = randomUUID(); break;
        case 'product': f.checkpoint.product_document_id = randomUUID(); break;
        case 'version': f.checkpoint.version_id = randomUUID(); break;
        case 'bytes': f.checkpoint.input_sha256 = 'f'.repeat(64); break;
        case 'result': f.extraction.warnings.push('changed'); f.rehash(); break;
        case 'component_amount': f.component.amount = {currency: 'ILS', minor_units: 400000}; f.rehash(); break;
        case 'component_page': f.component.source.page = 2; f.rehash(); break;
        case 'component_id': f.component.component_id = randomUUID(); f.rehash(); break;
        case 'component_confidence': f.component.confidence = 1e-7; f.rehash(); break;
        case 'component_geometry': f.component.source.bounding_box = {x: 1e-7, y: 0, width: 0.5, height: 0.01, coordinate_space: 'normalized'}; f.rehash(); break;
        case 'policy': input.policyVersion = 'next-extraction-policy'; break;
        case 'month': input.month = '2026-07'; break;
        case 'legal_policy': {const {target_sha256: _old, ...body} = {...input.target, legal_policy_sha256: 'f'.repeat(64)}; void _old; input.target = {...body, target_sha256: canonicalSha256(body)}; break;}
      }
      expect(resolveJune2026CollectionAnswer(input)).toMatchObject({state: 'stale', declaration: {request_id: input.requestId, candidate_evidence_admitted: false}});
    });

  it('does not stale sibling targets when the case input revision changes after a different answer', () => {
    const f = fixture(), input = f.input(), before = f.target();
    Object.assign(f.checkpoint, {unrelated_case_input_revision: 12});
    expect(f.target()).toEqual(before);
    expect(resolveJune2026CollectionAnswer(input).state).toBe('declared');
  });

  it('keeps scientific-notation confidence and geometry in the pinned checkpoint without float operands in the target', () => {
    const f = fixture(componentSelector);
    f.component.confidence = 1e-7;
    f.component.source.bounding_box = {x: 1e-7, y: 0, width: 0.5, height: 0.01, coordinate_space: 'normalized'};
    f.rehash();
    const target = f.target();
    expect(target.extraction_result_sha256).toBe(canonicalSha256(f.checkpoint.run.result));
    if (target.subject.kind !== 'component') throw Error('EXPECTED_COMPONENT');
    expect(target.subject.component).not.toHaveProperty('confidence');
    expect(target.subject.component.source).not.toHaveProperty('bounding_box');
    const inspectNumbers = (value: unknown): void => {
      if (typeof value === 'number') {expect(Number.isSafeInteger(value)).toBe(true); return;}
      if (value && typeof value === 'object') for (const child of Object.values(value)) inspectNumbers(child);
    };
    inspectNumbers(target);
    expect(resolveJune2026CollectionAnswer(f.input(JUNE2026_COMPONENT_DECLARATIONS.base_salary)).state).toBe('declared');
    expect(f.component.confidence).toBe(1e-7);
  });

  it('retains the120-character display bound in Unicode characters without changing the hashed full source label', () => {
    const f = fixture(componentSelector), label = 'א'.repeat(100) + '🔹'.repeat(30);
    f.component.source_label = label; f.rehash();
    const target = f.target(), question = june2026CollectionQuestion(target).question;
    if (target.subject.kind !== 'component') throw Error('EXPECTED_COMPONENT');
    expect(target.subject.component.source_label).toBe(label);
    expect(question).toContain('א'.repeat(100) + '🔹'.repeat(19) + '…');
    expect(question.length).toBeLessThanOrEqual(400);
    expect(question).not.toContain('\uFFFD');
  });

  it('rejects a foreign case and missing identity/revision before accepting any declaration', () => {
    const f = fixture(), input = f.input();
    expect(() => resolveJune2026CollectionAnswer({...input, caseId: randomUUID()})).toThrow('JUNE_COLLECTION_CASE_MISMATCH');
    for (const change of [{identityId: ''}, {answerRevision: 0}, {requestId: ''}, {answeredAt: 'invalid'}]) expect(() => resolveJune2026CollectionAnswer({...input, ...change})).toThrow();
  });

  it('rejects target alteration; even a recomputed target hash cannot replace the checkpoint component', () => {
    const f = fixture(componentSelector), target = structuredClone(f.target());
    if (target.subject.kind !== 'component') throw Error('EXPECTED_COMPONENT');
    target.subject.component.amount = {currency: 'ILS', minor_units: 900000};
    expect(() => june2026CollectionTargetSchema.parse(target)).toThrow();
    const {target_sha256: _old, ...body} = target; void _old;
    expect(resolveJune2026CollectionAnswer({...f.input(JUNE2026_COMPONENT_DECLARATIONS.base_salary), target: {...body, target_sha256: canonicalSha256(body)}}).state).toBe('stale');
  });

  it('requires full June, unique/current component inventory, intact checkpoint and no provider-authored confirmations', () => {
    const f = fixture(), period = f.extraction.fields.find(c => c.field === 'salary_period')!;
    if (period.field !== 'salary_period' || !period.normalized_value) throw Error('EXPECTED_PERIOD');
    period.normalized_value.start_date = '2026-06-02'; f.rehash(); expect(f.target).toThrow('JUNE_COLLECTION_PERIOD_UNSUPPORTED');
    period.normalized_value.start_date = '2026-06-01'; f.extraction.fields.push(structuredClone(period)); f.rehash(); expect(f.target).toThrow('JUNE_COLLECTION_PERIOD_UNSUPPORTED');
    const duplicate = fixture(); duplicate.extraction.additional_components.push(structuredClone(duplicate.component)); duplicate.rehash(); expect(duplicate.target).toThrow('JUNE_COLLECTION_COMPONENT_INVENTORY_INVALID');
    const foreign = fixture(); foreign.component.source.document_id = randomUUID(); foreign.rehash(); expect(foreign.target).toThrow('JUNE_COLLECTION_COMPONENT_INVENTORY_INVALID');
    const tooMany = fixture(); for (let i = 0; i < 32; i++) tooMany.extraction.additional_components.push({...structuredClone(tooMany.component), component_id: randomUUID()}); tooMany.rehash(); expect(tooMany.target).toThrow('JUNE_COLLECTION_COMPONENT_INVENTORY_INVALID');
    const corrupted = fixture(); corrupted.extraction.warnings.push('unhashed'); expect(corrupted.target).toThrow('JUNE_COLLECTION_CHECKPOINT_MISMATCH');
    const forged = fixture(); forged.extraction.customer_readings = []; forged.rehash(); expect(forged.target).toThrow('JUNE_COLLECTION_PROVIDER_CONFIRMATION_FORBIDDEN');
  });

  it('retains immutable correction provenance and replays identical answers without changing prior receipts', () => {
    const f = fixture(), firstInput = f.input(), first = resolveJune2026CollectionAnswer(firstInput), before = structuredClone(first);
    expect(resolveJune2026CollectionAnswer(firstInput)).toEqual(first);
    const corrected = resolveJune2026CollectionAnswer({...firstInput, answerRevision: 3, answeredAt: '2026-09-09T18:30:00.000Z', answer: JUNE2026_UNKNOWN_ANSWER});
    expect(corrected).toMatchObject({state: 'unknown', declaration: {answer_revision: 3, evidence_status: 'missing'}});
    expect(corrected.declaration.declaration_sha256).not.toBe(first.declaration.declaration_sha256);
    expect(corrected.declaration.provenance[0].source_reference.answer_revision).toBe(3);
    expect(first).toEqual(before);
  });

  it.each(['', 'yes', '0', 'כן', 'confirmed', 'a'.repeat(1501)])('refuses invalid choice or oversized answer', answer => {
    const f = fixture(); expect(() => resolveJune2026CollectionAnswer(f.input(answer))).toThrow();
  });

  it('rejects arbitrary fields, numeric version IDs and invented actor approvals', () => {
    const f = fixture(), target = f.target();
    expect(() => createJune2026CollectionTarget({checkpoint: f.checkpoint, policyVersion: 'test', subject: {kind: 'applicability', field: 'all_laws_approved'} as unknown as June2026CollectionSelector})).toThrow();
    expect(june2026CollectionTargetSchema.safeParse({...target, version_id: 1}).success).toBe(false);
    expect(june2026CollectionTargetSchema.safeParse({...target, reviewer_approved: true}).success).toBe(false);
  });
});
