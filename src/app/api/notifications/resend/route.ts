import {NextResponse} from 'next/server';
import {guardStableHttpEntrypoint} from '@/server/platform/capabilities/stable-http-entrypoint';
import {refusedEntrypoint} from '@/server/product/routes/http-common';
import {verifyResendWebhook} from '@/server/product/case-access/resend-webhook';
import {resolveCaseAccessDb,postgresCaseAccessDb} from '@/server/product/case-access/db';
export const runtime='nodejs';
let webhookPool:import('pg').Pool|undefined;
async function webhookStore(){
 const connectionString=process.env.TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL;
 if(!connectionString)return resolveCaseAccessDb();
 if(!webhookPool){const {default:pg}=await import('pg');webhookPool=new pg.Pool({connectionString,max:2,connectionTimeoutMillis:15000,application_name:'tivdoc_webhook'});}
 return postgresCaseAccessDb(webhookPool);
}
export async function POST(request:Request){
 try{await guardStableHttpEntrypoint("CEP-109", request);}catch(error){return refusedEntrypoint(error);}
 const secret=process.env.RESEND_WEBHOOK_SECRET;
 if(process.env.TIVDOC_NOTIFICATION_WEBHOOK_ENABLED!=='true'||!secret)return NextResponse.json({code:'webhook_disabled'},{status:503});
 let event:ReturnType<typeof verifyResendWebhook>;
 try{
  const reader=request.body?.getReader();if(!reader)return NextResponse.json({code:'webhook_invalid'},{status:400});
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536){void reader.cancel();return NextResponse.json({code:'body_too_large'},{status:413});}chunks.push(next.value);}
  event=verifyResendWebhook(Buffer.concat(chunks).toString('utf8'),request.headers,secret);
 }catch{return NextResponse.json({code:'signature_invalid'},{status:401});}
 if(!['email.sent','email.delivered','email.bounced','email.complained','email.suppressed','email.failed','email.delivery_delayed'].includes(event.kind))return NextResponse.json({accepted:true});
 try{
  const db=await webhookStore();if(!db)return NextResponse.json({code:'store_unavailable'},{status:503});
  await db.rpc('case_notification_webhook_record',{target_event:event.event_id,target_provider:event.provider_message_id,target_kind:event.kind,target_at:event.occurred_at});
  return NextResponse.json({accepted:true});
 }catch{return NextResponse.json({code:'event_persistence_failed'},{status:503});}
}
