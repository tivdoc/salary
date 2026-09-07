import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {parseProjection,type CaseReportProjection} from './case-report-projection';
import {reportDocumentSchema,type ReportDocument} from './report-document';
export type SavedReport={id:string;projection:CaseReportProjection;document:ReportDocument|null;sha256:string;publishedAt:string};
export type CustomerReports={caseId:string;publicId:string;checkPeriodMonth:string|null;reports:SavedReport[]};
export async function customerReports(caseId:string,identityId:string,publicId:string,db?:CaseAccessDb):Promise<CustomerReports>{
 const store=db??await resolveCaseAccessDb();if(!store)throw new Error('REPORT_STORE_UNAVAILABLE');
 const rows=await store.rpc<{value:CustomerReports}>('case_report_customer_snapshot',{target_case:caseId,target_identity:identityId});
 const result=rows[0]?.value;if(!result||result.caseId!==caseId||result.publicId!==publicId)throw new Error('REPORT_SCOPE_MISMATCH');
 return {...result,reports:result.reports.map(row=>{
  const projection=parseProjection(row.projection);
  if(projection.case_public_id!==publicId)throw new Error('REPORT_SCOPE_MISMATCH');
  const document=row.document?reportDocumentSchema.parse(row.document):null;
  if(document&&(document.case_id!==caseId||document.id!==row.id||document.projection_sha256!==row.sha256||canonicalSha256(projection)!==document.projection_sha256))throw new Error('REPORT_DOCUMENT_MISMATCH');
  return {...row,projection,document};
 })};
}
