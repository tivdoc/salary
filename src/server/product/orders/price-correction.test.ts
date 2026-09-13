import {it,expect,vi} from 'vitest';
import {createPriceQuote,createReleasePriceQuote,releasePricingBasisSchema,RELEASE_PRICING_BASIS_VERSION,type PricingBasis} from './pricing';
import {priceQuoteSchema} from './price-quote';
import {requestSavedPriceCorrection} from './price-correction';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
vi.mock('server-only',()=>({}));
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222',orderId='33333333-3333-4333-8333-333333333333',id='44444444-4444-4444-8444-444444444444';
const request={caseId,identityId,orderId,id};
function basis(amount=500000):PricingBasis{return {case_id:caseId,identity_id:identityId,analysis_version:'synthetic-correction',input_sha256:'b'.repeat(64),checked_months:['2020-01'],checked_topics:['pension'],components:[{finding_id:id,economic_key:'synthetic-deposit',month:'2020-01',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount,range:null,evidence_ids:[id],rule_versions:['synthetic-only'],alternative_group:null}]};}
function setup(){
 const quote=priceQuoteSchema.parse(createPriceQuote({basis:{...basis(2000000),input_sha256:'a'.repeat(64)},caseId,identityId,from:'2020-01',to:'2020-01',topics:['pension'],credit:{order_id:id,case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-08T00:00:00.000Z')}));
 const receipt={id,order_id:orderId,state:'requested' as const,cumulative_refund_minor:15000,requested_at:'2026-09-08T01:00:00.000Z'};
 const saved={input_sha256:'b'.repeat(64),quote_id:id,quote_sha256:quote.sha256,quote:quote as unknown,previous:null as null|typeof receipt};
 const query=vi.fn<PostgresTransactionContext['client']['query']>(async s=>({rows:[{value:s.name==='price_correction_context'?saved:{...receipt,replayed:false}}],row_count:1}));
 const context:PostgresTransactionContext={transaction_id:'synthetic-only',client:{query}};
 return {quote,receipt,saved,query,context};
}
it('uses the saved purchased quote and fresh trusted basis, requesting only its cumulative downward difference',async()=>{
 const s=setup(),read=vi.fn(async()=>basis());const result=await requestSavedPriceCorrection(s.context,request,read);
 expect(result).toEqual({...s.receipt,replayed:false});expect(read).toHaveBeenCalledWith(s.context,{caseId,identityId,inputSha256:'b'.repeat(64),checkedMonths:['2020-01'],checkedTopics:['pension']});
 const call=s.query.mock.calls[1][0];expect(call.values.slice(0,5)).toEqual([caseId,identityId,orderId,id,s.quote.sha256]);expect(call.values.slice(-2)).toEqual([500000,15000]);
});
it('returns a persisted retry before reading changed or unavailable monetary inputs',async()=>{
 const s=setup();s.saved.previous=s.receipt;const read=vi.fn(async()=>null);
 expect(await requestSavedPriceCorrection(s.context,request,read)).toEqual({...s.receipt,replayed:true});expect(read).not.toHaveBeenCalled();expect(s.query).toHaveBeenCalledTimes(1);
});
it.each(['missing','low','inactive','scope','higher'] as const)('does not persist an adjustment for %s basis',async defect=>{
 const s=setup(),b=basis(defect==='higher'?3000000:0);
 if(defect==='low')b.components[0].certainty='low';if(defect==='inactive')b.components[0].active=false;if(defect==='scope')b.checked_months=['2020-02'];
 const result=await requestSavedPriceCorrection(s.context,request,async()=>defect==='missing'?null:b);
 expect(result.state).toBe(defect==='higher'?'no_adjustment':'amount_unknown');expect(result).not.toHaveProperty('cumulative_refund_minor');expect(s.query).toHaveBeenCalledTimes(1);
});
it.each(['hash','foreign','source','ack'] as const)('refuses a changed %s boundary',async defect=>{
 const s=setup(),b=basis();if(defect==='hash')s.saved.quote_sha256='c'.repeat(64);if(defect==='foreign')s.quote.identity_id=id;if(defect==='source')b.input_sha256='c'.repeat(64);if(defect==='ack')s.receipt.order_id=id;
 await expect(requestSavedPriceCorrection(s.context,request,async()=>b)).rejects.toThrow();
 expect(s.query).toHaveBeenCalledTimes(defect==='ack'?2:1);
});
it('does not accept an HTTP-provided amount or basis in its request contract',async()=>{
 const s=setup();await expect(requestSavedPriceCorrection(s.context,{...request,amount:1} as typeof request,async()=>basis())).rejects.toThrow();expect(s.query).not.toHaveBeenCalled();
});

it.each(['rest_day','contract','bonuses'] as const)('corrects the exact saved %s versioned scope through the existing refund RPC',async topic=>{
 const s=setup();
 const release=(amount:number,inputSha='b'.repeat(64))=>releasePricingBasisSchema.parse({...basis(amount),schema_version:RELEASE_PRICING_BASIS_VERSION,input_sha256:inputSha,checked_topics:[topic],components:basis(amount).components.map(c=>({...c,topic}))});
 const quote=priceQuoteSchema.parse(createReleasePriceQuote({basis:release(2000000,'a'.repeat(64)),caseId,identityId,from:'2020-01',to:'2020-01',topics:[topic],credit:{order_id:id,case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-08T00:00:00.000Z')}));
 s.saved.quote=quote;s.saved.quote_sha256=quote.sha256;
 expect(await requestSavedPriceCorrection(s.context,request,async()=>release(500000))).toEqual({...s.receipt,replayed:false});
 const call=s.query.mock.calls[1][0];expect(JSON.parse(String(call.values[5]))).toMatchObject({schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:[topic]});expect(call.values.slice(-2)).toEqual([500000,15000]);
});
it('does not upgrade an old saved quote to a new basis version during correction',async()=>{
 const s=setup(),b=releasePricingBasisSchema.parse({...basis(),schema_version:RELEASE_PRICING_BASIS_VERSION});
 expect(await requestSavedPriceCorrection(s.context,request,async()=>b)).toEqual({state:'amount_unknown',reason:'invalid_saved_basis'});expect(s.query).toHaveBeenCalledTimes(1);
});
