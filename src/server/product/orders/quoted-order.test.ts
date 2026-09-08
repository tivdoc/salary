import {it,expect,vi} from 'vitest';
import {createPriceQuote,type PricingBasis} from './pricing';
import {priceQuoteSchema} from './price-quote';
import {quotedFullOffer,acceptSavedPriceQuote} from './quoted-order';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
vi.mock('server-only',()=>({}));
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222';
function input(){
 const basis:PricingBasis={case_id:caseId,identity_id:identityId,analysis_version:'synthetic-only',input_sha256:'a'.repeat(64),checked_months:['2026-08'],checked_topics:['pension'],components:[{
  finding_id:'33333333-3333-4333-8333-333333333333',economic_key:'synthetic-employer-deposit',month:'2026-08',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:['44444444-4444-4444-8444-444444444444'],rule_versions:['synthetic-rule-only'],alternative_group:null,
 }]};
 return {basis,caseId,identityId,from:'2026-08',to:'2026-08',topics:['pension'],credit:{order_id:'55555555-5555-4555-8555-555555555555',case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-08T00:00:00.000Z')};
}
const make=()=>priceQuoteSchema.parse(createPriceQuote(input()));

it('pins the quoted balance and AI service terms without asserting human review',()=>{
 const q=make(),o=quotedFullOffer(q,'saved-terms');expect(o).toMatchObject({version:'tivdoc-order-offer-v2',amount_minor:8901,terms_version:'saved-terms',human_review_required:false,service_kind:'ai_assisted',price_quote:q,sla:{track:'business',budget_ms:86400000}});
 o.price_quote.purchased_topics.push('travel');expect(q.purchased_topics).toEqual(['pension']);
});
it('rejects a tampered quote before constructing an offer',()=>{const q=make();q.balance_minor=1;expect(()=>quotedFullOffer(q,'terms')).toThrow();});
function acceptance(row:Record<string,unknown>|null){
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async s=>{
  if(s.name==='quoted_order_snapshot')return {rows:row?[row]:[],row_count:row?1:0};
  if(s.name==='quoted_order_accept')return {rows:[{value:{replayed:false,order:{id:'66666666-6666-4666-8666-666666666666',case_id:caseId,kind:'full',amount_minor:8901,currency:'ILS',state:'awaiting_payment',offer:JSON.parse(String(s.values[1]))}}}],row_count:1};
  throw new Error('UNEXPECTED_SQL');
 });return {query,context:{transaction_id:'synthetic-only',client:{query}} as PostgresTransactionContext};
}
it('loads only the exact case/identity quote and submits one atomically bound offer',async()=>{
 const q=make(),s=acceptance({snapshot:q,quote_sha256:q.sha256,terms_version:'saved-terms'}),quoteId='77777777-7777-4777-8777-777777777777';
 const result=await acceptSavedPriceQuote(s.context,{quoteId,caseId,identityId});expect(s.query.mock.calls[0][0].values).toEqual([quoteId,caseId,identityId]);expect(s.query).toHaveBeenCalledTimes(2);
 const {sha256,...payload}=result.order.offer as Record<string,unknown>;expect(sha256).toBe(canonicalSha256(payload));expect(payload.price_quote_id).toBe(quoteId);
});
it.each(['absent','wrong hash','foreign identity'] as const)('refuses %s saved evidence before mutation',async defect=>{
 const q=make(),s=acceptance(defect==='absent'?null:{snapshot:q,quote_sha256:defect==='wrong hash'?'b'.repeat(64):q.sha256,terms_version:'saved-terms'});
 await expect(acceptSavedPriceQuote(s.context,{quoteId:'77777777-7777-4777-8777-777777777777',caseId,identityId:defect==='foreign identity'?'88888888-8888-4888-8888-888888888888':identityId})).rejects.toThrow();expect(s.query).toHaveBeenCalledTimes(1);
});
