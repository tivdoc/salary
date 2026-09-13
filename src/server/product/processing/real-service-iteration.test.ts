import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runRealServiceIteration,type RealServiceIterationInput,type RealServiceHostConnectInput} from './real-service-iteration';
import type {RealServiceCandidate} from './real-service-managed-case';
import type {SavedWorkerTransactions} from './saved-worker-contracts';
const ports=vi.hoisted(()=>({run:vi.fn(),notify:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./real-service-managed-case',async original=>({...await original<typeof import('./real-service-managed-case')>(),runRealServiceManagedCase:ports.run}));
vi.mock('./real-service-notification-dispatch',()=>({runRealAiServiceNotificationPass:ports.notify}));
vi.mock('./ai-release-build',()=>({getCompiledAiReleaseBuild:()=>({manifest:{sha256:'f'.repeat(64)}})}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function setup(count=1){
 const target={schema_version:'real-service-worker-target-v1' as const,target_id:'synthetic-target',host:'db.example.test',port:5432,database:'synthetic_database',
  login:'tivdoc_worker_runtime',environment:'test' as const,deployment_sha256:hash('a'),machine_issuer_sha256:hash('b'),provider_budget_policy_sha256:hash('c')};
 const candidates=Array.from({length:count},(_,index)=>({case_id:id(index+1),identity_id:id(index+10),enrollment_id:id(index+20),source_revision:1,source_sha256:hash('d'),authority_dependency_sha256:hash('e'),plan_sha256:hash('0'),expires_at:'2026-09-13T00:10:00Z'}));
 const batch={evaluated_at:'2026-09-13T00:00:00Z',expires_at:'2026-09-13T00:10:00Z',candidates},trace:string[]=[];
 const binding=(c:RealServiceCandidate)=>({candidate_sha256:canonicalSha256(c),identity:{session_id:'synthetic-session',token_id:'synthetic-token',tenant_id:`saved-case:${c.case_id}`,
  actor_id:`synthetic-worker-${c.case_id}`,reviewer_organization_id:null,rotation_counter:0},issuer_sha256:target.machine_issuer_sha256,
  target_id:target.target_id,plan_sha256:c.plan_sha256,expires_at:c.expires_at,binding_receipt_sha256:hash('1')});
 const transactions:SavedWorkerTransactions=async operation=>operation({transaction_id:'synthetic-real',client:{async query(){throw Error('UNEXPECTED_QUERY');}}});
 const close=vi.fn(async()=>{trace.push('close');});
 const input:RealServiceIterationInput={enabled:true,planSha256:hash('0'),buildSha:'a'.repeat(40),target,
  controller:{candidates:vi.fn(async()=>{trace.push('candidates');return batch;})},
  issuer:{resolveProvisionedMachine:vi.fn(async(c:RealServiceCandidate)=>{trace.push('issuer');return binding(c);})},
  connectHost:vi.fn(async(_input:RealServiceHostConnectInput)=>{void _input;trace.push('connect');return {transactions,close};}),
  storage:{download:vi.fn()},extraction:{mode:'saved_receipts_only'},admitClaim:vi.fn(async()=>undefined),
  notifications:{origin:'https://example.test',secret:'synthetic-private-encryption-key',provider:{id:'synthetic',send:vi.fn(async()=>({ok:false as const,error_code:'not_used'}))}}};
 ports.run.mockImplementation(async(candidate:{candidate:RealServiceCandidate})=>{trace.push('processing');return {caseId:candidate.candidate.case_id,state:'idle',reason:'no_draft_dispatch'};});
 ports.notify.mockImplementation(async()=>{trace.push('notification');return {state:'finished',attempts:[],deliveryConfirmed:false};});
 return {input,batch,candidates,target,binding,trace,close,transactions};
}
describe('bounded REAL service iteration',()=>{
 it('creates a separate provider adapter only after each authenticated host opens',async()=>{
  const f=setup(2),forClaim=vi.fn(),forHost=vi.fn((host:{transactions:SavedWorkerTransactions})=>{
   expect(f.trace.at(-1)).toBe('connect');expect(host.transactions).toBe(f.transactions);
   f.trace.push('extraction');return {mode:'budgeted_provider' as const,forClaim};
  });
  const result=await runRealServiceIteration({...f.input,extraction:{mode:'budgeted_provider',forHost}});
  expect(result.items).toHaveLength(2);expect(forHost).toHaveBeenCalledTimes(2);
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({extraction:{mode:'budgeted_provider',forClaim}}));
  expect(f.close).toHaveBeenCalledTimes(2);
 });
 it('fails closed on host factory failure while preserving independent notification and closing the host',async()=>{
  const f=setup(),forHost=vi.fn(()=>{throw Error('REAL_SERVICE_RUN_EXTRACTOR_REQUIRED');});
  const result=await runRealServiceIteration({...f.input,extraction:{mode:'budgeted_provider',forHost}});
  expect(result.items[0]).toMatchObject({processing:{state:'unconfirmed',lastError:'budgeted_provider_unconfigured'},notification:{state:'finished'},host:'closed'});
  expect(ports.run).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
 });
 it('resolves proven machine bindings, connects the actual host port, and keeps notification and processing phases separate',async()=>{
  const f=setup(2),result=await runRealServiceIteration(f.input);
  expect(result.state).toBe('finished');expect(result.items).toHaveLength(2);
  expect(f.trace).toEqual(['candidates','issuer','connect','processing','notification','close','issuer','connect','processing','notification','close']);
  expect(f.input.controller.candidates).toHaveBeenCalledWith({target:f.target,planSha256:hash('0'),buildManifestSha256:hash('f'),limit:2});
  expect(f.input.connectHost).toHaveBeenCalledWith(expect.objectContaining({caseId:f.candidates[0].case_id,identity:f.binding(f.candidates[0]).identity,
   binding:f.binding(f.candidates[0]),buildManifestSha256:hash('f'),planSha256:hash('0')}));
  expect(ports.run).toHaveBeenCalledWith(expect.objectContaining({transactions:f.transactions,storage:f.input.storage,admitClaim:f.input.admitClaim,extraction:{mode:'saved_receipts_only'}}));
  for(const [call] of ports.notify.mock.calls)expect(call.workerId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(result.items.every(i=>i.host==='closed'&&i.processing.state==='idle'&&i.notification.state==='finished')).toBe(true);
 });
 it.each(['foreign_tenant','wrong_issuer','wrong_candidate','wrong_plan','expired'] as const)('rejects %s issuer binding before host connection',async mutation=>{
  const f=setup(),binding=f.binding(f.candidates[0]);
  if(mutation==='foreign_tenant')binding.identity.tenant_id=`saved-case:${id(20)}`;if(mutation==='wrong_issuer')binding.issuer_sha256=hash('9');
  if(mutation==='wrong_candidate')binding.candidate_sha256=hash('9');if(mutation==='wrong_plan')binding.plan_sha256=hash('9');
  if(mutation==='expired')binding.expires_at='2026-09-12T00:00:00Z';
  vi.mocked(f.input.issuer.resolveProvisionedMachine).mockResolvedValue(binding);
  expect((await runRealServiceIteration(f.input)).items[0]).toMatchObject({processing:{state:'unconfirmed',lastError:'machine_binding_changed'},host:'not_opened'});
  expect(f.input.connectHost).not.toHaveBeenCalled();expect(ports.run).not.toHaveBeenCalled();expect(ports.notify).not.toHaveBeenCalled();
 });
 it.each(['too_many','duplicate','wrong_plan','expired_batch'] as const)('refuses %s controller output rather than truncating or inferring scope',async mutation=>{
  const f=setup(2);if(mutation==='too_many')f.batch.candidates.push({...f.candidates[0],case_id:id(30)});
  if(mutation==='duplicate')f.batch.candidates[1]=f.batch.candidates[0];if(mutation==='wrong_plan')f.batch.candidates[0].plan_sha256=hash('9');
  if(mutation==='expired_batch')f.batch.expires_at='2026-09-12T00:00:00Z';
  await expect(runRealServiceIteration(f.input)).rejects.toThrow();expect(f.input.issuer.resolveProvisionedMachine).not.toHaveBeenCalled();
 });
 it('always closes the host after processing failure and can still process independently authorized notifications',async()=>{
  const f=setup();ports.run.mockRejectedValue(Error('SAVED_EXTRACTION_OUTCOME_PENDING'));
  const result=await runRealServiceIteration(f.input);expect(result.items[0]).toMatchObject({processing:{state:'unconfirmed',lastError:'provider_outcome_unknown'},notification:{state:'finished'},host:'closed'});
  expect(f.close).toHaveBeenCalledOnce();expect(ports.run).toHaveBeenCalledOnce();
 });
 it('does not overwrite a successful analysis when the notification pass fails',async()=>{
  const f=setup();ports.run.mockResolvedValue({caseId:f.candidates[0].case_id,state:'succeeded',manifestSha256:hash('2')});ports.notify.mockRejectedValue(Error('Synthetic secret transport failure'));
  const result=await runRealServiceIteration(f.input);expect(result.items[0]).toMatchObject({processing:{state:'succeeded'},notification:{state:'unconfirmed',lastError:'notification_pass_unconfirmed'},host:'closed'});
  expect(JSON.stringify(result)).not.toContain('secret transport');
 });
 it('stops opening hosts after an unconfirmed close while preserving the processing result',async()=>{
  const f=setup(2);f.close.mockRejectedValue(Error('Synthetic private close detail'));const result=await runRealServiceIteration(f.input);
  expect(result.state).toBe('held');expect(result.items).toHaveLength(1);expect(result.items[0].host).toBe('close_unconfirmed');expect(f.input.connectHost).toHaveBeenCalledOnce();
 });
 it('closes a just-connected host on cancellation without beginning work or notification',async()=>{
  const f=setup(),signal=new AbortController();vi.mocked(f.input.connectHost).mockImplementation(async()=>{signal.abort();return {transactions:f.transactions,close:f.close};});
  const result=await runRealServiceIteration({...f.input,signal:signal.signal});expect(result.state).toBe('interrupted');expect(result.items[0].host).toBe('closed');
  expect(ports.run).not.toHaveBeenCalled();expect(ports.notify).not.toHaveBeenCalled();
 });
 it('does not resolve credentials or allocate resources when disabled',async()=>{
  const f=setup();expect((await runRealServiceIteration({...f.input,enabled:false})).state).toBe('disabled');vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');
  expect((await runRealServiceIteration(f.input)).state).toBe('disabled');expect(f.trace).toEqual([]);
 });
 it('skips notification entirely without an explicit notification port',async()=>{
  const f=setup();const result=await runRealServiceIteration({...f.input,notifications:undefined});expect(result.items[0].notification).toEqual({state:'skipped'});expect(ports.notify).not.toHaveBeenCalled();
 });
 it('captures target and port references before awaiting the controller',async()=>{
  const f=setup();vi.mocked(f.input.controller.candidates).mockImplementation(async()=>{f.target.target_id='mutated';return f.batch;});
  // A resolver that also follows mutable configuration now disagrees with the
  // pinned target. It is refused; the host cannot silently follow the mutation.
  expect((await runRealServiceIteration(f.input)).items[0].processing).toMatchObject({state:'unconfirmed',lastError:'machine_binding_changed'});
  expect(f.input.connectHost).not.toHaveBeenCalled();
 });
});
