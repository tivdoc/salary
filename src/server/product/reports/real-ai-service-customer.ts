import 'server-only';
import {z} from 'zod';
import {hashSession} from '../case-access/crypto';
import {withCaseAccessPostgresTransaction,type CaseAccessDb} from '../case-access/db';
import {readRealAiServiceReport,readRealAiServiceRequestReview} from './real-ai-service-delivery';

const scope=z.object({caseId:z.uuid(),identityId:z.uuid(),sessionToken:z.string().min(20).max(512)}).strict();
const entry=z.object({report_id:z.uuid(),analysis_run_id:z.string().min(1),published_at:z.iso.datetime({offset:true}),
 from:z.iso.date(),to:z.iso.date(),current:z.boolean(),reason:z.string().max(100).nullable()}).strict();
export const realAiServiceCustomerEnabled=()=>process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1';
async function authenticated<T>(candidate:z.infer<typeof scope>,operation:(db:CaseAccessDb)=>Promise<T>){
 if(!realAiServiceCustomerEnabled())throw Error('REAL_SERVICE_DISABLED');
 const input=scope.parse(candidate);
 return withCaseAccessPostgresTransaction(async db=>{
  const installed=await db.rpc<{value:string}>('case_access_real_service_context_install',{target_case:input.caseId,target_session_hash:hashSession(input.sessionToken)});
  if(installed.length!==1||installed[0].value!==input.identityId)throw Error('REAL_SERVICE_SESSION_FORBIDDEN');
  return operation(db);
 });
}
export async function realAiServiceCustomerReports(input:z.infer<typeof scope>){
 return authenticated(input,async db=>{
  const rows=await db.rpc<{value:unknown}>('case_report_real_ai_list',{target_case:input.caseId,target_identity:input.identityId});
  if(rows.length!==1)throw Error('REAL_SERVICE_LIST_ACK');
  return z.array(entry).max(20).parse(rows[0].value);
 });
}
export async function realAiServiceCustomerArtifact(input:z.infer<typeof scope>,reportId:string,format:'html'|'pdf'){
 z.uuid().parse(reportId);
 return authenticated(input,db=>readRealAiServiceReport(db,{case_id:input.caseId,identity_id:input.identityId,report_id:reportId},format));
}
/** Optional presentation projection. Ambiguous current periods/orders preserve
 * every question; the list's current flag alone never authorizes suppression.
 * Session installation, discovery and full artifact revalidation share one
 * transaction. The returned review stays within the server request adapter. */
export async function realAiServiceCustomerRequestReview(input:z.infer<typeof scope>){
 if(!realAiServiceCustomerEnabled())return null;
 return authenticated(input,async db=>{
  const rows=await db.rpc<{value:unknown}>('case_report_real_ai_list',{target_case:input.caseId,target_identity:input.identityId});
  if(rows.length!==1)throw Error('REAL_SERVICE_LIST_ACK');
  const current=z.array(entry).max(20).parse(rows[0].value).filter(report=>report.current);
  if(current.length!==1)return null;
  const selected=current[0],review=await readRealAiServiceRequestReview(db,{
   case_id:input.caseId,identity_id:input.identityId,report_id:selected.report_id});
  if(review.case_id!==input.caseId||review.analysis_run_id!==selected.analysis_run_id
   ||review.period.from!==selected.from||review.period.to!==selected.to)throw Error('REAL_SERVICE_REQUEST_REVIEW_BINDING');
  return review;
 });
}
/** Foreign and nonexistent reports deliberately share one response. Only
 * explicit source/authority expiry is a stale result, never an outage. */
export function realAiServiceCustomerRefusal(error:unknown):404|410|null{
 if(!(error instanceof Error))return null;
 if(['REAL_SERVICE_DISABLED','REAL_SERVICE_SESSION_FORBIDDEN','REAL_SERVICE_UNAVAILABLE_FORBIDDEN','REAL_SERVICE_UNAVAILABLE_NOT_ENROLLED','REAL_SERVICE_UNAVAILABLE_UNPUBLISHED'].includes(error.message))return 404;
 if(['REAL_SERVICE_UNAVAILABLE_EXPIRED','REAL_SERVICE_UNAVAILABLE_REVOKED','REAL_SERVICE_UNAVAILABLE_SUPERSEDED',
  'REAL_SERVICE_ENROLLMENT_EXPIRED','REAL_SERVICE_DECISION_EXPIRED','REAL_SERVICE_CASE_DECISION_EXPIRED','REAL_SERVICE_REVOKED'].includes(error.message))return 410;
 return null;
}
