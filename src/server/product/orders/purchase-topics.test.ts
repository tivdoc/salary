import {it,expect,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {PricingBasis} from './pricing';
import {releasePricingBasisSchema,RELEASE_PRICING_BASIS_VERSION,createPriceQuote} from './pricing';
import {priceQuoteSchema,requireFreshPriceQuote} from './price-quote';
import {createReleasePriceQuote,issueSavedPriceQuote,issueSavedReleasePriceQuote,type SavedPricingBasisReader} from './quote-ledger';
import {acceptSavedPriceQuote,quotedFullOffer} from './quoted-order';
import {offerSnapshot,releaseInitialOfferSnapshot,orderRequestSchema} from './contracts';
import {PURCHASE_TOPICS_VERSION,RELEASE_PURCHASE_TOPICS,releasePurchaseTopicsSchema} from './purchase-topics';
import {savedOrderSchema,purchasedMonths,savedOrderLegalTopics,readSavedOrders} from '../processing/saved-order-scope';
vi.mock('server-only',()=>({}));

const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222',quoteId='33333333-3333-4333-8333-333333333333',orderId='44444444-4444-4444-8444-444444444444';
function fixture(){
 const basis:PricingBasis={case_id:caseId,identity_id:identityId,analysis_version:'synthetic-purchase-v2',input_sha256:'a'.repeat(64),checked_months:['2026-06'],checked_topics:['pension'],components:[{
  finding_id:quoteId,economic_key:'synthetic-pension',month:'2026-06',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:[orderId],rule_versions:['synthetic-only'],alternative_group:null,
 }]};
 const credit={order_id:orderId,case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false};
 const input={basis,caseId,identityId,from:'2026-06',to:'2026-06',topics:[...RELEASE_PURCHASE_TOPICS],credit,now:new Date('2026-09-08T00:00:00.000Z')};
 const request={id:quoteId,caseId,identityId,from:input.from,to:input.to,topics:input.topics};
 const saved:Record<string,unknown>[]=[],offers:Record<string,unknown>[]=[];
 const reader=vi.fn<SavedPricingBasisReader>(async()=>basis);
 const context:PostgresTransactionContext={transaction_id:'synthetic-purchase-v2',client:{async query(s){
  if(s.name==='price_quote_context')return {rows:[{value:{input_sha256:basis.input_sha256,now:input.now.toISOString(),credit}}],row_count:1};
  if(s.name==='price_quote_previous')return {rows:saved,row_count:saved.length};
  if(s.name==='price_quote_insert'){saved.push({id:s.values[0],request_sha256:s.values[3],snapshot:JSON.parse(String(s.values[4])),quote_sha256:s.values[5],terms_version:s.values[6]});return {rows:[],row_count:1};}
  if(s.name==='quoted_order_snapshot')return {rows:saved,row_count:saved.length};
  if(s.name==='quoted_order_accept'){const offer=JSON.parse(String(s.values[1]));offers.push(offer);return {rows:[{value:{replayed:false,order:{id:orderId,case_id:caseId,kind:'full',amount_minor:offer.amount_minor,currency:'ILS',state:'awaiting_payment',offer}}}],row_count:1};}
  throw Error('UNEXPECTED_SYNTHETIC_QUERY');
 }}};
 const initial=offerSnapshot('initial');
 const historicalOrder={id:orderId,kind:'full' as const,from:'2026-06-01',to:'2026-06-01',topics:['pension','sick_leave'],offer_sha256:initial.sha256};
 return {basis,input,request,reader,context,saved,offers,historicalOrder};
}
it('freezes exactly the nine release topics and excludes sick leave from new purchases',()=>{
 expect(RELEASE_PURCHASE_TOPICS).toEqual(['minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract']);
 expect(releasePurchaseTopicsSchema.parse([...RELEASE_PURCHASE_TOPICS])).toEqual(RELEASE_PURCHASE_TOPICS);
 for(const topics of [[],['sick_leave'],['pension','pension'],[...RELEASE_PURCHASE_TOPICS,'sick_leave']])expect(releasePurchaseTopicsSchema.safeParse(topics).success).toBe(false);
});
it('keeps initial price, one-month limit and max three while versioning only the new offer',()=>{
 const old=offerSnapshot('initial'),oldBytes=JSON.stringify(old),current=releaseInitialOfferSnapshot();
 expect(current).toMatchObject({version:'tivdoc-order-offer-v3',purchase_topics_version:PURCHASE_TOPICS_VERSION,kind:'initial',amount_minor:999,maximum_checked_topics:3,human_review_required:false,topic_order:RELEASE_PURCHASE_TOPICS});
 const {sha256,...payload}=current;expect(sha256).toBe(canonicalSha256(payload));expect(JSON.stringify(offerSnapshot('initial'))).toBe(oldBytes);
 expect(old.version).toBe('tivdoc-order-offer-v1');expect(old).not.toHaveProperty('purchase_topics_version');expect(old.topic_order).toContain('sick_leave');
 expect(orderRequestSchema.safeParse({kind:'initial',from:'2026-05',to:'2026-06'}).success).toBe(false);
});
it('quotes nine purchased topics against one actual checked topic without multiplying the monetary basis',()=>{
 const f=fixture(),old=priceQuoteSchema.parse(createPriceQuote({...f.input,topics:['pension']})),before=JSON.stringify(old);
 const quote=priceQuoteSchema.parse(createReleasePriceQuote(f.input));
 expect(quote).toMatchObject({schema_version:'tivdoc-price-quote-v2',purchase_topics_version:PURCHASE_TOPICS_VERSION,purchased_topics:RELEASE_PURCHASE_TOPICS,checked_topics:['pension'],basis_minor:50000,total_minor:9900,credit_minor:999,balance_minor:8901,basis_sha256:old.basis_sha256});
 expect(quote.sha256).not.toBe(old.sha256);expect(JSON.stringify(priceQuoteSchema.parse(old))).toBe(before);
 expect(quotedFullOffer(old,'saved-terms').version).toBe('tivdoc-order-offer-v2');expect(quotedFullOffer(quote,'saved-terms')).toMatchObject({version:'tivdoc-order-offer-v3',purchase_topics_version:PURCHASE_TOPICS_VERSION,maximum_checked_topics:9,topic_order:RELEASE_PURCHASE_TOPICS,amount_minor:8901});
});
it.each(['unknown','low','below-threshold','unsupported-contract-basis'])('does not manufacture a quote for %s evidence',async defect=>{
 const f=fixture();if(defect==='unknown')f.reader.mockResolvedValue(null);if(defect==='low')f.basis.components[0].certainty='low';
 if(defect==='below-threshold')f.basis.components[0].amount=49999;
 if(defect==='unsupported-contract-basis')f.reader.mockResolvedValue({...f.basis,checked_topics:['contract']} as unknown as PricingBasis);
 expect((await issueSavedReleasePriceQuote(f.context,f.request,f.reader)).state).not.toBe('quoted');expect(f.saved).toEqual([]);
});
it('persists and replays the pinned release request and accepts only its stored quote',async()=>{
 const f=fixture(),first=await issueSavedReleasePriceQuote(f.context,f.request,f.reader),bytes=JSON.stringify(f.saved);
 expect(first.state).toBe('quoted');expect(await issueSavedReleasePriceQuote(f.context,f.request,f.reader)).toEqual({...first,replayed:true});
 expect(f.reader).toHaveBeenCalledOnce();expect(f.saved).toHaveLength(1);expect(JSON.stringify(f.saved)).toBe(bytes);
 await acceptSavedPriceQuote(f.context,{quoteId,caseId,identityId});expect(f.offers).toHaveLength(1);
 const {sha256,...payload}=f.offers[0];expect(sha256).toBe(canonicalSha256(payload));expect(payload).toMatchObject({version:'tivdoc-order-offer-v3',purchase_topics_version:PURCHASE_TOPICS_VERSION,price_quote_id:quoteId});
 await expect(issueSavedReleasePriceQuote(f.context,{...f.request,topics:['pension']},f.reader)).rejects.toThrow('PRICE_QUOTE_REQUEST_CONFLICT');
});
it('keeps the historical issuer on its historical vocabulary and quote version',async()=>{
 const f=fixture(),forged:unknown={...f.request,topics:['contract']};
 await expect(issueSavedPriceQuote(f.context,forged as Parameters<typeof issueSavedPriceQuote>[1],f.reader)).rejects.toThrow();
 const result=await issueSavedPriceQuote(f.context,{...f.request,topics:['pension']},f.reader);
 expect(result).toMatchObject({state:'quoted',quote:{schema_version:'tivdoc-price-quote-v1',purchased_topics:['pension']}});
 if(result.state==='quoted')expect(result.quote).not.toHaveProperty('purchase_topics_version');
});
it.each(['version','pin','topic','hash'])('rejects a tampered release quote %s',change=>{
 const f=fixture(),quote=priceQuoteSchema.parse(createReleasePriceQuote(f.input));
 const changed={...quote,...(change==='version'?{schema_version:'tivdoc-price-quote-v1'}:{}),...(change==='pin'?{purchase_topics_version:'unknown'}:{}),...(change==='topic'?{purchased_topics:['sick_leave']}:{}),...(change==='hash'?{sha256:'f'.repeat(64)}:{})};
 expect(priceQuoteSchema.safeParse(changed).success).toBe(false);
});
it('retains the existing source and expiry checks for v2 quotes',()=>{
 const f=fixture(),quote=createReleasePriceQuote(f.input),fresh={caseId,identityId,inputSha256:f.basis.input_sha256,now:f.input.now};
 expect(requireFreshPriceQuote(quote,fresh).schema_version).toBe('tivdoc-price-quote-v2');
 expect(()=>requireFreshPriceQuote(quote,{...fresh,inputSha256:'f'.repeat(64)})).toThrow('PRICE_QUOTE_SOURCE_CHANGED');
 expect(()=>requireFreshPriceQuote(quote,{...fresh,now:new Date('2026-09-15T00:00:00.000Z')})).toThrow('PRICE_QUOTE_EXPIRED');
});
it('reads old modern orders unchanged and requires explicit v2 pins for release topics',()=>{
 const f=fixture(),old=f.historicalOrder,bytes=JSON.stringify(old);expect(JSON.stringify(savedOrderSchema.parse(old))).toBe(bytes);
 const current={...old,purchase_topics_version:PURCHASE_TOPICS_VERSION,topics:[...RELEASE_PURCHASE_TOPICS]},parsed=savedOrderSchema.parse(current);
 expect(parsed.topics).toEqual(RELEASE_PURCHASE_TOPICS);expect(purchasedMonths(parsed)).toEqual(['2026-06']);
 expect(savedOrderLegalTopics(parsed)).toEqual(['minimum_wage','working_time','pension','travel','convalescence','vacation']);expect(parsed.topics).toEqual(RELEASE_PURCHASE_TOPICS);
 expect(savedOrderSchema.safeParse({...old,topics:['contract']}).success).toBe(false);expect(savedOrderSchema.safeParse({...current,topics:['sick_leave']}).success).toBe(false);
 expect(savedOrderSchema.safeParse({...current,purchase_topics_version:'unknown'}).success).toBe(false);
 for(const invalid of [{...current,kind:'initial'},{...current,kind:'initial',topics:['contract'],to:'2026-07-01'}])expect(savedOrderSchema.safeParse(invalid).success).toBe(false);
 expect(savedOrderSchema.safeParse({...current,kind:'initial',topics:['rest_day','bonuses','contract']}).success).toBe(true);
});
it('requires the same pinned version and topics in the paid journal and current entitlement',async()=>{
 const f=fixture(),order={...f.historicalOrder,purchase_topics_version:PURCHASE_TOPICS_VERSION,topics:[...RELEASE_PURCHASE_TOPICS]};
 let current:unknown=order;
 const context:PostgresTransactionContext={transaction_id:'synthetic-order-pin',client:{async query(){return {rows:[{orders:[order],current_orders:[current]}],row_count:1};}}};
 const job={schema_version:'saved-case-work-v1' as const,case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft' as const};
 expect(await readSavedOrders(context,job)).toEqual([order]);current={...order,topics:['pension']};await expect(readSavedOrders(context,job)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
});

it.each(['rest_day','contract','bonuses'] as const)('persists and replays a versioned %s basis with the same existing ledger',async topic=>{
 const f=fixture(),basis=releasePricingBasisSchema.parse({...f.basis,schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:[topic],components:f.basis.components.map(c=>({...c,topic}))});
 const read=vi.fn(async()=>basis);
 const first=await issueSavedReleasePriceQuote(f.context,f.request,read),bytes=JSON.stringify(f.saved);
 expect(first).toMatchObject({state:'quoted',quote:{schema_version:'tivdoc-price-quote-v2',basis_schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:[topic],purchased_topics:RELEASE_PURCHASE_TOPICS}});
 expect(await issueSavedReleasePriceQuote(f.context,f.request,read)).toEqual({...first,replayed:true});expect(read).toHaveBeenCalledOnce();expect(JSON.stringify(f.saved)).toBe(bytes);
 await acceptSavedPriceQuote(f.context,{quoteId,caseId,identityId});expect(f.offers[0]).toMatchObject({version:'tivdoc-order-offer-v3',topic_order:RELEASE_PURCHASE_TOPICS,amount_minor:8901});
});
