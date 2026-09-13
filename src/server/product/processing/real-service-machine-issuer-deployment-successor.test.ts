import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {realServiceActivationPlanSchema,assertRealServiceActivationContext,REAL_SERVICE_ACTIVATION_REFUSALS} from './real-service-activation-contract';
import {prepareRealServiceDeploymentSuccessor,assertRealServiceDeploymentSuccessor} from './real-service-machine-issuer-deployment-successor';
vi.mock('server-only',()=>({}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(n:string)=>n.repeat(64);
function fixture(){
 const body={schema_version:'tivdoc-real-service-activation-plan-v1',plan_id:id(1),revision:2,state:'active',purpose:'real_customer_service',namespace:'real',
  configuration_sha256:sha('a'),service_decision_sha256:sha('b'),build_manifest_sha256:getCompiledAiReleaseBuild().manifest.sha256,population:'synthetic_population',
  environment:'test',database_name:'synthetic_database',target_id:'synthetic-target',deployment_sha256:sha('c'),period:{from:'2026-05',to:'2026-07'},topics:['minimum_wage','contract'],
  purchase:{offer_version:'tivdoc-order-offer-v3',purchase_topics_version:'tivdoc-purchase-topics-v2',terms_versions:['synthetic-v3']},
  machine_issuer_sha256:sha('d'),provider_budget_policy_sha256:sha('e'),activation_evidence_sha256:sha('f'),issued_at:'2026-09-13T00:00:00Z',expires_at:'2026-09-13T01:00:00Z'};
 const plan=realServiceActivationPlanSchema.parse({...body,sha256:canonicalSha256(body)});
 const selector={case_id:id(2),identity_id:id(3),source_revision:1,source_sha256:sha('0'),plan_sha256:plan.sha256};
 const approval={schema_version:'real-service-deployment-successor-v1',predecessor_plan_sha256:sha('9'),successor_plan_sha256:plan.sha256,
  authorization_evidence_sha256:sha('8'),issued_at:plan.issued_at,expires_at:plan.expires_at};
 const row={state:'eligible',transition:'deployment_successor',selector,plan,context_sha256:sha('1'),evaluated_at:'2026-09-13T00:30:00Z',expires_at:plan.expires_at,purchased_scope_sha256:sha('2'),
  configuration_sha256:plan.configuration_sha256,service_decision_sha256:plan.service_decision_sha256,population:plan.population,environment:plan.environment,
  database_name:plan.database_name,target_id:plan.target_id,deployment_sha256:plan.deployment_sha256,machine_issuer_sha256:plan.machine_issuer_sha256,provider_budget_policy_sha256:plan.provider_budget_policy_sha256,
  prior_enrollment:{event_id:id(4),state:'granted',plan_sha256:sha('9'),purchased_scope_sha256:sha('2')},deployment_authorization:{...approval,sha256:canonicalSha256(approval)}};
 const receipt={state:'enrolled',selector,event_id:id(5),predecessor_event_id:id(4),replayed:false,context_sha256:row.context_sha256,purchased_scope_sha256:row.purchased_scope_sha256,authority_dependency_sha256:sha('3'),expires_at:row.expires_at};
 return {plan,selector,row,receipt};
}
function worker(row:unknown,receipt:unknown):PostgresTransactionContext{return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async s=>({row_count:1,rows:[{value:s.name==='real_service_deployment_successor_context'?row:receipt}]}))}};}
beforeEach(()=>{vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY','synthetic-controller-capability-00000000');});
afterEach(()=>vi.unstubAllEnvs());
it('uses explicit authenticated successor RPCs and carries only selectors plus predecessor CAS token',async()=>{
 const f=fixture(),db=worker(f.row,f.receipt);
 expect(await prepareRealServiceDeploymentSuccessor(db,f.selector)).toEqual(f.receipt);
 const calls=vi.mocked(db.client.query).mock.calls.map(c=>c[0]);
 expect(calls.map(c=>c.name)).toEqual(['real_service_deployment_successor_context','real_service_deployment_successor_enroll']);
 expect(calls[1].values).toEqual([...calls[0].values,f.row.context_sha256]);expect(calls[1].values.some(v=>typeof v==='object')).toBe(false);
 expect(()=>assertRealServiceActivationContext(f.row,f.selector,f.plan.build_manifest_sha256)).toThrow();
});
it.each(['old-plan','new-plan','hash','future','expired'] as const)('refuses changed approval %s before enrollment',async kind=>{
 const f=fixture(),a=f.row.deployment_authorization;
 if(kind==='old-plan')a.predecessor_plan_sha256=sha('7');if(kind==='new-plan')a.successor_plan_sha256=sha('7');
 if(kind==='future')a.issued_at='2026-09-13T00:40:00Z';if(kind==='expired')a.expires_at='2026-09-13T00:20:00Z';
 const body={...a,sha256:undefined};delete body.sha256;a.sha256=kind==='hash'?sha('7'):canonicalSha256(body);
 const db=worker(f.row,f.receipt);await expect(prepareRealServiceDeploymentSuccessor(db,f.selector)).rejects.toThrow();expect(db.client.query).toHaveBeenCalledTimes(1);
});
it.each(['revoked','purchase','identity','build','target','same-plan'] as const)('refuses changed %s instead of adopting it',async kind=>{
 const f=fixture();if(kind==='revoked')f.row.prior_enrollment.state='revoked';if(kind==='purchase')f.row.prior_enrollment.purchased_scope_sha256=sha('7');
 if(kind==='identity')f.row.selector={...f.selector,identity_id:id(7)};if(kind==='target')f.row.target_id='foreign-target';
 if(kind==='same-plan')f.row.prior_enrollment.plan_sha256=f.plan.sha256;
 expect(()=>assertRealServiceDeploymentSuccessor(f.row,f.selector,kind==='build'?sha('7'):f.plan.build_manifest_sha256)).toThrow();
});
it.each(REAL_SERVICE_ACTIVATION_REFUSALS)('returns %s without any attempted write',async reason=>{
 const f=fixture(),db=worker({state:'unavailable',reason},f.receipt);expect(await prepareRealServiceDeploymentSuccessor(db,f.selector)).toEqual({state:'unavailable',reason});expect(db.client.query).toHaveBeenCalledTimes(1);
});
it('does not promote an approval revoked at the atomic write',async()=>{
 const f=fixture();expect(await prepareRealServiceDeploymentSuccessor(worker(f.row,{state:'unavailable',reason:'revoked'}),f.selector)).toEqual({state:'unavailable',reason:'revoked'});
});
it.each(['predecessor','event','scope','identity','expiry','context'] as const)('rejects changed receipt %s',async kind=>{
 const f=fixture();if(kind==='predecessor')f.receipt.predecessor_event_id=id(7);if(kind==='event')f.receipt.event_id=id(4);
 if(kind==='scope')f.receipt.purchased_scope_sha256=sha('7');if(kind==='identity')f.receipt.selector={...f.selector,identity_id:id(7)};
 if(kind==='expiry')f.receipt.expires_at='2026-09-13T02:00:00Z';if(kind==='context')f.receipt.context_sha256=sha('7');
 await expect(prepareRealServiceDeploymentSuccessor(worker(f.row,f.receipt),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
});
it('replays only the exact current event after a completed successor transition',async()=>{
 const f=fixture(),row={...f.row,deployment_authorization:undefined};delete row.deployment_authorization;row.transition='replay';row.prior_enrollment={...row.prior_enrollment,event_id:f.receipt.event_id,plan_sha256:f.plan.sha256};f.receipt.replayed=true;
 expect(await prepareRealServiceDeploymentSuccessor(worker(row,f.receipt),f.selector)).toEqual(f.receipt);
 await expect(prepareRealServiceDeploymentSuccessor(worker(row,{...f.receipt,event_id:id(7)}),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
});
it('cannot use the successor API for initial enrollment, paid extension or caller approval JSON',async()=>{
 const f=fixture(),row={...f.row,deployment_authorization:undefined};delete row.deployment_authorization;
 expect(()=>assertRealServiceDeploymentSuccessor({...row,transition:'initial_enrollment',prior_enrollment:null},f.selector,f.plan.build_manifest_sha256)).toThrow('REAL_DEPLOYMENT_SUCCESSOR_REQUIRED');
 expect(()=>assertRealServiceDeploymentSuccessor({...row,transition:'paid_scope_extension',prior_enrollment:{...row.prior_enrollment,plan_sha256:f.plan.sha256,purchased_scope_sha256:sha('7')}},f.selector,f.plan.build_manifest_sha256)).toThrow('REAL_DEPLOYMENT_SUCCESSOR_REQUIRED');
 const db=worker(f.row,f.receipt);await expect(prepareRealServiceDeploymentSuccessor(db,{...f.selector,approval:f.row.deployment_authorization} as typeof f.selector)).rejects.toThrow();expect(db.client.query).not.toHaveBeenCalled();
});
it('requires the existing service/enrollment switches and private capability before DB access',async()=>{
 const f=fixture(),db=worker(f.row,f.receipt);vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','0');await expect(prepareRealServiceDeploymentSuccessor(db,f.selector)).rejects.toThrow('REAL_ACTIVATION_DISABLED');
 vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY','');await expect(prepareRealServiceDeploymentSuccessor(db,f.selector)).rejects.toThrow('REAL_ACTIVATION_CONTROLLER_UNCONFIGURED');expect(db.client.query).not.toHaveBeenCalled();
});
