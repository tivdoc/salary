import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {claimSavedDraftJob,recordSavedJobFailure,runSavedDraftOnce,savedJobFailure} from './saved-job-runtime';
import type {SourceJob} from './source-dispatch';
const ports=vi.hoisted(()=>({admit:vi.fn(),orders:vi.fn(),dispatch:vi.fn(),audit:vi.fn(),run:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:ports.admit}));
vi.mock('./saved-order-scope',()=>({readSavedOrders:ports.orders}));
vi.mock('./source-dispatch',async importOriginal=>({...await importOriginal<typeof import('./source-dispatch')>(),dispatchCaseInput:ports.dispatch}));
vi.mock('./saved-job-runner',()=>({runSavedDraftJob:ports.run}));
vi.mock('@/server/platform/persistence/postgres/runtime/jobs-outbox-audit',()=>({PostgresJobsOutboxAuditRepository:class {append=ports.audit;}}));
beforeEach(()=>vi.resetAllMocks());

function setup(){
 const caseId=randomUUID(),source:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 let row={job_id:'job',tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,job_kind:'saved_case_analysis_v1',payload:source,payload_sha256:canonicalSha256(source),
  state:'queued',revision:1,fencing_token:0,attempt_count:0,max_attempts:3,lease_owner:null as string|null,lease_valid:false,due:true,cancellation_requested:false};
 const authority={principal:'tivdoc_worker_runtime',tenant_id:row.tenant_id},calls:string[]=[];
 const state={missingHead:false,missingDispatch:false,atomicRefusal:false,commits:0,dependency:null as string|null,profile:null as string|null};
 const context:PostgresTransactionContext={transaction_id:'recording',client:{async query(s){
  calls.push(s.name);
  switch(s.name){
   case 'saved_runtime_authority':return {rows:[authority],row_count:1};
   case 'saved_runtime_head':expect(s.text).toContain("d.mode='draft'");expect(s.text).toContain('d.processing_profile');return {rows:state.missingHead?[]:[{revision:1,input_sha256:source.input_sha256,authority_dependency_sha256:state.dependency,processing_profile:state.profile}],row_count:state.missingHead?0:1};
   case 'saved_runtime_clock':return {rows:[{now_ms:1788854400000}],row_count:1};
   case 'saved_runtime_dispatch':expect(s.text).toContain('authority_dependency_sha256 is not distinct from $3');expect(s.values[2]).toBe(state.dependency);expect(s.values[3]).toBe(state.profile);return {rows:state.missingDispatch?[]:[{job_id:row.job_id}],row_count:state.missingDispatch?0:1};
   case 'saved_runtime_job_lock':return {rows:[row],row_count:1};
   case 'saved_runtime_failure_case_lock':return {rows:[{id:caseId}],row_count:1};
   case 'saved_runtime_audit_time':return {rows:[{now:'2026-09-08T08:00:00Z'}],row_count:1};
   case 'saved_runtime_claim':
    expect(s.text).toContain('not cancellation_requested');expect(s.text).toContain('clock_timestamp()');
    if(state.atomicRefusal)return {rows:[],row_count:0};
    row={...row,state:'running',revision:row.revision+1,attempt_count:row.attempt_count+1,fencing_token:row.fencing_token+1,lease_owner:String(s.values[1]),lease_valid:true};
    return {rows:[{fencing_token:row.fencing_token}],row_count:1};
   case 'saved_runtime_exhausted':row={...row,state:'dead_letter',revision:row.revision+1,lease_owner:null,lease_valid:false};return {rows:[],row_count:1};
   case 'saved_runtime_failure':
    expect(s.text).toContain('lease_expires_at>clock_timestamp()');
    if(state.atomicRefusal)return {rows:[],row_count:0};
    row={...row,state:String(s.values[3]),revision:row.revision+1,lease_owner:null,lease_valid:false,due:false};return {rows:[{job_id:'job'}],row_count:1};
   default:throw new Error(`UNEXPECTED_SQL:${s.name}`);
  }
 }}};
 const transactions:SavedWorkerTransactions=async operation=>{const before=structuredClone(row);try{const value=await operation(context);state.commits++;return value;}catch(e){row=before;throw e;}};
 const input={caseId,workerId:'worker',transactions,enabled:true,providerEnabled:true,storage:{download:vi.fn()}};
 const claim=()=>transactions(c=>claimSavedDraftJob(c,{...input,leaseMs:60000}));
 const fail=(error:unknown,fence=row.fencing_token)=>transactions(c=>recordSavedJobFailure(c,{...input,jobId:'job',fencingToken:fence},error));
 return {input,claim,fail,authority,state,calls,row:()=>row};
}
describe('scoped saved job runtime',()=>{
 it('keeps the authenticated processing profile through admission, dispatch and lease retry',async()=>{
  const s=setup();s.state.profile='qualified_ai_v1';s.state.dependency='b'.repeat(64);
  const payload={...s.row().payload,authority_dependency_sha256:s.state.dependency,processing_profile:'qualified_ai_v1' as const};
  Object.assign(s.row(),{payload,payload_sha256:canonicalSha256(payload)});
  ports.admit.mockImplementation(async(_context,source)=>{expect(source).toEqual(payload);});
  expect(await s.claim()).toMatchObject({state:'claimed',fencingToken:1});
  expect((await s.claim()).state).toBe('busy');expect(s.row().attempt_count).toBe(1);
  s.row().lease_valid=false;expect(await s.claim()).toMatchObject({state:'claimed',fencingToken:2});
 });
 it('refuses a historical payload under a new profile without spending an attempt',async()=>{
  const s=setup();s.state.profile='qualified_ai_v1';const before=structuredClone(s.row());
  await expect(s.claim()).rejects.toThrow('SAVED_JOB_SCOPE');expect(s.row()).toEqual(before);expect(ports.audit).not.toHaveBeenCalled();
 });
 it('dispatches at DB time and claims only the pinned source with a new fencing token',async()=>{
  const s=setup();expect(await s.claim()).toEqual({state:'claimed',jobId:'job',fencingToken:1});
  expect(ports.dispatch.mock.calls[0][1]).toMatchObject({mode:'draft',liveEnabled:false,nowMs:1788854400000});
  expect(s.row()).toMatchObject({state:'running',attempt_count:1,lease_owner:'worker'});
  expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({reason:'saved_job_claimed',resource_revision:2}));
  expect(ports.admit.mock.calls[0][1]).not.toHaveProperty('authority_dependency_sha256');
 });
 it('claims a newly dispatched dependency job while preserving the previous successful payload',async()=>{
  const s=setup();s.row().state='succeeded';const previous=structuredClone(s.row());
  expect((await s.claim()).state).toBe('succeeded');expect(s.row()).toEqual(previous);
  s.state.dependency='b'.repeat(64);
  const payload={...s.row().payload,authority_dependency_sha256:s.state.dependency};
  Object.assign(s.row(),{job_id:'new_dependency_job',payload,payload_sha256:canonicalSha256(payload),state:'queued',revision:1,fencing_token:0,attempt_count:0});
  expect(await s.claim()).toEqual({state:'claimed',jobId:'new_dependency_job',fencingToken:1});
  expect(ports.admit.mock.calls.at(-1)?.[1]).toEqual(payload);
  expect(previous).toMatchObject({job_id:'job',state:'succeeded',attempt_count:0});expect(previous.payload).not.toHaveProperty('authority_dependency_sha256');
 });
 it('refuses a dispatch pointing at an old dependency job before another attempt or audit',async()=>{
  const s=setup();s.state.dependency='b'.repeat(64);const before=structuredClone(s.row());
  await expect(s.claim()).rejects.toThrow('SAVED_JOB_SCOPE');expect(s.row()).toEqual(before);expect(ports.audit).not.toHaveBeenCalled();
 });
 it.each(['principal','tenant'])('rejects wrong %s before reading private input',async mutation=>{
  const s=setup();if(mutation==='principal')s.authority.principal='tivdoc_web_runtime';else s.authority.tenant_id='foreign';
  await expect(s.claim()).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');expect(s.calls).toEqual(['saved_runtime_authority']);
 });
 it('does not spend another attempt on a busy job or overwrite a cancellation',async()=>{
  const s=setup();await s.claim();expect((await s.claim()).state).toBe('busy');expect(s.row().attempt_count).toBe(1);
  s.row().cancellation_requested=true;expect((await s.claim()).state).toBe('held');expect(s.row().cancellation_requested).toBe(true);
 });
 it('reclaims only an expired lease and refuses an old worker failure',async()=>{
  const s=setup();await s.claim();s.row().lease_valid=false;expect((await s.claim()).state).toBe('claimed');
  expect(s.row().fencing_token).toBe(2);await expect(s.fail(new Error('temporary'),1)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.row().state).toBe('running');
 });
 it('holds an exhausted expired job once instead of leaving an unclaimable running row',async()=>{
  const s=setup();await s.claim();s.row().lease_valid=false;s.row().attempt_count=3;
  expect(await s.claim()).toMatchObject({state:'held',reason:'attempts_exhausted'});const audits=ports.audit.mock.calls.length;
  expect((await s.claim()).state).toBe('held');expect(ports.audit).toHaveBeenCalledTimes(audits);
 });
 it('preserves a safe audit and backoff on transient failure, with read-only repeated failure',async()=>{
  const s=setup();await s.claim();const result=await s.fail(new Error('secret provider URL and customer text'));
  expect(result).toMatchObject({state:'retry_wait',reason:'saved_processing_retry',replayed:false});
  expect(ports.audit.mock.calls.at(-1)?.[0].reason).toBe('saved_processing_retry');
  const count=ports.audit.mock.calls.length;expect(await s.fail(new Error('again'))).toMatchObject({state:'retry_wait',replayed:true});
  expect(ports.audit).toHaveBeenCalledTimes(count);expect((await s.claim()).state).toBe('busy');
 });
 it('rolls the claim back if its durable audit fails',async()=>{
  const s=setup();ports.audit.mockRejectedValueOnce(new Error('AUDIT_WRITE_FAILED'));
  await expect(s.claim()).rejects.toThrow('AUDIT_WRITE_FAILED');expect(s.row()).toMatchObject({state:'queued',attempt_count:0,fencing_token:0});
 });
 it('does not mutate state or write an audit if the final atomic lease check refuses',async()=>{
  const s=setup();await s.claim();const audits=ports.audit.mock.calls.length;s.state.atomicRefusal=true;
  await expect(s.fail(new Error('temporary'))).rejects.toThrow('SAVED_JOB_FENCE');expect(s.row().state).toBe('running');expect(ports.audit).toHaveBeenCalledTimes(audits);
 });
 it.each([
  ['SAVED_EXTRACTION_OUTCOME_PENDING','dead_letter','saved_provider_outcome_unknown'],
  ['SOL_BUDGET_EXHAUSTED','dead_letter','saved_provider_budget_exhausted'],
  ['SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW','dead_letter','saved_provider_outcome_unknown'],
  ['SOL_REPLAY_REQUIRES_REVIEW','dead_letter','saved_provider_replay_review'],
  ['SOL_MANAGED_PACKAGE_EXPIRED','dead_letter','saved_provider_budget_expired'],
  ['SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED','dead_letter','saved_documents_missing'],
  ['ANALYSIS_INPUT_SUPERSEDED','cancelled','saved_source_superseded'],
  ['ANALYSIS_AUTHORITY_SUPERSEDED','cancelled','saved_authority_superseded'],
  ['SAVED_JOB_INTERRUPTED','retry_wait','saved_worker_interrupted'],
 ])('classifies %s without losing restart/reconciliation obligations',async(code,state,reason)=>{
  expect(savedJobFailure(new Error(code))).toEqual({state,reason});const s=setup();await s.claim();
  expect(await s.fail(new Error(code))).toMatchObject({state,reason});
 });
 it('moves the last failed attempt to a durable hold',async()=>{
  const s=setup();await s.claim();s.row().attempt_count=3;
  expect(await s.fail(new Error('transient'))).toMatchObject({state:'dead_letter',reason:'saved_attempts_exhausted'});
 });
 it('does no work while execution or provider configuration is disabled',async()=>{
  const s=setup();expect(await runSavedDraftOnce({...s.input,enabled:false})).toEqual({state:'disabled'});
  expect(await runSavedDraftOnce({...s.input,providerEnabled:false})).toEqual({state:'disabled'});expect(s.calls).toEqual([]);
 });
 it('composes claim, saved runner and durable failure without leaking the raw error',async()=>{
  const s=setup();ports.run.mockRejectedValueOnce(new Error('provider error containing private details'));
  expect(await runSavedDraftOnce(s.input)).toMatchObject({state:'retry_wait',reason:'saved_processing_retry',jobId:'job'});
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({jobId:'job',fencingToken:1,caseId:s.input.caseId}));
 });
 it('does not turn a lost success response into failure; validates the saved manifest on replay',async()=>{
  const s=setup();ports.run.mockImplementationOnce(async()=>{s.row().state='succeeded';throw new Error('COMMIT_RESPONSE_LOST');}).mockResolvedValueOnce({completion:{replayed:true}});
  expect(await runSavedDraftOnce(s.input)).toMatchObject({state:'succeeded',result:{completion:{replayed:true}}});
  expect(s.row().state).toBe('succeeded');expect(ports.run).toHaveBeenCalledTimes(2);
 });
});
