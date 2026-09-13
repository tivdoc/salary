import {Webhook} from 'svix';
import {z} from 'zod';
const event=z.object({type:z.string(),created_at:z.iso.datetime({offset:true}),data:z.object({email_id:z.uuid()})});
/** Decode without replacing malformed bytes or silently removing a BOM. A
 * signature must authenticate the wire payload, not a lossy UTF-8 repair. */
export function decodeResendWebhookBody(bytes:Uint8Array):string{
 if(bytes.byteLength>65536)throw new Error('WEBHOOK_TOO_LARGE');
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
export function verifyResendWebhook(body:string|Uint8Array,headers:Headers,secret:string){
 const raw=typeof body==='string'?body:decodeResendWebhookBody(body);
 if(Buffer.byteLength(raw)>65536)throw new Error('WEBHOOK_TOO_LARGE');
 const id=headers.get('svix-id')??'';
 if(id.length<1||id.length>200)throw new Error('WEBHOOK_EVENT_ID_INVALID');
 new Webhook(secret).verify(raw,{'svix-id':id,'svix-timestamp':headers.get('svix-timestamp')??'','svix-signature':headers.get('svix-signature')??''});
 const parsed=event.parse(JSON.parse(raw));
 return {event_id:id,provider_message_id:parsed.data.email_id,kind:parsed.type,occurred_at:parsed.created_at};
}
