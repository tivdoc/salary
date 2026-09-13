import {it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {CaseAccessDb} from '../case-access/db';
import {createReleaseInitialOrder,customerReleaseQuote} from './service';
import {offerSnapshot} from './contracts';
import {createReleasePriceQuote} from './quote-ledger';
import {priceQuoteSchema} from './price-quote';
import {quotedFullOffer} from './quoted-order';
import type {PricingBasis} from './pricing';
vi.mock('server-only',()=>({}));
vi.mock('@/lib/invoice4u',()=>({Invoice4uClient:class{},invoice4uErrorCode:()=>null}));
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222',quoteId='33333333-3333-4333-8333-333333333333',orderId='44444444-4444-4444-8444-444444444444';
function fixture(){
 const basis:PricingBasis={case_id:caseId,identity_id:identityId,analysis_version:'synthetic-only',input_sha256:'a'.repeat(64),checked_months:['2026-06'],checked_topics:['pension'],components:[{finding_id:quoteId,economic_key:'synthetic-pension',month:'2026-06',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[orderId],rule_versions:['synthetic-only'],alternative_group:null}]};
 const quote=priceQuoteSchema.parse(createReleasePriceQuote({basis,caseId,identityId,from:'2026-06',to:'2026-06',topics:['pension','rest_day','bonuses','contract'],credit:{order_id:orderId,case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-08T00:00:00.000Z')}));
 const payload={...quotedFullOffer(quote,'synthetic-terms'),price_quote_id:quoteId},offer={...payload,sha256:canonicalSha256(payload)};
 const order={id:orderId,case_id:caseId,kind:'full',state:'awaiting_payment',amount_minor:8901,currency:'ILS',period_from:'2026-06-01',period_to:'2026-06-01',topics:[...quote.purchased_topics],offer};
 const row={id:quoteId,snapshot:quote,quote_sha256:quote.sha256,input_sha256:basis.input_sha256,now:'2026-09-08T00:00:00.000Z',order_id:null as string|null};
 const rpc=vi.fn(async(name:string,_args:Readonly<Record<string,unknown>>):Promise<unknown[]>=>{void _args;if(name==='case_order_release_quote')return [{value:row}];if(name==='case_order_get')return [{value:order}];throw Error('UNEXPECTED_RPC');});
 const db:CaseAccessDb={provider:'fake',async rpc<T>(name:string,args:Readonly<Record<string,unknown>>){return await rpc(name,args) as T[];}};
 const input={caseId,identityId,request:{kind:'full' as const,from:'2026-06',to:'2026-06'}};
 return {row,quote,order,rpc,db,input};
}
it('creates an explicit release initial offer without provider work and keeps a historical SQL replay unchanged',async()=>{
 const f=fixture(),historical={id:orderId,offer:offerSnapshot('initial')},bytes=JSON.stringify(historical);f.rpc.mockResolvedValueOnce([{value:historical}]);
 expect(await createReleaseInitialOrder({...f.input,identityId:null,request:{kind:'initial',from:'2026-06',to:'2026-06'}},f.db)).toEqual(historical);
 expect(JSON.stringify(historical)).toBe(bytes);expect(f.rpc).toHaveBeenCalledExactlyOnceWith('case_order_create',expect.objectContaining({target_case:caseId,target_identity:null,target_kind:'initial',target_offer:expect.objectContaining({version:'tivdoc-order-offer-v3',purchase_topics_version:'tivdoc-purchase-topics-v2',amount_minor:999,maximum_checked_topics:3})}));
});
it('loads only the authenticated current quote and exposes commercial fields without source receipts',async()=>{
 const f=fixture(),result=await customerReleaseQuote(f.input,f.db);
 expect(result).toEqual({quote:{id:quoteId,from:'2026-06',to:'2026-06',topics:f.quote.purchased_topics,total_minor:9900,credit_minor:999,balance_minor:8901,currency:'ILS',expires_at:f.quote.expires_at},order:null});
 expect(f.rpc).toHaveBeenCalledExactlyOnceWith('case_order_release_quote',{target_case:caseId,target_identity:identityId,target_from:'2026-06-01',target_to:'2026-06-01'});
 expect(JSON.stringify(result)).not.toContain(f.quote.basis_sha256);
});
it('returns only an already-created order bound to the same saved quote',async()=>{
 const f=fixture();f.row.order_id=orderId;expect((await customerReleaseQuote(f.input,f.db)).order).toEqual(f.order);
 expect(f.rpc).toHaveBeenLastCalledWith('case_order_get',{target_case:caseId,target_identity:identityId,target_order:orderId});
});
it('refuses absent pricing evidence without creating a quote or order',async()=>{
 const f=fixture();f.rpc.mockResolvedValueOnce([{value:null}]);await expect(customerReleaseQuote(f.input,f.db)).rejects.toThrow('ORDER_PRICING_BASIS_UNAVAILABLE');expect(f.rpc).toHaveBeenCalledOnce();
});
it.each(['foreign','source','expired','hash','period','ambiguous'])('refuses %s quote metadata before retrieving any order',async change=>{
 const f=fixture();f.row.order_id=orderId;
 if(change==='foreign')f.input.identityId=orderId;if(change==='source')f.row.input_sha256='f'.repeat(64);if(change==='expired')f.row.now=f.quote.expires_at;
 if(change==='hash')f.row.quote_sha256='f'.repeat(64);if(change==='period')f.input.request.to='2026-07';if(change==='ambiguous')f.rpc.mockResolvedValueOnce([{value:f.row},{value:f.row}]);
 await expect(customerReleaseQuote(f.input,f.db)).rejects.toThrow();expect(f.rpc).toHaveBeenCalledOnce();
});
it.each(['scope','quote','price','case','cancelled'])('refuses a mismatched %s stored order',async change=>{
 const f=fixture();f.row.order_id=orderId;if(change==='scope')f.order.topics=['pension'];if(change==='quote')f.order.offer.price_quote_sha256='f'.repeat(64);
 if(change==='price')f.order.amount_minor=1;if(change==='case')f.order.case_id=identityId;if(change==='cancelled')f.order.state='cancelled';
 await expect(customerReleaseQuote(f.input,f.db)).rejects.toThrow('ORDER_QUOTE_LOOKUP_INVALID');
});
