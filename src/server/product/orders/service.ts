import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {attachDatabasePool} from '@vercel/functions';
import {Invoice4uClient,invoice4uErrorCode} from '../../../lib/invoice4u';
import {createPaymentReturnToken,hashPaymentReturnToken,getPaymentReturnUrl} from '../../../lib/payment';
import {validateInvoice4uClearingLog,PaymentVerificationError} from '../../../lib/payment-verification';
import {resolveCaseAccessDb,postgresCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {offerSnapshot,orderRequestSchema,priceCorrectionStatusSchema,OrderError,type OrderRequest,type ProductOrder} from './contracts';
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
export async function reconcileOrders(db?:CaseAccessDb,provider=new Invoice4uClient(),onlyOrder?:string){
 const store=db??await orderVerifierDb();const result=await store.rpc<{value:(ProductOrder&{provider_log_id:string;provider_order_id:string;provider_payment_id?:string|null})[]}>('case_order_payment_pending',{target_limit:100});const summary={scanned:0,verified:0,pending:0,rejected:0,failed:0};
 for(const order of result[0]?.value??[]){if(onlyOrder&&order.id!==onlyOrder)continue;summary.scanned++;try{const log=await provider.getClearingLogById(order.provider_log_id);if(!log){summary.pending++;continue;}const tx=validateInvoice4uClearingLog(log,order.provider_log_id,{amountMinor:order.amount_minor,currency:order.currency,orderId:order.provider_order_id,paymentId:order.provider_payment_id});await store.rpc('case_order_payment_verify',{target_order:order.id,target_log:tx.clearingLogId,target_payment:tx.paymentId,target_confirmation:tx.confirmationNumber,target_minor:Math.round(tx.amount*100),target_currency:tx.currency});summary.verified++;}catch(error){if(error instanceof PaymentVerificationError){if(error.code==='transaction_pending')summary.pending++;else summary.rejected++;}else summary.failed++;}}
 return summary;
}
