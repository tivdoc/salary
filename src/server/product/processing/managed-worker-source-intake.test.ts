import {beforeEach,describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {legacySourceIntakeFixture} from './saved-legacy-source-intake.fixture.ts';
import {sourceJobSchema} from './source-dispatch.ts';
import {readSavedOrders,readSavedWorkerOrderAdmission,purchasedMonths} from './saved-order-scope.ts';
import {runManagedDevCase} from './managed-worker-case.ts';
import {claimSavedDraftJob} from './saved-job-runtime.ts';
import type {SavedWorkerTransactions} from './saved-extraction-worker.ts';

const ports=vi.hoisted(()=>({owner:vi.fn(),profile:vi.fn(),admit:vi.fn(),dispatch:vi.fn(),audit:vi.fn(),failure:vi.fn(),physical:vi.fn(),extract:vi.fn(),month:vi.fn(),complete:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit,savedCaseTenant:(id:string)=>`saved-case:${id}`}));
vi.mock('./saved-owner-engineering-configuration',()=>({loadSavedOwnerEngineeringConfiguration:ports.owner}));
vi.mock('./saved-ai-release-configuration',()=>({loadSavedAiReleaseConfiguration:ports.profile}));
vi.mock('./source-dispatch',async original=>({...await original<typeof import('./source-dispatch.ts')>(),dispatchCaseInput:ports.dispatch}));
vi.mock('./saved-job-runtime',async original=>({...await original<typeof import('./saved-job-runtime.ts')>(),recordSavedJobFailure:ports.failure}));
vi.mock('@/server/platform/persistence/postgres/runtime/jobs-outbox-audit',()=>({PostgresJobsOutboxAuditRepository:class{append=ports.audit;}}));
vi.mock('./saved-source-physical-pages.ts',()=>({ensureSavedSourcePhysicalPages:ports.physical}));
vi.mock('./saved-extraction-worker',async original=>({...await original<typeof import('./saved-extraction-worker.ts')>(),runSavedWorkerExtraction:ports.extract}));
vi.mock('./saved-worker',()=>({runSavedWorkerMonth:ports.month}));
vi.mock('./saved-job-completion',()=>({completeSavedDraftJob:ports.complete}));
beforeEach(()=>vi.resetAllMocks());

function setup(){
 const f=legacySourceIntakeFixture(),journal={...structuredClone(f.journal),month:null,orders:[],answers:[] as typeof f.journal.answers,documents:[{...f.document,month:null}]};
 const intake={...f.input,journal,journalSha256:canonicalSha256(journal),currentDocuments:[{...f.document}],sourceAnchors:[f.anchor]};
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.caseId,revision:intake.revision,input_sha256:intake.inputSha256,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:'f'.repeat(64)});
 const scopeRow={database:'tivdoc_release_replay_20260907',is_qa:true,revision:job.revision,input_sha256:job.input_sha256,authority_dependency_sha256:job.authority_dependency_sha256,processing_profile:job.processing_profile,input:journal};
 const queue={job_id:'synthetic-intake-job',tenant_id:`saved-case:${f.caseId}`,canonical_case_id:f.caseId,job_kind:'saved_case_analysis_v1',payload:job,payload_sha256:canonicalSha256(job),state:'queued',revision:1,fencing_token:0,attempt_count:0,max_attempts:3,lease_owner:null as string|null,lease_valid:false,due:true,cancellation_requested:false};
 const state={currentLegacy:[f.scope] as unknown[],missingContext:false,stale:false,authority:{principal:'tivdoc_worker_runtime',tenant_id:queue.tenant_id}},queries:PostgresStatement[]=[],opened:unknown[]=[];
 const context:PostgresTransactionContext={transaction_id:'synthetic-real-intake-admission',client:{async query(q){
  queries.push(q);let rows:Record<string,unknown>[]=[];
  switch(q.name){
   case 'managed_worker_scope':rows=[scopeRow];break;
   case 'saved_order_entitlements':expect(q.values).toEqual([f.caseId,job.revision,job.input_sha256]);rows=[{orders:[],current_orders:[],legacy_orders:journal.legacy_orders,current_legacy_orders:state.currentLegacy}];break;
   case 'saved_legacy_source_intake_context':case 'saved_runner_source_intake_context':rows=[{context:state.missingContext?null:intake}];break;
   case 'saved_runtime_authority':rows=[state.authority];break;
   case 'saved_runtime_head':rows=[{revision:job.revision,input_sha256:job.input_sha256,authority_dependency_sha256:job.authority_dependency_sha256,processing_profile:job.processing_profile}];break;
   case 'saved_runtime_clock':rows=[{now_ms:1789236000000}];break;
   case 'saved_runtime_dispatch':rows=[{job_id:queue.job_id}];break;
   case 'saved_runtime_job_lock':case 'saved_runner_read':case 'saved_runner_lock':rows=[queue];break;
   case 'saved_runtime_claim':queue.state='running';queue.attempt_count++;queue.fencing_token++;queue.lease_owner=String(q.values[1]);queue.lease_valid=true;rows=[{fencing_token:queue.fencing_token}];break;
   case 'saved_runtime_audit_time':rows=[{now:'2026-09-12T18:00:00Z'}];break;
   case 'managed_worker_admit_claim':case 'managed_worker_note':break;
   case 'saved_runner_journal':rows=[{input:journal,actual_sha256:job.input_sha256}];break;
   case 'saved_runner_source_intake_open':opened.push(JSON.parse(String(q.values[3])));rows=[{id:'99999999-9999-4999-8999-999999999999'}];break;
   case 'saved_runner_source_upload_context':rows=[{contexts:[]}];break;
   case 'saved_runner_heartbeat':rows=[{job_id:queue.job_id}];break;
   default:throw Error('UNEXPECTED_SQL:'+q.name);
  }return {rows,row_count:rows.length};
 }}};
 const transactions:SavedWorkerTransactions=operation=>operation(context);
 ports.admit.mockImplementation(async(_context,source)=>{expect(source).toEqual(job);if(state.stale)throw Error('ANALYSIS_INPUT_SUPERSEDED');});
 ports.owner.mockResolvedValue({verified:true,purpose:'owner_engineering_review'});
 ports.failure.mockResolvedValue({state:'dead_letter'});
 const input={caseId:f.caseId,workerId:'synthetic-intake-worker',transactions,storage:{download:vi.fn()},extractor:undefined,providerEnabled:false,receiptOnly:true,onMonth:vi.fn()};
 const seal=()=>{intake.journalSha256=canonicalSha256(journal);};
 return {f,journal,intake,job,scopeRow,queue,state,context,queries,opened,input,seal,run:()=>runManagedDevCase(input)};
}

describe('real paid missing-period scope through managed admission and ordinary claim',()=>{
 it('keeps the original nine-topic receipt separate from executable orders and preserves the strict legacy reader',async()=>{
  const f=setup(),before=canonicalSha256(f.journal);
  await expect(readSavedOrders(f.context,f.job)).rejects.toThrow('SAVED_ORDER_SCOPE');
  const admission=await readSavedWorkerOrderAdmission(f.context,f.job);
  expect(admission.orders).toEqual([]);expect(admission.intakeScopes).toEqual([f.f.scope]);expect(admission.intakeScopes[0].topics).toHaveLength(9);
  expect(admission.intakeScopes[0]).not.toHaveProperty('from');expect(admission.intakeScopes[0].periods).toEqual([]);expect(canonicalSha256(f.journal)).toBe(before);
 });
 it.each(['source present','no documents'] as const)('claims and opens precise %s intake through the actual runner, then holds without financial work',async inventory=>{
  const f=setup();if(inventory==='no documents'){f.journal.documents=[];f.intake.currentDocuments=[];f.seal();}
  const before=canonicalSha256(f.journal);expect(await f.run()).toMatchObject({state:'dead_letter',lastError:'source_intake_required'});
  expect(f.queue.attempt_count).toBe(1);expect(ports.dispatch).toHaveBeenCalledOnce();expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({reason:'saved_job_claimed'}));
  expect(f.opened).toHaveLength(1);expect(f.opened[0]).toMatchObject({schema_version:inventory==='no documents'?'legacy-source-intake-document-v1':'document-source-period-intake-v1',month:null,order_id:f.f.scope.id});
  expect(ports.failure.mock.calls[0][2]).toMatchObject({message:'SAVED_SOURCE_INTAKE_REQUIRED',detail:{analyzedMonths:0,held:[{orderId:f.f.scope.id,month:null,code:'source_period_required'}]}});
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();expect(f.input.onMonth).not.toHaveBeenCalled();expect(canonicalSha256(f.journal)).toBe(before);
 });
 it.each(['unknown','unreadable'] as const)('retains an existing %s answer without inventing a month or repeatedly opening it',async action=>{
  const f=setup();f.journal.answers=[{...f.f.answerRow,answer:JSON.stringify({v:1,action})}];f.seal();
  expect(await f.run()).toMatchObject({state:'dead_letter',lastError:'source_intake_required'});expect(f.opened).toEqual([]);expect(ports.month).not.toHaveBeenCalled();
 });
 it('uses the real full-month reading when available while retaining the original missing purchase period',async()=>{
  const f=setup();f.journal.answers=[f.f.answerRow];f.seal();const result=await readSavedWorkerOrderAdmission(f.context,f.job);
  expect(result.intakeScopes).toEqual([]);expect(result.orders).toHaveLength(1);expect(purchasedMonths(result.orders[0])).toEqual(['2026-06']);
  expect(result.orders[0]).toMatchObject({legacy_scope:{period_state:'missing',periods:[]},source_period_evidence:{origin:'customer_document_reading',purchase_period_unchanged:true}});
 });
 it('retains an identified August source period but refuses managed financial scope before claim or provider work',async()=>{
  const f=setup();f.journal.answers=[{...f.f.answerRow,answer:JSON.stringify({...f.f.answer,value:{...f.f.answer.value,
   period:{from:'2026-08-01',to:'2026-08-31'},source_label:'Synthetic printed August 2026 payroll heading'}})}];f.seal();
  const before=canonicalSha256(f.journal),admission=await readSavedWorkerOrderAdmission(f.context,f.job);
  expect(admission.intakeScopes).toEqual([]);expect(admission.orders).toHaveLength(1);expect(purchasedMonths(admission.orders[0])).toEqual(['2026-08']);
  expect(admission.orders[0]).toMatchObject({legacy_scope:{period_state:'missing',periods:[]},source_period_evidence:{origin:'customer_document_reading',purchase_period_unchanged:true}});
  await expect(f.run()).rejects.toThrow('MANAGED_DEV_SCOPE_UNSUPPORTED');
  expect(f.queue.attempt_count).toBe(0);expect(ports.dispatch).not.toHaveBeenCalled();expect(ports.physical).not.toHaveBeenCalled();
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();expect(f.input.onMonth).not.toHaveBeenCalled();
  expect(f.queries.some(q=>q.name==='managed_worker_admit_claim')).toBe(false);expect(f.opened).toEqual([]);expect(canonicalSha256(f.journal)).toBe(before);
 });
 it.each(['revoked receipt','changed receipt','missing context','stale context','changed journal hash','foreign document','duplicate receipt'] as const)('refuses %s before claim, dispatch or source questions',async reason=>{
  const f=setup();
  if(reason==='revoked receipt')f.state.currentLegacy=[];
  if(reason==='changed receipt')f.state.currentLegacy=[{...f.f.scope,receipt_sha256:'0'.repeat(64)}];
  if(reason==='missing context')f.state.missingContext=true;
  if(reason==='stale context')f.intake.revision++;
  if(reason==='changed journal hash')f.intake.journalSha256='0'.repeat(64);
  if(reason==='foreign document')f.intake.currentDocuments[0].sha256='0'.repeat(64);
  if(reason==='duplicate receipt')f.journal.legacy_orders.push(f.f.scope);
  await expect(f.run()).rejects.toThrow();expect(f.queue.attempt_count).toBe(0);expect(ports.dispatch).not.toHaveBeenCalled();expect(f.opened).toEqual([]);
 });
 it.each(['expired configuration','no configuration','missing dependency','stale source','non-QA'] as const)('refuses %s before admitting monthless intake',async reason=>{
  const f=setup();if(reason==='expired configuration')ports.owner.mockRejectedValue(Error('OWNER_ENGINEERING_ENROLLMENT_EXPIRED'));
  if(reason==='no configuration'){ports.owner.mockResolvedValue(null);ports.profile.mockResolvedValue(null);}
  if(reason==='missing dependency'){delete f.job.authority_dependency_sha256;f.scopeRow.authority_dependency_sha256=undefined;}
  if(reason==='stale source')f.state.stale=true;if(reason==='non-QA')f.scopeRow.is_qa=false;
  await expect(f.run()).rejects.toThrow();expect(ports.dispatch).not.toHaveBeenCalled();expect(f.opened).toEqual([]);
 });
 it('direct ordinary claim also admits source intake without pretending to have an executable month',async()=>{
  const f=setup();expect(await claimSavedDraftJob(f.context,{...f.input,leaseMs:60000})).toMatchObject({state:'claimed'});expect(f.queue.attempt_count).toBe(1);expect(f.opened).toEqual([]);expect(ports.month).not.toHaveBeenCalled();
 });
 it('keeps an unqualified historical missing-period job refused',async()=>{
  const f=setup();delete f.job.processing_profile;f.scopeRow.processing_profile=undefined;
  await expect(f.run()).rejects.toThrow('SAVED_ORDER_SCOPE');expect(ports.dispatch).not.toHaveBeenCalled();expect(f.opened).toEqual([]);
 });
});
