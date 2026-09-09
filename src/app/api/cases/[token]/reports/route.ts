import {devFinancialCustomerReports,devFinancialPreviewEnabled} from '@/server/product/reports/dev-financial-customer';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {customerReports} from '@/server/product/reports/customer-reports';
import {savedReportPdf} from '@/server/product/reports/report-artifacts';
import {resolveCaseAccessDb} from '@/server/product/case-access/db';
import {listIdentityCases,resolveIdentitySession} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {sameOriginSessionRequest} from '@/server/product/case-access/session-actions';
import {getSupabaseAdmin} from '@/lib/supabase-admin';
import {PRODUCT_HTTP_HEADERS,strictJsonObject,refusedEntrypoint} from '@/server/product/routes/http-common';
import {guardStableHttpEntrypoint} from '@/server/platform/capabilities/stable-http-entrypoint';
export const runtime='nodejs';export const dynamic='force-dynamic';
type Context={params:Promise<{token:string}>};
async function scope(context:Context){const session=await resolveIdentitySession(await readCaseSessionCookie());if(!session)return null;const {token}=await context.params;const item=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===token);return item?{item,identity:session.identity_id}:null;}
export async function GET(request:Request,context:Context){
 try{await guardStableHttpEntrypoint("CEP-110",request);}catch(error){return refusedEntrypoint(error);}
 try{
  const owner=await scope(context);if(!owner)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
  const url=new URL(request.url);const id=z.uuid().safeParse(url.searchParams.get('report'));if(!id.success)return new Response(null,{status:404});
  if(url.searchParams.get('engineering')==='1'){
   if(!devFinancialPreviewEnabled())return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
   const [report]=await devFinancialCustomerReports(owner.item.case_id,owner.identity,id.data);
   if(!report)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
   if(!url.searchParams.has('version')){
    if(!report.pdf)throw Error('DEV_FINANCIAL_PDF_MISSING');
    return new Response(report.pdf,{headers:{...PRODUCT_HTTP_HEADERS,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Tivdoc-dev-${report.run.run_id}.pdf"`}});
   }
   if(url.searchParams.get('version')!==report.run.source.version_id)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
   const source=report.run.source,{data,error}=await getSupabaseAdmin().storage.from('salary-documents').download(source.path);
   if(error||!data||data.size!==source.size)throw Error('DEV_FINANCIAL_SOURCE_MISSING');
   const bytes=Buffer.from(await data.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==source.source_sha256)throw Error('DEV_FINANCIAL_SOURCE_CHANGED');
   return new Response(bytes,{headers:{...PRODUCT_HTTP_HEADERS,'Content-Type':source.mime,'Content-Disposition':`attachment; filename="source-${source.version_id}.${source.mime==='application/pdf'?'pdf':source.mime==='image/png'?'png':'jpg'}"`}});
  }
  const saved=await customerReports(owner.item.case_id,owner.identity,owner.item.public_id);const report=saved.reports.find(r=>r.id===id.data);if(!report)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
  if(!url.searchParams.has('version'))return new Response(Buffer.from(savedReportPdf(report)),{headers:{...PRODUCT_HTTP_HEADERS,'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Tivdoc-${owner.item.public_id}.pdf"`}});
  const version=z.uuid().safeParse(url.searchParams.get('version'));if(!version.success)return new Response(null,{status:404});
  const db=await resolveCaseAccessDb();if(!db)throw new Error('unavailable');
  const rows=await db.rpc<{value:{path:string;mime:string;size:number;sha256:string}}>('case_report_source',{target_case:owner.item.case_id,target_identity:owner.identity,target_report:report.id,target_version:version.data});
  const source=rows[0]?.value;if(!source||!source.path.startsWith(`cases/${owner.item.case_id}/`)||source.size>10*1024*1024)throw new Error('invalid_source');
  const {data,error}=await getSupabaseAdmin().storage.from('salary-documents').download(source.path);if(error||!data||data.size!==source.size)throw new Error('source_missing');
  const bytes=Buffer.from(await data.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new Error('source_changed');
  return new Response(bytes,{headers:{...PRODUCT_HTTP_HEADERS,'Content-Type':source.mime,'Content-Disposition':`attachment; filename="source-${version.data}.${source.mime==='application/pdf'?'pdf':source.mime==='image/png'?'png':'jpg'}"`}});
 }catch{return Response.json({code:'report_unavailable'},{status:503,headers:PRODUCT_HTTP_HEADERS});}
}
const correction=z.object({id:z.uuid(),reportId:z.uuid(),findingId:z.uuid(),message:z.string().trim().min(4).max(2000)}).strict();
export async function POST(request:Request,context:Context){
 try{await guardStableHttpEntrypoint("CEP-110",request);}catch(error){return refusedEntrypoint(error);}
 if(!sameOriginSessionRequest(request))return new Response(null,{status:403});
 try{const owner=await scope(context);if(!owner)return new Response(null,{status:404});const raw=await strictJsonObject(request,12000);const opened=z.object({action:z.literal('opened'),reportId:z.uuid()}).strict().safeParse(raw);if(opened.success){const db=await resolveCaseAccessDb();if(!db)throw new Error('unavailable');await db.rpc('case_report_open',{target_case:owner.item.case_id,target_identity:owner.identity,target_report:opened.data.reportId});return new Response(null,{status:204,headers:PRODUCT_HTTP_HEADERS});}const body=correction.safeParse(raw);if(!body.success)return Response.json({code:'invalid_correction'},{status:400});
 const db=await resolveCaseAccessDb();if(!db)throw new Error('unavailable');await db.rpc('case_report_correction_submit',{target_id:body.data.id,target_case:owner.item.case_id,target_identity:owner.identity,target_report:body.data.reportId,target_finding:body.data.findingId,target_message:body.data.message});return Response.json({state:'pending'},{status:202,headers:PRODUCT_HTTP_HEADERS});
 }catch{return Response.json({code:'correction_unavailable'},{status:503,headers:PRODUCT_HTTP_HEADERS});}
}
