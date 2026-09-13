import {z} from 'zod';
import {productOffer} from '../../../lib/product-offer.ts';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical.ts';
import {PROJECTION_TOPICS} from '../reports/case-report-projection.ts';
import {SERVICE_CALENDAR_2026,SLA_BUDGET_MS} from '../reports/business-clock.ts';
import {TERMS_VERSION} from '../../../lib/legal-terms.ts';
import type {QuotedFullOffer} from './quoted-order';
import {PURCHASE_TOPICS_VERSION,RELEASE_PURCHASE_TOPICS} from './purchase-topics';
export const orderRequestSchema=z.object({kind:z.enum(['initial','full']),from:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),to:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict().superRefine((v,c)=>{if(v.from>v.to||v.kind==='initial'&&v.from!==v.to)c.addIssue({code:'custom',message:'ORDER_PERIOD_INVALID'});});
export type OrderRequest=z.infer<typeof orderRequestSchema>;
export function offerSnapshot(kind:OrderRequest['kind']){
 if(kind==='full')throw new OrderError('ORDER_PRICING_BASIS_UNAVAILABLE');
 const config=productOffer();const price=config.initial_check.price;
 const snapshot={version:'tivdoc-order-offer-v1',kind:kind as 'initial'|'full',amount_minor:Number(price.amount.replace('.','')),currency:price.currency,terms_version:TERMS_VERSION,maximum_checked_topics:3,topic_order:[...PROJECTION_TOPICS],human_review_required:false as boolean,sla:{automatic_ms:SLA_BUDGET_MS.initial_automatic as number|null,human_ms:SLA_BUDGET_MS.initial_human,calendar:SERVICE_CALENDAR_2026,time_zone:'Asia/Jerusalem'}};
 return {...snapshot,sha256:canonicalSha256(snapshot)};
}
/** Explicit new-service constructor. The old constructor keeps its exact v1
 * snapshot; new initial purchases retain their price and max-three terms. */
export function releaseInitialOfferSnapshot(){
 const {sha256,...historical}=offerSnapshot('initial');void sha256;
 const snapshot={...historical,version:'tivdoc-order-offer-v3' as const,kind:'initial' as const,
  purchase_topics_version:PURCHASE_TOPICS_VERSION,topic_order:[...RELEASE_PURCHASE_TOPICS]};
 return {...snapshot,sha256:canonicalSha256(snapshot)};
}
export const priceCorrectionStatusSchema=z.object({state:z.literal('requested'),cumulative_refund_minor:z.number().int().positive().safe(),requested_at:z.iso.datetime({offset:true})}).strict();
export type ProductOrder={id:string;case_id:string;kind:'initial'|'full';period_from:string;period_to:string;amount_minor:number;currency:'ILS';state:'awaiting_payment'|'paid'|'cancelled';refund_state:'none'|'requested'|'processing'|'refunded'|'rejected';offer:ReturnType<typeof offerSnapshot>|ReturnType<typeof releaseInitialOfferSnapshot>|QuotedFullOffer;terms_version:string;topics:string[];created_at:string;verified_at:string|null;published_at:string|null;checkout_state:'none'|'creating'|'ready'|'uncertain';checkout_url:string|null;payment_id:string|null;receipt_url:string|null;can_cancel_unstarted?:boolean;price_correction?:z.infer<typeof priceCorrectionStatusSchema>|null;};
export class OrderError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
