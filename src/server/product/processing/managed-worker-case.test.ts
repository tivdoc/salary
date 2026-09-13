import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {runManagedDevCase} from './managed-worker-case';
const ports=vi.hoisted(()=>({claim:vi.fn(),run:vi.fn(),failure:vi.fn(),admit:vi.fn(),orders:vi.fn(),profile:vi.fn(),owner:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-job-runtime',()=>({claimSavedDraftJob:ports.claim,recordSavedJobFailure:ports.failure}));
vi.mock('./saved-job-runner',()=>({runSavedDraftJob:ports.run}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit,savedCaseTenant:(id:string)=>`saved-case:${id}`}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders,readSavedWorkerOrderAdmission:async(...args:unknown[])=>({orders:await ports.orders(...args),intakeScopes:[]})}));
vi.mock('./saved-ai-release-configuration',()=>({loadSavedAiReleaseConfiguration:ports.profile}));
vi.mock('./saved-owner-engineering-configuration',()=>({loadSavedOwnerEngineeringConfiguration:ports.owner}));
beforeEach(()=>vi.resetAllMocks());
function setup(){
 const caseId='11111111-1111-4111-8111-111111111111';
 const row={database:'tivdoc_release_replay_20260907',is_qa:true,revision:1,input_sha256:'a'.repeat(64),authority_dependency_sha256:null as string|null,processing_profile:null as string|null,input:{month:'2026-06',documents:[{type:'payslip',month:'2026-06' as string|null}]}};
 const order={id:'22222222-2222-4222-8222-222222222222',kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'c'.repeat(64)};
 const state={depth:0,budgetFails:false,noteFails:false,rollbacks:0,fullAiOffer:true,foreignOffer:false},calls:{name:string;values:readonly unknown[]}[]=[];
 const transactions:SavedWorkerTransactions=async operation=>{state.depth++;try{return await operation({transaction_id:'managed-unit',client:{async query(s){
  calls.push(s);if(s.name==='managed_worker_scope')return {rows:[row],row_count:1};
  if(s.name==='managed_worker_full_ai_offer'){
   expect(s.values).toEqual([order.id,caseId,order.offer_sha256]);
   for(const predicate of ["o.case_id=$2::uuid","o.offer_sha256=$3","o.kind='full'","o.state='paid'","o.refund_state<>'refunded'","e.state='active'","o.offer->>'version'='tivdoc-order-offer-v2'","o.offer->>'service_kind'='ai_assisted'","o.offer->'human_review_required'='false'::jsonb"])expect(s.text).toContain(predicate);
   return {rows:state.fullAiOffer?[{id:state.foreignOffer?'33333333-3333-4333-8333-333333333333':order.id}]:[],row_count:state.fullAiOffer?1:0};
  }
  if(s.name==='managed_worker_admit_claim'){if(state.budgetFails)throw Error('MANAGED_DEV_BUDGET_EXHAUSTED');return {rows:[],row_count:1};}
  if(s.name==='managed_worker_note'){if(state.noteFails)throw Error('SAVED_JOB_FENCE');return {rows:[],row_count:1};}
  throw Error('UNEXPECTED_SQL');
 }}});}catch(error){state.rollbacks++;throw error;}finally{state.depth--;}};
 ports.orders.mockResolvedValue([order]);ports.claim.mockImplementation(async()=>{expect(state.depth).toBe(1);return {state:'claimed',jobId:'saved_job',fencingToken:2};});
 ports.run.mockImplementation(async()=>{expect(state.depth).toBe(0);return {completion:{sha256:'b'.repeat(64)}};});
 ports.failure.mockResolvedValue({state:'retry_wait',replayed:false});
 const input={caseId,workerId:'synthetic.worker',transactions,storage:{download:vi.fn()},extractor:undefined,providerEnabled:true,onMonth:vi.fn()};
 return {input,row,order,state,calls};
}
describe('managed worker existing-queue composition',()=>{
 it('accepts an authenticated owner purpose on the shared transport without passing it to qualified verification',async()=>{
  const s=setup();s.row.processing_profile='qualified_ai_v1';s.row.authority_dependency_sha256='d'.repeat(64);
  ports.owner.mockResolvedValue({verified:true,purpose:'owner_engineering_review'});
  ports.profile.mockRejectedValue(Error('QUALIFIED_SCHEMA_REFUSES_OWNER'));
  expect(await runManagedDevCase(s.input)).toMatchObject({state:'succeeded'});
  expect(ports.profile).not.toHaveBeenCalled();expect(ports.claim).toHaveBeenCalledTimes(1);
 });
 it.each(['OWNER_ENGINEERING_ENROLLMENT_EXPIRED','OWNER_ENGINEERING_JOB_SCOPE','OWNER_ENGINEERING_ENROLLMENT_SCOPE'])('does not fall back or claim after owner refusal %s',async code=>{
  const s=setup();s.row.processing_profile='qualified_ai_v1';s.row.authority_dependency_sha256='d'.repeat(64);
  ports.owner.mockRejectedValue(Error(code));ports.profile.mockResolvedValue({verified:true});
  await expect(runManagedDevCase(s.input)).rejects.toThrow(code);
  expect(ports.profile).not.toHaveBeenCalled();expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it('admits the separately configured multi-topic AI profile while retaining paid periods and unclassified documents',async()=>{
  const s=setup();s.row.processing_profile='qualified_ai_v1';s.row.authority_dependency_sha256='d'.repeat(64);ports.profile.mockResolvedValue({verified:true});
  s.order.kind='full';s.order.from='2026-04-01';s.order.to='2026-07-01';s.order.topics=['pension','working_time','minimum_wage'];
  s.row.input.month='2026-07';s.row.input.documents.push({type:'payslip',month:'2026-04'},{type:'contract',month:null});
  const before=structuredClone(s.order);
  expect(await runManagedDevCase(s.input)).toMatchObject({state:'succeeded'});
  expect(s.order).toEqual(before);expect(ports.profile.mock.calls[0][1]).toMatchObject({processing_profile:'qualified_ai_v1',authority_dependency_sha256:'d'.repeat(64)});
  expect(s.calls.filter(c=>c.name==='managed_worker_admit_claim')).toHaveLength(1);
 });
 it.each(['absent','expired','build','no-dependency','no-supported-month','unqualified-full'])('refuses AI %s before reserving a queue/provider attempt',async condition=>{
  const s=setup();s.row.processing_profile='qualified_ai_v1';s.row.authority_dependency_sha256='d'.repeat(64);ports.profile.mockResolvedValue({verified:true});
  if(condition==='absent')ports.profile.mockResolvedValue(null);
  if(condition==='expired')ports.profile.mockRejectedValue(Error('AI_RELEASE_ENROLLMENT_EXPIRED'));
  if(condition==='build')ports.profile.mockRejectedValue(Error('AI_CONFIGURATION_BUILD_MISMATCH'));
  if(condition==='no-dependency')s.row.authority_dependency_sha256=null;
  if(condition==='no-supported-month')s.order.from=s.order.to='2026-08-01';
  if(condition==='unqualified-full'){s.order.kind='full';s.state.fullAiOffer=false;}
  await expect(runManagedDevCase(s.input)).rejects.toThrow();expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
  expect(s.calls.some(c=>c.name==='managed_worker_admit_claim')).toBe(false);
 });
 it('reserves budget in the real claim transaction and uses the existing fenced runner',async()=>{
  const s=setup();expect(await runManagedDevCase(s.input)).toMatchObject({state:'succeeded',jobId:'saved_job'});
  expect(s.calls.map(c=>c.name)).toEqual(['managed_worker_scope','managed_worker_admit_claim','managed_worker_note']);
  expect(s.calls[1].values).toEqual([s.input.caseId,'saved_job',2]);
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({onMonth:s.input.onMonth,jobId:'saved_job',fencingToken:2,heartbeat:{intervalMs:10000,leaseMs:180000}}));
  expect(ports.admit.mock.calls[0][1]).not.toHaveProperty('authority_dependency_sha256');
 });
 it('uses the same queue for an exact paid full AI June minimum-wage scope and propagates the current dependency',async()=>{
  const s=setup();s.order.kind='full';s.row.authority_dependency_sha256='d'.repeat(64);
  expect(await runManagedDevCase(s.input)).toMatchObject({state:'succeeded',jobId:'saved_job'});
  expect(s.calls.map(c=>c.name)).toEqual(['managed_worker_scope','managed_worker_full_ai_offer','managed_worker_admit_claim','managed_worker_note']);
  expect(ports.admit.mock.calls[0][1]).toMatchObject({case_id:s.input.caseId,revision:1,input_sha256:s.row.input_sha256,authority_dependency_sha256:s.row.authority_dependency_sha256});
  expect(ports.claim).toHaveBeenCalledTimes(1);expect(ports.run).toHaveBeenCalledTimes(1);
 });
 it.each(['unqualified-offer','foreign-order'])('refuses a full order with %s before claiming or spending budget',async mutation=>{
  const s=setup();s.order.kind='full';if(mutation==='unqualified-offer')s.state.fullAiOffer=false;else s.state.foreignOffer=true;
  await expect(runManagedDevCase(s.input)).rejects.toThrow('MANAGED_DEV_SCOPE_UNSUPPORTED');
  expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();expect(s.calls.map(c=>c.name)).not.toContain('managed_worker_admit_claim');
 });
 it.each(['order-month','topic','extra-order','extra-payslip'])('keeps the full AI scope restricted for %s',async mutation=>{
  const s=setup();s.order.kind='full';
  if(mutation==='order-month')s.order.to='2026-07-01';if(mutation==='topic')s.order.topics.push('pension');
  if(mutation==='extra-order')ports.orders.mockResolvedValue([s.order,{...s.order,id:'33333333-3333-4333-8333-333333333333'}]);
  if(mutation==='extra-payslip')s.row.input.documents.push({...s.row.input.documents[0]});
  await expect(runManagedDevCase(s.input)).rejects.toThrow('MANAGED_DEV_SCOPE_UNSUPPORTED');expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it('propagates an admission dependency refusal before claim or budget',async()=>{
  const s=setup();s.row.authority_dependency_sha256='d'.repeat(64);ports.admit.mockRejectedValue(Error('ANALYSIS_AUTHORITY_SUPERSEDED'));
  await expect(runManagedDevCase(s.input)).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it('rolls back a budget-refused claim before any provider or calculation',async()=>{
  const s=setup();s.state.budgetFails=true;await expect(runManagedDevCase(s.input)).rejects.toThrow('MANAGED_DEV_BUDGET_EXHAUSTED');
  expect(s.state.rollbacks).toBe(1);expect(ports.run).not.toHaveBeenCalled();
 });
 it.each(['database','non-qa','order-month','topic','extra-order','extra-payslip'])(
  'refuses %s outside the one-topic DEV lane before a claim',async mutation=>{
   const s=setup();
   if(mutation==='database')s.row.database='postgres';if(mutation==='non-qa')s.row.is_qa=false;
   if(mutation==='order-month')s.order.from='2026-05-01';if(mutation==='topic')s.order.topics=['pension'];
   if(mutation==='extra-order')ports.orders.mockResolvedValue([s.order,{...s.order,id:'33333333-3333-4333-8333-333333333333'}]);
   if(mutation==='extra-payslip')s.row.input.documents.push({...s.row.input.documents[0]});
   await expect(runManagedDevCase(s.input)).rejects.toThrow('MANAGED_DEV_SCOPE_UNSUPPORTED');expect(ports.claim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
  });
 it.each(['succeeded','busy','held'])('does not regenerate or spend budget for an existing %s job',async state=>{
  const s=setup();ports.claim.mockResolvedValue({state,jobId:'saved_job'});expect((await runManagedDevCase(s.input)).state).toBe(state);
  expect(ports.run).not.toHaveBeenCalled();expect(s.calls).toHaveLength(1);
 });
 it('records safe failure and durable backoff together without leaking provider details',async()=>{
  const s=setup();ports.run.mockRejectedValue(Error('secret provider token and payslip text'));
  expect(await runManagedDevCase(s.input)).toMatchObject({state:'retry_wait',lastError:'processing_failed'});
  expect(s.calls.at(-1)?.values).toEqual([s.input.caseId,'saved_job',2,'processing_failed']);expect(ports.failure).toHaveBeenCalledTimes(1);
 });
 it('does not overwrite a newer lease when the failure receipt is refused',async()=>{
  const s=setup();ports.run.mockRejectedValue(Error('SAVED_JOB_FENCE'));ports.failure.mockRejectedValue(Error('SAVED_JOB_FENCE'));
  expect(await runManagedDevCase(s.input)).toMatchObject({state:'unconfirmed',lastError:'worker_lease_lost'});
  expect(s.calls.map(c=>c.name)).not.toContain('managed_worker_note');
 });
 it('does no work after graceful cancellation',async()=>{
  const s=setup(),controller=new AbortController();controller.abort();expect((await runManagedDevCase({...s.input,signal:controller.signal})).state).toBe('interrupted');
  expect(s.calls).toHaveLength(0);expect(ports.claim).not.toHaveBeenCalled();
 });
});
