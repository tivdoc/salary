import 'server-only';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {z} from 'zod';
import {managedWorkerControlConfig} from './managed-worker-config';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {normalizeContact} from '../case-access/crypto';
import {recipientRefusal,payloadDigest,type NotificationMessage,type NotificationProvider} from '../case-access/notifications';
import {resendProvider} from '../case-access/resend-provider';
import {encryptNotification,deliverClaimedNotification} from '../case-access/notification-outbox';
const eventSchema=z.object({event_key:z.string(),event_kind:z.enum(['request_required','engineering_report_ready','report_ready']),case_id:z.uuid(),public_id:z.string().regex(/^TV-[A-Z0-9]{8}$/u),identity_id:z.uuid(),contact:z.email(),request_id:z.uuid().nullable(),report_id:z.uuid().nullable()}).strict();

/** Uses the existing encrypted outbox and Resend idempotency/fencing protocol.
 * Configuration and DB both restrict DEV destinations. Provider acceptance is
 * never returned as delivery; authenticated webhooks alone record delivery. */
export async function runAutomaticNotificationPass(input:{db:CaseAccessDb;capability:string;secret:string;origin:string;provider:NotificationProvider}){
 const url=new URL(input.origin);if(url.protocol!=='https:'||!url.hostname.endsWith('.vercel.app'))throw Error('MANAGED_NOTIFICATION_ORIGIN');
 if(Buffer.from(input.secret,'base64').length!==32)throw Error('NOTIFICATION_KEY_INVALID');
 const events=z.array(eventSchema).max(10).parse(await input.db.rpc('case_notification_managed_pending',{target_capability:input.capability}));
 let queued=0;
 for(const event of events){
  const contact=normalizeContact(event.contact);if(recipientRefusal(event.contact)||!contact)continue;
  const request=event.event_kind==='request_required',engineering=event.event_kind==='engineering_report_ready';
  const link=request?`${url.origin}/case/${event.public_id}/thread?requestId=${event.request_id}`:`${url.origin}/case/${event.public_id}/reports?${engineering?'engineering=1&':''}report=${event.report_id}`;
  const message:NotificationMessage={template:request?'document_request':'report_ready',channel:'email',to:event.contact,
   subject:request?`Tivdoc — נדרשת השלמה בתיק ${event.public_id}`:engineering?`Tivdoc DEV — דוח ניסוי הנדסי בתיק ${event.public_id}`:`Tivdoc — הדוח לתיק ${event.public_id} זמין`,
   body:[request?'הבדיקה ממתינה להשלמה ממוקדת. השאלה ומסמך המקור מופיעים בתיק.':engineering?'נוצר דוח ניסוי הנדסי ממסמך סינתטי. הכלל אינו פעיל בשירות וזה אינו חוב מאומת של מעסיק.':'נוצר דוח AI עם המקורות וההסברים של הניתוח.',`לצפייה מאובטחת: ${link}`,'הקישור דורש כניסה לתיק דרך האימייל המאומת.'].join('\n')};
  const id=payloadDigest(message);
  const receipt=await input.db.rpc<{value:string|null}>('case_notification_managed_enqueue',{target_capability:input.capability,target_event:event.event_key,target_delivery:id,target_payload:encryptNotification(message,id,input.secret),target_expires:new Date(Date.now()+5*3600000).toISOString(),expected_case:event.case_id,expected_identity:event.identity_id,expected_recipient:contact.hash});
  if(receipt[0]?.value)queued++;
 }
 const attempts:{state:string;provider:string;provider_message_id?:string;error_code:string|null}[]=[],workerId=randomUUID();
 for(let index=0;index<2;index++){
  const rows=await input.db.rpc<{delivery_id:string;encrypted_payload:unknown;fencing_token:number}>('case_notification_managed_claim',{target_capability:input.capability,target_worker:workerId});
  if(!rows[0])break;
  const outcome=await deliverClaimedNotification(input.db,rows[0],workerId,input.secret,input.provider);
  attempts.push({state:outcome.state==='sent'&&outcome.provider_message_id?'provider_accepted':outcome.state==='sent'?'unconfirmed_test_acceptance':outcome.state,provider:outcome.provider,provider_message_id:outcome.provider_message_id,error_code:outcome.error_code});
 }
 return {state:'finished' as const,queued,attempts,deliveryConfirmed:false};
}

export async function runManagedDevNotificationTick(env:Readonly<Record<string,string|undefined>>=process.env){
 if(env.TIVDOC_MANAGED_DEV_WORKER_ENABLED!=='true'||env.TIVDOC_NOTIFICATION_OUTBOX_ENABLED!=='true')return {state:'disabled' as const};
 const config=managedWorkerControlConfig(env);if(!config.enabled)return {state:'disabled' as const};
 if(env.TIVDOC_NOTIFICATION_PROVIDER!=='resend'||!env.RESEND_API_KEY?.trim()||!env.TIVDOC_NOTIFICATION_FROM?.trim())return {state:'blocked' as const,code:'notification_provider_unconfigured'};
 const secret=env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY;if(!secret||Buffer.from(secret,'base64').length!==32)return {state:'blocked' as const,code:'notification_encryption_unconfigured'};
 if(!env.DELIVERY_RECIPIENT_ALLOWLIST?.trim())return {state:'blocked' as const,code:'notification_recipient_unconfigured'};
 const origin=env.TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN;if(!origin)return {state:'blocked' as const,code:'notification_preview_origin_unconfigured'};
 const pool=new pg.Pool({connectionString:config.connectionUrl,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},max:1,connectionTimeoutMillis:15000,statement_timeout:15000});
 try{return await runAutomaticNotificationPass({db:postgresCaseAccessDb(pool),capability:config.capability,secret,origin,provider:resendProvider(env.RESEND_API_KEY!.trim(),env.TIVDOC_NOTIFICATION_FROM!.trim())});}
 finally{await pool.end();}
}
