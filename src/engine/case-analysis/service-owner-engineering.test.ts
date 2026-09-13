import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {CaseAnalysisService,type CaseAnalysisOwnerEngineeringContext} from './service.ts';
import {replayCaseAnalysisOwnerEngineering} from './contracts.ts';
import {ownerEngineeringServiceSetup as setup,issueOwnerEngineeringService as issue} from './service-owner-engineering.fixture.ts';
import {decodeBundle,decodeDependencies} from '../../server/platform/persistence/postgres/analysis/validation.ts';
import type {AnalysisResultBundle} from '../wave3/contracts.ts';

const resealBundle=(bundle:AnalysisResultBundle)=>{
 const {result_sha256,...body}=bundle;void result_sha256;bundle={...bundle,result_sha256:canonicalSha256(body)};return bundle;
};

describe('ordinary analysis persists the owner-only engineering envelope',()=>{
 it('rejects mixing owner engineering and qualified preparation hooks',async()=>{
  const f=setup({prepareOwnerEngineering:async c=>issue(c),prepareAiRelease:async()=>null});
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('CASE_ANALYSIS_PURPOSE_CONFLICT');
  expect(f.reportBuilder.counters.build_calls).toBe(0);expect(f.h.repository.completedCount()).toBe(0);
 });
 it('uses the persisted canonical facts and fixed composer/executor while legacy topic refusals remain',async()=>{
  const f=setup(),hook=vi.fn(async(context:CaseAnalysisOwnerEngineeringContext)=>{
   const run=await f.h.repository.getByRunId(context.analysis_run_id);
   expect(run?.stages.map(s=>s.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs']);
   expect(run?.stages.find(s=>s.stage==='canonical_facts')?.payload).toEqual({facts:context.facts,facts_snapshot_sha256:context.facts_snapshot_sha256});
   expect(context.command_sha256).toBe(canonicalSha256(f.command));expect(Object.isFrozen(context)).toBe(true);
   expect(f.h.executor.counters.execute_calls).toBe(0);return issue(context);
  });
  const service=new CaseAnalysisService({...f.dependencies,prepareOwnerEngineering:hook}),bundle=await service.runCaseAnalysis(f.command);
  expect(hook).toHaveBeenCalledOnce();expect(bundle.owner_engineering?.result.findings).toHaveLength(3);
  expect(bundle.ai_release).toBeUndefined();expect(bundle.owner_engineering?.result).toMatchObject({claim_kind:'owner_engineering_review',release_authorized:false,publication_allowed:false,notification_allowed:false,legal_debt_total:null,combined_amount:null});
  expect(bundle.owner_engineering?.result.findings.every(f=>f.human_law_review?.human_by_law.state==='unresolved')).toBe(true);
  expect(bundle.owner_engineering?.result.checks.every(c=>c.analysis_run_id===bundle.analysis_run_id)).toBe(true);
  expect(bundle.owner_engineering?.result.purchased_scope.topics).toHaveLength(9);
  expect(bundle.topic_results).toHaveLength(7);expect(bundle.topic_results.every(t=>t.amount===null&&t.trace===null)).toBe(true);
  expect(bundle.known_subtotal).toBeNull();expect(bundle.coverage_complete).toBe(false);
  expect(bundle.owner_engineering?.result.review).toEqual(bundle.document_review);
  expect(bundle.owner_engineering?.input.assessment_input.current.scope.facts_sha256).toBe(bundle.facts_snapshot_sha256);
  expect(f.h.review.counters.approvals).toBe(0);expect(f.h.executor.counters.execute_calls).toBe(0);
  const run=await service.getCompletedRun(bundle.analysis_run_id);expect(run?.dependencies?.code_version).toBe('case-analysis@0.6.9');
  expect(decodeDependencies(run!.dependencies)).toEqual(run?.dependencies);expect(decodeBundle(bundle)).toEqual(bundle);
 });
 it('leaves every byte unchanged when the optional server hook returns null',async()=>{
  const a=setup(),b=setup({prepareOwnerEngineering:async()=>null}),left=await a.service.runCaseAnalysis(a.command),right=await b.service.runCaseAnalysis(b.command);
  expect(right).toEqual(left);expect('owner_engineering' in right).toBe(false);
  expect((await b.service.getCompletedRun(right.analysis_run_id))?.dependencies?.code_version).toBe('case-analysis@0.6.7');
 });
 it.each(['case_id','input_revision','input_sha256','facts_sha256','population','order_id','order_origin','order_receipt_sha256','period'] as const)('rejects mismatched %s before any executor or report',async(field)=>{
  const f=setup({prepareOwnerEngineering:async c=>{
   const value=issue(c),scope=value.assessment_input.current.scope;
   if(field==='input_revision')scope.input_revision++;
   else if(field==='period')scope.period={from:'2026-07-01',to:'2026-07-31'};
   else if(field==='order_origin')scope.order_origin='saved_order';
   else scope[field]=field.endsWith('sha256')?'0'.repeat(64):'foreign';
   return value;
  }});
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('OWNER_ENGINEERING_CANONICAL_SCOPE_MISMATCH');
  expect(f.h.executor.counters.execute_calls).toBe(0);expect(f.reportBuilder.counters.build_calls).toBe(0);expect(f.h.review.counters.registrations).toBe(0);
 });
 it('does not equate the canonical facts hash with the journal input hash',async()=>{
  const f=setup({prepareOwnerEngineering:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command);
  const current=bundle.owner_engineering!.input.assessment_input.current.scope;
  expect(current.input_sha256).not.toBe(current.facts_sha256);expect(bundle.owner_engineering?.result.findings).toHaveLength(3);
  expect(current.input_revision).toBe(79);expect(bundle.case_revision).toBe(11);expect(bundle.owner_engineering?.binding.engine_case_revision).toBe(11);
 });
 it('requires a verified source-journal binding rather than taking the server hook claim alone',async()=>{
  const f=setup({prepareOwnerEngineering:async c=>issue(c)}),{source_journal,...withoutJournal}=f.stored;void source_journal;
  f.h.snapshots.add(withoutJournal);await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('OWNER_ENGINEERING_SOURCE_JOURNAL_REQUIRED');
  expect(f.reportBuilder.counters.build_calls).toBe(0);
 });
 it('awaits a failed authority loader and leaves no report or qualified result',async()=>{
  const f=setup({prepareOwnerEngineering:async()=>{throw Error('TEST_CURRENT_AUTHORITY_REVOKED');}});
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('TEST_CURRENT_AUTHORITY_REVOKED');
  expect(f.reportBuilder.counters.build_calls).toBe(0);expect(f.h.repository.completedCount()).toBe(0);
 });
 it('returns exact terminal history without loading a fresh authority or regenerating a report',async()=>{
  const hook=vi.fn(async(c:CaseAnalysisOwnerEngineeringContext)=>issue(c)),f=setup({prepareOwnerEngineering:hook}),bundle=await f.service.runCaseAnalysis(f.command);
  expect(await f.service.runCaseAnalysis(f.command)).toEqual(bundle);expect(await f.service.replay(bundle.analysis_run_id)).toEqual(bundle);
  expect(hook).toHaveBeenCalledOnce();expect(f.reportBuilder.counters.build_calls).toBe(1);
 });
 it('resumes after persisted results using exact saved evaluation inputs',async()=>{
  const hook=vi.fn(async(c:CaseAnalysisOwnerEngineeringContext)=>c.previous_owner_engineering
   ?{assessment_input:c.previous_owner_engineering.input.assessment_input,trusted_generator_pins:c.previous_owner_engineering.input.trusted_generator_pins}:issue(c));
  const f=setup({prepareOwnerEngineering:hook});f.h.repository.setFailureAfter('topic_results');
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow();const bundle=await f.service.runCaseAnalysis(f.command);
  expect(hook).toHaveBeenCalledTimes(2);expect(hook.mock.calls[1][0].previous_owner_engineering).not.toBeNull();
  expect(bundle.owner_engineering?.result.findings).toHaveLength(3);expect(f.h.repository.runCount()).toBe(1);
 });
 it('refuses silently removing authority on a nonterminal resume',async()=>{
  const f=setup({prepareOwnerEngineering:async c=>c.previous_owner_engineering?null:issue(c)});f.h.repository.setFailureAfter('topic_results');
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow();
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('OWNER_ENGINEERING_RESUME_AUTHORITY_REQUIRED');
  expect(f.h.repository.completedCount()).toBe(0);
 });
 it('rejects a resealed forged expected amount through persisted independent replay',async()=>{
  const f=setup({prepareOwnerEngineering:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command),envelope=bundle.owner_engineering!;
  const target=envelope.result.checks[0].expected;if(target?.kind!=='money')throw Error('TEST_MONEY_REQUIRED');
  const {sha256,...result}=envelope.result;void sha256;
  const forged={...result,checks:[{...result.checks[0],expected:{...target,minor_units:target.minor_units+1}},...result.checks.slice(1)]};
  const {sha256:old,...body}=envelope;void old;const changed={...body,result:{...forged,sha256:canonicalSha256(forged)}};
  const copy={...bundle,owner_engineering:{...changed,sha256:canonicalSha256(changed)}};
  expect(()=>replayCaseAnalysisOwnerEngineering(copy.owner_engineering)).toThrow('OWNER_ENGINEERING_REPLAY_MISMATCH');
  expect(()=>decodeBundle(resealBundle(copy))).toThrow('ANALYSIS_ROW_MALFORMED');
 });
 it.each(['facts_snapshot_sha256','analysis_run_id','case_id','case_revision'] as const)('rejects a valid envelope transplanted into another bundle %s',async field=>{
  const f=setup({prepareOwnerEngineering:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command);
  const copy={...bundle,[field]:field==='case_revision'?bundle.case_revision+1:field==='facts_snapshot_sha256'?'0'.repeat(64):'foreign'};
  expect(()=>decodeBundle(resealBundle(copy))).toThrow('ANALYSIS_ROW_MALFORMED');
 });
});
