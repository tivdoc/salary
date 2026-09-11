import 'server-only';
import {z} from 'zod';
import {decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {WAVE3_TOPICS} from '@/engine/wave3/contracts';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';

const summary=z.object({report_id:z.uuid(),analysis_run_id:z.uuid(),period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 report_revision:z.number().int().positive(),current:z.boolean(),created_at:z.string(),purchased_topics:z.array(z.string()).min(1)}).strict();
/** Protected owner drafts; SQL additionally restricts these to the isolated
 * QA database. No publication projection or customer notification is created. */
export async function privateDocumentReviewReports(caseId:string,identityId:string,db?:CaseAccessDb){
 z.uuid().parse(caseId);z.uuid().parse(identityId);
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('PRIVATE_REVIEW_STORE');
 const rows=await store.rpc<{value:unknown}>('case_report_private_review_list',{target_case:caseId,target_identity:identityId});
 if(rows.length!==1)throw Error('PRIVATE_REVIEW_LIST_ACK');
 return z.array(summary).max(100).parse(rows[0].value);
}
export async function privateDocumentReviewArtifact(caseId:string,identityId:string,reportId:string,db?:CaseAccessDb){
 [caseId,identityId,reportId].forEach(value=>z.uuid().parse(value));
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('PRIVATE_REVIEW_STORE');
 const rows=await store.rpc<{value:unknown}>('case_report_private_review_artifact',{target_case:caseId,target_identity:identityId,target_report:reportId});
 if(rows.length===0||rows.length===1&&rows[0].value===null)return null;
 if(rows.length!==1)throw Error('PRIVATE_REVIEW_ACK');
 const row=z.object({current:z.boolean(),completion:z.object({bundle:z.unknown(),report:z.unknown()}).passthrough()}).strict().parse(rows[0].value);
 const topics=z.object({topic_results:z.array(z.object({topic:z.enum(WAVE3_TOPICS)}))}).parse(row.completion.bundle).topic_results.map(t=>t.topic);
 const bundle=decodeBundle(row.completion.bundle,topics),report=decodeReport(row.completion.report);
 const presentation=z.object({schema_version:z.literal('document-review-presentation-v1'),report_id:z.uuid(),analysis_run_id:z.uuid(),
  analysis_result_sha256:z.string(),report_revision:z.number().int()}).passthrough().parse(JSON.parse(Buffer.from(report.json).toString('utf8')));
 if(!bundle.document_review||bundle.case_id!==caseId||report.report_id!==reportId||report.analysis_result_sha256!==bundle.result_sha256
  ||presentation.report_id!==reportId||presentation.analysis_run_id!==bundle.analysis_run_id||presentation.analysis_result_sha256!==bundle.result_sha256
  ||presentation.report_revision!==report.report_revision||canonicalSha256(bundle.document_review.input)!==bundle.document_review.input_sha256)throw Error('PRIVATE_REVIEW_BINDING');
 return {bundle,report,current:row.current};
}
