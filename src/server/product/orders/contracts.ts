import {z} from 'zod';
import {productOffer} from '../../../lib/product-offer.ts';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical.ts';
import {PROJECTION_TOPICS} from '../reports/case-report-projection.ts';
import {SERVICE_CALENDAR_2026,SLA_BUDGET_MS} from '../reports/business-clock.ts';
import {TERMS_VERSION} from '../../../lib/legal-terms.ts';
export const orderRequestSchema=z.object({kind:z.enum(['initial','full']),from:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),to:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict().superRefine((v,c)=>{if(v.from>v.to||v.kind==='initial'&&v.from!==v.to)c.addIssue({code:'custom',message:'ORDER_PERIOD_INVALID'});});
export type OrderRequest=z.infer<typeof orderRequestSchema>;
export function offerSnapshot(kind:OrderRequest['kind']){
 const config=productOffer();const price=kind==='initial'?config.initial_check.price:config.full_report.price;
 const snapshot={version:'tivdoc-order-offer-v1',kind,amount_minor:Number(price.amount.replace('.','')),currency:price.currency,terms_version:TERMS_VERSION,maximum_checked_topics:kind==='initial'?3:7,topic_order:[...PROJECTION_TOPICS],human_review_required:kind==='full',sla:{automatic_ms:kind==='initial'?SLA_BUDGET_MS.initial_automatic:null,human_ms:kind==='initial'?SLA_BUDGET_MS.initial_human:SLA_BUDGET_MS.full_human,calendar:SERVICE_CALENDAR_2026,time_zone:'Asia/Jerusalem'}};
 return {...snapshot,sha256:canonicalSha256(snapshot)};
}
export type ProductOrder={id:string;case_id:string;kind:'initial'|'full';period_from:string;period_to:string;amount_minor:number;currency:'ILS';state:'awaiting_payment'|'paid'|'cancelled';refund_state:'none'|'requested'|'processing'|'refunded'|'rejected';offer:ReturnType<typeof offerSnapshot>;terms_version:string;topics:string[];created_at:string;verified_at:string|null;published_at:string|null;checkout_state:'none'|'creating'|'ready'|'uncertain';checkout_url:string|null;payment_id:string|null;receipt_url:string|null;};
export class OrderError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
