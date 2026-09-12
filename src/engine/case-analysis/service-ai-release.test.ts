import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {runtimeFixture} from '../ai-release-runtime/runtime.fixture.ts';
import {prepareAiReleaseRuntime} from '../ai-release-runtime/generator-manifest.ts';
import {fixture as sourceFixture} from '../entitlement-review/compose.fixture.ts';
import {CaseAnalysisService,type CaseAnalysisAiReleaseContext,type CaseAnalysisAiReleasePreparation,type CaseAnalysisServiceDependencies} from './service.ts';
import {type StoredCaseInputSnapshot,replayCaseAnalysisAiRelease} from './contracts.ts';
import {buildSyntheticCaseFixture} from './synthetic-fixtures.ts';
import {FixedClock,FixtureReportBuilder} from './fixture-ports.ts';
import {createIntegratedFullSystemHarness} from '../../server/engine/case-analysis/integrated-harness.ts';
import {decodeBundle,decodeDependencies} from '../../server/platform/persistence/postgres/analysis/validation.ts';
import type {AnalysisResultBundle} from '../wave3/contracts.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';

function setup(overrides:Partial<CaseAnalysisServiceDependencies>={}){
 const original=sourceFixture().input;
 // Ordinary canonical provenance requires a UUID, unlike the pure source fixture.
 const source=composeEntitlementReview(documentReviewInputSchema.parse(JSON.parse(JSON.stringify(original).replaceAll('synthetic.entitlement.doc','44444444-4444-4444-8444-444444444444'))));
 const base=buildSyntheticCaseFixture({fixture_id:'ai-service-source',mode:'real'}),empty=canonicalSha256([]);
 const stored:StoredCaseInputSnapshot={...base.stored,documents:[],extractions:[],document_snapshot_sha256:empty,
  extraction_snapshot_sha256:empty,declared_fact_snapshot:{...base.stored.declared_fact_snapshot,facts:[],snapshot_sha256:empty},document_review_input:source,
  source_journal:{case_id:source.case_id,input_revision:79,input_sha256:canonicalSha256({synthetic:'source journal'})}};
 const command={...base.command,case_id:source.case_id,case_revision:11,document_snapshot_sha256:empty,extraction_snapshot_sha256:empty,
  declared_fact_snapshot_sha256:empty,period:{start_date:source.period.from,end_date:source.period.to},population:'general_private_adult_21_59',
  as_of:'2026-09-12',document_review_sha256:canonicalSha256(source)};
 const h=createIntegratedFullSystemHarness([stored]),reportBuilder=new FixtureReportBuilder(h.hashes,h.ids);
 const dependencies={...h,clock:new FixedClock('2026-09-12T10:00:00Z'),reportBuilder,reportRegistration:h.review,templateVersion:'synthetic-ai-wrapper-v1',...overrides};
 return {h,command,stored,source,dependencies,reportBuilder,service:new CaseAnalysisService(dependencies)};
}
function issue(context:CaseAnalysisAiReleaseContext):CaseAnalysisAiReleasePreparation{
 // Local synthetic AI reviewer only. Production code has no issuer here.
 const i=runtimeFixture(context.document_review_input);
 i.analysis_run_id=context.analysis_run_id;
 i.assessment_input.current.scope={...i.assessment_input.current.scope,case_id:context.command.case_id,
  facts_sha256:context.facts_snapshot_sha256,input_revision:context.source_journal?.input_revision??79,
  input_sha256:context.source_journal?.input_sha256??canonicalSha256({synthetic:'source journal'}),population:context.command.population};
 i.assessment_input.assessment.scope=i.assessment_input.current.scope;
 const prepared=prepareAiReleaseRuntime({source:i.source,analysis_run_id:i.analysis_run_id,trusted_generator_pins:i.trusted_generator_pins});i.assessment_input.current.expected_generated_rules=structuredClone(prepared.expected_generated_rules);
 for(const branch of i.assessment_input.assessment.branches){
  const expected=prepared.expected_generated_rules.find(e=>e.branch_id===branch.branch_id)!;
  branch.rule_sha256=expected.rule_sha256;branch.parameter_set_sha256=expected.parameter_set_sha256;
  branch.generated_from={generator:expected.generator,source_evidence_sha256:expected.source_evidence_sha256};
 }
 const {sha256,...body}=i.assessment_input.assessment;void sha256;
 i.assessment_input.assessment.sha256=canonicalSha256(body);i.assessment_input.current.assessment_sha256=i.assessment_input.assessment.sha256;
 return {assessment_input:i.assessment_input,trusted_generator_pins:i.trusted_generator_pins};
}
const resealBundle=(bundle:AnalysisResultBundle)=>{
 const {result_sha256,...body}=bundle;void result_sha256;bundle={...bundle,result_sha256:canonicalSha256(body)};return bundle;
};

describe('ordinary analysis persists the separate AI release envelope',()=>{
 it('uses the persisted canonical facts and fixed composer/executor while legacy topic refusals remain',async()=>{
  const f=setup(),hook=vi.fn(async(context:CaseAnalysisAiReleaseContext)=>{
   const run=await f.h.repository.getByRunId(context.analysis_run_id);
   expect(run?.stages.map(s=>s.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs']);
   expect(run?.stages.find(s=>s.stage==='canonical_facts')?.payload).toEqual({facts:context.facts,facts_snapshot_sha256:context.facts_snapshot_sha256});
   expect(context.command_sha256).toBe(canonicalSha256(f.command));expect(Object.isFrozen(context)).toBe(true);
   expect(f.h.executor.counters.execute_calls).toBe(0);return issue(context);
  });
  const service=new CaseAnalysisService({...f.dependencies,prepareAiRelease:hook}),bundle=await service.runCaseAnalysis(f.command);
  expect(hook).toHaveBeenCalledOnce();expect(bundle.ai_release?.result.findings).toHaveLength(3);
  expect(bundle.ai_release?.result.checks.every(c=>c.analysis_run_id===bundle.analysis_run_id)).toBe(true);
  expect(bundle.ai_release?.result.purchased_scope.topics).toHaveLength(9);
  expect(bundle.topic_results).toHaveLength(7);expect(bundle.topic_results.every(t=>t.amount===null&&t.trace===null)).toBe(true);
  expect(bundle.known_subtotal).toBeNull();expect(bundle.coverage_complete).toBe(false);
  expect(bundle.ai_release?.result.review).toEqual(bundle.document_review);
  expect(bundle.ai_release?.input.assessment_input.current.scope.facts_sha256).toBe(bundle.facts_snapshot_sha256);
  expect(f.h.review.counters.approvals).toBe(0);expect(f.h.executor.counters.execute_calls).toBe(0);
  const run=await service.getCompletedRun(bundle.analysis_run_id);expect(run?.dependencies?.code_version).toBe('case-analysis@0.6.8');
  expect(decodeDependencies(run!.dependencies)).toEqual(run?.dependencies);expect(decodeBundle(bundle)).toEqual(bundle);
 });
 it('leaves every byte unchanged when the optional server hook returns null',async()=>{
  const a=setup(),b=setup({prepareAiRelease:async()=>null}),left=await a.service.runCaseAnalysis(a.command),right=await b.service.runCaseAnalysis(b.command);
  expect(right).toEqual(left);expect('ai_release' in right).toBe(false);
  expect((await b.service.getCompletedRun(right.analysis_run_id))?.dependencies?.code_version).toBe('case-analysis@0.6.7');
 });
 it.each(['case_id','input_revision','input_sha256','facts_sha256','population','order_id','order_origin','order_receipt_sha256','period'] as const)('rejects mismatched %s before any executor or report',async(field)=>{
  const f=setup({prepareAiRelease:async c=>{
   const value=issue(c),scope=value.assessment_input.current.scope;
   if(field==='input_revision')scope.input_revision++;
   else if(field==='period')scope.period={from:'2026-07-01',to:'2026-07-31'};
   else if(field==='order_origin')scope.order_origin='saved_order';
   else scope[field]=field.endsWith('sha256')?'0'.repeat(64):'foreign';
   return value;
  }});
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('AI_RELEASE_CANONICAL_SCOPE_MISMATCH');
  expect(f.h.executor.counters.execute_calls).toBe(0);expect(f.reportBuilder.counters.build_calls).toBe(0);expect(f.h.review.counters.registrations).toBe(0);
 });
 it('does not equate the canonical facts hash with the journal input hash',async()=>{
  const f=setup({prepareAiRelease:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command);
  const current=bundle.ai_release!.input.assessment_input.current.scope;
  expect(current.input_sha256).not.toBe(current.facts_sha256);expect(bundle.ai_release?.result.findings).toHaveLength(3);
  expect(current.input_revision).toBe(79);expect(bundle.case_revision).toBe(11);expect(bundle.ai_release?.binding.engine_case_revision).toBe(11);
 });
 it('requires a verified source-journal binding rather than taking the server hook claim alone',async()=>{
  const f=setup({prepareAiRelease:async c=>issue(c)}),{source_journal,...withoutJournal}=f.stored;void source_journal;
  f.h.snapshots.add(withoutJournal);await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('AI_RELEASE_SOURCE_JOURNAL_REQUIRED');
  expect(f.reportBuilder.counters.build_calls).toBe(0);
 });
 it('awaits a failed authority loader and leaves no report or qualified result',async()=>{
  const f=setup({prepareAiRelease:async()=>{throw Error('TEST_CURRENT_AUTHORITY_REVOKED');}});
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('TEST_CURRENT_AUTHORITY_REVOKED');
  expect(f.reportBuilder.counters.build_calls).toBe(0);expect(f.h.repository.completedCount()).toBe(0);
 });
 it('returns exact terminal history without loading a fresh authority or regenerating a report',async()=>{
  const hook=vi.fn(async(c:CaseAnalysisAiReleaseContext)=>issue(c)),f=setup({prepareAiRelease:hook}),bundle=await f.service.runCaseAnalysis(f.command);
  expect(await f.service.runCaseAnalysis(f.command)).toEqual(bundle);expect(await f.service.replay(bundle.analysis_run_id)).toEqual(bundle);
  expect(hook).toHaveBeenCalledOnce();expect(f.reportBuilder.counters.build_calls).toBe(1);
 });
 it('resumes after persisted results using exact saved evaluation inputs',async()=>{
  const hook=vi.fn(async(c:CaseAnalysisAiReleaseContext)=>c.previous_ai_release
   ?{assessment_input:c.previous_ai_release.input.assessment_input,trusted_generator_pins:c.previous_ai_release.input.trusted_generator_pins}:issue(c));
  const f=setup({prepareAiRelease:hook});f.h.repository.setFailureAfter('topic_results');
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow();const bundle=await f.service.runCaseAnalysis(f.command);
  expect(hook).toHaveBeenCalledTimes(2);expect(hook.mock.calls[1][0].previous_ai_release).not.toBeNull();
  expect(bundle.ai_release?.result.findings).toHaveLength(3);expect(f.h.repository.runCount()).toBe(1);
 });
 it('refuses silently removing authority on a nonterminal resume',async()=>{
  const f=setup({prepareAiRelease:async c=>c.previous_ai_release?null:issue(c)});f.h.repository.setFailureAfter('topic_results');
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow();
  await expect(f.service.runCaseAnalysis(f.command)).rejects.toThrow('AI_RELEASE_RESUME_AUTHORITY_REQUIRED');
  expect(f.h.repository.completedCount()).toBe(0);
 });
 it('rejects a resealed forged expected amount through persisted independent replay',async()=>{
  const f=setup({prepareAiRelease:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command),envelope=bundle.ai_release!;
  const target=envelope.result.checks[0].expected;if(target?.kind!=='money')throw Error('TEST_MONEY_REQUIRED');
  const {sha256,...result}=envelope.result;void sha256;
  const forged={...result,checks:[{...result.checks[0],expected:{...target,minor_units:target.minor_units+1}},...result.checks.slice(1)]};
  const {sha256:old,...body}=envelope;void old;const changed={...body,result:{...forged,sha256:canonicalSha256(forged)}};
  const copy={...bundle,ai_release:{...changed,sha256:canonicalSha256(changed)}};
  expect(()=>replayCaseAnalysisAiRelease(copy.ai_release)).toThrow('AI_RUNTIME_REPLAY_MISMATCH');
  expect(()=>decodeBundle(resealBundle(copy))).toThrow('ANALYSIS_ROW_MALFORMED');
 });
 it.each(['facts_snapshot_sha256','analysis_run_id','case_id','case_revision'] as const)('rejects a valid envelope transplanted into another bundle %s',async field=>{
  const f=setup({prepareAiRelease:async c=>issue(c)}),bundle=await f.service.runCaseAnalysis(f.command);
  const copy={...bundle,[field]:field==='case_revision'?bundle.case_revision+1:field==='facts_snapshot_sha256'?'0'.repeat(64):'foreign'};
  expect(()=>decodeBundle(resealBundle(copy))).toThrow('ANALYSIS_ROW_MALFORMED');
 });
});
