import {beforeEach,describe,it,expect,vi} from 'vitest';
import {runManagedDevTick,readManagedDevStatus,retryManagedDevJob} from './managed-worker-host';
const ports=vi.hoisted(()=>({driver:vi.fn(),query:vi.fn(),release:vi.fn(),close:vi.fn(),host:vi.fn(),run:vi.fn(),provider:vi.fn(),storage:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('pg',()=>({default:{Pool:vi.fn()}}));
vi.mock('@supabase/supabase-js',()=>({createClient:()=>({storage:{from:ports.storage}})}));
vi.mock('@/server/platform/persistence/postgres/runtime/node-pg-driver',()=>({NodePostgresConnectionFactory:{fromConnectionUrl:ports.driver}}));
vi.mock('./saved-worker-host',()=>({createSavedWorkerHost:ports.host}));
vi.mock('./managed-worker-case',()=>({runManagedDevCase:ports.run}));
vi.mock('./live-extraction-runtime',()=>({createLiveExtractionRuntime:ports.provider}));
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`}));
beforeEach(()=>vi.resetAllMocks());
function setup(){
 const env={NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:'synthetic_capability_'.repeat(3),
  TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic-password@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907',
  NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-storage',OPENAI_API_KEY:'synthetic-key',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40)};
 const candidates=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map((id,index)=>({case_id:id,
  identity:{session_id:`synthetic.session.${index}`,token_id:`synthetic.token.${index}`,tenant_id:`saved-case:${id}`,actor_id:'synthetic.worker',reviewer_organization_id:null,rotation_counter:0}}));
 ports.driver.mockReturnValue({target:{database:'tivdoc_release_replay_20260907'},acquire:async()=>({query:ports.query,release:ports.release}),close:ports.close});
 ports.query.mockResolvedValue({rows:candidates,row_count:2});ports.provider.mockReturnValue({state:'configured',extractor:{extract:vi.fn()}});
 ports.run.mockImplementation(async({caseId})=>({caseId,state:'succeeded',jobId:'saved_job'}));ports.host.mockResolvedValue(vi.fn());
 return {env,candidates,onMonth:vi.fn(),tick:(signal?:AbortSignal)=>runManagedDevTick(env,'a'.repeat(40),vi.fn(),signal)};
}
describe('managed scheduler boundary',()=>{
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
  const result=await readManagedDevStatus(s.env);expect(result[0].updated_at).toBe(now.toISOString());expect(JSON.stringify(result)).not.toContain('synthetic_capability');expect(ports.close).toHaveBeenCalledOnce();
 });
 it('requires a matching durable retry receipt instead of claiming an unacknowledged retry',async()=>{
  const s=setup(),input={caseId:s.candidates[0].case_id,jobId:'saved_job',expectedRevision:3};
  ports.query.mockResolvedValue({rows:[{job_id:'other_job',job_revision:4,replayed:false}],row_count:1});await expect(retryManagedDevJob(input,s.env)).rejects.toThrow();
  expect(ports.query.mock.calls[0][0].values).toEqual([s.env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY,input.caseId,input.jobId,3]);expect(ports.close).toHaveBeenCalledOnce();
 });
});
