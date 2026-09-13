import {describe, expect, it, vi} from 'vitest';
import {CaseAnalysisService, type CaseAnalysisServiceDependencies} from './service.ts';
import {buildSyntheticCaseFixture} from './synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {June2026ReviewCatalog} from '../legal-operations/june2026-catalog.ts';
import {SYNTHETIC_CATALOG_DATE, SYNTHETIC_POPULATION, SYNTHETIC_SECTOR} from '../legal-operations/synthetic-fixtures.ts';
import {createIntegratedFullSystemHarness} from '../../server/engine/case-analysis/integrated-harness.ts';
import {SavedAnalysisDraftBuilder, SAVED_DRAFT_TEMPLATE} from '../../server/product/processing/saved-draft-report.ts';

function setup(overrides: Partial<CaseAnalysisServiceDependencies> = {}) {
  const fixture = buildSyntheticCaseFixture({fixture_id: 'preexecution-order'});
  const h = createIntegratedFullSystemHarness([fixture.stored]);
  const service = new CaseAnalysisService({...h, reportRegistration: h.review, reportBuilder: new SavedAnalysisDraftBuilder(),
    templateVersion: SAVED_DRAFT_TEMPLATE, ...overrides});
  return {h, service, command: {...fixture.command, requested_topics: ['minimum_wage' as const],
    period: {start_date: SYNTHETIC_CATALOG_DATE, end_date: SYNTHETIC_CATALOG_DATE}, as_of: SYNTHETIC_CATALOG_DATE,
    sector: SYNTHETIC_SECTOR, population: SYNTHETIC_POPULATION}};
}

describe('persisted canonical context before execution', () => {
  it('awaits the authenticated loader after input persistence and before an otherwise eligible executor', async () => {
    const f = setup(), events: string[] = [];
    const service = new CaseAnalysisService({...f.h, reportRegistration: f.h.review, templateVersion: SAVED_DRAFT_TEMPLATE,
      reportBuilder: new SavedAnalysisDraftBuilder(), prepareExecutionContext: async pins => {
        const saved = await f.h.repository.getByRunId(pins.analysis_run_id);
        expect(saved?.completed).toBe(false);
        expect(saved?.stages.map(stage => stage.stage)).toEqual(['input_snapshot', 'canonical_facts', 'rule_inputs', 'analysis_run']);
        expect(saved?.stages.find(stage => stage.stage === 'canonical_facts')?.payload).toMatchObject({facts_snapshot_sha256: pins.facts_snapshot_sha256});
        expect(saved?.stages.find(stage => stage.stage === 'rule_inputs')?.payload).toEqual({rule_inputs: pins.rule_inputs});
        expect(pins.command_sha256).toBe(canonicalSha256(f.command));
        expect(Object.isFrozen(pins)).toBe(true); expect(Object.isFrozen(pins.rule_inputs[0])).toBe(true);
        expect(f.h.executor.counters.execute_calls).toBe(0);
        await Promise.resolve(); events.push('context_loaded');
      }, executor: {async execute(input) {events.push('execute'); return f.h.executor.execute(input);}}});
    await service.runCaseAnalysis(f.command);
    expect(events).toEqual(['context_loaded', 'execute']);
  });
  it('propagates a source/authority failure before findings, report or registration; a retry revalidates', async () => {
    const error = Error('SAVED_JUNE_CONTEXT_READING_NOT_IN_JOURNAL');
    const hook = vi.fn(async () => {throw error;});
    const f = setup({prepareExecutionContext: hook});
    for (let attempt = 0; attempt < 2; attempt++) await expect(f.service.runCaseAnalysis(f.command)).rejects.toBe(error);
    const id = f.h.ids.derive('case-analysis-run', canonicalSha256(f.command));
    const saved = await f.h.repository.getByRunId(id);
    expect(saved?.completed).toBe(false); expect(saved?.report).toBeNull();
    expect(saved?.stages.map(stage => stage.stage)).toEqual(['input_snapshot', 'canonical_facts', 'rule_inputs', 'analysis_run']);
    expect(f.h.executor.counters.execute_calls).toBe(0); expect(hook).toHaveBeenCalledTimes(2);
    expect(f.h.review.counters.registrations).toBe(0);
  });
  it('does not retrofit or reload context for an already completed exact run', async () => {
    const hook = vi.fn(async () => {}), f = setup({prepareExecutionContext: hook});
    const bundle = await f.service.runCaseAnalysis(f.command);
    expect(await f.service.runCaseAnalysis(f.command)).toEqual(bundle); expect(hook).toHaveBeenCalledOnce();
  });
  it('loads context under the actual unsigned June catalog while retaining every execution refusal', async () => {
    const hook = vi.fn(async () => {}), f = setup({prepareExecutionContext: hook, legalCatalog: new June2026ReviewCatalog()});
    const bundle = await f.service.runCaseAnalysis({...f.command, mode: 'real', period: {start_date: '2026-06-01', end_date: '2026-06-30'},
      as_of: '2026-09-09', sector: 'unverified', population: 'unverified'});
    expect(hook).toHaveBeenCalledOnce(); expect(f.h.executor.counters.execute_calls).toBe(0);
    expect(bundle.topic_results[0]).toMatchObject({amount: null, trace: null});
    expect(bundle.topic_results[0].legal_readiness?.usable_for_rules).toBe(false);
  });
});
