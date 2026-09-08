import {z} from 'zod';
import {productOffer} from '../../../lib/product-offer';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {priceQuoteSchema,type PriceQuote} from './price-quote';
import {PROJECTION_TOPICS} from '../reports/case-report-projection';

const minor=z.number().int().nonnegative().safe();
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
/** Internal saved-result contract, never an HTTP request or an engine input. */
export const pricingBasisSchema=z.object({
 case_id:z.uuid(),identity_id:z.uuid(),analysis_version:z.string().min(1),input_sha256:hash,
 checked_months:z.array(month).min(1).max(600),checked_topics:z.array(z.enum(PROJECTION_TOPICS)).min(1).max(7),
 components:z.array(z.object({
  finding_id:z.uuid(),economic_key:z.string().min(1),month,topic:z.enum(PROJECTION_TOPICS),
  kind:z.enum(['wage_gap','fund_deposit','unrealized_balance','possible_compensation','estimated_interest','legal_cost']),
  direction:z.enum(['employer_owes','employee_owes','none']),
  certainty:z.enum(['high','medium','low']),active:z.boolean(),basis_complete:z.boolean(),
  amount:minor.nullable(),range:z.object({low:minor,high:minor}).strict().nullable(),
  evidence_ids:z.array(z.uuid()).min(1),rule_versions:z.array(z.string().min(1)).min(1),
  alternative_group:z.string().min(1).nullable(),
 }).strict()),
}).strict();
export type PricingBasis=z.infer<typeof pricingBasisSchema>;
export type PricingResult={state:'amount_unknown';reason:string}|{state:'no_upgrade';basis_minor:number;reason:'below_threshold'}|{state:'eligible';basis_minor:number;total_minor:number;pricing_version:string};

/** Pure commercial arithmetic. Incomplete or ambiguous inputs never disclose a tier. */
export function priceSavedBasis(raw:unknown):PricingResult{return priceUnderPolicy(raw,productOffer().full_report.pricing);}
function priceUnderPolicy(raw:unknown,policy:PriceQuote['pricing_policy']):PricingResult{
 const parsed=pricingBasisSchema.safeParse(raw);if(!parsed.success)return {state:'amount_unknown',reason:'invalid_saved_basis'};
 const basis=parsed.data;
 if(new Set(basis.checked_months).size!==basis.checked_months.length||new Set(basis.checked_topics).size!==basis.checked_topics.length)return {state:'amount_unknown',reason:'ambiguous_coverage'};
 const economic=new Map<string,string>(),findings=new Map<string,string>();let total=0;
 for(const c of basis.components){
  if(!['wage_gap','fund_deposit'].includes(c.kind))continue;
  if(!c.active||!c.basis_complete||c.certainty==='low')return {state:'amount_unknown',reason:'amount_not_publishable'};
  if(!basis.checked_months.includes(c.month)||!basis.checked_topics.includes(c.topic))return {state:'amount_unknown',reason:'component_outside_checked_scope'};
  if(c.alternative_group||c.direction==='employee_owes')return {state:'amount_unknown',reason:'unresolved_alternative_or_offset'};
  if(c.range&&c.range.low>c.range.high)return {state:'amount_unknown',reason:'invalid_range'};
  if(c.certainty==='high'&&c.range!==null||c.certainty==='medium'&&c.amount!==null)return {state:'amount_unknown',reason:'ambiguous_amount_representation'};
  const amount=c.certainty==='medium'?c.range?.low:c.amount;
  if(amount===null||amount===undefined)return {state:'amount_unknown',reason:'amount_missing'};
  if(c.direction==='none'&&amount!==0)return {state:'amount_unknown',reason:'direction_mismatch'};
  const key=`${c.month}:${c.economic_key}`;
  const signature=canonicalSha256({amount,kind:c.kind,direction:c.direction,topic:c.topic,month:c.month,economic_key:c.economic_key});
  if((economic.has(key)&&economic.get(key)!==signature)||(findings.has(c.finding_id)&&findings.get(c.finding_id)!==signature))return {state:'amount_unknown',reason:'conflicting_duplicate'};
  if(economic.has(key)||findings.has(c.finding_id))continue;
  economic.set(key,signature);findings.set(c.finding_id,signature);total+=amount;
  if(!Number.isSafeInteger(total))return {state:'amount_unknown',reason:'amount_overflow'};
 }
 if(economic.size===0)return {state:'amount_unknown',reason:'no_quantified_components'};
 const tier=policy.tiers.findLast(t=>total>=t.minimum_basis_minor);
 return tier?{state:'eligible',basis_minor:total,total_minor:tier.total_minor,pricing_version:policy.version}:{state:'no_upgrade',basis_minor:total,reason:'below_threshold'};
}

export type InitialCredit={order_id:string;case_id:string;identity_id:string;verified:boolean;paid_minor:number;already_consumed:boolean};
export function createPriceQuote(input:{basis:PricingBasis;caseId:string;identityId:string;from:string;to:string;topics:readonly string[];credit:InitialCredit;now:Date}){
 const basis=pricingBasisSchema.parse(input.basis);
 if(basis.case_id!==input.caseId||basis.identity_id!==input.identityId)throw new Error('PRICING_FORBIDDEN');
 month.parse(input.from);month.parse(input.to);
 const monthCount=(Number(input.to.slice(0,4))-Number(input.from.slice(0,4)))*12+Number(input.to.slice(5))-Number(input.from.slice(5))+1;
 if(monthCount<1||monthCount>600||input.topics.length===0||new Set(input.topics).size!==input.topics.length)throw new Error('PRICING_PURCHASE_SCOPE');
 if(basis.checked_months.some(m=>m<input.from||m>input.to)||basis.checked_topics.some(t=>!input.topics.includes(t)))throw new Error('PRICING_PURCHASE_SCOPE');
 const result=priceSavedBasis(basis);if(result.state!=='eligible')return result;
 const credit=input.credit;
 if(!credit.verified||credit.case_id!==input.caseId||credit.identity_id!==input.identityId||!z.uuid().safeParse(credit.order_id).success||!Number.isSafeInteger(credit.paid_minor)||credit.paid_minor<0)throw new Error('PRICING_CREDIT_UNVERIFIED');
 const initialMinor=Number(productOffer().initial_check.price.amount.replace('.',''));
 const credited=credit.already_consumed?0:Math.min(initialMinor,credit.paid_minor,result.total_minor);
 const quote={...result,analysis_version:basis.analysis_version,input_sha256:basis.input_sha256,basis_sha256:canonicalSha256(basis),case_id:input.caseId,identity_id:input.identityId,checked_months:basis.checked_months,checked_topics:basis.checked_topics,purchased_period:{from:input.from,to:input.to},purchased_topics:[...input.topics],credit_order_id:credited?credit.order_id:null,credit_minor:credited,balance_minor:result.total_minor-credited,created_at:input.now.toISOString(),expires_at:new Date(input.now.getTime()+productOffer().full_report.pricing.quote_valid_days*86400000).toISOString()};
 const snapshot={...quote,schema_version:'tivdoc-price-quote-v1' as const,pricing_policy:structuredClone(productOffer().full_report.pricing),initial_credit_cap_minor:initialMinor};
 return priceQuoteSchema.parse({...snapshot,sha256:canonicalSha256(snapshot)});
}

/** Corrections can open a refund request; this never asserts provider settlement. */
export function pricingRefundDifference(paid:{total_minor:number;upgrade_paid_minor:number},corrected:PricingResult):number|null{
 if(corrected.state==='amount_unknown')return null;
 if(!Number.isSafeInteger(paid.total_minor)||!Number.isSafeInteger(paid.upgrade_paid_minor)||paid.upgrade_paid_minor<0||paid.total_minor<paid.upgrade_paid_minor)throw new Error('PRICING_PAID_SNAPSHOT_INVALID');
 return corrected.state==='no_upgrade'?paid.upgrade_paid_minor:Math.max(0,Math.min(paid.upgrade_paid_minor,paid.total_minor-corrected.total_minor));
}

/** Commercial correction arithmetic for the SAME originally checked scope.
 * It does not establish payment, create a refund request or confirm settlement.
 * A persisted paid-order adapter must bind this quote and canonical basis first.
 * Historical purchases use their saved policy, never today's price table. */
export function quoteCorrectionRefund(candidateQuote:unknown,candidateBasis:unknown){
 const parsedQuote=priceQuoteSchema.safeParse(candidateQuote),parsedBasis=pricingBasisSchema.safeParse(candidateBasis);
 if(!parsedQuote.success||!parsedBasis.success)return {state:'amount_unknown' as const,reason:'invalid_correction_basis_or_quote'};
 const quote=parsedQuote.data,basis=parsedBasis.data;
 const same=(a:readonly string[],b:readonly string[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 if(basis.case_id!==quote.case_id||basis.identity_id!==quote.identity_id||!same(basis.checked_months,quote.checked_months)||!same(basis.checked_topics,quote.checked_topics))return {state:'amount_unknown' as const,reason:'correction_scope_mismatch'};
 const corrected=priceUnderPolicy(basis,quote.pricing_policy);if(corrected.state==='amount_unknown')return corrected;
 return {state:'calculated' as const,pricing_version:quote.pricing_version,quote_sha256:quote.sha256,corrected_basis_sha256:canonicalSha256(basis),
  corrected_basis_minor:corrected.basis_minor,refund_minor:pricingRefundDifference({total_minor:quote.total_minor,upgrade_paid_minor:quote.balance_minor},corrected)!};
}
