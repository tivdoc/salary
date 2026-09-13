import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedWorkerTransactions} from './saved-worker-contracts';
import {runRealServiceManagedCase,type RealServiceManagedCaseInput,type RealServiceClaimAdmissionPort} from './real-service-managed-case';
import {completeRealAiServiceMonth} from './automatic-real-service';
const ports=vi.hoisted(()=>({claim:vi.fn(),run:vi.fn(),failure:vi.fn(),admit:vi.fn(),orders:vi.fn(),profile:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-job-runtime',()=>({claimSavedDraftJob:ports.claim,recordSavedJobFailure:ports.failure}));
vi.mock('./saved-job-runner',()=>({runSavedDraftJob:ports.run}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit,savedCaseTenant:(id:string)=>`saved-case:${id}`}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
vi.mock('./saved-real-ai-service-configuration',()=>({loadSavedRealAiServiceConfiguration:ports.profile}));
vi.mock('./automatic-real-service',()=>({completeRealAiServiceMonth:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function setup(){
 const candidate={case_id:id(1),identity_id:id(2),enrollment_id:id(4),source_revision:4,source_sha256:hash('a'),authority_dependency_sha256:hash('b'),plan_sha256:hash('c'),expires_at:'2026-09-13T00:10:00Z'};
 const row={is_qa:false,revision:4,input_sha256:candidate.source_sha256,authority_dependency_sha256:candidate.authority_dependency_sha256,
  processing_profile:'qualified_ai_v1',principal:'tivdoc_worker_runtime',tenant_id:`saved-case:${candidate.case_id}`};
 const order={id:id(3),kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:hash('d'),purchase_topics_version:'tivdoc-purchase-topics-v2'};
 const profile={identity_id:candidate.identity_id,enrollment_id:candidate.enrollment_id,purpose:'real_customer_service',namespace:'real',is_qa:false,dependency_sha256:candidate.authority_dependency_sha256,
  live_evaluated_at:'2026-09-13T00:00:00Z',expires_at:candidate.expires_at};
 const admission={state:'admitted' as const,reservation_id:'synthetic-reservation',case_id:candidate.case_id,job_id:'saved_job',fencing_token:2,
  source_sha256:candidate.source_sha256,authority_dependency_sha256:candidate.authority_dependency_sha256,plan_sha256:candidate.plan_sha256,
  provider_budget_policy_sha256:hash('e'),extraction_mode:'saved_receipts_only' as 'saved_receipts_only'|'budgeted_provider',expires_at:candidate.expires_at};
 let depth=0;const trace:string[]=[],state={offer:true};
 const context:PostgresTransactionContext={transaction_id:'synthetic-real',client:{async query(q){trace.push(q.name);
  if(q.name==='real_service_managed_scope')return {row_count:1,rows:[row]};
  if(q.name==='real_service_managed_offer')return {row_count:state.offer?1:0,rows:state.offer?[{id:order.id}]:[]};throw Error(q.name);}}};
 const transactions:SavedWorkerTransactions=async operation=>{depth++;trace.push('begin');try{const result=await operation(context);trace.push('commit');return result;}
  catch(error){trace.push('rollback');throw error;}finally{depth--;}};
 const admitClaim:RealServiceClaimAdmissionPort=vi.fn(async (current:PostgresTransactionContext,request:Parameters<RealServiceClaimAdmissionPort>[1])=>{
  expect(current).toBe(context);expect(depth).toBe(1);expect(request).toMatchObject({candidate,job:{revision:4,mode:'draft'},workerId:'synthetic-worker',jobId:'saved_job',fencingToken:2});trace.push('budget');return admission;});
 ports.orders.mockResolvedValue([order]);ports.profile.mockResolvedValue(profile);
 ports.claim.mockImplementation(async()=>{expect(depth).toBe(1);trace.push('claim');return {state:'claimed',jobId:'saved_job',fencingToken:2};});
 ports.run.mockImplementation(async()=>{expect(depth).toBe(0);trace.push('run');return {completion:{sha256:hash('f')}};});
 ports.failure.mockResolvedValue({state:'retry_wait',replayed:false});
 const input:RealServiceManagedCaseInput={candidate,workerId:'synthetic-worker',transactions,storage:{download:vi.fn()},
  extraction:{mode:'saved_receipts_only'},admitClaim,providerBudgetPolicySha256:hash('e')};
 return {input,candidate,row,order,profile,admission,admitClaim,trace,context,state};
}
describe('REAL case runner on the existing durable queue',()=>{
 it('commits claim and mandatory admission together, then runs explicit receipt-only processing with the REAL completion callback',async()=>{
  const f=setup();expect(await runRealServiceManagedCase(f.input)).toMatchObject({state:'succeeded',jobId:'saved_job',manifestSha256:hash('f')});
  expect(f.trace).toEqual(['begin','real_service_managed_scope','real_service_managed_offer','claim','budget','commit','run']);
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({providerEnabled:false,receiptOnly:true,extractor:undefined,onMonth:completeRealAiServiceMonth,
   heartbeat:{intervalMs:10000,leaseMs:180000},fencingToken:2}));expect(ports.failure).not.toHaveBeenCalled();
 });
 it.each(['qa','tenant','profile','source','authority','identity','enrollment','expired','offer','legacy','empty_orders'] as const)('refuses %s before claiming a queue attempt',async mutation=>{
  const f=setup();
  if(mutation==='qa')f.row.is_qa=true;if(mutation==='tenant')f.row.tenant_id=`saved-case:${id(20)}`;
  if(mutation==='profile')f.row.processing_profile='historical';if(mutation==='source')f.row.input_sha256=hash('1');
  if(mutation==='authority')f.row.authority_dependency_sha256=hash('1');if(mutation==='identity')f.profile.identity_id=id(20);if(mutation==='enrollment')f.profile.enrollment_id=id(20);
  if(mutation==='expired')f.profile.expires_at='2026-09-12T00:00:00Z';if(mutation==='offer')f.state.offer=false;
  if(mutation==='legacy')ports.orders.mockResolvedValue([{...f.order,kind:'legacy_initial'}]);if(mutation==='empty_orders')ports.orders.mockResolvedValue([]);
  await expect(runRealServiceManagedCase(f.input)).rejects.toThrow();expect(ports.claim).not.toHaveBeenCalled();expect(f.admitClaim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it.each(['denied','foreign_case','wrong_fence','wrong_job','wrong_policy','wrong_source','wrong_mode','expired'] as const)('rolls back the claim when atomic admission is %s',async change=>{
  const f=setup();if(change==='denied')vi.mocked(f.admitClaim).mockRejectedValue(Error('REAL_SERVICE_BUDGET_EXHAUSTED'));
  if(change==='foreign_case')f.admission.case_id=id(9);if(change==='wrong_fence')f.admission.fencing_token=3;
  if(change==='wrong_job')f.admission.job_id='foreign_job';if(change==='wrong_policy')f.admission.provider_budget_policy_sha256=hash('1');
  if(change==='wrong_source')f.admission.source_sha256=hash('1');if(change==='wrong_mode')f.admission.extraction_mode='budgeted_provider';if(change==='expired')f.admission.expires_at='2026-09-12T00:00:00Z';
  await expect(runRealServiceManagedCase(f.input)).rejects.toThrow();expect(f.trace.at(-1)).toBe('rollback');expect(ports.run).not.toHaveBeenCalled();expect(ports.failure).not.toHaveBeenCalled();
 });
 it.each(['idle','busy','held','succeeded'] as const)('does not reserve new budget or rerun a %s job',async state=>{
  const f=setup();ports.claim.mockResolvedValue({state,jobId:'saved_job'});expect((await runRealServiceManagedCase(f.input)).state).toBe(state);
  expect(f.admitClaim).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it('binds a provider only after admission commits and refuses an absent extractor instead of using the default SDK',async()=>{
  const f=setup(),bind=vi.fn(async()=>{expect(f.trace.at(-1)).toBe('commit');return {extractor:undefined};});f.admission.extraction_mode='budgeted_provider';
  const extraction={mode:'budgeted_provider' as const,forClaim:bind} as unknown as RealServiceManagedCaseInput['extraction'];
  expect(await runRealServiceManagedCase({...f.input,extraction})).toMatchObject({state:'retry_wait',lastError:'budgeted_provider_unconfigured'});
  expect(bind).toHaveBeenCalledWith(f.admission);expect(ports.run).not.toHaveBeenCalled();expect(ports.failure).toHaveBeenCalledOnce();
 });
 it('rolls back a claim cancelled before admission commits and does not bind or run extraction',async()=>{
  const f=setup(),signal=new AbortController();vi.mocked(f.admitClaim).mockImplementation(async()=>{queueMicrotask(()=>signal.abort());return f.admission;});
  await expect(runRealServiceManagedCase({...f.input,signal:signal.signal})).rejects.toThrow('SAVED_JOB_INTERRUPTED');
  expect(f.trace.at(-1)).toBe('rollback');expect(ports.run).not.toHaveBeenCalled();
 });
 it('passes only the provider bound to committed admission to the existing runner',async()=>{
  const f=setup();f.admission.extraction_mode='budgeted_provider';
  const extractor={extractPreparedPass:vi.fn()},bind=vi.fn(async()=>{expect(f.trace.at(-1)).toBe('commit');return {extractor};});
  const extraction={mode:'budgeted_provider' as const,forClaim:bind} as unknown as RealServiceManagedCaseInput['extraction'];
  expect((await runRealServiceManagedCase({...f.input,extraction})).state).toBe('succeeded');
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({providerEnabled:true,receiptOnly:false,extractor,onMonth:completeRealAiServiceMonth}));
  expect(bind).toHaveBeenCalledWith(expect.objectContaining({extraction_mode:'budgeted_provider',reservation_id:f.admission.reservation_id}));
 });
 it('records an interruption after committed admission without losing the original fence',async()=>{
  const f=setup(),signal=new AbortController();f.admission.extraction_mode='budgeted_provider';
  const extraction={mode:'budgeted_provider' as const,forClaim:vi.fn(async()=>{signal.abort();return {extractor:{extractPreparedPass:vi.fn()}};})} as unknown as RealServiceManagedCaseInput['extraction'];
  expect(await runRealServiceManagedCase({...f.input,extraction,signal:signal.signal})).toMatchObject({state:'retry_wait',lastError:'worker_interrupted'});
  expect(ports.run).not.toHaveBeenCalled();expect(ports.failure).toHaveBeenCalledWith(f.context,expect.objectContaining({jobId:'saved_job',fencingToken:2}),expect.objectContaining({message:'SAVED_JOB_INTERRUPTED'}));
 });
 it('requires the atomic admission port even in receipt-only mode',async()=>{
  const f=setup();await expect(runRealServiceManagedCase({...f.input,admitClaim:undefined} as unknown as RealServiceManagedCaseInput)).rejects.toThrow('REAL_SERVICE_RUN_BUDGET_REQUIRED');
  expect(f.trace).toEqual([]);expect(ports.run).not.toHaveBeenCalled();
 });
 it('preserves provider uncertainty, recording failure only through the original lease',async()=>{
  const f=setup(),error=Error('SAVED_EXTRACTION_OUTCOME_PENDING');ports.run.mockRejectedValue(error);ports.failure.mockResolvedValue({state:'dead_letter'});
  expect(await runRealServiceManagedCase(f.input)).toMatchObject({state:'dead_letter',lastError:'provider_outcome_unknown'});
  expect(ports.failure).toHaveBeenCalledWith(f.context,{caseId:f.candidate.case_id,workerId:'synthetic-worker',jobId:'saved_job',fencingToken:2},error);
  ports.failure.mockRejectedValue(Error('SAVED_JOB_FENCE'));expect(await runRealServiceManagedCase(f.input)).toMatchObject({state:'unconfirmed',lastError:'provider_outcome_unknown'});
 });
 it('keeps an already committed success when a later failure transition observes that success',async()=>{
  const f=setup();ports.run.mockRejectedValue(Error('POSTGRES_RELEASE_FAILED'));ports.failure.mockResolvedValue({state:'succeeded'});
  expect(await runRealServiceManagedCase(f.input)).toMatchObject({state:'succeeded',lastError:null});expect(ports.run).toHaveBeenCalledOnce();
 });
 it('retains deferred evidence on successful assessment without calling it resolved',async()=>{
  const f=setup(),deferredEvidence=[{versionId:id(30),code:'SAVED_EXTRACTION_OUTCOME_PENDING'}];ports.run.mockResolvedValue({completion:{sha256:hash('f')},deferredEvidence});
  expect(await runRealServiceManagedCase(f.input)).toMatchObject({state:'succeeded',deferredEvidence,lastError:'provider_outcome_unknown'});
 });
 it('is effect-free when disabled or cancelled before entry',async()=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');expect((await runRealServiceManagedCase(f.input)).state).toBe('disabled');
  vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');const signal=new AbortController();signal.abort();expect((await runRealServiceManagedCase({...f.input,signal:signal.signal})).state).toBe('interrupted');expect(f.trace).toEqual([]);
 });
});
