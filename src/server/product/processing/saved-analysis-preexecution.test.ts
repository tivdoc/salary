import {beforeEach, describe, expect, it, vi} from 'vitest';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createIntegratedFullSystemHarness} from '@/server/engine/case-analysis/integrated-harness';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {runSavedMonthAnalysis} from './saved-analysis';
import {loadSavedJune2026AdmittedContext, type SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
import {SAVED_JUNE_REVIEW_VERSION} from './saved-minimum-wage-review';

const mocks = vi.hoisted(() => ({snapshot: null as unknown, order: {id: '22222222-2222-4222-8222-222222222222', kind: 'initial',
  from: '2026-06-01', to: '2026-06-01', topics: ['minimum_wage'], offer_sha256: 'b'.repeat(64)}, collection: {resolutions: []}}));
vi.mock('server-only', () => ({}));
vi.mock('./source-dispatch', async original => ({...await original<typeof import('./source-dispatch')>(), lockCurrentSource: vi.fn(async () => {})}));
vi.mock('./saved-order-scope', async original => ({...await original<typeof import('./saved-order-scope')>(), readSavedOrders: vi.fn(async () => [mocks.order])}));
vi.mock('./saved-snapshot', () => ({SavedCaseSnapshot: class {
  async read() {return mocks.snapshot;} async loadPinned() {return mocks.snapshot;}
}}));
vi.mock('./saved-june2026-collection', () => ({readSavedJune2026Collection: vi.fn(async () => mocks.collection)}));
vi.mock('./saved-june2026-admitted-context', () => ({loadSavedJune2026AdmittedContext: vi.fn()}));

beforeEach(() => {vi.clearAllMocks(); mocks.order.from = mocks.order.to = '2026-06-01';});

/** Composition proof over the real CaseAnalysisService and in-memory stages.
 * The loader is mocked here; its SQL/journal authority is tested separately.
 * These synthetic context objects do not claim a verified customer reading. */
function setup() {
  const fixture = buildSyntheticCaseFixture({fixture_id: 'saved-preexecution', mode: 'real'});
  mocks.snapshot = fixture.stored;
  const h = createIntegratedFullSystemHarness([fixture.stored]);
  const job: SourceJob = {schema_version: 'saved-case-work-v1', case_id: fixture.command.case_id, revision: 1, input_sha256: 'a'.repeat(64), mode: 'draft'};
  const context: PostgresTransactionContext = {transaction_id: 'unit-composition-only', client: {async query(query) {
    if (query.name !== 'saved_analysis_order') throw Error(`UNEXPECTED_SQL:${query.name}`);
    return {rows: [{created_at: '2026-09-09T20:00:00.000Z', engine_revision: 1}], row_count: 1};
  }}};
  let loaded: SavedJune2026AdmittedContext;
  const loader = vi.mocked(loadSavedJune2026AdmittedContext);
  loader.mockImplementation(async input => {
    const saved = await h.repository.getByRunId(input.analysisRunId);
    expect(saved?.completed).toBe(false);
    expect(saved?.stages.map(stage => stage.stage)).toEqual(['input_snapshot', 'canonical_facts', 'rule_inputs', 'analysis_run']);
    loaded = {schema_version: 'saved-june2026-factual-context-v1', state: 'context_blocked', code: 'multiple_documents',
      case_id: job.case_id, analysis_run_id: input.analysisRunId, legal_activation: false, publication_allowed: false};
    return loaded;
  });
  return {h, job, loader, get loaded() {return loaded;}, input: {context, analysis: {caseAnalysis: h.repository, reports: h.review} as unknown as PostgresAnalysisRepositories,
    tenantId: `saved-case:${job.case_id}`, job, orderId: mocks.order.id, month: '2026-06'}};
}

describe('saved June preexecution composition', () => {
  it('loads once before outcomes, keeps an honest unsupported-source diagnostic and replays without retrofitting', async () => {
    const f = setup(), saved = await runSavedMonthAnalysis(f.input);
    const review = saved.stages.find(stage => stage.stage === 'review_pending')?.payload;
    expect(review).toMatchObject({diagnostics: {schema_version: SAVED_JUNE_REVIEW_VERSION, factual_context: f.loaded,
      activation_allowed: false, candidate_calculation_performed: false}});
    expect(await runSavedMonthAnalysis(f.input)).toEqual(saved); expect(f.loader).toHaveBeenCalledOnce();
    expect(saved.bundle?.topic_results[0]).toMatchObject({amount: null, trace: null});
  });
  it('does not load June context for an unrelated purchased month', async () => {
    const f = setup(); mocks.order.from = mocks.order.to = '2026-08-01';
    await runSavedMonthAnalysis({...f.input, month: '2026-08'}); expect(f.loader).not.toHaveBeenCalled();
  });
  it('retains the exact preloaded context when all persisted pins match without authorizing calculation', async () => {
    const f = setup(); let loaded: SavedJune2026AdmittedContext | undefined;
    f.loader.mockImplementation(async input => {
      const saved = (await f.h.repository.getByRunId(input.analysisRunId))!;
      const canonical = saved.stages.find(stage => stage.stage === 'canonical_facts')!.payload as {facts_snapshot_sha256: string};
      const rules = saved.stages.find(stage => stage.stage === 'rule_inputs')!.payload as {rule_inputs: unknown[]};
      loaded = {schema_version: 'saved-june2026-factual-context-v1', state: 'context_loaded', command_sha256: canonicalSha256(saved.command),
        context: {current: {case_id: f.job.case_id, analysis_run_id: input.analysisRunId}, facts_snapshot_sha256: canonical.facts_snapshot_sha256,
          rule_input: rules.rule_inputs[0], state: 'factual_context_blocked', legal_activation: false, publication_allowed: false},
        legal_activation: false, publication_allowed: false} as unknown as SavedJune2026AdmittedContext;
      return loaded;
    });
    const saved = await runSavedMonthAnalysis(f.input);
    expect(saved.stages.find(stage => stage.stage === 'review_pending')?.payload).toMatchObject({diagnostics: {factual_context: loaded, activation_allowed: false}});
    expect(saved.bundle?.topic_results[0]).toMatchObject({amount: null, trace: null}); expect(f.loader).toHaveBeenCalledOnce();
  });
  it.each(['case', 'run', 'command', 'facts', 'rule_input'] as const)('refuses loaded %s pin mismatch before later stages', async difference => {
    const f = setup(); let runId = '';
    f.loader.mockImplementation(async input => {
      runId = input.analysisRunId;
      const saved = (await f.h.repository.getByRunId(runId))!;
      const canonical = saved.stages.find(stage => stage.stage === 'canonical_facts')!.payload as {facts_snapshot_sha256: string};
      const rules = saved.stages.find(stage => stage.stage === 'rule_inputs')!.payload as {rule_inputs: unknown[]};
      const context = {current: {case_id: difference === 'case' ? 'foreign' : f.job.case_id, analysis_run_id: difference === 'run' ? 'another-run' : runId},
        facts_snapshot_sha256: difference === 'facts' ? 'f'.repeat(64) : canonical.facts_snapshot_sha256,
        rule_input: difference === 'rule_input' ? {snapshot_sha256: 'f'.repeat(64)} : rules.rule_inputs[0]};
      return {schema_version: 'saved-june2026-factual-context-v1', state: 'context_loaded', context,
        command_sha256: difference === 'command' ? 'f'.repeat(64) : canonicalSha256(saved.command), legal_activation: false, publication_allowed: false} as unknown as SavedJune2026AdmittedContext;
    });
    await expect(runSavedMonthAnalysis(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_PREEXECUTION_BINDING');
    const saved = await f.h.repository.getByRunId(runId);
    expect(saved?.completed).toBe(false); expect(saved?.report).toBeNull();
    expect(saved?.stages.map(stage => stage.stage)).toEqual(['input_snapshot', 'canonical_facts', 'rule_inputs', 'analysis_run']);
  });
  it('propagates actual loader authority refusal instead of turning it into an inactive-catalog success', async () => {
    const f = setup(); f.loader.mockRejectedValue(Error('SAVED_WORKER_SCOPE_FORBIDDEN'));
    await expect(runSavedMonthAnalysis(f.input)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
  });
});
