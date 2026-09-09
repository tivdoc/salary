import {randomUUID} from 'node:crypto';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {resolvePayslipSnapshot, resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createTopicRuleInputSnapshot} from '@/engine/rule-input/snapshot';
import type {CaseAnalysisCommand} from '@/engine/wave3/contracts';
import {extractSavedPayslip} from '@/server/engine/extraction/saved-payslip';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import type {PostgresStatement, PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {documentFieldTarget, DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {devFinancialInputFixture} from './dev-financial-flow.fixture';
import {SavedCaseSnapshot, SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {savedMonthIdempotencyKey, type SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';
import {loadSavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
vi.mock('server-only', () => ({}));

const now = '2026-09-09T20:30:00.000Z';
type Checkpoint = Awaited<ReturnType<typeof extractSavedPayslip>>;
let originals: {checkpoint: Checkpoint; size: number; name: string}[];

beforeAll(async () => {
  const fixture = await devFinancialInputFixture(false), caseId = randomUUID();
  originals = [];
  for (let index = 0; index < 2; index++) {
    const versionId = randomUUID(), productId = randomUUID();
    const extractor = new OpenAiPayslipV2PassExtractor({apiKey: 'unit-test-unused-key', model: 'unit-test-model', timeoutMs: 1000}, {
      transport: {async parse() {return {id: `resp_test_${index}`, requestId: `req_test_${index}`, model: 'unit-test-model', status: 'completed',
        outputParsed: structuredClone(fixture.output), usage: {input_tokens: 100, output_tokens: 30, total_tokens: 130}};}}, extractorVersion: '2.1'});
    const checkpoint = await extractSavedPayslip({caseId, versionId, expectedMonth: '2026-06', extractor,
      context: {snapshot_id: randomUUID(), case_id: caseId, analysis_run_id: randomUUID(), schema_version: '1.0.0', created_at: now,
        fact_ids: Object.fromEntries(resolvedPayslipFactPaths.map(path => [path, randomUUID()]))},
      db: {async query() {return {rows: [{id: productId, case_id: caseId, version_id: versionId, document_type: 'payslip',
        storage_path: `cases/${caseId}/versions/${versionId}.pdf`, original_filename: fixture.name, mime_type: 'application/pdf', size: fixture.bytes.length,
        content_sha256: fixture.sha256, period_month: '2026-06-01', created_at: now}]};}},
      storage: {async download() {return {data: new Blob([Buffer.from(fixture.bytes)], {type: 'application/pdf'}), error: null};}}});
    originals.push({checkpoint, size: fixture.bytes.length, name: fixture.name});
  }
});

/** A recording SQL adapter, not a PostgreSQL ownership proof. Actual snapshot,
 * journal reading, receipt parsing and context implementations execute here. */
async function fixture() {
  const [{checkpoint, size, name}, second] = structuredClone(originals), caseId = checkpoint.case_id;
  const job: SourceJob = {schema_version: 'saved-case-work-v1', case_id: caseId, revision: 3, input_sha256: 'a'.repeat(64), mode: 'draft'};
  const order: SavedOrderScope = {id: randomUUID(), kind: 'initial', from: '2026-06-01', to: '2026-06-01', topics: ['minimum_wage'], offer_sha256: 'b'.repeat(64)};
  const required = ['regular_hours', 'base_monthly_salary', 'gross_salary', 'salary_type', 'salary_period'];
  // Explicit automated confirmations of independently known synthetic values.
  // These are not actual customer actions, professional review or DB authority.
  const answers = checkpoint.run.result.final_extraction.fields.filter(field => required.includes(field.field)).map(candidate => {
    const target = documentFieldTarget({checkpoint, policyVersion: SAVED_EXTRACTION_POLICY, candidateId: candidate.candidate_id});
    return {id: randomUUID(), case_id: caseId, scope_month: '2026-06', code: `document_field:${target.target_sha256}`, answer_kind: 'choice',
      answer: DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0] as string, answer_revision: 1, answer_identity_id: randomUUID(), answer_created_at: now, field_target: target};
  });
  const pinned = (value: Checkpoint) => ({id: value.product_document_id, version_id: value.version_id, sha256: value.input_sha256, type: 'payslip', month: '2026-06'});
  const journal = {case_id: caseId, month: '2026-06', documents: [pinned(checkpoint)], answers, orders: [order]};
  const record = (value: Checkpoint, bytes: number, filename: string) => ({id: value.product_document_id, product_document_id: value.product_document_id,
    case_id: caseId, version_id: value.version_id, original_filename: filename, mime_type: 'application/pdf', size: bytes,
    content_sha256: value.input_sha256, storage_path: `cases/${caseId}/versions/${value.version_id}.pdf`, created_at: now,
    checkpoint_input_sha256: value.input_sha256, checkpoint_result_sha256: value.result_sha256, result: value});
  const document = record(checkpoint, size, name), secondDocument = record(second.checkpoint, second.size, second.name);
  const responses: Record<string, Record<string, unknown>[]> = {
    saved_june_context_authority: [{tenant_id: `saved-case:${caseId}`, principal: 'tivdoc_worker_runtime'}],
    source_case_lock: [], source_revision_check: [{revision: job.revision, input_sha256: job.input_sha256}],
    saved_order_entitlements: [{orders: [order], current_orders: [structuredClone(order)]}],
    saved_snapshot_journal: [{input: journal, input_sha256: job.input_sha256, actual_sha256: job.input_sha256, created_at: now}],
    saved_june_context_checkpoint: [document],
    saved_june2026_journal: [{input: journal, input_sha256: job.input_sha256, actual_sha256: job.input_sha256, evaluated_at: new Date(now)}],
    saved_june2026_targets: [], saved_june2026_checkpoints: [{result: checkpoint}],
  };
  const calls: PostgresStatement[] = [];
  const context: PostgresTransactionContext = {transaction_id: 'recording.saved-june-context', client: {async query(query) {
    calls.push(query);
    const rows = query.name === 'saved_snapshot_document' ? [query.values[1] === secondDocument.id ? secondDocument : document] : responses[query.name];
    if (!rows) throw Error(`UNEXPECTED_SQL:${query.name}`);
    return {rows, row_count: rows.length};
  }}};
  let snapshot = await new SavedCaseSnapshot(context, job, '2026-06').read();
  const analysisRunId = randomUUID();
  const facts = resolvePayslipSnapshot({document: snapshot.documents[0], extraction: snapshot.extractions[0],
    validation: validatePayslipGate0(snapshot.extractions[0], {reference_year: 2026}), context: {snapshot_id: randomUUID(), case_id: caseId,
      analysis_run_id: analysisRunId, schema_version: '1.0.0', created_at: now, fact_ids: Object.fromEntries(resolvedPayslipFactPaths.map(path => [path, randomUUID()]))}});
  let command: CaseAnalysisCommand = {case_id: caseId, case_revision: 1, document_snapshot_id: snapshot.document_snapshot_id, document_snapshot_sha256: snapshot.document_snapshot_sha256,
    extraction_snapshot_id: snapshot.extraction_snapshot_id, extraction_snapshot_sha256: snapshot.extraction_snapshot_sha256,
    declared_fact_snapshot_id: snapshot.declared_fact_snapshot.snapshot_id, declared_fact_snapshot_sha256: snapshot.declared_fact_snapshot.snapshot_sha256,
    period: {start_date: '2026-06-01', end_date: '2026-06-30'}, as_of: '2026-09-09', requested_topics: ['minimum_wage'], sector: 'unverified', population: 'unverified', mode: 'real',
    idempotency_key: savedMonthIdempotencyKey(job, order.id, '2026-06')};
  const stages: {stage: string; payload: unknown; payload_sha256: string}[] = [];
  const setStage = (stage: string, payload: unknown) => {
    const value = {stage, payload, payload_sha256: canonicalSha256(payload)}, index = stages.findIndex(row => row.stage === stage);
    if (index < 0) stages.push(value); else stages[index] = value;
  };
  function setFacts(next = facts) {
    setStage('canonical_facts', {facts: next, facts_snapshot_sha256: canonicalSha256(next)});
    setStage('rule_inputs', {rule_inputs: command.requested_topics.map(topic => createTopicRuleInputSnapshot(next, topic))});
  }
  function setCommand(next = command) {
    command = next;
    responses.saved_june_context_run = [{analysis_run_id: analysisRunId, case_id: caseId, command, command_sha256: canonicalSha256(command), idempotency_key: command.idempotency_key,
      source_revision: job.revision, source_input_sha256: job.input_sha256, actual_input_sha256: job.input_sha256}];
    setStage('input_snapshot', {command_sha256: canonicalSha256(command), document_snapshot_sha256: command.document_snapshot_sha256,
      extraction_snapshot_sha256: command.extraction_snapshot_sha256, declared_fact_snapshot_sha256: command.declared_fact_snapshot_sha256, created_at: now});
  }
  setCommand(); setFacts(); responses.saved_june_context_stages = stages; calls.length = 0;
  async function repinSnapshot() {
    snapshot = await new SavedCaseSnapshot(context, job, '2026-06').read();
    setCommand({...command, document_snapshot_sha256: snapshot.document_snapshot_sha256, extraction_snapshot_sha256: snapshot.extraction_snapshot_sha256,
      declared_fact_snapshot_sha256: snapshot.declared_fact_snapshot.snapshot_sha256});
    calls.length = 0;
  }
  return {input: {context, job, orderId: order.id, analysisRunId}, responses, calls, checkpoint, facts, document, journal, order,
    second, pinned, setStage, setFacts, setCommand, repinSnapshot, get command() {return command;}};
}

describe('saved June context loader over actual saved-stage/reading adapters', () => {
  it('loads persisted stages and actual journal readings, preserving injected provenance and every legal block', async () => {
    const f = await fixture(), result = await loadSavedJune2026AdmittedContext(f.input);
    expect(result.state).toBe('context_loaded');
    if (result.state !== 'context_loaded') throw Error('fixture_not_loaded');
    expect(result.context.state).toBe('factual_context_ready'); expect(result.context.source_fact_bindings).toHaveLength(2);
    expect(result.provenance.kind).toBe('injected_test_provider');
    expect(result.context.legal_gates.every(gate => gate.status === 'not_admitted')).toBe(true);
    expect(result).toMatchObject({legal_activation: false, publication_allowed: false});
    expect(f.calls.slice(0, 5).map(query => query.name)).toEqual(['saved_june_context_authority', 'source_case_lock', 'source_revision_check', 'saved_order_entitlements', 'saved_june_context_run']);
    const runQuery = f.calls.find(query => query.name === 'saved_june_context_run')!;
    expect(runQuery.values).toEqual([`saved-case:${f.input.job.case_id}`, f.input.job.case_id, f.input.analysisRunId]);
    expect(runQuery.text).toContain("ar.status in ('running','completed')");
    expect(f.responses.saved_june_context_stages.map(row => row.stage).sort()).toEqual(['canonical_facts', 'input_snapshot', 'rule_inputs']);
    expect(f.calls.find(query => query.name === 'saved_june_context_stages')?.text).toContain("s.stage in ('input_snapshot','canonical_facts','rule_inputs')");
    expect(runQuery.text).toContain("ar.command_payload->>'document_snapshot_id'='saved-documents:2026-06:'||v.input_sha256");
    expect(f.calls.map(query => query.text).join('\n')).not.toMatch(/^\s*(?:insert|update|delete)\b/imu);
  });
  it.each(['foreign_tenant', 'anonymous_principal'] as const)('refuses %s before any source read', async difference => {
    const f = await fixture();
    f.responses.saved_june_context_authority[0][difference === 'foreign_tenant' ? 'tenant_id' : 'principal'] = difference === 'foreign_tenant' ? `saved-case:${randomUUID()}` : 'anon';
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN'); expect(f.calls).toHaveLength(1);
  });
  it('refuses live mode, stale source and revoked or unpurchased entitlement', async () => {
    const f = await fixture();
    await expect(loadSavedJune2026AdmittedContext({...f.input, job: {...f.input.job, mode: 'live'}})).rejects.toThrow('SAVED_LIVE_COMPOSITION_NOT_ENABLED'); expect(f.calls).toHaveLength(0);
    f.responses.source_revision_check[0].revision = 4;
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
    f.responses.source_revision_check[0].revision = 3; f.responses.saved_order_entitlements[0].current_orders = [];
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
    f.order.topics = ['pension']; f.responses.saved_order_entitlements[0].current_orders = [structuredClone(f.order)];
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_ORDER_SCOPE');
  });
  it.each(['analysis_run_id', 'case_id', 'source_revision', 'source_input_sha256', 'actual_input_sha256', 'command_sha256', 'idempotency_key'] as const)(
    'refuses saved run %s mismatch rather than manufacturing saved=current', async field => {
      const f = await fixture(); f.responses.saved_june_context_run[0][field] = field === 'source_revision' ? 2 : field.endsWith('sha256') ? 'f'.repeat(64) : randomUUID();
      await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_RUN_BINDING');
    });
  it('refuses a missing run and an altered snapshot even after command and input-stage rehash', async () => {
    const f = await fixture(), run = f.responses.saved_june_context_run;
    f.responses.saved_june_context_run = []; await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_RUN_REQUIRED');
    f.responses.saved_june_context_run = run;
    f.setCommand({...f.command, extraction_snapshot_sha256: 'e'.repeat(64)});
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_COMMAND_PIN_MISMATCH');
  });
  it.each(['missing', 'outer_hash', 'inner_hash', 'foreign_facts', 'rule_input'] as const)('rejects %s persisted stage integrity before legacy fallback', async difference => {
    const f = await fixture(); Reflect.deleteProperty(f.checkpoint.run, 'provider_receipts');
    if (difference === 'missing') f.responses.saved_june_context_stages.pop();
    if (difference === 'outer_hash') f.responses.saved_june_context_stages[0].payload_sha256 = 'f'.repeat(64);
    if (difference === 'inner_hash') f.setStage('canonical_facts', {facts: f.facts, facts_snapshot_sha256: 'f'.repeat(64)});
    if (difference === 'foreign_facts') f.setFacts({...f.facts, analysis_run_id: randomUUID()});
    if (difference === 'rule_input') f.setStage('rule_inputs', {rule_inputs: [createTopicRuleInputSnapshot(f.facts, 'travel')]});
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow();
    expect(f.calls.some(query => query.name === 'saved_june_context_checkpoint')).toBe(false);
  });
  it('uses the persisted canonical status instead of reconstructing a more permissive fact', async () => {
    const f = await fixture();
    f.setFacts(employmentSnapshotSchema.parse({...f.facts, facts: f.facts.facts.map(fact => fact.path === 'work.regular_hours' ? {...fact, status: 'needs_confirmation'} : fact)}));
    const result = await loadSavedJune2026AdmittedContext(f.input);
    expect(result.state).toBe('context_loaded');
    if (result.state !== 'context_loaded') throw Error('fixture_not_loaded');
    expect(result.context).toMatchObject({state: 'factual_context_blocked', source_fact_bindings: [], factual_issues: [{field: 'work.regular_hours'}]});
  });
  it('refuses a confirmation absent from the current journal even with self-consistent run/stage hashes', async () => {
    const f = await fixture(), first = f.journal.answers.find(answer => answer.field_target.candidate.field === 'regular_hours')!;
    first.answer_revision = 2; first.answer = DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]; await f.repinSnapshot();
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_READING_NOT_IN_JOURNAL');
  });
  it('refuses an attributed reading with a different answer revision and unattributed machine verification', async () => {
    const f = await fixture(), changed = structuredClone(f.facts), fact = changed.facts.find(value => value.path === 'work.regular_hours')!;
    const source = fact.provenance.find(value => value.source_type === 'documented')!;
    if (source.source_type !== 'documented' || !source.customer_confirmation) throw Error('fixture_reading');
    source.customer_confirmation.answer_revision = 999; f.setFacts(changed);
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_READING_NOT_IN_JOURNAL');
    Reflect.deleteProperty(source, 'customer_confirmation'); f.setFacts(changed);
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_UNATTRIBUTED_READING');
  });
  it('keeps legacy provider and legacy page-count receipts typed blocked without claiming readiness', async () => {
    const f = await fixture(), receipts = f.checkpoint.run.provider_receipts;
    Reflect.deleteProperty(f.checkpoint.run, 'provider_receipts');
    expect(await loadSavedJune2026AdmittedContext(f.input)).toMatchObject({state: 'context_blocked', code: 'legacy_source_provenance', legal_activation: false});
    Reflect.set(f.checkpoint.run, 'provider_receipts', receipts!.map(receipt => {
      const {receipt_sha256, source_page_count, ...body} = receipt; void receipt_sha256; void source_page_count; return createOpenAiProviderReceipt(body);
    }));
    expect(await loadSavedJune2026AdmittedContext(f.input)).toMatchObject({state: 'context_blocked', code: 'legacy_source_page_count', publication_allowed: false});
  });
  it('returns multiple-document scope as a review block without combining payroll facts', async () => {
    const f = await fixture(); f.journal.documents.push(f.pinned(f.second.checkpoint)); await f.repinSnapshot();
    expect(await loadSavedJune2026AdmittedContext(f.input)).toMatchObject({state: 'context_blocked', code: 'multiple_documents', legal_activation: false});
    expect(f.calls.some(query => query.name === 'saved_june_context_checkpoint')).toBe(false);
  });
  it.each(['size', 'mime', 'receipt_hash'] as const)('refuses actual source %s disagreement', async changed => {
    const f = await fixture();
    if (changed === 'size') f.document.size += 1;
    if (changed === 'mime') f.document.mime_type = 'image/png';
    if (changed === 'receipt_hash') Reflect.set(f.checkpoint.run.provider_receipts![0], 'receipt_sha256', 'f'.repeat(64));
    if (changed === 'size') await f.repinSnapshot();
    await expect(loadSavedJune2026AdmittedContext(f.input)).rejects.toThrow();
  });
});
