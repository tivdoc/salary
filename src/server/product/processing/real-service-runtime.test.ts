import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import path from 'node:path';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runConfiguredRealServiceIteration,runRealServiceRuntime,type RealServiceRuntimeConfiguration,type RealServiceRuntimeSecrets} from './real-service-runtime';
import type {RealServiceIterationInput} from './real-service-iteration';
import type {RealServiceCandidate} from './real-service-managed-case';
const ports=vi.hoisted(()=>({controller:vi.fn(),issuer:vi.fn(),host:vi.fn(),iteration:vi.fn(),storage:vi.fn(),resend:vi.fn(),admit:vi.fn(),budgetAdmit:vi.fn(),extraction:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./real-service-controller',async original=>({...await original<typeof import('./real-service-controller')>(),connectRealServiceController:ports.controller,admitRealServiceSavedReceiptsClaim:ports.admit,admitRealServiceBudgetedProviderClaim:ports.budgetAdmit}));
vi.mock('./real-service-budgeted-extractor',()=>({createRealServiceBudgetedExtraction:ports.extraction}));
vi.mock('./real-service-machine-maintenance',()=>({connectRealServiceMachineMaintenance:ports.issuer}));
vi.mock('./real-service-worker-host',()=>({connectRealServiceWorker:ports.host}));
vi.mock('./real-service-iteration',async original=>({...await original<typeof import('./real-service-iteration')>(),runRealServiceIteration:ports.iteration}));
vi.mock('@supabase/supabase-js',()=>({createClient:ports.storage}));
vi.mock('../case-access/resend-provider',()=>({resendProvider:ports.resend}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
function setup(){
 const configuration:RealServiceRuntimeConfiguration={schema_version:'real-service-runtime-v1',plan_sha256:sha('0'),build_sha:'a'.repeat(40),extraction_mode:'saved_receipts_only',storage_origin:'https://storage.example.test',notifications:null,
  target:{schema_version:'real-service-worker-target-v1',target_id:'synthetic-real',host:'db.example.test',port:5432,database:'synthetic',login:'tivdoc_worker_runtime',environment:'test',
   deployment_sha256:sha('a'),machine_issuer_sha256:sha('b'),provider_budget_policy_sha256:sha('c')}};
 const secrets:RealServiceRuntimeSecrets={workerConnectionUrl:'postgresql://synthetic-worker-private',issuerConnectionUrl:'postgresql://synthetic-issuer-private',certificateAuthority:'synthetic-private-ca',controllerCapability:'synthetic_private_capability',storageKey:'synthetic-private-storage'};
 const candidate:RealServiceCandidate={case_id:id(1),identity_id:id(2),enrollment_id:id(3),source_revision:1,source_sha256:sha('d'),authority_dependency_sha256:sha('e'),plan_sha256:configuration.plan_sha256,expires_at:'2026-09-13T00:10:00Z'};
 const response={state:'active' as const,plan_sha256:configuration.plan_sha256,issuer_sha256:configuration.target.machine_issuer_sha256,target_id:configuration.target.target_id,
  database_name:configuration.target.database,environment:configuration.target.environment,deployment_sha256:configuration.target.deployment_sha256,
  case_id:candidate.case_id,identity_id:candidate.identity_id,enrollment_id:candidate.enrollment_id,request_id:id(4),provenance_sha256:sha('1'),replayed:false,
  evaluated_at:'2026-09-13T00:00:00Z',valid_after:'2026-09-12T23:59:00Z',expires_at:candidate.expires_at,
  identity:{session_id:'synthetic-session',token_id:'synthetic-token',tenant_id:`saved-case:${candidate.case_id}`,actor_id:id(5),reviewer_organization_id:null,rotation_counter:0}};
 const controller={enrollPaidSources:vi.fn(async()=>({state:'finished',items:[]})),candidates:vi.fn(async()=>({evaluated_at:response.evaluated_at,expires_at:candidate.expires_at,candidates:[candidate]})),close:vi.fn()},
  issuer={read:vi.fn(async()=>response),maintain:vi.fn(async()=>response),close:vi.fn()},storage={download:vi.fn()},host={transactions:vi.fn(),close:vi.fn()},provider={id:'resend',send:vi.fn()};
 ports.controller.mockResolvedValue(controller);ports.issuer.mockResolvedValue(issuer);ports.storage.mockReturnValue({storage:{from:vi.fn(()=>storage)}});
 ports.resend.mockReturnValue(provider);ports.host.mockResolvedValue(host);ports.iteration.mockResolvedValue({worker:'real_service',state:'finished',items:[]});
 const input={configuration,secrets,buildSha:configuration.build_sha};
 return {input,configuration,secrets,candidate,response,controller,issuer,storage,host,provider};
}
describe('configured REAL runtime composition',()=>{
 it('connects actual adapters, reads existing issuer binding and supplies zero-spend admission to the ordinary iteration',async()=>{
  const f=setup();let binding:unknown;
  ports.iteration.mockImplementation(async(input:RealServiceIterationInput)=>{
   binding=await input.issuer.resolveProvisionedMachine(f.candidate);
   await input.connectHost({caseId:f.candidate.case_id,identity:f.response.identity,buildSha:f.configuration.build_sha,buildManifestSha256:sha('f'),planSha256:f.configuration.plan_sha256,target:f.configuration.target,
    binding:{candidate_sha256:canonicalSha256(f.candidate),identity:f.response.identity,issuer_sha256:f.response.issuer_sha256,target_id:f.response.target_id,
     plan_sha256:f.response.plan_sha256,expires_at:f.response.expires_at,binding_receipt_sha256:f.response.provenance_sha256}});
   expect(input.storage).toBe(f.storage);expect(input.admitClaim).toBe(ports.admit);expect(input.extraction).toEqual({mode:'saved_receipts_only'});
   return {worker:'real_service',state:'finished',items:[]};
  });
  const result=await runConfiguredRealServiceIteration(f.input);expect(result.state).toBe('finished');
  expect(f.issuer.read).toHaveBeenCalledWith({case_id:f.candidate.case_id,identity_id:f.candidate.identity_id,enrollment_id:f.candidate.enrollment_id,plan_sha256:f.candidate.plan_sha256});
  expect(binding).toMatchObject({candidate_sha256:canonicalSha256(f.candidate),binding_receipt_sha256:f.response.provenance_sha256,identity:f.response.identity});
  expect(ports.host).toHaveBeenCalledWith(expect.objectContaining({connectionUrl:f.secrets.workerConnectionUrl,certificateAuthority:f.secrets.certificateAuthority,identity:f.response.identity}));
  expect(f.controller.close).toHaveBeenCalledOnce();expect(f.issuer.close).toHaveBeenCalledOnce();expect(ports.resend).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('synthetic-private');
 });
 it('consumes durable paid-source enrollment before discovery without blocking existing work on an enrollment failure',async()=>{
  const f=setup();f.controller.enrollPaidSources.mockRejectedValue(Error('private enrollment error'));
  ports.iteration.mockImplementation(async()=>{expect(f.controller.enrollPaidSources).toHaveBeenCalledOnce();return {worker:'real_service',state:'finished',items:[]};});
  const result=await runConfiguredRealServiceIteration(f.input);expect(result).toMatchObject({state:'finished',enrollments:{state:'unconfirmed',error:'real_enrollment_unconfirmed'}});
  expect(ports.issuer).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain('private enrollment error');
 });
 it('performs bounded maintenance then narrows execution candidates before hashing their machine binding',async()=>{
  const f=setup();f.response.expires_at='2026-09-13T00:05:00Z';
  ports.iteration.mockImplementation(async(input:RealServiceIterationInput)=>{
   const raw=await input.controller.candidates({target:input.target,planSha256:input.planSha256,buildManifestSha256:sha('f'),limit:2});
   const batch=raw as {candidates:RealServiceCandidate[]};expect(batch.candidates).toHaveLength(1);
   const selected=batch.candidates[0];expect(selected.expires_at).toBe('2026-09-13T00:05:00.000Z');expect(f.candidate.expires_at).toBe('2026-09-13T00:10:00Z');
   expect(await input.issuer.resolveProvisionedMachine(selected)).toMatchObject({candidate_sha256:canonicalSha256(selected)});
   return {worker:'real_service',state:'finished',items:[]};
  });
  const result=await runConfiguredRealServiceIteration(f.input);expect(f.issuer.maintain).toHaveBeenCalledOnce();expect(result).toMatchObject({machines:[{case_id:f.candidate.case_id,state:'active',provenance_sha256:f.response.provenance_sha256}]});
  expect(JSON.stringify(result)).not.toContain('synthetic-session');
 });
 it.each(['case_id','identity_id','enrollment_id','database_name','deployment_sha256'] as const)('rejects issuer %s drift at composition boundary',async field=>{
  const f=setup();Object.assign(f.response,{[field]:field.endsWith('_id')?id(9):field.endsWith('sha256')?sha('9'):'foreign'});
  ports.iteration.mockImplementation(async(input:RealServiceIterationInput)=>{await input.issuer.resolveProvisionedMachine(f.candidate);throw Error('SHOULD_NOT_REACH');});
  const result=await runConfiguredRealServiceIteration(f.input);expect(result.state).toBe('unconfirmed');expect(ports.host).not.toHaveBeenCalled();expect(f.issuer.close).toHaveBeenCalledOnce();
 });
 it('retains primary failure separately when both pool cleanup operations fail',async()=>{
  const f=setup();ports.iteration.mockRejectedValue(Error('REAL_SERVICE_RUN_SCOPE'));f.issuer.close.mockRejectedValue(Error('private issuer error'));f.controller.close.mockRejectedValue(Error('private controller error'));
  expect(await runConfiguredRealServiceIteration(f.input)).toMatchObject({state:'unconfirmed',error:'real_scope_changed',cleanup:[{resource:'issuer',state:'close_unconfirmed'},{resource:'controller',state:'close_unconfirmed'}]});
 });
 it('closes the controller if issuer connection fails',async()=>{
  const f=setup();ports.issuer.mockRejectedValue(Error('synthetic-private-connection'));const result=await runConfiguredRealServiceIteration(f.input);
  expect(result.state).toBe('unconfirmed');expect(f.controller.close).toHaveBeenCalledOnce();expect(ports.iteration).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toContain('synthetic-private');
 });
 it('creates the explicit notification provider only when configured, independently of extraction mode',async()=>{
  const f=setup();f.configuration.notifications={origin:'https://reports.example.test',from:'Tivdoc <noreply@example.test>'};
  await runConfiguredRealServiceIteration({...f.input,secrets:{...f.secrets,notificationApiKey:'synthetic-api-key',notificationEncryptionKey:Buffer.alloc(32).toString('base64')}});
  expect(ports.resend).toHaveBeenCalledWith('synthetic-api-key',f.configuration.notifications.from);expect(ports.iteration).toHaveBeenCalledWith(expect.objectContaining({notifications:expect.objectContaining({provider:f.provider,maxMessages:2})}));
 });
 it('rejects provider extraction without the explicit switch and configuration before connecting anything',async()=>{
  const f=setup();const configuration={...f.configuration,extraction_mode:'budgeted_provider' as const};
  await expect(runConfiguredRealServiceIteration({...f.input,configuration})).rejects.toThrow();expect(ports.controller).not.toHaveBeenCalled();
 });
 it('binds the genuine provider factory to the case host and selects actual budgeted claim admission',async()=>{
  const f=setup(),forClaim=vi.fn();vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');
  ports.extraction.mockReturnValue({mode:'budgeted_provider',forClaim});
  const artifactDirectory=path.resolve('../release-work/synthetic-provider-artifacts');
  ports.iteration.mockImplementation(async(input:RealServiceIterationInput)=>{
   expect(ports.extraction).not.toHaveBeenCalled();expect(input.admitClaim).toBe(ports.budgetAdmit);
   if(!('forHost' in input.extraction))throw Error('HOST_FACTORY_REQUIRED');
   expect(input.extraction.forHost(f.host)).toEqual({mode:'budgeted_provider',forClaim});
   expect(ports.extraction).toHaveBeenCalledWith({transactions:f.host.transactions,apiKey:'synthetic-provider-key',artifactDirectory,signal:undefined});
   return {worker:'real_service',state:'finished',items:[]};
  });
  const result=await runConfiguredRealServiceIteration({...f.input,configuration:{...f.configuration,extraction_mode:'budgeted_provider'},
   secrets:{...f.secrets,providerApiKey:'synthetic-provider-key',providerArtifactDirectory:artifactDirectory}});
  expect(result.state).toBe('finished');expect(JSON.stringify(result)).not.toContain('synthetic-provider-key');
 });
 it.each(['missing_key','relative_directory'] as const)('refuses %s before opening a controller or reserving a claim',async missing=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_PROVIDER_ENABLED','1');
  await expect(runConfiguredRealServiceIteration({...f.input,configuration:{...f.configuration,extraction_mode:'budgeted_provider'},
   secrets:{...f.secrets,providerApiKey:missing==='missing_key'?'':'synthetic-key',providerArtifactDirectory:missing==='relative_directory'?'relative':path.resolve('../release-work/artifacts')}})).rejects.toThrow('REAL_SERVICE_RUNTIME_PROVIDER_REQUIRED');
  expect(ports.controller).not.toHaveBeenCalled();expect(ports.extraction).not.toHaveBeenCalled();
 });
 it('refuses compiled Git mismatch before effects',async()=>{
  const f=setup();await expect(runConfiguredRealServiceIteration({...f.input,buildSha:'b'.repeat(40)})).rejects.toThrow('REAL_SERVICE_RUNTIME_BUILD_CHANGED');expect(ports.controller).not.toHaveBeenCalled();
 });
 it('does nothing when disabled or cancelled before configuration',async()=>{
  const f=setup(),signal=new AbortController();signal.abort();expect((await runConfiguredRealServiceIteration({...f.input,signal:signal.signal})).state).toBe('interrupted');
  vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');expect((await runRealServiceRuntime({},'invalid')).state).toBe('disabled');expect(ports.controller).not.toHaveBeenCalled();
 });
 it('loads only dedicated private REAL configuration for a scheduler invocation',async()=>{
  const f=setup();const result=await runRealServiceRuntime({TIVDOC_REAL_AI_SERVICE_ENABLED:'1',TIVDOC_REAL_SERVICE_RUNTIME_CONFIG:JSON.stringify(f.configuration),
   TIVDOC_REAL_SERVICE_DATABASE_URL:f.secrets.workerConnectionUrl,TIVDOC_REAL_SERVICE_ISSUER_DATABASE_URL:f.secrets.issuerConnectionUrl,
   TIVDOC_REAL_SERVICE_DATABASE_CA:f.secrets.certificateAuthority,TIVDOC_REAL_SERVICE_CONTROLLER_CAPABILITY:f.secrets.controllerCapability,TIVDOC_REAL_SERVICE_STORAGE_KEY:f.secrets.storageKey},f.configuration.build_sha);
  expect(result.state).toBe('finished');expect(ports.controller).toHaveBeenCalledWith(expect.objectContaining({capability:f.secrets.controllerCapability}));
 });
});
