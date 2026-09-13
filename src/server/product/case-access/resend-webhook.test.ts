import {describe,expect,it} from 'vitest';
import {Webhook} from 'svix';
import {decodeResendWebhookBody,verifyResendWebhook} from './resend-webhook.ts';

const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const providerId='11111111-1111-4111-8111-111111111111';
function signed(raw:string,id='msg_synthetic_wire',at=new Date()):Headers{
 return new Headers({'svix-id':id,'svix-timestamp':String(Math.floor(at.getTime()/1000)),
  'svix-signature':new Webhook(secret).sign(id,at,raw)});
}
const body=(createdAt=new Date().toISOString())=>JSON.stringify({type:'email.delivered',created_at:createdAt,data:{email_id:providerId,subject:'תלוש בדיקה'}});
describe('Resend raw receipt validation; synthetic signatures, no supplier delivery claim',()=>{
 it('preserves multibyte JSON, whitespace and exact correlation coordinates',()=>{
  const raw=`\n ${body()} \n`,headers=signed(raw);
  expect(decodeResendWebhookBody(Buffer.from(raw))).toBe(raw);
  expect(verifyResendWebhook(Buffer.from(raw),headers,secret)).toEqual({event_id:headers.get('svix-id'),provider_message_id:providerId,kind:'email.delivered',occurred_at:JSON.parse(raw).created_at});
  expect(()=>verifyResendWebhook(raw.trim(),headers,secret)).toThrow();
 });
 it.each([[0xff],[0xc0,0xaf],[0xe2,0x82]])('refuses malformed UTF-8 bytes %j without repair',(...bytes:number[])=>{
  expect(()=>decodeResendWebhookBody(Uint8Array.from(bytes))).toThrow();
 });
 it('does not silently remove a leading BOM from the signed bytes',()=>{
  const raw=body(),wire=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(raw)]);
  expect(decodeResendWebhookBody(wire)).toBe(`\uFEFF${raw}`);
  expect(()=>verifyResendWebhook(wire,signed(raw),secret)).toThrow();
 });
 it('enforces byte size and DB event-ID bounds before persistence',()=>{
  expect(()=>decodeResendWebhookBody(Buffer.alloc(65537))).toThrow('WEBHOOK_TOO_LARGE');
  const raw=body();
  expect(()=>verifyResendWebhook(raw,signed(raw,'x'.repeat(201)),secret)).toThrow('WEBHOOK_EVENT_ID_INVALID');
  expect(verifyResendWebhook(raw,signed(raw,'x'.repeat(200)),secret).event_id).toHaveLength(200);
 });
 it('allows an old delivery occurrence with a fresh signed attempt and stable duplicate coordinates',()=>{
  const raw=body('2020-01-01T00:00:00Z'),headers=signed(raw);
  const first=verifyResendWebhook(raw,headers,secret);
  expect(first.occurred_at).toBe('2020-01-01T00:00:00Z');
  expect(verifyResendWebhook(raw,headers,secret)).toEqual(first);
  const old=new Date(Date.now()-600000);
  expect(()=>verifyResendWebhook(raw,signed(raw,'msg_synthetic_wire',old),secret)).toThrow();
 });
});
