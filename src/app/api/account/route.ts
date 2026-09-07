import {z} from 'zod';
import {resolveIdentitySession,listIdentityCases} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {sameOriginSessionRequest} from '@/server/product/case-access/session-actions';
import {resolveCaseAccessDb} from '@/server/product/case-access/db';
import {strictJsonObject,PRODUCT_HTTP_HEADERS,refusedEntrypoint} from '@/server/product/routes/http-common';
import {guardStableHttpEntrypoint} from '@/server/platform/capabilities/stable-http-entrypoint';
export const runtime='nodejs';export const dynamic='force-dynamic';
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('request'),id:z.uuid(),publicId:z.string(),kind:z.enum(['access','correction','deletion']),message:z.string().trim().min(4).max(2000)}).strict(),
 z.object({action:z.literal('export'),publicId:z.string()}).strict(),
]);
export async function POST(request:Request){
 try{await guardStableHttpEntrypoint("CEP-113",request);}catch(error){return refusedEntrypoint(error);}
 if(!sameOriginSessionRequest(request))return new Response(null,{status:403,headers:PRODUCT_HTTP_HEADERS});
 const body=schema.safeParse(await strictJsonObject(request,12000).catch(()=>null));if(!body.success)return new Response(null,{status:400,headers:PRODUCT_HTTP_HEADERS});
 try{const session=await resolveIdentitySession(await readCaseSessionCookie());if(!session)return new Response(null,{status:401,headers:PRODUCT_HTTP_HEADERS});const item=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===body.data.publicId);if(!item)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});const db=await resolveCaseAccessDb();if(!db)throw new Error('store');
 if(body.data.action==='export'){const result=await db.rpc<{value:unknown}>('case_privacy_export',{target_case:item.case_id,target_identity:session.identity_id,target_session:session.session_id});if(!result[0]?.value)throw new Error('store');return Response.json(result[0].value,{headers:{...PRODUCT_HTTP_HEADERS,'Content-Disposition':`attachment; filename="Tivdoc-personal-data-${item.public_id}.json"`}});}
 const result=await db.rpc<{value:unknown}>('case_privacy_request',{target_case:item.case_id,target_identity:session.identity_id,target_id:body.data.id,target_kind:body.data.kind,target_message:body.data.message});return Response.json({request:result[0]?.value},{status:202,headers:PRODUCT_HTTP_HEADERS});
 }catch(error){const reauth=error instanceof Error&&error.message.includes('PRIVACY_REAUTH_REQUIRED');return Response.json({code:reauth?'reauth_required':'privacy_unavailable',error:reauth?'ליצוא המידע צריך להיכנס מחדש עם קוד אימות.':'לא ניתן לאשר שהבקשה הושלמה. אפשר לנסות שוב.'},{status:reauth?401:503,headers:PRODUCT_HTTP_HEADERS});}
}
