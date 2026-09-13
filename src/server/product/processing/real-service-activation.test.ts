import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import {realServiceActivationPlanSchema,assertRealServiceActivationContext,REAL_SERVICE_ACTIVATION_REFUSALS} from './real-service-activation-contract';
import {prepareRealServiceActivationEnrollment} from './real-service-activation';
vi.mock('server-only',()=>({}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(n:string)=>n.repeat(64);
function fixture(){
 const body={schema_version:'tivdoc-real-service-activation-plan-v1',plan_id:id(1),revision:1,state:'active',purpose:'real_customer_service',namespace:'real',
  configuration_sha256:sha('a'),service_decision_sha256:sha('b'),build_manifest_sha256:getCompiledAiReleaseBuild().manifest.sha256,population:'synthetic_population',
  environment:'test',database_name:'synthetic_database',target_id:'synthetic-target',deployment_sha256:sha('c'),period:{from:'2026-05',to:'2026-07'},topics:['minimum_wage','contract'],
  purchase:{offer_version:'tivdoc-order-offer-v3',purchase_topics_version:'tivdoc-purchase-topics-v2',terms_versions:['synthetic-v3']},
  machine_issuer_sha256:sha('d'),provider_budget_policy_sha256:sha('e'),activation_evidence_sha256:sha('f'),issued_at:'2026-09-13T00:00:00Z',expires_at:'2026-09-13T01:00:00Z'};
 const plan=realServiceActivationPlanSchema.parse({...body,sha256:canonicalSha256(body)});
 const selector={case_id:id(2),identity_id:id(3),source_revision:1,source_sha256:sha('0'),plan_sha256:plan.sha256};
 const row={state:'eligible',transition:'initial_enrollment',selector,plan,context_sha256:sha('1'),evaluated_at:'2026-09-13T00:30:00Z',expires_at:plan.expires_at,purchased_scope_sha256:sha('2'),
  configuration_sha256:plan.configuration_sha256,service_decision_sha256:plan.service_decision_sha256,population:plan.population,environment:plan.environment,
  database_name:plan.database_name,target_id:plan.target_id,deployment_sha256:plan.deployment_sha256,machine_issuer_sha256:plan.machine_issuer_sha256,provider_budget_policy_sha256:plan.provider_budget_policy_sha256,prior_enrollment:null as null|{event_id:string;state:string;plan_sha256:string;purchased_scope_sha256:string}};
 const receipt={state:'enrolled',selector,event_id:id(4),predecessor_event_id:null as string|null,replayed:false,context_sha256:row.context_sha256,purchased_scope_sha256:row.purchased_scope_sha256,authority_dependency_sha256:sha('3'),expires_at:row.expires_at};
 return {plan,selector,row,receipt};
}
function worker(row:unknown,receipt:unknown):PostgresTransactionContext{return {transaction_id:'synthetic-no-db',client:{query:vi.fn(async s=>({row_count:1,rows:[{value:s.name==='real_service_activation_context'?row:receipt}]}))}};}
beforeEach(()=>{vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY','synthetic-controller-capability-00000000');});
afterEach(()=>vi.unstubAllEnvs());
it('enrolls only from the authenticated context and sends identifiers plus its CAS token',async()=>{
 const f=fixture(),db=worker(f.row,f.receipt);
 expect(await prepareRealServiceActivationEnrollment(db,f.selector)).toEqual(f.receipt);
 const calls=vi.mocked(db.client.query).mock.calls.map(c=>c[0]);
 expect(calls.map(c=>c.name)).toEqual(['real_service_activation_context','real_service_activation_enroll']);
 expect(calls[1].values).toEqual([...calls[0].values,f.row.context_sha256]);
 expect(calls[1].values.some(v=>typeof v==='object')).toBe(false);
});
it('acknowledges an exact replay without authorizing another event',async()=>{
 const f=fixture();f.row.prior_enrollment={event_id:f.receipt.event_id,state:'granted',plan_sha256:f.plan.sha256,purchased_scope_sha256:f.row.purchased_scope_sha256};f.receipt.replayed=true;
 f.row.transition='replay';
 expect((await prepareRealServiceActivationEnrollment(worker(f.row,f.receipt),f.selector)).state).toBe('enrolled');
 await expect(prepareRealServiceActivationEnrollment(worker(f.row,{...f.receipt,event_id:id(5)}),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
});
it('accepts a paid full-order scope extension under the same plan with an exact predecessor',async()=>{
 const f=fixture();f.row.transition='paid_scope_extension';f.row.prior_enrollment={event_id:id(7),state:'granted',plan_sha256:f.plan.sha256,purchased_scope_sha256:sha('8')};
 f.receipt.predecessor_event_id=id(7);
 expect(await prepareRealServiceActivationEnrollment(worker(f.row,f.receipt),f.selector)).toEqual(f.receipt);
 await expect(prepareRealServiceActivationEnrollment(worker(f.row,{...f.receipt,predecessor_event_id:id(9)}),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
 await expect(prepareRealServiceActivationEnrollment(worker(f.row,{...f.receipt,event_id:id(7)}),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
});
it.each(['replay','initial_enrollment'])('refuses changed purchased scope disguised as %s',async transition=>{
 const f=fixture();f.row.transition=transition;f.row.prior_enrollment={event_id:id(7),state:'granted',plan_sha256:f.plan.sha256,purchased_scope_sha256:sha('8')};
 const db=worker(f.row,f.receipt);await expect(prepareRealServiceActivationEnrollment(db,f.selector)).rejects.toThrow('REAL_ACTIVATION_SCOPE_TRANSITION');expect(db.client.query).toHaveBeenCalledTimes(1);
});
it.each(REAL_SERVICE_ACTIVATION_REFUSALS)('returns %s without attempting an enrollment write',async reason=>{
 const f=fixture(),db=worker({state:'unavailable',reason},f.receipt);
 expect(await prepareRealServiceActivationEnrollment(db,f.selector)).toEqual({state:'unavailable',reason});expect(db.client.query).toHaveBeenCalledTimes(1);
});
it('returns a revocation observed at the atomic write instead of promoting preflight',async()=>{
 const f=fixture();expect(await prepareRealServiceActivationEnrollment(worker(f.row,{state:'unavailable',reason:'revoked'}),f.selector)).toEqual({state:'unavailable',reason:'revoked'});
});
it.each(['revoked','scope_changed'] as const)('refuses resurrection or adoption of prior %s history',async kind=>{
 const f=fixture();f.row.prior_enrollment={event_id:id(4),state:kind==='revoked'?'revoked':'granted',plan_sha256:kind==='scope_changed'?sha('9'):f.plan.sha256,purchased_scope_sha256:f.row.purchased_scope_sha256};
 const db=worker(f.row,f.receipt);await expect(prepareRealServiceActivationEnrollment(db,f.selector)).rejects.toThrow(kind==='revoked'?'REAL_ACTIVATION_NO_RESURRECTION':'REAL_ACTIVATION_EXISTING_SCOPE_CHANGED');expect(db.client.query).toHaveBeenCalledTimes(1);
});
it.each(['build','expiry','context','selector'] as const)('rejects changed %s before enrollment',kind=>{
 const f=fixture();if(kind==='expiry')f.row.evaluated_at=f.plan.expires_at;if(kind==='context')f.row.machine_issuer_sha256=sha('9');if(kind==='selector')f.row.selector={...f.selector,identity_id:id(8)};
 expect(()=>assertRealServiceActivationContext(f.row,f.selector,kind==='build'?sha('9'):getCompiledAiReleaseBuild().manifest.sha256)).toThrow();
});
it.each(['topics','hash','period','namespace'] as const)('rejects malformed plan %s without accepting a recomputed authority',kind=>{
 const f=fixture(),body:Record<string,unknown>={...f.plan};delete body.sha256;
 if(kind==='topics')body.topics=['contract','contract'];if(kind==='period')body.period={from:'2026-07',to:'2026-05'};if(kind==='namespace')body.namespace='owner_engineering';
 expect(realServiceActivationPlanSchema.safeParse({...body,sha256:kind==='hash'?sha('9'):canonicalSha256(body)}).success).toBe(false);
});
it('fails closed before DB access when disabled or capability absent',async()=>{
 const f=fixture(),db=worker(f.row,f.receipt);vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','0');await expect(prepareRealServiceActivationEnrollment(db,f.selector)).rejects.toThrow('REAL_ACTIVATION_DISABLED');
 vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY','');await expect(prepareRealServiceActivationEnrollment(db,f.selector)).rejects.toThrow('REAL_ACTIVATION_CONTROLLER_UNCONFIGURED');expect(db.client.query).not.toHaveBeenCalled();
});
it('refuses caller-supplied plan JSON and invalid DB acknowledgements',async()=>{
 const f=fixture(),db=worker(f.row,f.receipt);await expect(prepareRealServiceActivationEnrollment(db,{...f.selector,plan:f.plan} as typeof f.selector)).rejects.toThrow();expect(db.client.query).not.toHaveBeenCalled();
 await expect(prepareRealServiceActivationEnrollment(worker(f.row,{...f.receipt,purchased_scope_sha256:sha('9')}),f.selector)).rejects.toThrow('REAL_ACTIVATION_ENROLLMENT_CHANGED');
});
