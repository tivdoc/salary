import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {RELEASE_PURCHASE_TOPICS} from './purchase-topics';
import {createReleasePriceQuote,releasePricingBasisSchema,RELEASE_PRICING_BASIS_VERSION,priceSavedReleaseBasis} from './pricing';
import {priceQuoteSchema} from './price-quote';
import {priceSavedBasis,createPriceQuote,pricingRefundDifference,quoteCorrectionRefund,type PricingBasis} from './pricing';
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222';
function basis(amount:number):PricingBasis{return {case_id:caseId,identity_id:identityId,analysis_version:'synthetic-analysis-1',input_sha256:'a'.repeat(64),checked_months:['2026-08'],checked_topics:['pension'],components:[{finding_id:'33333333-3333-4333-8333-333333333333',economic_key:'employer-pension-contribution',month:'2026-08',topic:'pension',kind:'fund_deposit',direction:amount?'employer_owes':'none',certainty:'high',active:true,basis_complete:true,amount,range:null,evidence_ids:['44444444-4444-4444-8444-444444444444'],rule_versions:['synthetic-rule-v1'],alternative_group:null}]};}
function quoteInput(value=50_000){return {basis:basis(value),caseId,identityId,from:'2026-08',to:'2026-08',topics:['pension'],credit:{order_id:'55555555-5555-4555-8555-555555555555',case_id:caseId,identity_id:identityId,verified:true,paid_minor:999,already_consumed:false},now:new Date('2026-09-07T12:00:00.000Z')};}
describe('v1.1 commercial pricing, separate from legal calculation',()=>{
 it.each([[0,null],[49999,null],[50000,9900],[499999,9900],[500000,19900],[1999999,19900],[2000000,34900]])('basis %i chooses the exact boundary', (amount,total)=>{const result=priceSavedBasis(basis(amount));if(total===null)expect(result).toEqual({state:'no_upgrade',basis_minor:amount,reason:'below_threshold'});else expect(result).toMatchObject({state:'eligible',basis_minor:amount,total_minor:total});});
 it.each(['low','missing','inactive','amount_missing'] as const)('%s cannot leak a tier or amount',kind=>{const input=basis(2_000_000);const c=input.components[0];if(kind==='low')c.certainty='low';if(kind==='missing')c.basis_complete=false;if(kind==='inactive')c.active=false;if(kind==='amount_missing')c.amount=null;const result=priceSavedBasis(input);expect(result.state).toBe('amount_unknown');expect(result).not.toHaveProperty('total_minor');expect(result).not.toHaveProperty('basis_minor');});
 it.each(['high','medium'] as const)('refuses simultaneous point and range for %s certainty',certainty=>{const input=basis(50000);Object.assign(input.components[0],{certainty,range:{low:49999,high:50000}});expect(priceSavedBasis(input)).toEqual({state:'amount_unknown',reason:'ambiguous_amount_representation'});});
 it('uses only a permitted lower bound, with no extrapolation to the purchased period',()=>{const input=quoteInput();input.to='2027-07';const c=input.basis.components[0];c.certainty='medium';c.amount=null;c.range={low:49999,high:9000000};expect(createPriceQuote(input)).toMatchObject({state:'no_upgrade',basis_minor:49999});});
 it('deduplicates the same economic component even with another finding ID',()=>{const input=basis(49999);input.components.push({...input.components[0],finding_id:'66666666-6666-4666-8666-666666666666'});expect(priceSavedBasis(input)).toMatchObject({state:'no_upgrade',basis_minor:49999});});
 it('refuses contradictory duplicates and unresolved alternatives',()=>{const input=basis(49999);input.components.push({...input.components[0],amount:50000});expect(priceSavedBasis(input).state).toBe('amount_unknown');input.components=[{...input.components[0],alternative_group:'unresolved'}];expect(priceSavedBasis(input).state).toBe('amount_unknown');});
 it.each(['unrealized_balance','possible_compensation','estimated_interest','legal_cost'] as const)('excludes %s from a tier',kind=>{const input=basis(49999);input.components.push({...input.components[0],kind,amount:9_000_000});expect(priceSavedBasis(input)).toMatchObject({state:'no_upgrade',basis_minor:49999});});
 it('does not invent zero when no monetary component exists',()=>{const input=basis(0);input.components=[];expect(priceSavedBasis(input)).toEqual({state:'amount_unknown',reason:'no_quantified_components'});});
 it('does not add an opposite direction without an established offset rule',()=>{const input=basis(50000);input.components[0].direction='employee_owes';expect(priceSavedBasis(input).state).toBe('amount_unknown');});
 it('refuses evidence outside the checked month and refuses unsafe minor units',()=>{const input=basis(50000);input.components[0].month='2026-07';expect(priceSavedBasis(input).state).toBe('amount_unknown');expect(priceSavedBasis(basis(Number.MAX_SAFE_INTEGER+1)).state).toBe('amount_unknown');});
 it('pins identity, analysis, checked coverage, bought scope, credit and seven-day expiry',()=>{expect(createPriceQuote(quoteInput())).toMatchObject({state:'eligible',total_minor:9900,credit_minor:999,balance_minor:8901,analysis_version:'synthetic-analysis-1',checked_months:['2026-08'],purchased_period:{from:'2026-08',to:'2026-08'},expires_at:'2026-09-14T12:00:00.000Z'});});
 it.each([500_000,2_000_000])('credits the initial against the %i tier',amount=>{expect(createPriceQuote(quoteInput(amount))).toMatchObject({balance_minor:amount===500_000?18901:33901});});
 it('does not reuse credit or credit more than actually paid',()=>{const input=quoteInput();input.credit.already_consumed=true;expect(createPriceQuote(input)).toMatchObject({credit_minor:0,balance_minor:9900});input.credit.already_consumed=false;input.credit.paid_minor=700;expect(createPriceQuote(input)).toMatchObject({credit_minor:700,balance_minor:9200});});
 it('refuses foreign and unverified credit and foreign saved analysis',()=>{const input=quoteInput();input.credit.identity_id='foreign';expect(()=>createPriceQuote(input)).toThrow('PRICING_CREDIT_UNVERIFIED');input.credit.identity_id=identityId;input.credit.verified=false;expect(()=>createPriceQuote(input)).toThrow('PRICING_CREDIT_UNVERIFIED');input.basis.case_id='77777777-7777-4777-8777-777777777777';expect(()=>createPriceQuote(input)).toThrow('PRICING_FORBIDDEN');});
 it('changes the quote fingerprint with source revision, without mutating an earlier snapshot',()=>{const input=quoteInput();const old=createPriceQuote(input);input.basis.input_sha256='b'.repeat(64);const next=createPriceQuote(input);expect(old).not.toEqual(next);expect(old).toMatchObject({input_sha256:'a'.repeat(64),balance_minor:8901});});
 it('requests only the downward tier difference; unknown is not zero and increases do not surcharge',()=>{const paid={total_minor:34900,upgrade_paid_minor:33901};expect(pricingRefundDifference(paid,priceSavedBasis(basis(500000)))).toBe(15000);expect(pricingRefundDifference(paid,priceSavedBasis(basis(49999)))).toBe(33901);expect(pricingRefundDifference(paid,{state:'amount_unknown',reason:'missing'})).toBeNull();expect(pricingRefundDifference({total_minor:9900,upgrade_paid_minor:8901},priceSavedBasis(basis(2000000)))).toBe(0);});
});

describe('correction uses the original quoted policy and checked scope',()=>{
 it('keeps historical tier prices even when today would compute a different refund',()=>{
  const original=createPriceQuote(quoteInput(2000000));if(original.state!=='eligible')throw Error('fixture');
  const old=structuredClone(original);old.pricing_policy.version='historical-test';old.pricing_version='historical-test';
  old.pricing_policy.tiers.forEach((tier,i)=>{tier.total_minor=[5000,10000,20000][i];});old.total_minor=20000;old.balance_minor=19001;
  const {sha256:ignored,...payload}=old;void ignored;old.sha256=canonicalSha256(payload);priceQuoteSchema.parse(old);
  const before=JSON.stringify(old);
  expect(quoteCorrectionRefund(old,basis(500000))).toMatchObject({state:'calculated',pricing_version:'historical-test',refund_minor:10000,quote_sha256:old.sha256});
  expect(pricingRefundDifference({total_minor:20000,upgrade_paid_minor:19001},priceSavedBasis(basis(500000)))).toBe(100);
  expect(JSON.stringify(old)).toBe(before);
 });
 it.each([[49999,33901],[500000,15000],[2000000,0],[3000000,0]])('corrected %i yields only a bounded upgrade refund', (amount,refund)=>{
  expect(quoteCorrectionRefund(createPriceQuote(quoteInput(2000000)),basis(amount))).toMatchObject({state:'calculated',refund_minor:refund});
 });
 it.each(['case','identity','months','topics'])('does not treat changed %s scope as a downward correction',kind=>{
  const corrected=basis(49999);
  if(kind==='case')corrected.case_id='66666666-6666-4666-8666-666666666666';
  if(kind==='identity')corrected.identity_id='66666666-6666-4666-8666-666666666666';
  if(kind==='months')corrected.checked_months=['2026-08','2026-09'];
  if(kind==='topics')corrected.checked_topics=['pension','travel'];
  expect(quoteCorrectionRefund(createPriceQuote(quoteInput()),corrected)).toEqual({state:'amount_unknown',reason:'correction_scope_mismatch'});
 });
 it.each(['low','missing','inactive','tampered_quote'])('keeps %s as unknown rather than a zero finding',kind=>{
  const corrected=basis(0),quote=createPriceQuote(quoteInput());
  if(kind==='low')corrected.components[0].certainty='low';
  if(kind==='missing')corrected.components=[];
  if(kind==='inactive')corrected.components[0].active=false;
  if(kind==='tampered_quote'&&quote.state==='eligible')quote.balance_minor=1;
  const result=quoteCorrectionRefund(quote,corrected);expect(result.state).toBe('amount_unknown');expect(result).not.toHaveProperty('refund_minor');
 });
});

describe('release-only nine-topic basis version',()=>{
 it('retains the historical v1 and v2 canonical fingerprints without a new basis marker',()=>{
  const original=priceQuoteSchema.parse(createPriceQuote(quoteInput()));
  const release=priceQuoteSchema.parse(createReleasePriceQuote({...quoteInput(),topics:RELEASE_PURCHASE_TOPICS}));
  expect(original.sha256).toBe('6a37c682e9b98d7433246dfa74566f385db1ceb1d2adae7d8110661c7a5702fa');
  expect(release.sha256).toBe('bea359f89c13af9e52e0789f7b556c7a3b86ecff109feed530c6982acf94990a');
  expect(release).not.toHaveProperty('basis_schema_version');
 });
 function releaseBasis(topic:'rest_day'|'contract'|'bonuses',amount=50000){
  const old=basis(amount);return releasePricingBasisSchema.parse({...old,schema_version:RELEASE_PRICING_BASIS_VERSION,checked_topics:[topic],components:old.components.map(c=>({...c,topic}))});
 }
 it.each(['rest_day','contract','bonuses'] as const)('pins a checked %s comparison independently of nine purchased topics',topic=>{
  const b=releaseBasis(topic),q=createReleasePriceQuote({...quoteInput(),basis:b,topics:RELEASE_PURCHASE_TOPICS});
  expect(q).toMatchObject({schema_version:'tivdoc-price-quote-v2',basis_schema_version:RELEASE_PRICING_BASIS_VERSION,basis_sha256:canonicalSha256(b),checked_topics:[topic],purchased_topics:RELEASE_PURCHASE_TOPICS,total_minor:9900,balance_minor:8901});
  expect(priceSavedBasis(b).state).toBe('amount_unknown');
  expect(()=>createPriceQuote({...quoteInput(),basis:b as unknown as PricingBasis})).toThrow();
 });
 it('validates all nine actually checked topics without adding priced components for purchased-only coverage',()=>{
  const b=releaseBasis('contract');b.checked_topics=[...RELEASE_PURCHASE_TOPICS];
  expect(createReleasePriceQuote({...quoteInput(),basis:b,topics:RELEASE_PURCHASE_TOPICS})).toMatchObject({checked_topics:RELEASE_PURCHASE_TOPICS,basis_minor:50000});
  expect(releasePricingBasisSchema.safeParse({...b,checked_topics:['sick_leave']}).success).toBe(false);
  expect(releasePricingBasisSchema.safeParse({...b,schema_version:'future'}).success).toBe(false);
 });
 it.each(['unknown','incomplete','alternative','outside_scope','conflicting_duplicate'] as const)('refuses %s in the new basis with the same commercial guards',defect=>{
  const b=releaseBasis('contract');
  if(defect==='unknown')b.components[0].amount=null;
  if(defect==='incomplete')b.components[0].basis_complete=false;
  if(defect==='alternative')b.components[0].alternative_group='unresolved';
  if(defect==='outside_scope')b.components[0].topic='bonuses';
  if(defect==='conflicting_duplicate')b.components.push({...b.components[0],finding_id:'66666666-6666-4666-8666-666666666666',amount:60000});
  expect(priceSavedReleaseBasis(b).state).toBe('amount_unknown');
 });
 it('requires the original basis version and checked scope for corrections',()=>{
  const b=releaseBasis('contract',2000000),quote=createReleasePriceQuote({...quoteInput(),basis:b,topics:RELEASE_PURCHASE_TOPICS});
  expect(quoteCorrectionRefund(quote,releaseBasis('contract',500000))).toMatchObject({state:'calculated',refund_minor:15000});
  expect(quoteCorrectionRefund(quote,releaseBasis('bonuses',500000))).toMatchObject({state:'amount_unknown',reason:'correction_scope_mismatch'});
  const oldBasis=basis(2000000),versioned=releasePricingBasisSchema.parse({...oldBasis,schema_version:RELEASE_PRICING_BASIS_VERSION});
  const oldQuote=createReleasePriceQuote({...quoteInput(),basis:oldBasis,topics:RELEASE_PURCHASE_TOPICS});
  const newQuote=createReleasePriceQuote({...quoteInput(),basis:versioned,topics:RELEASE_PURCHASE_TOPICS});
  expect(quoteCorrectionRefund(oldQuote,versioned).state).toBe('amount_unknown');
  expect(quoteCorrectionRefund(newQuote,oldBasis).state).toBe('amount_unknown');
 });
 it('requires the basis marker for new checked topics even when a payload is resealed',()=>{
  const q=priceQuoteSchema.parse(createReleasePriceQuote({...quoteInput(),basis:releaseBasis('contract'),topics:RELEASE_PURCHASE_TOPICS}));
  if(q.schema_version!=='tivdoc-price-quote-v2')throw Error('fixture');
  const {sha256,basis_schema_version,...payload}=q;void sha256;void basis_schema_version;
  expect(priceQuoteSchema.safeParse({...payload,sha256:canonicalSha256(payload)}).success).toBe(false);
 });
});
