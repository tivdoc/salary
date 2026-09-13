import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {CANONICAL_POSTGRES_SCHEMA_VERSION} from '@/server/platform/composition/canonical-postgres';
import {enrollCurrentPaidRealServiceSources} from './real-service-purchase-enrollment';
const ports=vi.hoisted(()=>({prepare:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./ai-release-build',()=>({getCompiledAiReleaseBuild:()=>({manifest:{sha256:'f'.repeat(64)}})}));
vi.mock('./real-service-activation',()=>({prepareRealServiceActivationEnrollment:ports.prepare}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY','synthetic_capability_'.repeat(3));});
afterEach(()=>vi.unstubAllEnvs());
function setup(){
 const target={schema_version:'real-service-worker-target-v1' as const,target_id:'synthetic-real',host:'db.example.test',port:5432,database:'synthetic',login:'tivdoc_worker_runtime',
  environment:'test' as const,deployment_sha256:sha('a'),machine_issuer_sha256:sha('b'),provider_budget_policy_sha256:sha('c')};
 const selector={case_id:id(1),identity_id:id(2),source_revision:7,source_sha256:sha('d'),plan_sha256:sha('e')},selectors=[selector];
 const actual={database:target.database,principal:'tivdoc_worker_runtime',schema_version:CANONICAL_POSTGRES_SCHEMA_VERSION};
 const receipt={state:'enrolled',selector,event_id:id(3),replayed:false,predecessor_event_id:null,context_sha256:sha('0'),purchased_scope_sha256:sha('1'),authority_dependency_sha256:sha('2'),expires_at:'2026-09-13T04:00:00Z'};
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async q=>{
  if(q.name==='real_service_paid_source_actual')return {row_count:1,rows:[actual]};
  if(q.name==='real_service_paid_source_selectors')return {row_count:1,rows:[{value:selectors}]};throw Error('UNEXPECTED_QUERY');});
 const context:PostgresTransactionContext={transaction_id:'synthetic-paid-source',client:{query}},input={target,planSha256:selector.plan_sha256,limit:2};
 ports.prepare.mockResolvedValue(receipt);return {target,selector,selectors,actual,receipt,query,context,input};
}
describe('durable paid purchase/source enrollment consumer',()=>{
 it('calls the existing enrollment helper in the same authenticated controller transaction with current source CAS',async()=>{
  const f=setup(),result=await enrollCurrentPaidRealServiceSources(f.context,f.input);
  expect(result).toEqual({state:'finished',items:[{case_id:f.selector.case_id,receipt:f.receipt}]});
  expect(ports.prepare).toHaveBeenCalledWith(f.context,f.selector);const [query]=f.query.mock.calls[1];
  expect(query.name).toBe('real_service_paid_source_selectors');expect(query.values.slice(0,3)).toEqual([process.env.TIVDOC_REAL_AI_ENROLLMENT_CAPABILITY,f.input.planSha256,sha('f')]);
  expect(query.values.at(-1)).toBe(2);expect(Object.isFrozen(result)).toBe(true);
 });
 it('preserves an existing-helper full-scope extension receipt and expiry exactly',async()=>{
  const f=setup(),extension={...f.receipt,event_id:id(4),predecessor_event_id:f.receipt.event_id};ports.prepare.mockResolvedValue(extension);
  const result=await enrollCurrentPaidRealServiceSources(f.context,f.input);expect(result.items[0].receipt).toEqual(extension);expect(ports.prepare).toHaveBeenCalledOnce();
 });
 it('does not enroll on source-only changes excluded by authenticated discovery',async()=>{
  const f=setup();f.selectors.splice(0);expect(await enrollCurrentPaidRealServiceSources(f.context,f.input)).toEqual({state:'finished',items:[]});expect(ports.prepare).not.toHaveBeenCalled();
 });
 it('preserves current same-scope replay if another transaction already enrolled the purchase',async()=>{
  const f=setup(),replay={...f.receipt,replayed:true};ports.prepare.mockResolvedValue(replay);
  expect((await enrollCurrentPaidRealServiceSources(f.context,f.input)).items[0].receipt).toEqual(replay);
 });
 it.each(['foreign_plan','duplicate_case','over_limit'] as const)('refuses %s selectors before any enrollment write',async mutation=>{
  const f=setup();if(mutation==='foreign_plan')f.selector.plan_sha256=sha('9');if(mutation==='duplicate_case')f.selectors.push({...f.selector});
  if(mutation==='over_limit')f.selectors.push({...f.selector,case_id:id(5)},{...f.selector,case_id:id(6)});
  await expect(enrollCurrentPaidRealServiceSources(f.context,f.input)).rejects.toThrow();expect(ports.prepare).not.toHaveBeenCalled();
 });
 it.each(['database','principal','schema_version'] as const)('refuses wrong actual %s before selector discovery',async field=>{
  const f=setup();Object.assign(f.actual,{[field]:'foreign'});await expect(enrollCurrentPaidRealServiceSources(f.context,f.input)).rejects.toThrow('REAL_SERVICE_CONTROLLER_DATABASE');expect(f.query).toHaveBeenCalledOnce();expect(ports.prepare).not.toHaveBeenCalled();
 });
 it('keeps a stale-source refusal without retrying with invented current pins',async()=>{
  const f=setup(),refused={state:'unavailable',reason:'source_changed'};ports.prepare.mockResolvedValue(refused);
  expect((await enrollCurrentPaidRealServiceSources(f.context,f.input)).items[0].receipt).toEqual(refused);expect(ports.prepare).toHaveBeenCalledOnce();
 });
 it('propagates CAS failure to roll back the enclosing transaction',async()=>{
  const f=setup(),failure=Error('REAL_ACTIVATION_CONTEXT_SUPERSEDED');ports.prepare.mockRejectedValue(failure);
  await expect(enrollCurrentPaidRealServiceSources(f.context,f.input)).rejects.toBe(failure);
 });
 it('does no work without the separate enrollment enable flag',async()=>{
  const f=setup();vi.stubEnv('TIVDOC_REAL_AI_ENROLLMENT_ENABLED','0');expect(await enrollCurrentPaidRealServiceSources(f.context,f.input)).toEqual({state:'disabled',items:[]});expect(f.query).not.toHaveBeenCalled();
 });
});
