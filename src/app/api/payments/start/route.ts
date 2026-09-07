import {z} from 'zod';
import {readCaseIdFromCookie} from '@/lib/case-cookie';
import {createOrder,orderCheckout} from '@/server/product/orders/service';
import {orderRequestSchema} from '@/server/product/orders/contracts';
import {resolveCaseAccessDb} from '@/server/product/case-access/db';
import {listIdentityCases,resolveIdentitySession} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {sameOriginSessionRequest} from '@/server/product/case-access/session-actions';
import {PRODUCT_HTTP_HEADERS,strictJsonObject,refusedEntrypoint} from '@/server/product/routes/http-common';
import {guardStableHttpEntrypoint} from '@/server/platform/capabilities/stable-http-entrypoint';
export const runtime='nodejs';
const bodySchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('quote'),publicId:z.string().optional(),request:orderRequestSchema.optional()}).strict(),
 z.object({action:z.literal('checkout'),publicId:z.string().optional(),orderId:z.uuid(),termsAccepted:z.literal(true)}).strict(),
 z.object({action:z.literal('refund'),publicId:z.string(),orderId:z.uuid(),id:z.uuid(),reason:z.string().trim().min(4).max(2000)}).strict(),
]);
export async function POST(request:Request){
 try{await guardStableHttpEntrypoint("CEP-022",request);}catch(error){return refusedEntrypoint(error);}
 if(!sameOriginSessionRequest(request))return new Response(null,{status:403});
 const body=bodySchema.safeParse(await strictJsonObject(request,12000).catch(()=>null));if(!body.success)return Response.json({error:'פרטי הבקשה אינם תקינים'},{status:400});
 try{
  let caseId:string|null=null,identityId:string|null=null;
  if(body.data.publicId){const session=await resolveIdentitySession(await readCaseSessionCookie());if(session){const item=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===body.data.publicId);if(item){caseId=item.case_id;identityId=session.identity_id;}}}
  else caseId=await readCaseIdFromCookie();
  if(!caseId)return new Response(null,{status:404});
  if(body.data.action==='refund'){
   const db=await resolveCaseAccessDb();if(!db)throw new Error('store');const state=(await db.rpc<{value:string}>('case_order_refund_request',{target_case:caseId,target_identity:identityId,target_order:body.data.orderId,target_id:body.data.id,target_reason:body.data.reason}))[0]?.value;
   return Response.json({state},{status:202,headers:PRODUCT_HTTP_HEADERS});
  }
  if(body.data.action==='checkout')return Response.json(await orderCheckout({caseId,identityId,orderId:body.data.orderId,termsAccepted:body.data.termsAccepted}),{headers:PRODUCT_HTTP_HEADERS});
  let desired=body.data.request;
  if(!identityId){
   if(desired&&desired.kind!=='initial')return new Response(null,{status:404});
   const db=await resolveCaseAccessDb();if(!db)throw new Error('store');
   const data=(await db.rpc<{value:{check_period_month:string;payment_status:string;legacy_payment:boolean}}>('case_order_funnel_state',{target_case:caseId}))[0]?.value;if(!data)return new Response(null,{status:404});
   if(['paid','verified'].includes(data.payment_status))return Response.json({url:'/check/received'},{headers:PRODUCT_HTTP_HEADERS});
   if(data.legacy_payment)throw new Error('ORDER_LEGACY_PAYMENT_REQUIRES_RECONCILIATION');
   const month=String(data.check_period_month).slice(0,7);desired={kind:'initial',from:month,to:month};
  }
  if(!desired)return Response.json({error:'צריך לבחור תקופת בדיקה'},{status:400});
  return Response.json({order:await createOrder({caseId,identityId,request:desired})},{headers:PRODUCT_HTTP_HEADERS});
 }catch(error){const code=error instanceof Error?error.message:'';if(code==='ORDER_PRICING_BASIS_UNAVAILABLE')return Response.json({error:'עדיין אין בתיק בסיס כספי וכיסוי מאומתים להצעת שדרוג. התוצאה הראשונית ששולמה נשארת זמינה.',code:'pricing_basis_unavailable'},{status:409,headers:PRODUCT_HTTP_HEADERS});const uncertain=code.includes('UNCERTAIN')||code.includes('LEGACY_PAYMENT');return Response.json({error:uncertain?'מצב התשלום דורש בירור. לא נפתח חיוב נוסף.':'לא ניתן לפתוח את ההזמנה כרגע. הסטטוס הקיים נשמר.',code:uncertain?'checkout_requires_reconciliation':'order_unavailable'},{status:409,headers:PRODUCT_HTTP_HEADERS});}
}
