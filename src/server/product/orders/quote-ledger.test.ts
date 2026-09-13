import {describe,it,expect,vi} from 'vitest';
import {issueSavedPriceQuote,type SavedPricingBasisReader} from './quote-ledger';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {PricingBasis} from './pricing';
vi.mock('server-only',()=>({}));
function setup(){
 const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222';
 const request={id:'33333333-3333-4333-8333-333333333333',caseId,identityId,from:'2026-08',to:'2026-08',topics:['pension' as const]};
 const credit={order_id:'44444444-4444-4444-8444-444444444444',case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false};
 const current={input_sha256:'a'.repeat(64),now:'2026-09-08T00:00:00.000Z',credit:credit as typeof credit|null};
 const stored:Record<string,unknown>[]=[];
 const basis:PricingBasis={case_id:caseId,identity_id:identityId,analysis_version:'synthetic-only',input_sha256:current.input_sha256,checked_months:['2026-08'],checked_topics:['pension'],components:[{finding_id:request.id,economic_key:'synthetic-only',month:'2026-08',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[credit.order_id],rule_versions:['synthetic-only'],alternative_group:null}]};
 const reader=vi.fn<SavedPricingBasisReader>(async()=>basis);
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async s=>{
  if(s.name==='price_quote_context')return {rows:[{value:current}],row_count:1};
  if(s.name==='price_quote_previous')return {rows:stored,row_count:stored.length};
  if(s.name==='price_quote_insert'){stored.push({id:s.values[0],request_sha256:s.values[3],snapshot:JSON.parse(String(s.values[4])),quote_sha256:s.values[5],terms_version:s.values[6]});return {rows:[],row_count:1};}
  throw new Error('UNEXPECTED_SQL');
 });
 const context:PostgresTransactionContext={transaction_id:'synthetic-only',client:{query}};
 return {request,current,basis,reader,stored,context,issue:()=>issueSavedPriceQuote(context,request,reader)};
}
describe('server quote issuance from a supplied trusted-reader port',()=>{
 it('persists once and replays exact history without new basis work',async()=>{const s=setup(),first=await s.issue();expect(first).toMatchObject({state:'quoted',quote:{balance_minor:8901},replayed:false});expect(await s.issue()).toEqual({...first,replayed:true});expect(s.reader).toHaveBeenCalledOnce();expect(s.stored).toHaveLength(1);});
 it('never invokes the basis reader without a verified saved initial payment',async()=>{const s=setup();s.current.credit=null;expect(await s.issue()).toEqual({state:'amount_unknown',reason:'verified_initial_credit_unavailable'});expect(s.reader).not.toHaveBeenCalled();expect(s.stored).toHaveLength(0);});
 it.each(['absent','low','inactive','zero','below threshold'] as const)('never stores an eligible quote for %s monetary evidence',async defect=>{
  const s=setup();if(defect==='absent')s.reader.mockResolvedValue(null);if(defect==='low')s.basis.components[0].certainty='low';if(defect==='inactive')s.basis.components[0].active=false;
  if(defect==='zero'){s.basis.components[0].amount=0;s.basis.components[0].direction='none';}if(defect==='below threshold')s.basis.components[0].amount=49999;
  expect((await s.issue()).state).not.toBe('quoted');expect(s.stored).toHaveLength(0);
 });
 it('refuses a reader result from an old source before storing it',async()=>{const s=setup();s.basis.input_sha256='b'.repeat(64);await expect(s.issue()).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');expect(s.stored).toHaveLength(0);});
 it('refuses retry after source change or expiry, retaining the old stored bytes',async()=>{
  const s=setup();await s.issue();const old=JSON.stringify(s.stored);s.current.input_sha256='b'.repeat(64);await expect(s.issue()).rejects.toThrow('PRICE_QUOTE_SOURCE_CHANGED');
  s.current.input_sha256='a'.repeat(64);s.current.now='2026-09-15T00:00:00.000Z';await expect(s.issue()).rejects.toThrow('PRICE_QUOTE_EXPIRED');expect(JSON.stringify(s.stored)).toBe(old);expect(s.reader).toHaveBeenCalledOnce();
 });
 it('requires a new idempotency key for a changed purchase request',async()=>{const s=setup();await s.issue();s.request.to='2026-09';await expect(s.issue()).rejects.toThrow('PRICE_QUOTE_REQUEST_CONFLICT');expect(s.stored).toHaveLength(1);});
});
