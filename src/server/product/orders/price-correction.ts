import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {priceQuoteSchema} from './price-quote';
import {pricingBasisSchema,quoteCorrectionRefund} from './pricing';
import type {PricingBasis} from './pricing';
import type {PriceQuote} from './price-quote';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const requestSchema=z.object({id:z.uuid(),caseId:z.uuid(),identityId:z.uuid(),orderId:z.uuid()}).strict();
const receiptSchema=z.object({id:z.uuid(),order_id:z.uuid(),state:z.literal('requested'),cumulative_refund_minor:z.number().int().positive().safe(),requested_at:z.iso.datetime({offset:true})}).strict();
export type SavedCorrectedPricingBasisReader=(context:PostgresTransactionContext,source:{caseId:string;identityId:string;inputSha256:string;checkedMonths:PriceQuote['checked_months'];checkedTopics:PriceQuote['checked_topics']})=>Promise<PricingBasis|null>;

/** One verified worker transaction. The reader must load canonical corrected
 * evidence for the ORIGINAL checked scope. No HTTP amount or default reader.
 * Receipts are cumulative requests, never additive payouts or settlement. */
export async function requestSavedPriceCorrection(context:PostgresTransactionContext,candidate:z.infer<typeof requestSchema>,readBasis:SavedCorrectedPricingBasisReader){
 const input=requestSchema.parse(candidate);
 const loaded=await context.client.query(statement('price_correction_context',
  'select private.order_price_correction_context($1::uuid,$2::uuid,$3::uuid,$4::uuid) value',
  [input.caseId,input.identityId,input.orderId,input.id]));
 const saved=z.object({input_sha256:hash,quote_id:z.uuid(),quote_sha256:hash,quote:z.unknown(),previous:receiptSchema.nullable()}).strict().parse(loaded.rows[0]?.value);
 if(saved.previous){
  if(saved.previous.id!==input.id||saved.previous.order_id!==input.orderId)throw new Error('PRICE_CORRECTION_ACK_MISMATCH');
  return {...saved.previous,replayed:true};
 }
 const quote=priceQuoteSchema.parse(saved.quote);
 if(quote.sha256!==saved.quote_sha256||quote.case_id!==input.caseId||quote.identity_id!==input.identityId)throw new Error('PRICE_CORRECTION_QUOTE_MISMATCH');
 const raw=await readBasis(context,{caseId:input.caseId,identityId:input.identityId,inputSha256:saved.input_sha256,checkedMonths:[...quote.checked_months],checkedTopics:[...quote.checked_topics]});
 if(raw===null)return {state:'amount_unknown' as const,reason:'trusted_monetary_basis_unavailable'};
 const parsed=pricingBasisSchema.safeParse(raw);
 if(!parsed.success)return {state:'amount_unknown' as const,reason:'invalid_saved_basis'};
 const basis=parsed.data;
 if(basis.input_sha256!==saved.input_sha256)throw new Error('PRICE_CORRECTION_SOURCE_CHANGED');
 const correction=quoteCorrectionRefund(quote,basis);
 if(correction.state==='amount_unknown')return correction;
 if(correction.refund_minor===0)return {state:'no_adjustment' as const};
 const written=await context.client.query(statement('price_correction_request',
  'select private.order_price_correction_request($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::bigint,$9::integer) value',
  [input.caseId,input.identityId,input.orderId,input.id,quote.sha256,JSON.stringify(basis),canonicalSha256(basis),correction.corrected_basis_minor,correction.refund_minor]));
 const result=receiptSchema.extend({replayed:z.boolean()}).strict().parse(written.rows[0]?.value);
 if(result.order_id!==input.orderId||result.cumulative_refund_minor<correction.refund_minor)throw new Error('PRICE_CORRECTION_ACK_MISMATCH');
 return result;
}
