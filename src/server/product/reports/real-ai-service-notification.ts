import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {normalizeContact} from '../case-access/crypto';
import {encryptNotification} from '../case-access/notification-outbox';
import {payloadDigest,recipientRefusal,renderReportReady,type NotificationMessage} from '../case-access/notifications';
import {loadRealAiServiceDelivery,realAiServiceSelectorSchema,type RealAiServiceSelector} from './real-ai-service-delivery';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
export const REAL_AI_SERVICE_NOTIFICATION_TEMPLATE='real-ai-report-ready-v1' as const;
/** Separate immutable recipient permission. The service action decision alone
 * never implies consent to send a message. SQL authenticates this grant's
 * enrollment, current identity contact, opt-out, expiry and revocation. */
export const realAiServiceNotificationGrantSchema=z.object({schema_version:z.literal('tivdoc-real-ai-service-notification-grant-v1'),
 grant_id:z.uuid(),state:z.enum(['active','revoked']),namespace:z.literal('real'),case_id:z.uuid(),identity_id:z.uuid(),report_id:z.uuid(),
 service_decision_sha256:hash,recipient_sha256:hash,origin:z.url(),template:z.literal(REAL_AI_SERVICE_NOTIFICATION_TEMPLATE),
 issued_at:time,expires_at:time,sha256:hash,
}).strict().superRefine((v,ctx)=>{
 const {sha256,...body}=v;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'REAL_SERVICE_NOTIFICATION_GRANT_HASH'});
 if(Date.parse(v.issued_at)>=Date.parse(v.expires_at))ctx.addIssue({code:'custom',message:'REAL_SERVICE_NOTIFICATION_GRANT_WINDOW'});
});
export const realAiServiceNotificationContextSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unavailable'),reason:z.enum(['not_authorized','revoked','expired','opted_out','contact_changed'])}).strict(),
 z.object({state:z.literal('authorized'),grant:realAiServiceNotificationGrantSchema,grant_sha256:hash,context_sha256:hash,
  evaluated_at:time,contact:z.email(),public_id:z.string().regex(/^TV-[A-Z0-9]{8}$/u),
  revocations:z.array(z.object({target_sha256:hash,effective_at:time}).strict()).max(128),
 }).strict(),
]);
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}
function trustedOrigin(value:string){
 const url=new URL(value);
 assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/', 'REAL_SERVICE_NOTIFICATION_ORIGIN');
 return url.origin;
}

/** Worker-only authorization at enqueue AND immediately before the existing
 * provider dispatcher sends a claimed outbox item. trustedAppOrigin comes from
 * deployment configuration, never a Host header or notification payload.
 * No arbitrary subject, body, URL, recipient or monetary finding is accepted. */
export async function authorizeRealAiReportNotification(context:PostgresTransactionContext,selector:RealAiServiceSelector,trustedAppOrigin:string){
 const delivery=await loadRealAiServiceDelivery(context,selector),bound=delivery.selector;
 assert(delivery.publication,'REAL_SERVICE_NOTIFICATION_UNPUBLISHED');
 const result=await context.client.query(statement('real_ai_service_notification_context',
  'select private.real_ai_service_notification_context($1::uuid,$2::uuid,$3::uuid) value',
  [bound.case_id,bound.identity_id,bound.report_id]));
 assert(result.row_count===1,'REAL_SERVICE_NOTIFICATION_CONTEXT_ACK');
 const row=realAiServiceNotificationContextSchema.parse(result.rows[0]?.value);
 assert(row.state==='authorized',row.state==='unavailable'?`REAL_SERVICE_NOTIFICATION_${row.reason.toUpperCase()}`:'REAL_SERVICE_NOTIFICATION_UNAVAILABLE');
 const grant=row.grant,at=Date.parse(row.evaluated_at),origin=trustedOrigin(trustedAppOrigin);
 assert(grant.state==='active'&&grant.sha256===row.grant_sha256,'REAL_SERVICE_NOTIFICATION_ACTIVE_GRANT_REQUIRED');
 assert(grant.case_id===bound.case_id&&grant.identity_id===bound.identity_id&&grant.report_id===bound.report_id
  &&grant.service_decision_sha256===delivery.binding.service_decision_sha256,'REAL_SERVICE_NOTIFICATION_SCOPE');
 assert(origin===trustedOrigin(grant.origin),'REAL_SERVICE_NOTIFICATION_ORIGIN_CHANGED');
 assert(at>=Date.parse(grant.issued_at)&&at<Date.parse(grant.expires_at)
  &&at>=Date.parse(delivery.evaluated_at)&&at<Date.parse(delivery.expires_at),'REAL_SERVICE_NOTIFICATION_EXPIRED');
 const contact=normalizeContact(row.contact);
 assert(contact?.channel==='email'&&contact.hash===grant.recipient_sha256&&!recipientRefusal(row.contact),'REAL_SERVICE_NOTIFICATION_RECIPIENT');
 const expiries=[grant.expires_at,delivery.expires_at];
 for(const revocation of row.revocations){
  if(![grant.sha256,grant.service_decision_sha256,grant.recipient_sha256].includes(revocation.target_sha256))continue;
  assert(at<Date.parse(revocation.effective_at),'REAL_SERVICE_NOTIFICATION_REVOKED');expiries.push(revocation.effective_at);
 }
 const rendered=renderReportReady({publicId:row.public_id,linkUrl:`${origin}/case/${row.public_id}/reports?report=${bound.report_id}`});
 const message:NotificationMessage={template:'report_ready',channel:'email',to:contact.normalized,...rendered};
 return {selector:bound,message,payload_sha256:payloadDigest(message),recipient_sha256:contact.hash,grant_sha256:grant.sha256,
  delivery_context_sha256:delivery.context_sha256,notification_context_sha256:row.context_sha256,
  delivery_binding_sha256:delivery.binding.delivery_binding_sha256,
  expires_at:new Date(Math.min(...expiries.map(Date.parse))).toISOString()};
}

/** Reuses private.case_notification_outbox through the dedicated atomic SQL
 * bridge. The DB rechecks both context tokens and contact authorization before
 * enqueueing this encrypted intention. No network/provider operation here. */
export async function enqueueRealAiReportNotification(context:PostgresTransactionContext,selector:RealAiServiceSelector,trustedAppOrigin:string,secret:string){
 const authorized=await authorizeRealAiReportNotification(context,selector,trustedAppOrigin);
 const encrypted=encryptNotification(authorized.message,authorized.payload_sha256,secret);
 const result=await context.client.query(statement('real_ai_service_notification_enqueue',
  'select private.real_ai_service_notification_enqueue($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9::timestamptz) value',
  [authorized.selector.case_id,authorized.selector.identity_id,authorized.selector.report_id,authorized.delivery_context_sha256,authorized.notification_context_sha256,
   authorized.payload_sha256,authorized.recipient_sha256,JSON.stringify(encrypted),authorized.expires_at]));
 assert(result.row_count===1,'REAL_SERVICE_NOTIFICATION_ENQUEUE_ACK');
 const receipt=z.object({delivery_id:hash,grant_sha256:hash,delivery_binding_sha256:hash,replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
 assert(receipt.delivery_id===authorized.payload_sha256&&receipt.grant_sha256===authorized.grant_sha256
  &&receipt.delivery_binding_sha256===authorized.delivery_binding_sha256,'REAL_SERVICE_NOTIFICATION_ENQUEUE_BINDING');
 return receipt;
}

const preparationSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('not_authorized'),reason:z.enum(['not_authorized','revoked','expired','opted_out','contact_changed'])}).strict(),
 z.object({state:z.literal('prepared'),grant_sha256:hash,derived:z.boolean()}).strict(),
]);
/** Derives the unchanged per-report grant only from recorded, live case
 * authorization. An absent or revoked authorization is an ordinary skip, so
 * callers can retain an otherwise valid publication. SQL/validation failures
 * still throw; they must never be reported as a successful queue operation. */
export async function prepareAndEnqueueRealAiReportNotification(context:PostgresTransactionContext,selector:RealAiServiceSelector,trustedAppOrigin:string,secret:string){
 assert(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1','REAL_SERVICE_DISABLED');
 assert(process.env.TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED==='1','REAL_SERVICE_NOTIFICATIONS_DISABLED');
 const bound=realAiServiceSelectorSchema.parse(selector),origin=trustedOrigin(trustedAppOrigin);
 assert(Buffer.from(secret,'base64').length===32,'NOTIFICATION_KEY_INVALID');
 const result=await context.client.query(statement('real_ai_service_notification_prepare',
  'select private.real_ai_service_notification_prepare($1::uuid,$2::uuid,$3::uuid) value',
  [bound.case_id,bound.identity_id,bound.report_id]));
 assert(result.row_count===1,'REAL_SERVICE_NOTIFICATION_PREPARE_ACK');
 const prepared=preparationSchema.parse(result.rows[0]?.value);
 if(prepared.state==='not_authorized')return {state:'skipped_not_authorized' as const,reason:prepared.reason};
 const receipt=await enqueueRealAiReportNotification(context,bound,origin,secret);
 assert(receipt.grant_sha256===prepared.grant_sha256,'REAL_SERVICE_NOTIFICATION_PREPARATION_CHANGED');
 return {state:'queued' as const,...receipt,derived:prepared.derived};
}

/** Invoke after decrypting an existing claimed intention and before sending.
 * A retry cannot use a previous successful authorization or changed content.
 * Lease ownership/fencing and final provider receipt remain the existing
 * dispatcher's responsibility. This function never calls a provider. */
export async function revalidateRealAiReportNotification(context:PostgresTransactionContext,selector:RealAiServiceSelector,trustedAppOrigin:string,
 claimed:{delivery_id:string;message:NotificationMessage}){
 const authorized=await authorizeRealAiReportNotification(context,selector,trustedAppOrigin);
 assert(claimed.delivery_id===authorized.payload_sha256&&payloadDigest(claimed.message)===authorized.payload_sha256
  &&canonicalSha256(claimed.message)===canonicalSha256(authorized.message),'REAL_SERVICE_NOTIFICATION_PAYLOAD_CHANGED');
 return {delivery_id:authorized.payload_sha256,grant_sha256:authorized.grant_sha256,expires_at:authorized.expires_at};
}
