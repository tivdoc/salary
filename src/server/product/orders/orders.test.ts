import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../../../lib/invoice4u',()=>({Invoice4uClient:class{},invoice4uErrorCode:()=>null}));
import {legacyFullOfferFixture} from './fixtures/legacy-offer';
import {offerSnapshot,orderRequestSchema} from './contracts';
import {orderCheckout,reconcileOrders,customerOrders} from './service';
import {validateInvoice4uClearingLog} from '../../../lib/payment-verification';
import type {CaseAccessDb} from '../case-access/db';
const order={id:'order-one',case_id:'case-one',kind:'full',state:'awaiting_payment',amount_minor:14900,currency:'ILS',terms_version:'test',offer:legacyFullOfferFixture()};
const scope={caseId:'case-one',identityId:'identity-one',orderId:order.id,termsAccepted:true};
function store(implementation:(fn:string,args:Readonly<Record<string,unknown>>)=>unknown):CaseAccessDb{return {provider:'fake',rpc:async<T>(fn:string,args:Readonly<Record<string,unknown>>)=>[{value:await implementation(fn,args)} as T]};}
beforeEach(()=>{vi.stubEnv('NEXT_PUBLIC_SITE_URL','https://synthetic.invalid');vi.stubEnv('TIVDOC_FULL_SALES_ENABLED','true');vi.stubEnv('TIVDOC_INVOICE4U_CHECKOUT_ENABLED','true');});afterEach(()=>vi.unstubAllEnvs());
describe('P09 order boundary',()=>{
 it('does not accept customer prices or reversed periods',()=>{expect(orderRequestSchema.safeParse({kind:'full',from:'2026-01',to:'2026-02',price:1}).success).toBe(false);expect(orderRequestSchema.safeParse({kind:'full',from:'2026-02',to:'2026-01'}).success).toBe(false);expect(offerSnapshot('initial').amount_minor).toBe(999);expect(()=>offerSnapshot('full')).toThrow('ORDER_PRICING_BASIS_UNAVAILABLE');});
 it('does not reach the provider when sales are disabled',async()=>{vi.stubEnv('TIVDOC_FULL_SALES_ENABLED','false');const createCheckout=vi.fn();await expect(orderCheckout(scope,store(()=>order),{createCheckout})).rejects.toThrow('ORDER_SALES_UNAVAILABLE');expect(createCheckout).not.toHaveBeenCalled();});
 it.each(['creating','uncertain'])('does not open another checkout for an existing %s attempt',async state=>{const createCheckout=vi.fn();await expect(orderCheckout(scope,store(fn=>fn==='case_order_get'?order:{claimed:false,order,checkout:{state}}),{createCheckout})).rejects.toThrow('ORDER_CHECKOUT_UNCERTAIN');expect(createCheckout).not.toHaveBeenCalled();});
 it('uses the saved price and leaves provider timeout uncertain',async()=>{const finished:unknown[]=[];const createCheckout=vi.fn(async(_input:unknown)=>{void _input;throw new Error('provider timeout');});const db=store((fn,args)=>{if(fn==='case_order_get')return order;if(fn==='case_order_checkout_begin')return {claimed:true,order,checkout:{provider_order_id:'provider-order-one'},contact:{public_id:'TV-TEST0001',first_name:'Synthetic',email:'test@example.invalid',phone:'0500000000'}};finished.push(args);return null;});await expect(orderCheckout(scope,db,{createCheckout})).rejects.toThrow('ORDER_CHECKOUT_UNCERTAIN');expect(createCheckout.mock.calls[0][0]).toMatchObject({amount:149,currency:'ILS',orderId:'provider-order-one'});expect(finished).toHaveLength(1);expect(finished[0]).toMatchObject({target_error:'checkout_persistence_unknown'});});
 it('rejects fractional minor units and a foreign provider order',()=>{const log={Amount:149,CurrencyName:'ILS',IsSuccess:true,PaymentId:'p1',Id:'log1',ClearingConfirmationNumber:'c1',OrderIdClientUsage:'o1'};expect(validateInvoice4uClearingLog(log,'log1',{amountMinor:14900,currency:'ILS',orderId:'o1'}).amount).toBe(149);expect(()=>validateInvoice4uClearingLog({...log,Amount:149.001},'log1',{amountMinor:14900,currency:'ILS'})).toThrow('amount_mismatch');expect(()=>validateInvoice4uClearingLog(log,'log1',{amountMinor:14900,currency:'ILS',orderId:'other'})).toThrow('transaction_reused');});
 it('provider pending results grant no entitlement',async()=>{const called:string[]=[];const db=store(fn=>{called.push(fn);return [{...order,provider_log_id:'log',provider_order_id:'p'}];});const provider={getClearingLogById:vi.fn(async()=>null)};expect(await reconcileOrders(db,provider as never)).toMatchObject({scanned:1,pending:1,verified:0});expect(called).toEqual(['case_order_payment_pending']);});
 it.each(['expected-payment',null,'other-payment'])('binds provider reconciliation to saved payment %s',async savedPayment=>{
  const verified:unknown[]=[];const db=store((fn,args)=>{if(fn==='case_order_payment_pending')return [{...order,provider_log_id:'log',provider_order_id:'provider-order',provider_payment_id:savedPayment}];verified.push(args);return true;});
  const provider={getClearingLogById:vi.fn(async()=>({Id:'log',PaymentId:'expected-payment',ClearingConfirmationNumber:'confirmation',OrderIdClientUsage:'provider-order',Amount:149,Currency:1,IsSuccess:true,IsCredit:false,LogType:2,TransactionType:0}))};
  const result=await reconcileOrders(db,provider as never);
  expect(result).toMatchObject({scanned:1,verified:savedPayment==='other-payment'?0:1,rejected:savedPayment==='other-payment'?1:0});
  expect(verified).toHaveLength(savedPayment==='other-payment'?0:1);
 });
});

describe('customer correction status',()=>{
 const pending={state:'requested',cumulative_refund_minor:15000,requested_at:'2026-09-08T12:00:00.000Z'};
 it('returns a bounded cumulative request without claiming provider settlement',async()=>{
  const saved={...order,state:'paid',amount_minor:33901,price_correction:pending};
  expect(await customerOrders('case-one','identity-one',store(()=>[saved]))).toEqual([saved]);
 });
 it.each(['excess','settled','negative','internal_fields','unpaid'] as const)('refuses %s correction status from the store',async defect=>{
  const saved={...order,state:defect==='unpaid'?'awaiting_payment':'paid',amount_minor:33901,price_correction:{...pending}};
  if(defect==='excess')saved.price_correction.cumulative_refund_minor=33902;
  if(defect==='negative')saved.price_correction.cumulative_refund_minor=-1;
  if(defect==='settled')saved.price_correction.state='refunded';
  if(defect==='internal_fields')Object.assign(saved.price_correction,{corrected_basis:{secret:'internal'}});
  await expect(customerOrders('case-one','identity-one',store(()=>[saved]))).rejects.toThrow('ORDER_STORE_UNAVAILABLE');
 });
 it('preserves old orders without manufacturing a zero adjustment',async()=>{
  expect(await customerOrders('case-one','identity-one',store(()=>[order]))).toEqual([order]);
 });
});
