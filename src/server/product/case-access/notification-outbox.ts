import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {CaseAccessDb} from './db.ts';
import {normalizeContact} from './crypto.ts';
import {payloadDigest,recipientRefusal,sendNotification,type NotificationMessage,type NotificationOutcome,type NotificationProvider} from './notifications.ts';
const messageSchema=z.object({template:z.enum(['case_link','access_code','report_ready','document_request','abandonment_reminder']),channel:z.enum(['email','phone']),to:z.string().max(180),subject:z.string().max(300),body:z.string().max(16000)}).strict();
const envelope=z.object({version:z.literal(1),iv:z.string(),tag:z.string(),ciphertext:z.string()}).strict();
function key(value:string){const bytes=Buffer.from(value,'base64');if(bytes.length!==32)throw new Error('NOTIFICATION_KEY_INVALID');return bytes;}
export function encryptNotification(message:NotificationMessage,id:string,secret:string){
 const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key(secret),iv);cipher.setAAD(Buffer.from(id));
 const encrypted=Buffer.concat([cipher.update(JSON.stringify(messageSchema.parse(message)),'utf8'),cipher.final()]);
 return {version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
}
export function decryptNotification(value:unknown,id:string,secret:string):NotificationMessage{
 const parsed=envelope.parse(value);const decipher=createDecipheriv('aes-256-gcm',key(secret),Buffer.from(parsed.iv,'base64'));decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(parsed.tag,'base64'));
 return messageSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext,'base64')),decipher.final()]).toString('utf8')));
}
/** The encrypted intention exists BEFORE any provider call. A lost provider
 * reply retries the same content/key inside its 24-hour idempotency window. */
export async function enqueueNotification(db:CaseAccessDb,input:{message:NotificationMessage;caseId:string|null;identityId:string|null;tokenHash?:string;secret:string;now?:number}){
 const message=messageSchema.parse(input.message);const digest=payloadDigest(message);const contact=normalizeContact(message.to);if(!contact)throw new Error('NOTIFICATION_RECIPIENT_INVALID');
 const refusal=recipientRefusal(message.to);if(refusal)throw new Error('NOTIFICATION_RECIPIENT_REFUSED');
 const now=input.now??Date.now();const ttl=message.template==='access_code'?9*60000:5*3600000;
 const payload=encryptNotification(message,digest,input.secret);
 await db.rpc('case_notification_outbox_enqueue',{target_id:digest,target_case:input.caseId,target_identity:input.identityId,target_recipient:contact.hash,target_template:message.template,target_payload:payload,target_expires:new Date(now+ttl).toISOString(),target_token_hash:input.tokenHash??null});
 return digest;
}
export async function deliverNotificationOutbox(db:CaseAccessDb,workerId:string,secret:string,provider:NotificationProvider):Promise<NotificationOutcome|null>{
 key(secret);
 const rows=await db.rpc<{delivery_id:string;encrypted_payload:unknown;fencing_token:number}>('case_notification_outbox_claim',{target_worker:workerId});
 const row=rows[0];if(!row)return null;
 const message=decryptNotification(row.encrypted_payload,row.delivery_id,secret);
 const outcome=await sendNotification(message,provider);
 await db.rpc('case_notification_outbox_finish',{target_id:row.delivery_id,target_worker:workerId,target_fence:row.fencing_token,target_provider_id:outcome.provider_message_id??null,target_error:outcome.error_code??(outcome.state==='sent'?'provider_receipt_missing':null)});
 return outcome;
}

export async function notifyCase(db:CaseAccessDb,scope:{caseId:string|null;identityId:string|null;tokenHash?:string},message:NotificationMessage):Promise<NotificationOutcome>{
 if(process.env.TIVDOC_NOTIFICATION_OUTBOX_ENABLED!=='true')return sendNotification(message);
 const refusal=recipientRefusal(message.to);const digest=payloadDigest(message);
 if(refusal)return {state:'refused',provider:'resend_outbox',error_code:refusal,payload_sha256:digest};
 const secret=process.env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY;
 if(!secret)return {state:'failed',provider:'resend_outbox',error_code:'notification_encryption_not_configured',payload_sha256:digest};
 await enqueueNotification(db,{...scope,message,secret});
 return {state:'queued',provider:'resend_outbox',error_code:null,payload_sha256:digest};
}

export async function enqueueRequestReminders(db:CaseAccessDb,secret:string,origin:string){
 const url=new URL(origin);if(url.protocol!=='https:'&&url.hostname!=='localhost'&&url.hostname!=='127.0.0.1')throw new Error('NOTIFICATION_ORIGIN_INVALID');
 const rows=await db.rpc<{request_id:string;kind:string;case_id:string;public_id:string;identity_id:string;contact:string;question:string}>('case_notification_request_reminders',{target_limit:100});
 let queued=0;
 for(const row of rows){
  const message:NotificationMessage={template:'document_request',channel:'email',to:row.contact,subject:`תזכורת להשלמה בתיק ${row.public_id}`,body:[row.kind==='reminder_5d'?'חלפו חמישה ימים מאז שביקשנו השלמה.':'חלפו יומיים מאז שביקשנו השלמה.',row.question,`להמשך בתיק: ${url.origin}/case/${encodeURIComponent(row.public_id)}/thread?requestId=${encodeURIComponent(row.request_id)}`,'אפשר להיכנס דרך האימייל המאומת. המסמכים אינם נשלחים למעסיק.'].join('\n')};
  const contact=normalizeContact(message.to);if(!contact||recipientRefusal(message.to))continue;
  const id=payloadDigest(message);
  const result=await db.rpc<string>('case_notification_reminder_enqueue',{target_request:row.request_id,target_kind:row.kind,target_id:id,target_case:row.case_id,target_identity:row.identity_id,target_recipient:contact.hash,target_payload:encryptNotification(message,id,secret),target_expires:new Date(Date.now()+5*3600000).toISOString()});
  if(result[0])queued++;
 }
 return queued;
}
