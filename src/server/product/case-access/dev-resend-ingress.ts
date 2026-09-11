import {decodeResendWebhookBody,verifyResendWebhook} from './resend-webhook.ts';

type Env=Readonly<Record<string,string|undefined>>;
const response=(status:number,code:string)=>Response.json({code},{status,headers:{'cache-control':'no-store'}});
const INGRESS_APPLICATION_ENV=new Set(['RESEND_WEBHOOK_SECRET','TIVDOC_DEV_INGRESS_ENABLED',
 'TIVDOC_DEV_PREVIEW_SHARE_SECRET','TIVDOC_DEV_PREVIEW_ORIGIN','TIVDOC_DEV_PREVIEW_SHARE_EXPIRES']);
/** A reused project must blank its application variables for this deployment.
 * This checks the actual runtime values, not a build-time claim. Platform-owned
 * Vercel/AWS credentials are outside the application's credential namespace. */
export function devIngressCredentialScopeValid(env:Env):boolean{
 return Object.entries(env).every(([key,value])=>{
  if(!value||INGRESS_APPLICATION_ENV.has(key))return true;
  if(/^(?:VERCEL_|AWS_)/u.test(key))return true;
  return !/^(?:TIVDOC_|NEXT_PUBLIC_|SUPABASE_|OPENAI_|RESEND_|CASE_|DELIVERY_|GA4_|INVOICE4U_|META_|PAYMENT_|STRIPE_|DATABASE_|POSTGRES_|PGPASSWORD$|PGPASSFILE$)/u.test(key)
   && !/(?:^|_)(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS|POSTGRES_URL|DATABASE_URL)$/u.test(key);
 });
}
/** Public DEV-only webhook ingress. Its runtime refuses application DB,
 * storage, customer session, OCR and email-sending credentials. An expiring share for one immutable
 * Preview is exchanged for its scoped Vercel cookie; project-wide bypass keys
 * are never accepted. The application independently verifies the original
 * provider signature and records the receipt under its existing DB guards. */
export async function handleDevResendIngress(request:Request,env:Env,transport:typeof fetch=fetch):Promise<Response>{
 if(env.VERCEL_ENV!=='preview'||env.TIVDOC_DEV_INGRESS_ENABLED!=='true')return response(503,'ingress_disabled');
 if(!devIngressCredentialScopeValid(env))return response(503,'credential_scope_violation');
 return forwardSignedDevEvent(request,env,transport);
}
/** Explicit local test relay, not a deployment or a replacement for Preview
 * protection. Only its signed-event endpoint is exposed by the temporary tunnel.
 * The local process receives no DB, storage or sending credential. */
export async function handleLocalDevResendIngress(request:Request,env:Env,transport:typeof fetch=fetch):Promise<Response>{
 const expires=Date.parse(env.TIVDOC_DEV_LOCAL_INGRESS_EXPIRES??'');
 if(env.VERCEL||env.VERCEL_ENV||env.NODE_ENV!=='development'||env.TIVDOC_DEV_LOCAL_INGRESS_ENABLED!=='true'
  ||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+4*60*60*1000)return response(503,'local_ingress_disabled');
 return forwardSignedDevEvent(request,env,transport);
}
async function forwardSignedDevEvent(request:Request,env:Env,transport:typeof fetch):Promise<Response>{
 if(new URL(request.url).pathname!=='/api/resend')return response(404,'not_found');
 if(request.method!=='POST')return response(405,'method_not_allowed');
 const secret=env.RESEND_WEBHOOK_SECRET,share=env.TIVDOC_DEV_PREVIEW_SHARE_SECRET;
 const origin=env.TIVDOC_DEV_PREVIEW_ORIGIN;
 if(!secret||!share||!/^[A-Za-z0-9_-]{20,128}$/u.test(share)||!origin
  ||!/^https:\/\/salary-[a-z0-9]+-tivdoccom-5042s-projects\.vercel\.app$/u.test(origin)
  ||!/^\d{4}-\d{2}-\d{2}T/.test(env.TIVDOC_DEV_PREVIEW_SHARE_EXPIRES??'')
  ||Date.parse(env.TIVDOC_DEV_PREVIEW_SHARE_EXPIRES!)<=Date.now()
  ||!Number.isFinite(Date.parse(env.TIVDOC_DEV_PREVIEW_SHARE_EXPIRES!)))return response(503,'ingress_configuration_required');
 const contentLength=request.headers.get('content-length');
 if(contentLength&&(!/^\d+$/u.test(contentLength)||Number(contentLength)>65536))return response(413,'body_too_large');
 let raw:string;
 try{
  const reader=request.body?.getReader();if(!reader)return response(400,'body_required');
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const read=await reader.read();if(read.done)break;size+=read.value.byteLength;
   if(size>65536){void reader.cancel();return response(413,'body_too_large');}chunks.push(read.value);}
  raw=decodeResendWebhookBody(Buffer.concat(chunks));
  verifyResendWebhook(raw,request.headers,secret);
 }catch{return response(401,'signature_invalid');}
 try{
  // No automatic redirects: an unexpected URL cannot receive credentials.
  const access=new URL('/api/health',origin);access.searchParams.set('_vercel_share',share);
  const exchange=await transport(access,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000)});
  const location=exchange.headers.get('location');
  const destination=location?new URL(location,origin):null;
  if(exchange.status!==307||destination?.origin!==origin||destination.pathname!=='/api/health'||destination.search)return response(502,'preview_access_refused');
  const cookies=exchange.headers.getSetCookie();
  const cookie=cookies.map(value=>value.split(';',1)[0]).find(value=>value.startsWith('_vercel_jwt='));
  if(!cookie||cookie.length>16384)return response(502,'preview_access_refused');
  const headers=new Headers({'content-type':'application/json','cookie':cookie});
  for(const name of ['svix-id','svix-timestamp','svix-signature'])headers.set(name,request.headers.get(name)!);
  const delivered=await transport(new URL('/api/notifications/resend',origin),{
   method:'POST',redirect:'manual',headers,body:raw,signal:AbortSignal.timeout(15000),
  });
  // The provider gets success only after the existing application persisted or
  // safely deduplicated its signed receipt. No response body is reflected.
  if(delivered.status!==200)return response(502,'preview_receipt_not_saved');
  const body:unknown=await delivered.json();
  if(!body||typeof body!=='object'||!('accepted' in body)||body.accepted!==true)return response(502,'preview_receipt_not_saved');
  return Response.json({accepted:true},{headers:{'cache-control':'no-store'}});
 }catch{return response(502,'preview_unavailable');}
}
