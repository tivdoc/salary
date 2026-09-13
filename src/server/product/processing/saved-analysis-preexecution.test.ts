import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {createTopicRuleInputSnapshot} from '@/engine/rule-input/snapshot';
import {prepareJune2026AdmittedContext} from '@/engine/minimum-wage-june2026/admitted-context';
import {prepareJune2026AssessmentPacket} from '@/engine/minimum-wage-june2026/assessment-packet';
import {createAdmissionTestFixture,createTestAssessment,admissionTestNow} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {createIntegratedFullSystemHarness} from '@/server/engine/case-analysis/integrated-harness';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import type {SavedOrderScope} from './saved-order-scope';
import {SavedCaseSnapshot} from './saved-snapshot';
import {SavedJune2026CanonicalRuntime} from './saved-june2026-canonical';
import {readSavedJune2026Collection} from './saved-june2026-collection';
import {runSavedMonthAnalysis} from './saved-analysis';
import {loadSavedJune2026AdmittedContext,type SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';

vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async original=>({...await original<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
vi.mock('./saved-june2026-collection',async original=>({...await original<typeof import('./saved-june2026-collection')>(),readSavedJune2026Collection:vi.fn()}));
vi.mock('./saved-june2026-admitted-context',async original=>({...await original<typeof import('./saved-june2026-admitted-context')>(),loadSavedJune2026AdmittedContext:vi.fn()}));
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>vi.restoreAllMocks());

/** Real service, authority issuer, snapshot loadPinned, runtime and stage
 * repository. Only SQL rows, snapshot read and the factual loader return are
 * fixtures. They establish no DB, customer-reading or professional authority. */
function setup(month:'2026-06'|'2026-08'='2026-06'){
 const evidence=createAdmissionTestFixture(),packet=evidence.packet(),assessment=createTestAssessment(packet);
 const fixture=buildSyntheticCaseFixture({fixture_id:'june2026-admission-boundary',mode:'real'});
 expect(fixture.command.case_id).toBe(packet.current.case_id);
 const h=createIntegratedFullSystemHarness([fixture.stored]);
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:packet.current.case_id,revision:packet.current.input_revision,input_sha256:packet.current.input_sha256,mode:'draft'};
 const order:SavedOrderScope={id:packet.current.order_id,kind:'initial',from:month+'-01',to:month+'-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
 const collection={schema_version:'saved-june2026-collection-evidence-v1' as const,case_id:job.case_id,month:'2026-06' as const,evaluated_at:admissionTestNow,
  resolutions:[],customer_declarations:0,unknown:0,conflicted:0,legal_confirmation:false as const,rule_activation:false as const};
 vi.mocked(readSavedJune2026Collection).mockResolvedValue(collection);
 const snapshot=month==='2026-06'?fixture.stored:{...fixture.stored,documents:[],document_snapshot_sha256:canonicalSha256([]),extractions:[],extraction_snapshot_sha256:canonicalSha256([])};
 // Keep real loadPinned authority/mode/period/snapshot checks. A passthrough
 // loadPinned mock would hide the composition regression.
 vi.spyOn(SavedCaseSnapshot.prototype,'read').mockResolvedValue(snapshot);
 const queries:string[]=[],persisted:unknown[]=[];
 const context:PostgresTransactionContext={transaction_id:'preexecution-unit',client:{async query(query){
  queries.push(query.name);
  if(query.name==='saved_order_entitlements')return {rows:[{orders:[order],current_orders:[order]}],row_count:1};
  if(query.name==='saved_analysis_order')return {rows:[{created_at:admissionTestNow,engine_revision:1}],row_count:1};
  if(query.name==='june_test_authority')return {rows:[{authority:{assessment,assessment_sha256:canonicalSha256(assessment),evaluated_at:admissionTestNow}}],row_count:1};
  if(query.name==='june_canonical_test_save'){persisted.push(query.values);return {rows:[{}],row_count:1};}
  if(query.name==='review_source_read')return {rows:[{source:{state:'legacy'}}],row_count:1};
  if(query.name==='review_checkpoint_read')return {rows:[],row_count:0};
  if(query.name==='review_source_inventory')return {rows:[{id:evidence.checkpoint.product_document_id,version_id:evidence.checkpoint.version_id,
   document_type:'attendance',content_sha256:evidence.checkpoint.input_sha256}],row_count:1};
  if(query.name==='review_requests_stage'){
   const run=await h.repository.getByRunId(String(query.values[0])),stage=run?.stages.find(s=>s.stage==='topic_results');
   if(!stage)throw Error('TEST_PERSISTED_REVIEW_REQUIRED');return {rows:[{payload:stage.payload,payload_sha256:canonicalSha256(stage.payload)}],row_count:1};
  }
  if(query.name==='review_request_open')return {rows:[{id:'55555555-5555-4555-8555-555555555555'}],row_count:1};
  if(query.name==='review_upload_assessment_inputs'){
   const run=await h.repository.getByRunId(String(query.values[3]));if(!run?.bundle?.document_review)throw Error('TEST_PERSISTED_REVIEW_REQUIRED');
   return {rows:[{value:{review:run.bundle.document_review,current_source_pins:[],items:[]}}],row_count:1};
  }
  throw Error('UNEXPECTED_SQL:'+query.name);
 }}};
 let loaded:SavedJune2026AdmittedContext|undefined;
 const loader=vi.mocked(loadSavedJune2026AdmittedContext);
 loader.mockImplementation(async input=>{
  const saved=await h.repository.getByRunId(input.analysisRunId);
  expect(saved?.completed).toBe(false);expect(saved?.stages.map(stage=>stage.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs','analysis_run']);
  expect(saved?.command.idempotency_key).toMatch(/^june-test:/u);expect(saved?.command.document_review_sha256).toBeUndefined();
  expect(input.testAuthority?.assessment_sha256).toBe(canonicalSha256(assessment));
  loaded={schema_version:'saved-june2026-factual-context-v1',state:'context_blocked',code:'multiple_documents',case_id:job.case_id,
   analysis_run_id:input.analysisRunId,legal_activation:false,publication_allowed:false};return loaded;
 });
 // Complete typed mock return from ACTUAL persisted canonical facts and the
 // exact ordinary rule-input derivation. Unsupported facts/empty collection
 // stay blocked. Provenance is honestly unproven: this tests composition,
 // not a claim that the actual loader admits legacy provider receipts.
 async function loadedContext(runId:string):Promise<Extract<SavedJune2026AdmittedContext,{state:'context_loaded'}>>{
  const saved=await h.repository.getByRunId(runId);if(!saved)throw Error('TEST_PERSISTED_RUN_REQUIRED');
  const canonical=z.object({facts:employmentSnapshotSchema,facts_snapshot_sha256:z.string()}).parse(saved.stages.find(s=>s.stage==='canonical_facts')?.payload);
  const current={...evidence.input.current,analysis_run_id:runId},sameSaved={...evidence.input.saved,analysis_run_id:runId};
  const admitted=prepareJune2026AdmittedContext({...evidence.input,current,saved:sameSaved,canonicalStage:canonical,
   ruleInput:createTopicRuleInputSnapshot(canonical.facts,'minimum_wage'),collection});
  return {schema_version:'saved-june2026-factual-context-v1',state:'context_loaded',context:admitted,facts:canonical.facts,
   admission_assessment:prepareJune2026AssessmentPacket({context:admitted,facts:canonical.facts}),
   provenance:{kind:'unproven_legacy',providerAttempted:false,allPassesSucceeded:false,checkpointResultSha256:evidence.checkpoint.result_sha256,receipts:[]},
   persisted_stage_sha256s:Object.fromEntries(saved.stages.map(s=>[s.stage,canonicalSha256(s.payload)])),command_sha256:canonicalSha256(saved.command),
   legal_activation:false,publication_allowed:false};
 }
 return {h,job,loader,loadedContext,queries,persisted,get loaded(){return loaded;},input:{context,
  analysis:{caseAnalysis:h.repository,reports:h.review} as unknown as PostgresAnalysisRepositories,tenantId:'saved-case:'+job.case_id,job,orderId:order.id,month}};
}

describe('saved June preexecution composition',()=>{
 it('loads once before outcomes, keeps an honest unsupported-source diagnostic and replays without retrofitting',async()=>{
  const f=setup(),saved=await runSavedMonthAnalysis(f.input);
  expect(saved.stages.find(s=>s.stage==='review_pending')?.payload).toMatchObject({diagnostics:{authority:'isolated_dev_test_assumptions',comparison:null,
   admission:{schema_version:'june2026-context-blocked-v1',legal_activation:false,human_approval:false,execution_allowed:false,preflight:{state:'context_blocked',code:'multiple_documents'}}}});
  expect(saved.bundle?.topic_results[0]).toMatchObject({amount:null,trace:null,status:'blocked_missing_facts'});
  expect(saved.bundle?.document_review).toBeUndefined();expect(saved.command.document_review_sha256).toBeUndefined();
  expect(saved.command.mode).toBe('synthetic_test');expect(f.persisted).toHaveLength(1);expect(f.queries).not.toContain('review_source_read');
  expect(await runSavedMonthAnalysis(f.input)).toEqual(saved);expect(f.loader).toHaveBeenCalledOnce();expect(f.persisted).toHaveLength(1);
 });
 it('does not load June context for an unrelated purchased month',async()=>{
  const f=setup('2026-08'),saved=await runSavedMonthAnalysis(f.input);
  expect(saved.completed).toBe(true);expect(saved.command.mode).toBe('real');expect(saved.command.idempotency_key).toMatch(/^review:/u);
  expect(saved.bundle?.document_review?.coverage_gaps[0].kind).toBe('missing_source');expect(f.loader).not.toHaveBeenCalled();
  expect(vi.mocked(readSavedJune2026Collection)).not.toHaveBeenCalled();expect(f.queries).not.toContain('june_test_authority');expect(f.persisted).toEqual([]);
 });
 it('retains the exact preloaded context when all persisted pins match without authorizing calculation',async()=>{
  const f=setup();let loaded:Awaited<ReturnType<typeof f.loadedContext>>|undefined;
  const prepare=vi.spyOn(SavedJune2026CanonicalRuntime.prototype,'prepare');
  f.loader.mockImplementation(async input=>{loaded=await f.loadedContext(input.analysisRunId);return loaded;});
  const saved=await runSavedMonthAnalysis(f.input);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(loaded);expect(loaded?.context.state).toBe('factual_context_blocked');
  expect(loaded?.context.legal_gates.every(g=>g.status==='not_admitted')).toBe(true);
  expect(saved.stages.find(s=>s.stage==='review_pending')?.payload).toMatchObject({diagnostics:{comparison:null,admission:{execution_allowed:false,legal_activation:false,human_approval:false}}});
  expect(saved.bundle?.topic_results[0]).toMatchObject({amount:null,trace:null});expect(f.loader).toHaveBeenCalledOnce();
 });
 it.each(['case','run','command','facts','rule_input'] as const)('refuses loaded %s pin mismatch before later stages',async difference=>{
  const f=setup();let runId='';
  f.loader.mockImplementation(async input=>{
   runId=input.analysisRunId;const value=await f.loadedContext(runId);
   return {...value,command_sha256:difference==='command'?'f'.repeat(64):value.command_sha256,context:{...value.context,
    current:{...value.context.current,case_id:difference==='case'?'11111111-1111-4111-8111-111111111111':f.job.case_id,
     analysis_run_id:difference==='run'?'22222222-2222-4222-8222-222222222222':runId},
    facts_snapshot_sha256:difference==='facts'?'f'.repeat(64):value.context.facts_snapshot_sha256,
    rule_input:{...value.context.rule_input,snapshot_sha256:difference==='rule_input'?'f'.repeat(64):value.context.rule_input.snapshot_sha256}}};
  });
  await expect(runSavedMonthAnalysis(f.input)).rejects.toThrow('SAVED_JUNE_CONTEXT_PREEXECUTION_BINDING');
  const saved=await f.h.repository.getByRunId(runId);expect(saved?.completed).toBe(false);expect(saved?.report).toBeNull();
  expect(saved?.stages.map(s=>s.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs','analysis_run']);expect(f.persisted).toEqual([]);
 });
 it('propagates actual loader authority refusal instead of turning it into an inactive-catalog success',async()=>{
  const f=setup();f.loader.mockRejectedValue(Error('SAVED_WORKER_SCOPE_FORBIDDEN'));
  await expect(runSavedMonthAnalysis(f.input)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(f.persisted).toEqual([]);
 });
});
