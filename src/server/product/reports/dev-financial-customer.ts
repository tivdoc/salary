import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {parseDevFinancialRun} from '../processing/dev-financial-contract';
import {isolatedPreviewDatabase} from '../case-access/preview-database';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {devArtifactSha,renderDevFinancialArtifacts} from './dev-financial-artifacts';

export function devFinancialPreviewEnabled(){return isolatedPreviewDatabase(process.env)!==null;}
/** Existing authenticated customer scope is checked again by the private SQL
 * boundary. DEV/QA artifacts never enter the ordinary publication contract. */
export async function devFinancialCustomerReports(caseId:string,identityId:string,runId:string|null=null,db?:CaseAccessDb){
 z.uuid().parse(caseId);z.uuid().parse(identityId);if(runId)z.uuid().parse(runId);
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('DEV_FINANCIAL_STORE_UNAVAILABLE');
 const result=await store.rpc<{value:unknown}>('case_report_dev_financial',{target_case:caseId,target_identity:identityId,target_run:runId});
 if(result.length!==1)throw Error('DEV_FINANCIAL_READ_ACK');
 return z.array(z.object({payload:z.unknown(),payload_sha256:z.string(),html:z.string(),html_sha256:z.string(),pdf_sha256:z.string(),pdf_base64:z.string().nullable(),current:z.boolean()}).strict()).max(100).parse(result[0].value).map(row=>{
  const run=parseDevFinancialRun(row.payload);
  if(run.case_id!==caseId||(runId&&run.run_id!==runId)||canonicalSha256(run)!==row.payload_sha256)throw Error('DEV_FINANCIAL_READ_SCOPE');
  const artifacts=renderDevFinancialArtifacts(run);
  if(row.html!==artifacts.html||row.html_sha256!==artifacts.htmlSha256||row.pdf_sha256!==artifacts.pdfSha256)throw Error('DEV_FINANCIAL_ARTIFACT_MISMATCH');
  const pdf=row.pdf_base64===null?null:Buffer.from(row.pdf_base64,'base64');
  if(pdf&&devArtifactSha(pdf)!==row.pdf_sha256)throw Error('DEV_FINANCIAL_PDF_MISMATCH');
  return {run,current:row.current,html:row.html,pdf};
 });
}
export type DevCustomerFinancialReport=Awaited<ReturnType<typeof devFinancialCustomerReports>>[number];
