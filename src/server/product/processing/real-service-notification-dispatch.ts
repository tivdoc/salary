import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {decryptNotification} from '../case-access/notification-outbox';
import {sendNotification,type NotificationProvider,type NotificationOutcome} from '../case-access/notifications';
import {revalidateRealAiReportNotification} from '../reports/real-ai-service-notification';
import type {SavedWorkerTransactions} from './saved-worker-contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const claimSchema=z.object({delivery_id:hash,encrypted_payload:z.unknown(),fencing_token:z.number().int().positive(),
 case_id:z.uuid(),identity_id:z.uuid(),report_id:z.uuid()}).strict();
type Claim=z.infer<typeof claimSchema>;
type Attempt={delivery_id:string;state:'cancelled'|'provider_accepted'|'provider_unconfirmed';provider:string|null;provider_message_id:string|null;error_code:string|null;recorded:boolean};
const enabled=()=>process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1'&&process.env.TIVDOC_REAL_AI_NOTIFICATIONS_ENABLED==='1';
function origin(value:string){const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('REAL_SERVICE_NOTIFICATION_ORIGIN');return url.origin;
}
function encryptionKey(value:string){const bytes=Buffer.from(value,'base64');if(bytes.length!==32||bytes.toString('base64')!==value)throw Error('NOTIFICATION_KEY_INVALID');return value;}
async function authorize(context:PostgresTransactionContext,caseId:string){
 const result=await context.client.query(statement('real_notification_worker_scope',
  'select session_user::text principal,private.runtime_verified_tenant() tenant_id',[]));
 if(result.row_count!==1||result.rows[0]?.principal!=='tivdoc_worker_runtime'||result.rows[0]?.tenant_id!==`saved-case:${caseId}`)throw Error('REAL_SERVICE_NOTIFICATION_WORKER_FORBIDDEN');
}
async function dispatch(context:PostgresTransactionContext,claim:Claim,workerId:string){
 const result=await context.client.query(statement('real_notification_dispatch',
  'select private.real_ai_service_notification_dispatch($1::uuid,$2,$3::uuid,$4::integer) value',
  [claim.case_id,claim.delivery_id,workerId,claim.fencing_token]));
 if(result.row_count!==1)throw Error('REAL_SERVICE_NOTIFICATION_DISPATCH_ACK');
 return z.enum(['ready','cancelled']).parse(result.rows[0]?.value);
}
const safeError=(code:string|null)=>code&&/^[a-z0-9_]{1,100}$/u.test(code)?code:'provider_error_unclassified';

/** One bounded consumer of the EXISTING outbox. transactions must install the
 * provisioned machine SID/JTI on every transaction; this adapter verifies it
 * again and never manufactures a tenant/session or notification grant.
 * The caller provides private configured origin/key, never request headers.
 * Provider calls happen outside DB transactions. A post-dispatch revocation
 * cannot recall an in-flight email; its authenticated report URL revalidates.
 * No old generic claim/deliver path can bypass the REAL authorization below. */
export async function runRealAiServiceNotificationPass(input:{transactions:SavedWorkerTransactions;caseId:string;workerId:string;
 origin:string;secret:string;provider?:NotificationProvider;maxMessages?:number;signal?:AbortSignal}){
 const attempts:Attempt[]=[];
 const result=(state:'disabled'|'interrupted'|'finished'|'held',reason?:'finish_unconfirmed')=>({state,...(reason?{reason}:{}),attempts,deliveryConfirmed:false as const});
 if(!enabled())return result('disabled');if(input.signal?.aborted)return result('interrupted');
 // Snapshot caller data before awaiting; later mutation cannot change scope,
 // provider, transaction host, origin or encryption key halfway through a pass.
 const caseId=z.uuid().parse(input.caseId),workerId=z.uuid().parse(input.workerId),trustedOrigin=origin(input.origin),secret=encryptionKey(input.secret);
 const maximum=z.number().int().min(1).max(10).parse(input.maxMessages??2),transactions=input.transactions,provider=input.provider,signal=input.signal;
 for(let index=0;index<maximum;index++){
  if(!enabled())return result('disabled');if(signal?.aborted)return result('interrupted');
  const claimed=await transactions(async context=>{
   await authorize(context,caseId);
   const rows=await context.client.query(statement('real_notification_claim',
    'select * from private.real_ai_service_notification_claim($1::uuid,$2::uuid)',[caseId,workerId]));
   if(rows.row_count!==rows.rows.length||rows.rows.length>1)throw Error('REAL_SERVICE_NOTIFICATION_CLAIM_ACK');
   if(!rows.rows.length)return null;
   const row=claimSchema.parse(rows.rows[0]);if(row.case_id!==caseId)throw Error('REAL_SERVICE_NOTIFICATION_CLAIM_SCOPE');return row;
  });
  if(!claimed)break;
  if(!enabled())return result('disabled');if(signal?.aborted)return result('interrupted');
  const message=await transactions(async context=>{
   await authorize(context,caseId);
   // SQL owns case -> outbox lock order and checks current publication/grant,
   // expiry, contact, source and lease BEFORE decrypting any claimed content.
   if(await dispatch(context,claimed,workerId)==='cancelled')return null;
   const decrypted=decryptNotification(claimed.encrypted_payload,claimed.delivery_id,secret);
   await revalidateRealAiReportNotification(context,{case_id:caseId,identity_id:claimed.identity_id,report_id:claimed.report_id},trustedOrigin,
    {delivery_id:claimed.delivery_id,message:decrypted});
   // Replay/rerender can take time: recheck DB time/fence after that work too.
   return await dispatch(context,claimed,workerId)==='ready'?decrypted:null;
  });
  if(!message){attempts.push({delivery_id:claimed.delivery_id,state:'cancelled',provider:null,provider_message_id:null,error_code:null,recorded:true});continue;}
  if(!enabled())return result('disabled');if(signal?.aborted)return result('interrupted');
  let outcome:NotificationOutcome;
  try{outcome=await sendNotification(message,provider);}
  catch{outcome={state:'failed',provider:provider?.id??'configured_provider',error_code:'provider_transport_uncertain',payload_sha256:claimed.delivery_id};}
  const providerId=outcome.state==='sent'&&z.uuid().safeParse(outcome.provider_message_id).success?outcome.provider_message_id!:null;
  const error=providerId?null:outcome.state==='sent'?'provider_receipt_missing':safeError(outcome.error_code);
  const attempt:Attempt={delivery_id:claimed.delivery_id,state:providerId?'provider_accepted':'provider_unconfirmed',provider:outcome.provider,
   provider_message_id:providerId,error_code:error,recorded:false};attempts.push(attempt);
  try{
   await transactions(async context=>{
    await authorize(context,caseId);
    const finished=await context.client.query(statement('real_notification_finish',
     'select private.real_ai_service_notification_finish($1::uuid,$2,$3::uuid,$4::integer,$5::uuid,$6) value',
     [caseId,claimed.delivery_id,workerId,claimed.fencing_token,providerId,error]));
    if(finished.row_count!==1)throw Error('REAL_SERVICE_NOTIFICATION_FINISH_ACK');
   });attempt.recorded=true;
  }catch{
   // The provider may already have accepted this exact digest. Do not send
   // again here or infer rollback; the durable lease and same-key retry are
   // retained for the next ordinary outbox pass, inside its existing expiry.
   return result('held','finish_unconfirmed');
  }
 }
 return result('finished');
}
