import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {maintainRealServiceMachine} from './real-service-machine-maintenance';
const ports=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./real-service-machine-issuer',async original=>({...await original<typeof import('./real-service-machine-issuer')>(),manageRealServiceMachine:ports.read}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha=(c:string)=>c.repeat(64);
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_ENABLED','1');vi.stubEnv('TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY','synthetic_capability_'.repeat(3));});
afterEach(()=>vi.unstubAllEnvs());
function setup(){
 const selector={case_id:id(1),identity_id:id(2),plan_sha256:sha('a'),enrollment_id:id(3)},expected={plan_sha256:selector.plan_sha256,issuer_sha256:sha('b'),target_id:'synthetic',database_name:'synthetic',environment:'test' as const,deployment_sha256:sha('c')};
 const response={state:'active' as const,...expected,...selector,request_id:id(4),provenance_sha256:sha('d'),replayed:false,evaluated_at:'2026-09-13T00:00:00Z',valid_after:'2026-09-13T00:00:00Z',expires_at:'2026-09-13T00:10:00Z',
  identity:{session_id:'synthetic-session',token_id:'synthetic-token',tenant_id:`saved-case:${selector.case_id}`,actor_id:id(5),reviewer_organization_id:null,rotation_counter:0}};
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async()=>({row_count:1,rows:[{value:response}]}));
 const context:PostgresTransactionContext={transaction_id:'synthetic-maintenance',client:{query}};
 ports.read.mockResolvedValue({state:'unavailable',reason:'expired'});return {selector,expected,response,query,context};
}
describe('bounded machine maintenance adapter',()=>{
 it('reuses an active authenticated read without maintenance or caller-generated SID',async()=>{
  const f=setup();ports.read.mockResolvedValue(f.response);expect(await maintainRealServiceMachine(f.context,f.selector,f.expected)).toBe(f.response);expect(f.query).not.toHaveBeenCalled();
 });
 it.each(['revoked','superseded','not_enrolled'] as const)('preserves terminal %s without trying to issue',async reason=>{
  const f=setup();ports.read.mockResolvedValue({state:'unavailable',reason});expect(await maintainRealServiceMachine(f.context,f.selector,f.expected)).toEqual({state:'unavailable',reason});expect(f.query).not.toHaveBeenCalled();
 });
 it.each(['not_issued','expired','scope_changed'] as const)('delegates %s eligibility to existing authenticated SQL guards',async reason=>{
  const f=setup();ports.read.mockResolvedValue({state:'unavailable',reason});expect(await maintainRealServiceMachine(f.context,f.selector,f.expected)).toEqual(f.response);
  expect(f.query).toHaveBeenCalledOnce();const [q]=f.query.mock.calls[0];expect(q.name).toBe('real_service_machine_maintain');expect(q.values).toEqual([process.env.TIVDOC_REAL_AI_MACHINE_ISSUER_CAPABILITY,...[f.selector.case_id,f.selector.identity_id,f.selector.plan_sha256,f.selector.enrollment_id]]);
  expect(q.values).not.toContain(f.response.identity.session_id);
 });
 it('preserves SQL refusal without fallback or a second issuance attempt',async()=>{
  const f=setup();f.query.mockResolvedValue({row_count:1,rows:[{value:{state:'unavailable',reason:'revoked'}}]});expect(await maintainRealServiceMachine(f.context,f.selector,f.expected)).toEqual({state:'unavailable',reason:'revoked'});expect(f.query).toHaveBeenCalledOnce();
 });
 it('refuses an acknowledged foreign enrollment',async()=>{
  const f=setup();f.response.enrollment_id=id(9);await expect(maintainRealServiceMachine(f.context,f.selector,f.expected)).rejects.toThrow('REAL_MACHINE_CASE_BINDING_CHANGED');
 });
 it('refuses an acknowledged lifetime beyond the existing one-hour cap',async()=>{
  const f=setup();f.response.expires_at='2026-09-14T00:00:00Z';await expect(maintainRealServiceMachine(f.context,f.selector,f.expected)).rejects.toThrow('REAL_MACHINE_SESSION_EXPIRED');
 });
});
