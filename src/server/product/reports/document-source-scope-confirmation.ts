import {z} from 'zod';
import {sourceScopeObservationSchema} from '@/engine/extraction/contracts';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {documentScopeReadingFields} from '@/engine/extraction/reading-resolution';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {formatRequestMonth} from '@/lib/request-display';
const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,expected_month:month,
 period_mismatch:z.boolean(),result_sha256:sha,run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()});
export const documentSourceScopeTargetSchema=z.object({schema_version:z.literal('document-source-scope-confirmation-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month,policy_version:z.string().min(1).max(100),extraction_result_sha256:sha,original_observation:sourceScopeObservationSchema,target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 const candidate=target.original_observation.candidate;
 if(!documentScopeReadingFields.some(field=>field===candidate.field))ctx.addIssue({code:'custom',message:'Only a numeric source observation can be confirmed'});
 if(candidate.source.document_id!==target.version_id)ctx.addIssue({code:'custom',message:'Observation must belong to the exact document version'});
 const {target_sha256,...body}=target;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Scope observation target hash mismatch'});
});
export type DocumentSourceScopeTarget=Readonly<z.infer<typeof documentSourceScopeTargetSchema>>;
export function documentSourceScopeTarget(input:{checkpoint:unknown;policyVersion:string;candidateId:string}):DocumentSourceScopeTarget {
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction;
 if(extraction.customer_readings!==undefined||extraction.customer_row_readings!==undefined||extraction.customer_scope_readings!==undefined||extraction.customer_source_transcriptions!==undefined||extraction.source_reading_context!==undefined)throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(checkpoint.period_mismatch||!periods.length||periods.some(p=>!p.normalized_value||`${p.normalized_value.year}-${String(p.normalized_value.month).padStart(2,'0')}`!==checkpoint.expected_month))throw Error('REQUEST_FIELD_PERIOD_UNKNOWN');
 const observations=extraction.source_scope_observations?.filter(o=>o.candidate.candidate_id===input.candidateId)??[];
 if(observations.length!==1||extraction.fields.some(f=>f.candidate_id===input.candidateId)||extraction.additional_components.some(r=>r.component_id===input.candidateId))throw Error('REQUEST_FIELD_CANDIDATE_AMBIGUOUS');
 const body={schema_version:'document-source-scope-confirmation-v1' as const,case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,
  source_sha256:checkpoint.input_sha256,month:checkpoint.expected_month,policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,original_observation:observations[0]};
 return deepFreeze(documentSourceScopeTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function documentSourceScopeQuestion(input:unknown){
 const target=documentSourceScopeTargetSchema.parse(input),observation=target.original_observation;
 return {code:`document_field:${target.target_sha256}`,question:`בעמוד ${observation.candidate.source.page} במסמך לחודש ${formatRequestMonth(target.month)}, מהו הערך תחת "${observation.source_label}"? יש להשוות את הקריאה המוצגת למקור. האימות מתייחס לערך בלבד.`,
  answer_kind:'choice' as const,options:['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת'],field_crop:`source_scope.${observation.scope}`,blocking:false};
}
export function documentSourceScopeCurrent(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;requestId:string;answerRevision:number;identityId:string;answeredAt:string}):boolean {
 const target=documentSourceScopeTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.string().datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return false;
 try{return documentSourceScopeTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,candidateId:target.original_observation.candidate.candidate_id}).target_sha256===target.target_sha256;}
 catch{return false;}
}
