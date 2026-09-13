import 'server-only';
import {z} from 'zod';
import {productOffer} from '@/lib/product-offer';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PROJECTION_TOPICS} from '../reports/case-report-projection';
import {SERVICE_CALENDAR_2026} from '../reports/business-clock';
import {priceQuoteSchema,type PriceQuote} from './price-quote';
import {PURCHASE_TOPICS_VERSION,RELEASE_PURCHASE_TOPICS} from './purchase-topics';

/** New AI offer only. Historical v1 orders keep their actual review/SLA terms.
 * Business-hour scheduling does not claim that a person reviewed the report. */
export function quotedFullOffer(candidate:PriceQuote,termsVersion:string){
 const quote=priceQuoteSchema.parse(candidate);z.string().min(1).parse(termsVersion);
 const delivery=structuredClone(productOffer().full_report.delivery);
 const budget=delivery.value*(delivery.unit==='business_days'?8*3600000:delivery.unit==='hours'?3600000:60000);
 z.number().int().positive().safe().parse(budget);
 const payload={version:'tivdoc-order-offer-v2' as const,kind:'full' as const,amount_minor:quote.balance_minor,currency:'ILS' as const,
  terms_version:termsVersion,maximum_checked_topics:7,topic_order:[...PROJECTION_TOPICS],human_review_required:false,
  service_kind:'ai_assisted' as const,
  price_quote_sha256:quote.sha256,price_quote:quote,delivery,
  sla:{track:delivery.unit==='business_days'?'business' as const:'automatic' as const,budget_ms:budget,calendar:structuredClone(SERVICE_CALENDAR_2026),time_zone:'Asia/Jerusalem'},
 };
 // The ID is bound by the caller after the persisted quote row is loaded.
 return quote.schema_version==='tivdoc-price-quote-v2'
  ?{...payload,version:'tivdoc-order-offer-v3' as const,purchase_topics_version:PURCHASE_TOPICS_VERSION,maximum_checked_topics:9,topic_order:[...RELEASE_PURCHASE_TOPICS]}
  :payload;
}
export type QuotedFullOffer=ReturnType<typeof quotedFullOffer>&{price_quote_id:string;sha256:string};

/** One private SQL call creates the full order and its credit reservation, or
 * rolls both back. No provider invocation, entitlement grant or sale flag.
 * There is no customer-supplied price, offer, clock or credit in this API. */
export async function acceptSavedPriceQuote(context:PostgresTransactionContext,candidate:{quoteId:string;caseId:string;identityId:string}){
 const input=z.object({quoteId:z.uuid(),caseId:z.uuid(),identityId:z.uuid()}).strict().parse(candidate);
 const selected=await context.client.query(statement('quoted_order_snapshot',
  'select snapshot,quote_sha256,terms_version from private.order_price_quotes where id=$1::uuid and case_id=$2::uuid and identity_id=$3::uuid',
  [input.quoteId,input.caseId,input.identityId]));
 const row=selected.rows[0];if(!row)throw new Error('PRICE_QUOTE_FORBIDDEN');
 const quote=priceQuoteSchema.parse(row.snapshot);
 if(quote.sha256!==row.quote_sha256||quote.case_id!==input.caseId||quote.identity_id!==input.identityId)throw new Error('PRICE_QUOTE_INVALID');
 const payload={...quotedFullOffer(quote,z.string().parse(row.terms_version)),price_quote_id:input.quoteId};
 const offer:QuotedFullOffer={...payload,sha256:canonicalSha256(payload)};
 const result=await context.client.query(statement('quoted_order_accept',
  'select private.order_quote_accept($1::uuid,$2::jsonb) value',[input.quoteId,JSON.stringify(offer)]));
 return z.object({replayed:z.boolean(),order:z.object({id:z.uuid(),case_id:z.uuid(),kind:z.literal('full'),amount_minor:z.number().int().positive(),currency:z.literal('ILS'),state:z.enum(['awaiting_payment','paid']),offer:z.unknown()}).passthrough()}).strict().parse(result.rows[0]?.value);
}
