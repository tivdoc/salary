import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {CanonicalPostgresError} from '@/server/platform/persistence/postgres/runtime/errors';
import {RELEASE_PURCHASE_TOPICS,PURCHASE_TOPICS_VERSION} from '../orders/purchase-topics';
import {createSavedReleasePricingBasisReader,savedReleasePricingUnsupportedTopics} from '../orders/saved-release-pricing-basis';
import {issueSavedReleasePriceQuote} from '../orders/quote-ledger';
import {acceptSavedPriceQuote} from '../orders/quoted-order';
import {readSavedOrders,purchasedMonths,savedOrderReceiptSha256} from './saved-order-scope';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedAnalysisId} from './saved-draft-report';

const selectionSchema=z.object({job:sourceJobSchema,orderId:z.uuid(),identityId:z.uuid(),
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),analysisRunId:z.string().min(1)}).strict();
export type SavedReleaseQuoteStageInput={context:PostgresTransactionContext;job:SourceJob;orderId:string;identityId:string;month:string;analysisRunId:string};
export type SavedReleaseQuoteStageResult=
 |{state:'offer_saved';quote_id:string;order_id:string;replayed:boolean;period:{from:string;to:string};topics:readonly string[]}
 |{state:'skipped';reason:string;unsupported_topics?:readonly string[]};
const expectedRefusals=new Set(['PRICE_QUOTE_EXPIRED','PRICE_QUOTE_CREDIT_UNAVAILABLE',
 'PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION','ORDER_COVERAGE_UNAVAILABLE']);

/** After ordinary REAL initial report publication, prepare an optional saved
 * nine-topic offer for ONLY that same checked month. The customer must still
 * choose checkout and accept its actual terms; this performs no payment call.
 * Deterministic identity reuses the same saved quote/order on retries. Expiry
 * never creates a replacement ID or resets a credit. A changed source gets a
 * distinct quote identity; an existing awaiting order/credit reservation then
 * requires the existing cancelUnstartedQuotedOrder/reconciliation workflow.
 * This stage never cancels an order, releases credit, edits terms or extends
 * coverage to an unrequested broader period. Unsupported pricing is a software
 * boundary; incomplete supported comparisons are a separate explicit outcome.
 * Expected commercial refusals roll back ONLY this savepoint, so a published
 * initial report is not lost. Authority, source and integrity errors still fail
 * the enclosing transaction. Caller owns transaction commit/rollback.
 */
export async function prepareSavedReleaseQuoteStage(candidate:SavedReleaseQuoteStageInput):Promise<SavedReleaseQuoteStageResult>{
 const {context,...raw}=candidate,input=selectionSchema.parse(raw),{job,orderId,identityId,month,analysisRunId}=input;
 const orders=await readSavedOrders(context,job,orderId);
 if(orders.length!==1||orders[0].id!==orderId)throw Error('RELEASE_QUOTE_INITIAL_ORDER_SCOPE');
 const order=orders[0];if(order.kind!=='initial'&&order.kind!=='legacy_initial')return {state:'skipped',reason:'not_initial_order'};
 const months=purchasedMonths(order);
 if(months.length!==1||months[0]!==month)return {state:'skipped',reason:'initial_pricing_requires_exact_single_month'};
 const unsupported=savedReleasePricingUnsupportedTopics(order.topics);
 if(unsupported.length)return {state:'skipped',reason:'pricing_adapter_unsupported_topics',unsupported_topics:unsupported};
 const quoteId=savedAnalysisId('saved-release-initial-full-quote-v1',canonicalSha256({case_id:job.case_id,
  identity_id:identityId,source:job,analysis_run_id:analysisRunId,initial_order_id:orderId,initial_receipt_sha256:savedOrderReceiptSha256(order),
  purchased_period:{from:month,to:month},purchase_topics_version:PURCHASE_TOPICS_VERSION,purchased_topics:RELEASE_PURCHASE_TOPICS}));
 let unavailableReason:string|undefined;
 const reader=createSavedReleasePricingBasisReader(job,reason=>{unavailableReason=reason;});
 await context.client.query(statement('release_quote_stage_savepoint','savepoint saved_release_quote_stage',[]));
 try{
  const issued=await issueSavedReleasePriceQuote(context,{id:quoteId,caseId:job.case_id,identityId,from:month,to:month,topics:[...RELEASE_PURCHASE_TOPICS]},async(tx,source)=>{
   const basis=await reader(tx,source);
   if(basis&&(basis.analysis_version!==analysisRunId||basis.checked_months.length!==1||basis.checked_months[0]!==month))throw Error('RELEASE_QUOTE_ANALYSIS_SCOPE');
   return basis;
  });
  if(issued.state!=='quoted'){
   await context.client.query(statement('release_quote_stage_release','release savepoint saved_release_quote_stage',[]));
   return {state:'skipped',reason:issued.reason==='trusted_monetary_basis_unavailable'?(unavailableReason??'supported_comparison_basis_unavailable'):issued.reason};
  }
  if(issued.quote.analysis_version!==analysisRunId||issued.quote.input_sha256!==job.input_sha256
   ||issued.quote.purchased_period.from!==month||issued.quote.purchased_period.to!==month
   ||canonicalSha256(issued.quote.purchased_topics)!==canonicalSha256(RELEASE_PURCHASE_TOPICS))throw Error('RELEASE_QUOTE_SAVED_SCOPE');
  const accepted=await acceptSavedPriceQuote(context,{quoteId:issued.id,caseId:job.case_id,identityId});
  if(accepted.order.case_id!==job.case_id||accepted.order.amount_minor!==issued.quote.balance_minor)throw Error('RELEASE_QUOTE_ORDER_ACK');
  await context.client.query(statement('release_quote_stage_release','release savepoint saved_release_quote_stage',[]));
  return {state:'offer_saved',quote_id:issued.id,order_id:accepted.order.id,replayed:issued.replayed&&accepted.replayed,
   period:{from:month,to:month},topics:[...RELEASE_PURCHASE_TOPICS]};
 }catch(error){
  await context.client.query(statement('release_quote_stage_rollback','rollback to savepoint saved_release_quote_stage',[]));
  await context.client.query(statement('release_quote_stage_release','release savepoint saved_release_quote_stage',[]));
  const refusal=error instanceof CanonicalPostgresError&&error.sqlstate==='P0001'?error.domain_code:error instanceof Error?error.message:null;
  if(refusal&&expectedRefusals.has(refusal))return {state:'skipped',reason:refusal};
  throw error;
 }
}
