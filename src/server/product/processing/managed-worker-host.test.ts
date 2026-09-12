import {getCompiledAiReleaseBuild} from './ai-release-build';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {runManagedDevTick,readManagedDevStatus,readManagedDevHealth,retryManagedDevJob} from './managed-worker-host';
const ports=vi.hoisted(()=>({driver:vi.fn(),query:vi.fn(),release:vi.fn(),close:vi.fn(),host:vi.fn(),run:vi.fn(),provider:vi.fn(),storage:vi.fn(),budget:vi.fn(),budgetClose:vi.fn(),budgetSummary:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('pg',()=>({default:{Pool:vi.fn()}}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({storage:{from:ports.storage}})}));
vi.mock('@/server/platform/persistence/postgres/runtime/node-pg-driver',()=>({NodePostgresConnectionFactory:{fromConnectionUrl:ports.driver}}));
vi.mock('./saved-worker-host',()=>({createSavedWorkerHost:ports.host}));
vi.mock('./managed-worker-case',()=>({runManagedDevCase:ports.run}));
vi.mock('./live-extraction-runtime',()=>({createLiveExtractionRuntime:ports.provider}));
vi.mock('./sol-budgeted-extractor',()=>({createManagedSolBudgetedExtractor:ports.budget}));
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`}));
beforeEach(()=>vi.resetAllMocks());
function setup(){
 const env:Record<string,string|undefined>={NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:'synthetic_capability_'.repeat(3),
  TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic-password@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907',
  NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-storage',OPENAI_API_KEY:'synthetic-key',OPENAI_EXTRACTION_MODEL:'gpt-4o-mini-2024-07-18',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40)};
 const candidates=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map((id,index)=>({case_id:id,
  identity:{session_id:`synthetic.session.${index}`,token_id:`synthetic.token.${index}`,tenant_id:`saved-case:${id}`,actor_id:'synthetic.worker',reviewer_organization_id:null,rotation_counter:0}}));
 ports.driver.mockReturnValue({target:{database:'tivdoc_release_replay_20260907'},acquire:async()=>({query:ports.query,release:ports.release}),close:ports.close});
 ports.query.mockResolvedValue({rows:candidates,row_count:2});ports.provider.mockReturnValue({state:'configured',extractor:{extract:vi.fn()}});
 ports.run.mockImplementation(async({caseId})=>({caseId,state:'succeeded',jobId:'saved_job'}));ports.host.mockResolvedValue(vi.fn());
 ports.budgetSummary.mockReturnValue({contentRequests:0,generations:0});ports.budget.mockReturnValue({extractor:{extract:vi.fn()},close:ports.budgetClose,summary:ports.budgetSummary});
 return {env,candidates,onMonth:vi.fn(),tick:(signal?:AbortSignal)=>runManagedDevTick(env,'a'.repeat(40),vi.fn(),signal)};
}
describe('managed scheduler boundary',()=>{
 it('saved-receipt processing needs no spend authority and constructs neither provider nor budget wrapper',async()=>{
  const s=setup();s.env.TIVDOC_MANAGED_EXTRACTION_MODE='saved_receipts_only';s.env.TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED='false';delete s.env.OPENAI_API_KEY;delete s.env.OPENAI_EXTRACTION_MODEL;
  expect(await s.tick()).toMatchObject({state:'finished'});expect(ports.provider).not.toHaveBeenCalled();expect(ports.budget).not.toHaveBeenCalled();
  expect(ports.run.mock.calls.every(c=>c[0].receiptOnly===true&&c[0].providerEnabled===false&&c[0].extractor===undefined)).toBe(true);
 });
 it('receipt-only mode cannot be activated in a deployed environment',async()=>{
  const s=setup();s.env.TIVDOC_MANAGED_EXTRACTION_MODE='saved_receipts_only';s.env.VERCEL='1';
  await expect(s.tick()).rejects.toThrow('MANAGED_DEV_CONFIGURATION_INVALID');expect(ports.provider).not.toHaveBeenCalled();expect(ports.budget).not.toHaveBeenCalled();
 });

 it('requires the Sol package before discovery and never constructs the unbudgeted Sol runtime',async()=>{
  const s=setup();s.env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';
  expect(await s.tick()).toMatchObject({state:'blocked',code:'MANAGED_DEV_SOL_BUDGET_UNCONFIGURED',items:[]});
  expect(ports.provider).not.toHaveBeenCalled();expect(ports.budget).not.toHaveBeenCalled();expect(ports.driver).not.toHaveBeenCalled();
 });
 it('routes the configured default Sol through the budget wrapper even when no model env override exists',async()=>{
  const s=setup();delete s.env.OPENAI_EXTRACTION_MODEL;s.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE='synthetic-package.json';
  expect(await s.tick()).toMatchObject({state:'finished'});expect(ports.provider).not.toHaveBeenCalled();
  expect(ports.budget).toHaveBeenCalledWith(expect.objectContaining({OPENAI_EXTRACTION_MODEL:'gpt-5.6-sol'}),'a'.repeat(40));
 });
 it('uses only the bounded Sol extractor, reports its safe summary and releases the lock after the driver',async()=>{
  const s=setup();s.env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';s.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE='synthetic-package.json';
  const extractor={extract:vi.fn()};ports.budget.mockReturnValue({extractor,close:ports.budgetClose,summary:ports.budgetSummary});
  const result=await s.tick();expect(result).toMatchObject({state:'finished',budget:{contentRequests:0,generations:0}});
  expect(ports.provider).not.toHaveBeenCalled();expect(ports.run.mock.calls.every(c=>c[0].extractor===extractor)).toBe(true);
  expect(ports.budget).toHaveBeenCalledWith(expect.objectContaining({TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40)}),'a'.repeat(40));
  expect(ports.budgetClose).toHaveBeenCalledOnce();expect(ports.close.mock.invocationCallOrder[0]).toBeLessThan(ports.budgetClose.mock.invocationCallOrder[0]);
 });
 it.each([['SOL_BUDGET_EXHAUSTED','provider_budget_exhausted'],['SOL_MANAGED_PACKAGE_EXPIRED','provider_budget_expired'],['SOL_UNKNOWN_OUTCOME_REQUIRES_REVIEW','provider_outcome_unknown'],['secret filename and credentials','provider_budget_invalid']])('blocks %s before any DB or provider action',async(message,code)=>{
  const s=setup();s.env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';s.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE='synthetic-package.json';ports.budget.mockImplementation(()=>{throw Error(message);});
  expect(await s.tick()).toMatchObject({state:'blocked',code,items:[]});expect(ports.driver).not.toHaveBeenCalled();expect(ports.provider).not.toHaveBeenCalled();
 });
 it('keeps a retained budget lock instead of deleting it or falling back',async()=>{
  const s=setup();s.env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';s.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE='synthetic-package.json';ports.budget.mockImplementation(()=>{throw Object.assign(Error('secret/path'),{code:'EEXIST'});});
  expect(await s.tick()).toMatchObject({state:'blocked',code:'provider_budget_locked'});expect(ports.driver).not.toHaveBeenCalled();expect(ports.provider).not.toHaveBeenCalled();
 });
 it('releases a Sol budget lock even when connection-factory setup fails',async()=>{
  const s=setup();s.env.OPENAI_EXTRACTION_MODEL='gpt-5.6-sol';s.env.TIVDOC_MANAGED_SOL_PACKAGE_FILE='synthetic-package.json';ports.driver.mockImplementation(()=>{throw Error('connection unavailable');});
  await expect(s.tick()).rejects.toThrow('connection unavailable');expect(ports.budgetClose).toHaveBeenCalledOnce();expect(ports.close).not.toHaveBeenCalled();
 });
 it('does not query candidates or dispatch when the live provider is unconfigured',async()=>{
  const s=setup();ports.provider.mockReturnValue({state:'blocked',code:'LIVE_EXTRACTION_PROVIDER_UNCONFIGURED',provider:'openai'});
  expect(await s.tick()).toMatchObject({state:'blocked',items:[]});expect(ports.driver).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();
 });
 it('executes at most two candidates sequentially with separate exact-case identities and closes the driver',async()=>{
  const s=setup();let running=0;ports.run.mockImplementation(async({caseId})=>{expect(running).toBe(0);running++;await Promise.resolve();running--;return {caseId,state:'succeeded',jobId:'saved_job'};});
  expect((await s.tick()).items).toHaveLength(2);expect(ports.query.mock.calls[0][0].values).toEqual([s.env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY,2]);
  expect(ports.host.mock.calls.map(c=>c[0].identity)).toEqual(s.candidates.map(c=>c.identity));expect(ports.close).toHaveBeenCalledOnce();expect(ports.release).toHaveBeenCalledOnce();
 });
 it.each(['too-many','duplicate','foreign-identity','unexpected-property'])('refuses %s scheduler result before processing',async mutation=>{
  const s=setup();if(mutation==='too-many')s.candidates.push({...s.candidates[0]});
  if(mutation==='duplicate')s.candidates[1]=s.candidates[0];
  if(mutation==='foreign-identity')s.candidates[0].identity.tenant_id=s.candidates[1].identity.tenant_id;
  if(mutation==='unexpected-property')Object.assign(s.candidates[0],{source_path:'private/path'});
  await expect(s.tick()).rejects.toThrow();expect(ports.run).not.toHaveBeenCalled();expect(ports.close).toHaveBeenCalledOnce();
 });
 it('continues an independent case after one admission failure and returns no provider text',async()=>{
  const s=setup();ports.run.mockRejectedValueOnce(Error('secret raw provider response'));
  const result=await s.tick();expect(result.items).toHaveLength(2);expect(result.items[0]).toMatchObject({state:'unconfirmed',lastError:'processing_failed'});expect(JSON.stringify(result)).not.toContain('secret raw');
 });
 it('stops between cases after interruption and retains prior acknowledged output',async()=>{
  const s=setup(),controller=new AbortController();ports.run.mockImplementationOnce(async({caseId})=>{controller.abort();return {caseId,state:'succeeded',jobId:'saved_job'};});
  expect(await s.tick(controller.signal)).toMatchObject({state:'interrupted',items:[{caseId:s.candidates[0].case_id,state:'succeeded',jobId:'saved_job'}]});expect(ports.run).toHaveBeenCalledOnce();
 });
 it('reads real status timestamps without returning the scheduler capability or identity',async()=>{
  const s=setup(),now=new Date('2026-09-09T15:00:00Z');ports.query.mockResolvedValue({rows:[{case_id:s.candidates[0].case_id,state:'waiting',input_revision:1,job_id:'saved_job',job_revision:3,
   attempt_count:1,max_attempts:3,next_attempt_at:now,last_error:null,current_run_id:null,updated_at:now}],row_count:1});
  const result=await readManagedDevStatus(s.env);expect(ports.query.mock.calls[0][0].values).toEqual([s.env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY,getCompiledAiReleaseBuild().manifest.sha256]);expect(result[0].updated_at).toBe(now.toISOString());expect(JSON.stringify(result)).not.toContain('synthetic_capability');expect(ports.close).toHaveBeenCalledOnce();
 });
 it('requires a matching durable retry receipt instead of claiming an unacknowledged retry',async()=>{
  const s=setup(),input={caseId:s.candidates[0].case_id,jobId:'saved_job',expectedRevision:3};
  ports.query.mockResolvedValue({rows:[{job_id:'other_job',job_revision:4,replayed:false}],row_count:1});await expect(retryManagedDevJob(input,s.env)).rejects.toThrow();
  expect(ports.query.mock.calls[0][0].values).toEqual([s.env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY,input.caseId,input.jobId,3]);expect(ports.close).toHaveBeenCalledOnce();
 });
 it('reads scoped operational metadata without provider configuration or exposing authority documents',async()=>{
  const s=setup();delete s.env.OPENAI_API_KEY;delete s.env.SUPABASE_SERVICE_ROLE_KEY;
  const now=new Date('2026-09-11T00:30:00Z');
  ports.query.mockResolvedValue({rows:[{checked_at:now,last_activity_at:null,capability_expires_at:now,daily_claims:'2',total_claims:'3',daily_limit:8,total_limit:20,
   cases:[{case_id:s.candidates[0].case_id,pending_requests:'4',authority_state:'record_present',authority_expires_at:now}]}],row_count:1});
  expect(await readManagedDevHealth(s.env)).toMatchObject({checked_at:now.toISOString(),daily_claims:2,cases:[{pending_requests:4,authority_state:'record_present'}]});
  expect(ports.query.mock.calls[0][0].values).toEqual([s.env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY]);
  expect(ports.provider).not.toHaveBeenCalled();expect(ports.budget).not.toHaveBeenCalled();expect(ports.close).toHaveBeenCalledOnce();
 });
 it('refuses ambiguous operational health rows and closes the control connection',async()=>{
  const s=setup();ports.query.mockResolvedValue({rows:[{},{}],row_count:2});
  await expect(readManagedDevHealth(s.env)).rejects.toThrow();expect(ports.close).toHaveBeenCalledOnce();
 });
});
