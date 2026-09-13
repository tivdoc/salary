import {it,expect,vi} from 'vitest';
import {Invoice4uClient} from './invoice4u';
vi.mock('server-only',()=>({}));
const input={caseId:'TV-SYNTHETIC',orderId:'synthetic-order',fullName:'Synthetic test',phone:'0500000000',email:'test@example.invalid',returnUrl:'https://synthetic.invalid/return',amount:9.99,currency:'ILS'};
const url='https://synthetic-provider.invalid/pay';
function client(payload:unknown){const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({ProcessApiRequestV2Result:payload})));return {api:new Invoice4uClient('synthetic-key',fetcher,15,'qa'),fetcher};}
it('reads the documented dictionary OpenInfo while retaining the exact clearing-log reference',async()=>{
 const s=client({ClearingRedirectUrl:url,OpenInfo:{I4UClearingLogId:'123',PaymentId:'456'},Errors:[]});
 expect(await s.api.createCheckout(input)).toEqual({url,clearingLogId:'123',paymentId:'456'});
});
it('reads the documented top-level payment reference when the exact log is separately present',async()=>{
 const s=client({ClearingRedirectUrl:url,PaymentId:'456',OpenInfo:[{Key:'I4UClearingLogId',Value:123}],Errors:[]});
 expect(await s.api.createCheckout(input)).toMatchObject({clearingLogId:'123',paymentId:'456'});
});
it('sets documented QA mode and NIS on the wire while the product uses ILS',async()=>{
 const s=client({ClearingRedirectUrl:url,OpenInfo:[{Key:'I4UClearingLogId',Value:123}],Errors:[]});await s.api.createCheckout(input);
 expect(JSON.parse(String(s.fetcher.mock.calls[0][1]?.body)).request).toMatchObject({IsQaMode:true,Currency:'NIS',Sum:9.99,OrderIdClientUsage:'synthetic-order',Refund:false});
});
it.each([
 {PaymentId:'different',OpenInfo:[{Key:'I4UClearingLogId',Value:123},{Key:'PaymentId',Value:'456'}]},
 {OpenInfo:[{Key:'I4UClearingLogId',Value:123},{Key:'I4UClearingLogId',Value:124}]},
])('refuses contradictory references rather than selecting the first %j',async fields=>{
 const s=client({ClearingRedirectUrl:url,Errors:[],...fields});await expect(s.api.createCheckout(input)).rejects.toThrow('invalid_provider_response');
});
it('never substitutes PaymentId for an absent clearing log or releases an unidentified checkout',async()=>{
 const s=client({ClearingRedirectUrl:url,PaymentId:'456',Errors:[]});await expect(s.api.createCheckout(input)).rejects.toThrow('invalid_checkout_session');
});
it.each([0,-1,9.991,Number.NaN,Number.POSITIVE_INFINITY])('refuses invalid charge %s before transport',async amount=>{
 const s=client({ClearingRedirectUrl:url,OpenInfo:[{Key:'I4UClearingLogId',Value:123}]});await expect(s.api.createCheckout({...input,amount})).rejects.toThrow('invalid_checkout_amount');expect(s.fetcher).not.toHaveBeenCalled();
});
it.each(['NIS','USD',''])('refuses unsupported product currency %s before transport',async currency=>{
 const s=client({});await expect(s.api.createCheckout({...input,currency})).rejects.toThrow('invalid_checkout_currency');expect(s.fetcher).not.toHaveBeenCalled();
});
it('sets production mode explicitly and accepts ordinary decimal cents',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({ClearingRedirectUrl:url,PaymentId:'456',OpenInfo:{I4UClearingLogId:123,PaymentId:456}})));
 await new Invoice4uClient('synthetic-key',fetcher,15,'production').createCheckout({...input,amount:19.99});
 expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body)).request).toMatchObject({IsQaMode:false,Sum:19.99,Currency:'NIS'});
});
it('accepts repeated identical references without losing the exact identifier',async()=>{
 const s=client({ClearingRedirectUrl:url,PaymentId:456,OpenInfo:[{Key:'I4UClearingLogId',Value:123},{Key:'I4UClearingLogId',Value:'123'},{Key:'PaymentId',Value:'456'}]});
 expect(await s.api.createCheckout(input)).toMatchObject({clearingLogId:'123',paymentId:'456'});
});
it.each([{},true,1.5])('refuses malformed reference %j',async PaymentId=>{
 const s=client({ClearingRedirectUrl:url,PaymentId,OpenInfo:{I4UClearingLogId:123}});await expect(s.api.createCheckout(input)).rejects.toThrow('invalid_provider_response');
});
