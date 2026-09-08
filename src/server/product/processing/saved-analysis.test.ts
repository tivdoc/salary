import {describe,it,expect,vi} from 'vitest';
import {runSavedMonthAnalysis} from './saved-analysis';
import {savedOrderSchema,type SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';

vi.mock('./source-dispatch',async importOriginal=>({...await importOriginal<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
const caseId='11111111-1111-4111-8111-111111111111';
function setup(){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'22222222-2222-4222-8222-222222222222',kind:'initial',from:'2026-08-01',to:'2026-08-01',topics:['pension'],offer_sha256:'b'.repeat(64)};
 const current:SavedOrderScope[]=[{...order}];
 const replay={command:{case_id:caseId},bundle:{},report:{}};
 const cached=vi.fn(async()=>replay);
 const context:PostgresTransactionContext={transaction_id:'unit-only',client:{async query(s){
  if(s.name==='saved_order_entitlements')return {rows:[{orders:[order],current_orders:current}],row_count:1};
  if(s.name==='saved_analysis_order')return {rows:[{input:{orders:[order]},created_at:'2026-09-08T00:00:00.000Z',engine_revision:1}],row_count:1};
  throw new Error(`UNEXPECTED_SQL:${s.name}`);
 }}};
 return {order,current,cached,replay,input:{context,analysis:{caseAnalysis:{getCompletedByIdempotencyKey:cached}} as unknown as PostgresAnalysisRepositories,tenantId:`saved-case:${caseId}`,job,orderId:order.id,month:'2026-08'}};
}
describe('saved monthly analysis admission before replay',()=>{
 it.each(['revoked entitlement','another order','changed offer'] as const)('refuses %s before reading cached results',async defect=>{
  const s=setup();
  if(defect==='revoked entitlement')s.current.length=0;
  if(defect==='another order')s.current[0].id='33333333-3333-4333-8333-333333333333';
  if(defect==='changed offer')s.current[0].offer_sha256='c'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
  expect(s.cached).not.toHaveBeenCalled();
 });
 it('replays an exact currently entitled order',async()=>{const s=setup();expect(await runSavedMonthAnalysis(s.input)).toBe(s.replay);expect(s.cached).toHaveBeenCalledOnce();});
 it('refuses a saved initial order wider than the purchased three-topic product',async()=>{
  const s=setup();s.order.topics=['pension','travel','vacation','sick_leave'];s.current[0]={...s.order};
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow();expect(s.cached).not.toHaveBeenCalled();
 });
 it('applies the same initial scope rule to the finalizer contract while preserving seven-topic full orders',()=>{
  const s=setup();s.order.topics=['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave'];
  expect(savedOrderSchema.safeParse(s.order).success).toBe(false);
  expect(savedOrderSchema.safeParse({...s.order,kind:'full'}).success).toBe(true);
 });
});
