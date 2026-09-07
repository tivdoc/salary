import {createHash} from 'node:crypto';
import type {NotificationProvider,NotificationMessage} from './notifications.ts';
/** Fixed endpoint; no attachments, redirects, caller-controlled sender or logs.
 * Success means API acceptance with a provider ID, never confirmed delivery. */
export function resendProvider(apiKey:string,from:string,transport:typeof fetch=fetch):NotificationProvider{
 return {id:'resend',async send(message:NotificationMessage){
  if(message.channel!=='email')return {ok:false,error_code:'resend_email_only'};
  if(!apiKey||!from||/[\r\n]/.test(from))return {ok:false,error_code:'resend_not_configured'};
  const key=createHash('sha256').update(`${message.template}|${message.channel}|${message.to}|${message.subject}|${message.body}`).digest('hex');
  try{
   const response=await transport('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from,to:[message.to],subject:message.subject,text:message.body})});
   if(!response.ok)return {ok:false,error_code:response.status===429||response.status>=500?'resend_retryable':'resend_rejected'};
   const data:unknown=await response.json();
   if(!data||typeof data!=='object'||!('id' in data)||typeof data.id!=='string'||!/^[a-f0-9-]{36}$/i.test(data.id))return {ok:false,error_code:'resend_response_invalid'};
   return {ok:true,provider_message_id:data.id};
  }catch{return {ok:false,error_code:'resend_transport_uncertain'};}
 }};
}
