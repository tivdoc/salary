import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {realServiceActivationPlanSchema} from './real-service-activation-contract';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {createRealServiceWorkerHost,connectRealServiceWorker} from './real-service-worker-host';
import type {PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
vi.mock('server-only',()=>({}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash=(c:string)=>c.repeat(64);
beforeEach(()=>vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1'));afterEach(()=>vi.unstubAllEnvs());
function fixture(){
 const caseId=id(1),identity={session_id:'synthetic-session',token_id:'synthetic-token',tenant_id:`saved-case:${caseId}`,actor_id:'synthetic-worker',reviewer_organization_id:null,rotation_counter:0};
 const target={schema_version:'real-service-worker-target-v1' as const,target_id:'synthetic-target',host:'db.example.test',port:5432,database:'synthetic_database',
  login:'tivdoc_worker_runtime',environment:'test' as const,deployment_sha256:hash('a'),machine_issuer_sha256:hash('b'),provider_budget_policy_sha256:hash('c')};
 const body={schema_version:'tivdoc-real-service-activation-plan-v1',plan_id:id(2),revision:1,state:'active',purpose:'real_customer_service',namespace:'real',
  configuration_sha256:hash('d'),service_decision_sha256:hash('e'),build_manifest_sha256:getCompiledAiReleaseBuild().manifest.sha256,population:'synthetic_population',environment:target.environment,
  database_name:target.database,target_id:target.target_id,deployment_sha256:target.deployment_sha256,period:{from:'2026-05',to:'2026-07'},topics:['minimum_wage'],
  purchase:{offer_version:'tivdoc-order-offer-v3',purchase_topics_version:'tivdoc-purchase-topics-v2',terms_versions:['synthetic-v3']},
  machine_issuer_sha256:target.machine_issuer_sha256,provider_budget_policy_sha256:target.provider_budget_policy_sha256,activation_evidence_sha256:hash('0'),
  issued_at:'2026-09-13T00:00:00Z',expires_at:'2026-09-13T01:00:00Z'};
 const plan=realServiceActivationPlanSchema.parse({...body,sha256:canonicalSha256(body)});
 const input={caseId,identity,target,buildSha:'a'.repeat(40),buildManifestSha256:plan.build_manifest_sha256,planSha256:plan.sha256};
 const scope={state:'authorized',plan,case_id:caseId,identity_id:id(3),enrollment_id:id(4),evaluated_at:'2026-09-13T00:30:00Z',expires_at:plan.expires_at,authority_dependency_sha256:hash('1')};
 const installed={tenant_id:identity.tenant_id,actor_id:identity.actor_id,runtime_role:'worker',reviewer_organization_id:null,session_rotation_counter:'0'};
 const actual={database:target.database,principal:'tivdoc_worker_runtime',tenant_id:identity.tenant_id,schema_version:'tivdoc-canonical-postgresql-v0.9.0'};
 const queries:PostgresStatement[]=[];let acquisitions=0,releases=0;const control={fail:''};
 const driver={async acquire(){acquisitions++;return {async query(q:PostgresStatement){queries.push(q);if(control.fail===q.name)throw Error('synthetic-driver-failure');
  const rows=q.name==='runtime_verified_context_install'?[installed]:q.name==='real_service_host_actual'?[actual]:q.name==='real_service_activation_worker_context'?[{value:scope}]:[];
  return {rows,row_count:rows.length};},release(){releases++;}};}};
 return {input,scope,installed,actual,queries,control,driver,counts:()=>({acquisitions,releases})};
}
it('reinstalls actual machine identity and rechecks plan pins for every transaction using one canonical client',async()=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver);
 f.input.identity={...f.input.identity,token_id:'changed-token'};f.input.target={...f.input.target,deployment_sha256:hash('9')};
 for(let n=0;n<2;n++)expect(await host(async()=>n)).toBe(n);
 expect(f.queries.filter(q=>q.name==='runtime_verified_context_install')).toHaveLength(3);
 expect(f.queries.filter(q=>q.name==='runtime_verified_context_install').every(q=>q.values[1]==='synthetic-token')).toBe(true);
 expect(f.queries.filter(q=>q.name==='real_service_activation_worker_context')).toHaveLength(3);
 expect(f.counts()).toEqual({acquisitions:3,releases:3});
});
it.each(['tenant_id','actor_id','runtime_role','session_rotation_counter'] as const)('refuses wrong installed %s before application work',async field=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver),work=vi.fn();f.installed[field]='foreign';
 await expect(host(work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();expect(f.queries.at(-1)?.name).toBe('transaction_rollback');
});
it.each(['database','principal','tenant_id','schema_version'] as const)('refuses changed actual %s',async field=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver),work=vi.fn();f.actual[field]='foreign';
 await expect(host(work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();
});
it.each(['target_id','database_name','deployment_sha256','machine_issuer_sha256','provider_budget_policy_sha256','build_manifest_sha256'] as const)('refuses a rehashed plan with changed %s',async field=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver),work=vi.fn();
 const {sha256,...body}=f.scope.plan;void sha256;body[field]=field.endsWith('sha256')?hash('9'):'foreign';f.scope.plan={...body,sha256:canonicalSha256(body)};
 await expect(host(work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();
});
it('blocks natural DB-evaluated expiry and an emergency stop before work',async()=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver),work=vi.fn();f.scope.evaluated_at=f.scope.expires_at;
 await expect(host(work)).rejects.toThrow();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');await expect(host(work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();
});
it('preserves application holds after rollback but never labels an uncertain commit successful',async()=>{
 const f=fixture(),host=await createRealServiceWorkerHost(f.input,f.driver),hold=Error('SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED');
 await expect(host(async()=>{throw hold;})).rejects.toBe(hold);f.control.fail='transaction_commit';await expect(host(async()=>42)).rejects.toThrow('POSTGRES_TRANSACTION_FAILED');
 expect(f.counts()).toEqual({acquisitions:3,releases:3});
});
it('rejects mismatched URL coordinates or disabled service before network acquisition',async()=>{
 const f=fixture();for(const connectionUrl of ['postgresql://tivdoc_worker_runtime:synthetic@foreign.test/synthetic_database',
  'postgresql://tivdoc_worker_runtime:synthetic@db.example.test/synthetic_database?sslmode=no-verify',
  'postgresql://service_role:synthetic@db.example.test/synthetic_database']){
  await expect(connectRealServiceWorker({...f.input,connectionUrl,certificateAuthority:'-----BEGIN CERTIFICATE-----synthetic'})).rejects.toThrow();
 }
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');await expect(createRealServiceWorkerHost(f.input,f.driver)).rejects.toThrow('REAL_SERVICE_WORKER_DISABLED');expect(f.counts().acquisitions).toBe(0);
});
