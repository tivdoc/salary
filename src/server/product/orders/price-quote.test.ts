import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createPriceQuote,type PricingBasis} from './pricing';
import {priceQuoteSchema,requireFreshPriceQuote,type PriceQuote} from './price-quote';
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222';
function input(){
 const basis:PricingBasis={case_id:caseId,identity_id:identityId,analysis_version:'synthetic-only',input_sha256:'a'.repeat(64),checked_months:['2026-08'],checked_topics:['pension'],components:[{
  finding_id:'33333333-3333-4333-8333-333333333333',economic_key:'synthetic-employer-deposit',month:'2026-08',topic:'pension',kind:'fund_deposit',direction:'employer_owes',certainty:'high',active:true,basis_complete:true,amount:50000,range:null,evidence_ids:['44444444-4444-4444-8444-444444444444'],rule_versions:['synthetic-rule-only'],alternative_group:null,
 }]};
 return {basis,caseId,identityId,from:'2026-08',to:'2026-08',topics:['pension'],credit:{order_id:'55555555-5555-4555-8555-555555555555',case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-08T00:00:00.000Z')};
}
const make=()=>priceQuoteSchema.parse(createPriceQuote(input()));
function rehash(quote:PriceQuote){const {sha256:ignored,...payload}=quote;void ignored;quote.sha256=canonicalSha256(payload);return quote;}
const current=()=>({caseId,identityId,inputSha256:'a'.repeat(64),now:new Date('2026-09-09T00:00:00.000Z')});
describe('stored price quote integrity and purchase freshness',()=>{
 it('pins the actual policy and validates an exact JSON round trip',()=>{
  const quote=make();expect(priceQuoteSchema.parse(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
  expect(quote).toMatchObject({schema_version:'tivdoc-price-quote-v1',initial_credit_cap_minor:999,total_minor:9900,credit_minor:999,balance_minor:8901});
  expect(requireFreshPriceQuote(quote,current())).toEqual(quote);
 });
 it('rejects changed bytes before using the price',()=>{const q=make();q.balance_minor++;expect(()=>requireFreshPriceQuote(q,current())).toThrow('PRICE_QUOTE_INVALID');});
 it.each(['tier','policy version','credit exceeds cap','balance','credit linkage','expiry','scope','duplicate months','duplicate topics'] as const)('rejects internally inconsistent %s even with a recomputed checksum',defect=>{
  const q=make();
  if(defect==='tier')q.total_minor=19900;
  if(defect==='policy version')q.pricing_version='unrelated';
  if(defect==='credit exceeds cap'){q.credit_minor=1000;q.balance_minor=8900;}
  if(defect==='balance')q.balance_minor=1;
  if(defect==='credit linkage')q.credit_order_id=null;
  if(defect==='expiry')q.expires_at='2026-09-16T00:00:00.000Z';
  if(defect==='scope')q.purchased_period.from='2026-09';
  if(defect==='duplicate months')q.checked_months.push('2026-08');
  if(defect==='duplicate topics')q.purchased_topics.push('pension');
  expect(priceQuoteSchema.safeParse(rehash(q)).success).toBe(false);
 });
 it.each(['caseId','identityId','inputSha256'] as const)('refuses changed current %s',field=>{
  const c=current();c[field]=field==='inputSha256'?'b'.repeat(64):'66666666-6666-4666-8666-666666666666';
  expect(()=>requireFreshPriceQuote(make(),c)).toThrow(field==='inputSha256'?'PRICE_QUOTE_SOURCE_CHANGED':'PRICE_QUOTE_FORBIDDEN');
 });
 it.each(['2026-09-15T00:00:00.000Z','2026-09-07T23:59:59.999Z','invalid'])('refuses an unpaid quote at invalid database time %s',time=>{
  expect(()=>requireFreshPriceQuote(make(),{...current(),now:new Date(time)})).toThrow('PRICE_QUOTE_EXPIRED');
 });
 it('accepts the last millisecond before expiry and preserves expired history for reading',()=>{
  const q=make();expect(requireFreshPriceQuote(q,{...current(),now:new Date('2026-09-14T23:59:59.999Z')})).toEqual(q);
  expect(priceQuoteSchema.parse(q)).toEqual(q);
 });
 it('validates historical policy arithmetic without imposing the current launch prices',()=>{
  const q=make();q.pricing_policy.version='synthetic-historical-policy';q.pricing_version=q.pricing_policy.version;
  q.pricing_policy.tiers=q.pricing_policy.tiers.map(t=>({...t,total_minor:t.total_minor+100}));q.total_minor+=100;q.balance_minor+=100;
  expect(priceQuoteSchema.parse(rehash(q)).total_minor).toBe(10000);expect(make().total_minor).toBe(9900);
 });
 it('rejects malformed initial credit IDs and unsupported purchased topics at issuance',()=>{
  const value=input();value.credit.order_id='not-an-order';expect(()=>createPriceQuote(value)).toThrow('PRICING_CREDIT_UNVERIFIED');
  value.credit.order_id=input().credit.order_id;value.topics.push('invented-topic');expect(()=>createPriceQuote(value)).toThrow();
 });
});
