import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import pg from 'pg';
import {attachDatabasePool} from '@vercel/functions';
import {Invoice4uClient,invoice4uErrorCode} from '../../../lib/invoice4u';
import {createPaymentReturnToken,hashPaymentReturnToken,getPaymentReturnUrl} from '../../../lib/payment';
import {validateInvoice4uClearingLog,PaymentVerificationError} from '../../../lib/payment-verification';
import {resolveCaseAccessDb,postgresCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {offerSnapshot,releaseInitialOfferSnapshot,orderRequestSchema,priceCorrectionStatusSchema,OrderError,type OrderRequest,type ProductOrder} from './contracts';
import {requireFreshPriceQuote} from './price-quote';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {releaseQuoteAvailabilitySchema,type ReleaseQuoteAvailability} from './release-quote-status';
import {hashSession,isOpaqueToken} from '../case-access/crypto';

export type CustomerReleaseQuote={id:string;from:string;to:string;topics:string[];total_minor:number;credit_minor:number;balance_minor:number;currency:'ILS';expires_at:string};
async function storeOrThrow(db?:CaseAccessDb){const store=db??await resolveCaseAccessDb();if(!store)throw new OrderError('ORDER_STORE_UNAVAILABLE');return store;}
export async function createOrder(input:{caseId:string;identityId:string|null;request:OrderRequest},db?:CaseAccessDb){
 const request=orderRequestSchema.parse(input.request);const store=await storeOrThrow(db);
 const result=await store.rpc<{value:ProductOrder}>('case_order_create',{target_case:input.caseId,target_identity:input.identityId,target_kind:request.kind,target_from:request.from+'-01',target_to:request.to+'-01',target_offer:offerSnapshot(request.kind)});
 if(!result[0]?.value)throw new OrderError('ORDER_NOT_CREATED');return result[0].value;
}
export async function customerOrders(caseId:string,identityId:string,db?:CaseAccessDb){const store=await storeOrThrow(db);const rows=await store.rpc<{value:ProductOrder[]}>('case_order_snapshot',{target_case:caseId,target_identity:identityId});if(!Array.isArray(rows[0]?.value))throw new OrderError('ORDER_STORE_UNAVAILABLE');return rows[0].value.map(order=>{if(order.can_cancel_unstarted!==undefined&&typeof order.can_cancel_unstarted!=='boolean')throw new OrderError('ORDER_STORE_UNAVAILABLE');if(order.price_correction==null)return order;const parsed=priceCorrectionStatusSchema.safeParse(order.price_correction);if(!parsed.success||order.kind!=='full'||order.state!=='paid'||!Number.isSafeInteger(order.amount_minor)||parsed.data.cumulative_refund_minor>order.amount_minor)throw new OrderError('ORDER_STORE_UNAVAILABLE');return {...order,price_correction:parsed.data};});}
export async function orderCheckout(input:{caseId:string;identityId:string|null;orderId:string;termsAccepted:boolean},db?:CaseAccessDb,provider?:Pick<Invoice4uClient,"createCheckout">){
 if(!input.termsAccepted)throw new OrderError('ORDER_TERMS_REQUIRED');const store=await storeOrThrow(db);
 const rows=await store.rpc<{value:ProductOrder&{public_id:string}}>('case_order_get',{target_case:input.caseId,target_identity:input.identityId,target_order:input.orderId});const order=rows[0]?.value;if(!order)throw new OrderError('ORDER_FORBIDDEN');
 if(order.state==='paid')return {url:`/case/${order.public_id}/orders`,order};
 const enabled=order.kind==='initial'?process.env.TIVDOC_INITIAL_SALES_ENABLED:process.env.TIVDOC_FULL_SALES_ENABLED;
 if(enabled!=='true'||process.env.TIVDOC_INVOICE4U_CHECKOUT_ENABLED!=='true')throw new OrderError('ORDER_SALES_UNAVAILABLE');
 const token=createPaymentReturnToken(),attempt=randomUUID();const returnUrl=getPaymentReturnUrl(token);const checkoutProvider=provider??new Invoice4uClient();
 const reservation=(await store.rpc<{value:{claimed:boolean;order:ProductOrder;checkout?:{state:string;checkout_url:string|null;provider_order_id:string};contact?:{first_name:string;phone:string;email:string;public_id:string}}}>('case_order_checkout_begin',{target_case:input.caseId,target_identity:input.identityId,target_order:input.orderId,target_attempt:attempt,target_return_hash:hashPaymentReturnToken(token),target_terms:order.terms_version??order.offer.terms_version}))[0]?.value;
 if(!reservation)throw new OrderError('ORDER_CHECKOUT_UNCERTAIN');
 if(!reservation.claimed){if(reservation.checkout?.state==='ready'&&reservation.checkout.checkout_url)return {url:reservation.checkout.checkout_url,order:reservation.order};throw new OrderError('ORDER_CHECKOUT_UNCERTAIN');}
 try{
  const contact=reservation.contact!;const checkout=await checkoutProvider.createCheckout({caseId:contact.public_id,kind:order.kind,orderId:reservation.checkout!.provider_order_id,fullName:contact.first_name,phone:contact.phone,email:contact.email,returnUrl,amount:order.amount_minor/100,currency:order.currency});
  await store.rpc('case_order_checkout_finish',{target_order:order.id,target_attempt:attempt,target_log:checkout.clearingLogId,target_payment:checkout.paymentId,target_url:checkout.url,target_error:null});return {url:checkout.url,order};
 }catch(error){await store.rpc('case_order_checkout_finish',{target_order:order.id,target_attempt:attempt,target_log:null,target_payment:null,target_url:null,target_error:invoice4uErrorCode(error)??'checkout_persistence_unknown'}).catch(()=>{});throw new OrderError('ORDER_CHECKOUT_UNCERTAIN');}
}
let verifier:CaseAccessDb|null=null;
export async function orderVerifierDb(){
 if(verifier)return verifier;const url=process.env.TIVDOC_PAYMENT_VERIFICATION_POSTGRES_URL;if(!url)throw new OrderError('ORDER_VERIFIER_UNAVAILABLE');
 // No yield between cache lookup and assignment, including the cold path.
 const pool=new pg.Pool({connectionString:url,max:2,min:0,idleTimeoutMillis:5000,connectionTimeoutMillis:15000,application_name:'tivdoc_payment_verifier'});
 pool.on('error',()=>console.error('PAYMENT_VERIFIER_POOL_IDLE_ERROR'));attachDatabasePool(pool);
 verifier=postgresCaseAccessDb(pool);return verifier;
}
/** Explicit new-customer path. SQL preserves an existing order unchanged and
 * applies the v3 offer only when creating a new one. This opens no checkout. */
export async function createReleaseInitialOrder(input:{caseId:string;identityId:string|null;request:OrderRequest},db?:CaseAccessDb){
 const request=orderRequestSchema.parse(input.request);
 if(request.kind!=='initial')throw new OrderError('ORDER_PRICING_BASIS_UNAVAILABLE');
 const store=await storeOrThrow(db);
 const result=await store.rpc<{value:ProductOrder}>('case_order_create',{target_case:input.caseId,target_identity:input.identityId,target_kind:'initial',target_from:request.from+'-01',target_to:request.to+'-01',target_offer:releaseInitialOfferSnapshot()});
 if(result.length!==1||!result[0]?.value)throw new OrderError('ORDER_NOT_CREATED');return result[0].value;
}
/** Read an actual worker-issued quote only. A missing quote remains missing
 * evidence; this web path neither synthesizes a basis nor impersonates worker
 * authority to create an order or reserve credit. */
export async function customerReleaseQuote(input:{caseId:string;identityId:string;request:OrderRequest;sessionToken?:string},db?:CaseAccessDb):Promise<{quote:CustomerReleaseQuote;order:ProductOrder|null}>{
 const caseId=z.uuid().parse(input.caseId),identityId=z.uuid().parse(input.identityId),request=orderRequestSchema.parse(input.request);
 if(request.kind!=='full')throw new OrderError('ORDER_PERIOD_INVALID');
 const store=await storeOrThrow(db),rows=await store.rpc<{value:unknown}>('case_order_release_quote',{target_case:caseId,target_identity:identityId,target_from:request.from+'-01',target_to:request.to+'-01'});
 if(rows.length!==1)throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
 if(rows[0].value===null){
  const saved=input.sessionToken?await customerSavedReleaseQuote({caseId,identityId,sessionToken:input.sessionToken},store):null;
  if(saved?.quote&&(saved.quote.from!==request.from||saved.quote.to!==request.to))throw new OrderError('ORDER_QUOTE_PERIOD_UNAVAILABLE');
  throw new OrderError('ORDER_PRICING_BASIS_UNAVAILABLE');
 }
 return resolveCustomerReleaseQuoteRow(rows[0].value,caseId,identityId,store,request);
}
async function resolveCustomerReleaseQuoteRow(raw:unknown,caseId:string,identityId:string,store:CaseAccessDb,request?:OrderRequest):Promise<{quote:CustomerReleaseQuote;order:ProductOrder|null}>{
 const row=z.object({id:z.uuid(),snapshot:z.unknown(),quote_sha256:z.string().regex(/^[a-f0-9]{64}$/u),input_sha256:z.string().regex(/^[a-f0-9]{64}$/u),now:z.iso.datetime({offset:true}),order_id:z.uuid().nullable()}).strict().parse(raw);
 const quote=requireFreshPriceQuote(row.snapshot,{caseId,identityId,inputSha256:row.input_sha256,now:new Date(row.now)});
 if(quote.schema_version!=='tivdoc-price-quote-v2'||quote.sha256!==row.quote_sha256||request&&(quote.purchased_period.from!==request.from||quote.purchased_period.to!==request.to))throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
 let order:ProductOrder|null=null;
 if(row.order_id){
  const saved=await store.rpc<{value:ProductOrder}>('case_order_get',{target_case:caseId,target_identity:identityId,target_order:row.order_id});
  if(saved.length!==1||!saved[0]?.value)throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
  order=saved[0].value;
  if(order.id!==row.order_id||order.case_id!==caseId||order.kind!=='full'||order.state!=='awaiting_payment'||order.offer.version!=='tivdoc-order-offer-v3'
   ||!('price_quote_id'in order.offer)||order.offer.price_quote_id!==row.id||order.offer.price_quote_sha256!==quote.sha256
   ||canonicalSha256(order.offer.price_quote)!==canonicalSha256(quote)||order.amount_minor!==quote.balance_minor||order.currency!=='ILS'
   ||order.period_from!==quote.purchased_period.from+'-01'||order.period_to!==quote.purchased_period.to+'-01'||canonicalSha256(order.topics)!==canonicalSha256(quote.purchased_topics))throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
 }
 return {quote:{id:row.id,from:quote.purchased_period.from,to:quote.purchased_period.to,topics:[...quote.purchased_topics],total_minor:quote.total_minor,credit_minor:quote.credit_minor,balance_minor:quote.balance_minor,currency:'ILS',expires_at:quote.expires_at},order};
}
export type CustomerSavedReleaseQuoteResult={quote:CustomerReleaseQuote|null;order:ProductOrder|null;availability:ReleaseQuoteAvailability};
/** Discover an existing offer or its current, safe preparation status. This
 * authenticated read performs no quote issuance, credit reservation or charge. */
export async function customerSavedReleaseQuote(input:{caseId:string;identityId:string;sessionToken:string},db?:CaseAccessDb):Promise<CustomerSavedReleaseQuoteResult>{
 const caseId=z.uuid().parse(input.caseId),identityId=z.uuid().parse(input.identityId),store=await storeOrThrow(db);
 if(!isOpaqueToken(input.sessionToken))throw new OrderError('ORDER_FORBIDDEN');
 const rows=await store.rpc<{value:unknown}>('case_order_saved_release_quote',{target_case:caseId,target_identity:identityId,target_session_hash:hashSession(input.sessionToken)});
 if(rows.length!==1)throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
 const value=z.object({quote:z.unknown().nullable(),availability:releaseQuoteAvailabilitySchema}).strict().parse(rows[0].value);
 if(value.quote===null){if(value.availability.state==='ready')throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');return {quote:null,order:null,availability:value.availability};}
 const saved=await resolveCustomerReleaseQuoteRow(value.quote,caseId,identityId,store);
 if(value.availability.state!=='ready'||value.availability.period?.from!==saved.quote.from||value.availability.period.to!==saved.quote.to)throw new OrderError('ORDER_QUOTE_LOOKUP_INVALID');
 return {...saved,availability:value.availability};
}
export async function reconcileOrders(db?:CaseAccessDb,provider=new Invoice4uClient(),onlyOrder?:string){
 const store=db??await orderVerifierDb();const result=await store.rpc<{value:(ProductOrder&{provider_log_id:string;provider_order_id:string;provider_payment_id?:string|null})[]}>('case_order_payment_pending',{target_limit:100});const summary={scanned:0,verified:0,pending:0,rejected:0,failed:0};
 for(const order of result[0]?.value??[]){if(onlyOrder&&order.id!==onlyOrder)continue;summary.scanned++;try{const log=await provider.getClearingLogById(order.provider_log_id);if(!log){summary.pending++;continue;}const tx=validateInvoice4uClearingLog(log,order.provider_log_id,{amountMinor:order.amount_minor,currency:order.currency,orderId:order.provider_order_id,paymentId:order.provider_payment_id});await store.rpc('case_order_payment_verify',{target_order:order.id,target_log:tx.clearingLogId,target_payment:tx.paymentId,target_confirmation:tx.confirmationNumber,target_minor:Math.round(tx.amount*100),target_currency:tx.currency});summary.verified++;}catch(error){if(error instanceof PaymentVerificationError){if(error.code==='transaction_pending')summary.pending++;else summary.rejected++;}else summary.failed++;}}
 return summary;
}
