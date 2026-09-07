import {Webhook} from 'svix';
import {z} from 'zod';
const event=z.object({type:z.string(),created_at:z.iso.datetime({offset:true}),data:z.object({email_id:z.uuid()})});
export function verifyResendWebhook(raw:string,headers:Headers,secret:string){
 if(Buffer.byteLength(raw)>65536)throw new Error('WEBHOOK_TOO_LARGE');
 const id=headers.get('svix-id')??'';
 new Webhook(secret).verify(raw,{'svix-id':id,'svix-timestamp':headers.get('svix-timestamp')??'','svix-signature':headers.get('svix-signature')??''});
 const parsed=event.parse(JSON.parse(raw));
 return {event_id:id,provider_message_id:parsed.data.email_id,kind:parsed.type,occurred_at:parsed.created_at};
}
