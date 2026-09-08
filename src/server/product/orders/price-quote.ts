import {z} from 'zod';
import {productOfferSchema} from '@/lib/product-offer';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {PROJECTION_TOPICS} from '../reports/case-report-projection';

const minor=z.number().int().nonnegative().safe();
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const topics=z.array(z.enum(PROJECTION_TOPICS)).min(1).max(7).refine(v=>new Set(v).size===v.length);
/** A stored quote validates against its own policy snapshot. Reading history
 * must never silently recalculate an old purchase with today's price policy.
 * This is an integrity contract, not evidence that its monetary basis is true;
 * the issuer must load that basis and paid credit from their trusted stores. */
export const priceQuoteSchema=z.object({
 schema_version:z.literal('tivdoc-price-quote-v1'),state:z.literal('eligible'),
 pricing_version:z.string().min(1),pricing_policy:productOfferSchema.shape.full_report.shape.pricing,
 initial_credit_cap_minor:minor,
 case_id:z.uuid(),identity_id:z.uuid(),analysis_version:z.string().min(1),input_sha256:hash,basis_sha256:hash,
 checked_months:z.array(month).min(1).max(600).refine(v=>new Set(v).size===v.length),checked_topics:topics,
 purchased_period:z.object({from:month,to:month}).strict(),purchased_topics:topics,
 basis_minor:minor,total_minor:minor,credit_order_id:z.uuid().nullable(),credit_minor:minor,balance_minor:minor,
 created_at:z.iso.datetime(),expires_at:z.iso.datetime(),sha256:hash,
}).strict().superRefine((quote,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 const {sha256,...payload}=quote;
 if(canonicalSha256(payload)!==sha256)fail('QUOTE_HASH_MISMATCH');
 const tier=quote.pricing_policy.tiers.findLast(t=>quote.basis_minor>=t.minimum_basis_minor);
 if(!tier||tier.total_minor!==quote.total_minor||quote.pricing_version!==quote.pricing_policy.version)fail('QUOTE_POLICY_MISMATCH');
 if(quote.credit_minor>Math.min(quote.initial_credit_cap_minor,quote.total_minor)
  ||quote.balance_minor!==quote.total_minor-quote.credit_minor
  ||(quote.credit_minor===0)!==(quote.credit_order_id===null))fail('QUOTE_CREDIT_MISMATCH');
 const {from,to}=quote.purchased_period;
 const count=(Number(to.slice(0,4))-Number(from.slice(0,4)))*12+Number(to.slice(5))-Number(from.slice(5))+1;
 if(count<1||count>600||quote.checked_months.some(m=>m<from||m>to)
  ||quote.checked_topics.some(t=>!quote.purchased_topics.includes(t)))fail('QUOTE_SCOPE_MISMATCH');
 if(Date.parse(quote.expires_at)-Date.parse(quote.created_at)!==quote.pricing_policy.quote_valid_days*86400000)fail('QUOTE_EXPIRY_MISMATCH');
});
export type PriceQuote=z.infer<typeof priceQuoteSchema>;

/** Call against a server-loaded current input and the database clock before
 * reserving an unpaid quote. Paid history uses the schema alone, never this
 * freshness guard. Passing this check does not reserve or consume any credit. */
export function requireFreshPriceQuote(raw:unknown,current:{caseId:string;identityId:string;inputSha256:string;now:Date}):PriceQuote{
 const parsed=priceQuoteSchema.safeParse(raw);
 if(!parsed.success)throw new Error('PRICE_QUOTE_INVALID');
 const quote=parsed.data;
 if(quote.case_id!==current.caseId||quote.identity_id!==current.identityId)throw new Error('PRICE_QUOTE_FORBIDDEN');
 if(quote.input_sha256!==current.inputSha256)throw new Error('PRICE_QUOTE_SOURCE_CHANGED');
 const now=current.now.getTime();
 if(!Number.isFinite(now)||now<Date.parse(quote.created_at)||now>=Date.parse(quote.expires_at))throw new Error('PRICE_QUOTE_EXPIRED');
 return quote;
}
