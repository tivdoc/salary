import {describe,it,expect} from 'vitest';
import {Webhook} from 'svix';
import {resendProvider} from './resend-provider';
import {verifyResendWebhook} from './resend-webhook';
const message={template:'access_code' as const,channel:'email' as const,to:'synthetic@example.invalid',subject:'קוד כניסה',body:'קוד בדיקה סינתטי'};
describe('P07 Resend boundary',()=>{
 it('keeps a stable idempotency key and requires provider acceptance ID',async()=>{
  const keys:string[]=[];const mock:typeof fetch=async(_url,options)=>{keys.push(new Headers(options?.headers).get('Idempotency-Key')!);return Response.json({id:'11111111-1111-4111-8111-111111111111'});};
  const provider=resendProvider('test-only','test@example.invalid',mock);expect(await provider.send(message)).toMatchObject({ok:true,provider_message_id:expect.any(String)});await provider.send(message);expect(keys[0]).toBe(keys[1]);
  expect(await resendProvider('test-only','test@example.invalid',async()=>Response.json({})) .send(message)).toMatchObject({ok:false});
 });
 it('refuses phone delivery and classifies retry/uncertain responses',async()=>{
  expect(await resendProvider('test','test@example.invalid',async()=>{throw new Error('must not send');}).send({...message,channel:'phone'})).toMatchObject({ok:false,error_code:'resend_email_only'});
  expect(await resendProvider('test','test@example.invalid',async()=>new Response('',{status:429})).send(message)).toMatchObject({ok:false,error_code:'resend_retryable'});
  expect(await resendProvider('test','test@example.invalid',async()=>{throw new Error('timeout');}).send(message)).toMatchObject({ok:false,error_code:'resend_transport_uncertain'});
 });
 it('verifies the exact signed body and rejects alteration or stale replay',()=>{
  const secret='whsec_'+Buffer.alloc(32,7).toString('base64');const wh=new Webhook(secret);const time=new Date();const id='msg_synthetic';
  const raw=JSON.stringify({type:'email.delivered',created_at:time.toISOString(),data:{email_id:'11111111-1111-4111-8111-111111111111'}});
  const headers=new Headers({'svix-id':id,'svix-timestamp':String(Math.floor(time.getTime()/1000)),'svix-signature':wh.sign(id,time,raw)});
  expect(verifyResendWebhook(raw,headers,secret).kind).toBe('email.delivered');expect(()=>verifyResendWebhook(raw+' ',headers,secret)).toThrow();
  const old=new Date(time.getTime()-600000);headers.set('svix-timestamp',String(Math.floor(old.getTime()/1000)));headers.set('svix-signature',wh.sign(id,old,raw));expect(()=>verifyResendWebhook(raw,headers,secret)).toThrow();
 });
});
