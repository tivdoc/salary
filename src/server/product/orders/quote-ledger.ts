import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {TERMS_VERSION} from '@/lib/legal-terms';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PROJECTION_TOPICS} from '../reports/case-report-projection';
import {createPriceQuote,pricingBasisSchema,type PricingBasis,type InitialCredit} from './pricing';
import {priceQuoteSchema,requireFreshPriceQuote} from './price-quote';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const requestSchema=z.object({id:z.uuid(),caseId:z.uuid(),identityId:z.uuid(),from:month,to:month,
 topics:z.array(z.enum(PROJECTION_TOPICS)).min(1).max(7).refine(v=>new Set(v).size===v.length),
}).strict();
type QuoteRequest=z.infer<typeof requestSchema>;
/** Only a server implementation that loads immutable canonical evidence belongs
 * here. No default reader or HTTP amount/basis field is provided. Null means no
 * trusted monetary basis, including the current inactive real-rule catalog. */
export type SavedPricingBasisReader=(context:PostgresTransactionContext,source:{caseId:string;identityId:string;inputSha256:string})=>Promise<PricingBasis|null>;
const contextSchema=z.object({input_sha256:hash,now:z.iso.datetime(),credit:z.object({
 order_id:z.uuid(),case_id:z.uuid(),identity_id:z.uuid(),verified:z.literal(true),paid_minor:z.number().int().nonnegative().safe(),already_consumed:z.boolean(),
}).strict().nullable()}).strict();
const rowSchema=z.object({id:z.uuid(),request_sha256:hash,snapshot:z.unknown(),quote_sha256:hash,terms_version:z.string().min(1)});

/** Caller owns ONE verified worker transaction, including rollback on refusal.
 * The database locks the case before reading credit/source/identity. Issuance
 * never reserves credit, creates an order or authorizes a sale. */
export async function issueSavedPriceQuote(context:PostgresTransactionContext,candidate:QuoteRequest,readBasis:SavedPricingBasisReader){
 const request=requestSchema.parse(candidate);
 const loaded=await context.client.query(statement('price_quote_context',
  'select private.order_quote_context($1::uuid,$2::uuid) value',[request.caseId,request.identityId]));
 const current=contextSchema.parse(loaded.rows[0]?.value);
 const requestHash=canonicalSha256(request);
 const previous=await context.client.query(statement('price_quote_previous',
  'select id,request_sha256,snapshot,quote_sha256,terms_version from private.order_price_quotes where id=$1::uuid and case_id=$2::uuid and identity_id=$3::uuid',
  [request.id,request.caseId,request.identityId]));
 const fresh={caseId:request.caseId,identityId:request.identityId,inputSha256:current.input_sha256,now:new Date(current.now)};
 if(previous.rows.length){
  const row=rowSchema.parse(previous.rows[0]);
  if(row.request_sha256!==requestHash)throw new Error('PRICE_QUOTE_REQUEST_CONFLICT');
  const quote=requireFreshPriceQuote(row.snapshot,fresh);
  if(quote.sha256!==row.quote_sha256)throw new Error('PRICE_QUOTE_INVALID');
  return {state:'quoted' as const,id:row.id,quote,termsVersion:row.terms_version,replayed:true};
 }
 if(!current.credit)return {state:'amount_unknown' as const,reason:'verified_initial_credit_unavailable'};
 const candidateBasis=await readBasis(context,{caseId:request.caseId,identityId:request.identityId,inputSha256:current.input_sha256});
 if(candidateBasis===null)return {state:'amount_unknown' as const,reason:'trusted_monetary_basis_unavailable'};
 const parsed=pricingBasisSchema.safeParse(candidateBasis);
 if(!parsed.success)return {state:'amount_unknown' as const,reason:'invalid_saved_basis'};
 if(parsed.data.input_sha256!==current.input_sha256)throw new Error('PRICE_QUOTE_SOURCE_CHANGED');
 const result=createPriceQuote({basis:parsed.data,...request,credit:current.credit as InitialCredit,now:new Date(current.now)});
 if(result.state!=='eligible')return result;
 const quote=priceQuoteSchema.parse(result);
 await context.client.query(statement('price_quote_insert',
  'insert into private.order_price_quotes(id,case_id,identity_id,request_sha256,snapshot,quote_sha256,terms_version) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7)',
  [request.id,request.caseId,request.identityId,requestHash,JSON.stringify(quote),quote.sha256,TERMS_VERSION]));
 return {state:'quoted' as const,id:request.id,quote,termsVersion:TERMS_VERSION,replayed:false};
}

/** Reserve once against the exact full order constructed in this transaction.
 * Its offer must bind quote ID/hash, price, scope and terms. There is deliberately
 * no release-on-timeout: an uncertain provider outcome cannot free a credit for
 * a second purchase. Provider cancellation/refund reconciliation is separate. */
export async function reserveSavedQuoteCredit(context:PostgresTransactionContext,input:{quoteId:string;orderId:string}){
 z.uuid().parse(input.quoteId);z.uuid().parse(input.orderId);
 const result=await context.client.query(statement('price_quote_reserve',
  'select private.order_quote_reserve($1::uuid,$2::uuid) value',[input.quoteId,input.orderId]));
 return z.object({quote_id:z.uuid(),case_id:z.uuid(),order_id:z.uuid(),credit_order_id:z.uuid().nullable(),credit_minor:z.number().int().nonnegative().safe(),reserved_at:z.iso.datetime({offset:true}),released_at:z.iso.datetime({offset:true}).nullable().default(null),release_reason:z.enum(['customer_changed_scope','source_changed','quote_expired']).nullable().default(null)}).strict().parse(result.rows[0]?.value);
}
