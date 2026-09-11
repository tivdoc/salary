import {hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import {z} from 'zod';
import {normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {rowReadingCellSchema} from '@/engine/extraction/customer-reading';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {formatRequestMonth} from '@/lib/request-display';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 input_sha256:sha,expected_month:month,period_mismatch:z.boolean(),result_sha256:sha,
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()});
export const documentRowCellTargetSchema=z.object({schema_version:z.literal('document-row-cell-confirmation-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month,policy_version:z.string().min(1).max(100),extraction_result_sha256:sha,
 original_component:normalizedAdditionalComponentSchema,cell:rowReadingCellSchema,target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 const raw=target.original_component[`${target.cell}_raw`];
 if(raw===null||!raw.trim()||raw.length>500)ctx.addIssue({code:'custom',message:'A row reading needs an existing printed cell; blank is not zero'});
 if(target.original_component.source.document_id!==target.version_id)ctx.addIssue({code:'custom',message:'Row must belong to the exact document version'});
 const {target_sha256,...body}=target;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Row cell target hash mismatch'});
});
export type DocumentRowCellTarget=Readonly<z.infer<typeof documentRowCellTargetSchema>>;
export function documentRowCellTarget(input:{checkpoint:unknown;policyVersion:string;componentId:string;cell:z.infer<typeof rowReadingCellSchema>}):DocumentRowCellTarget {
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction;
 if(hasPayslipReadingAnnotations(extraction))throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(checkpoint.period_mismatch||!periods.length||periods.some(p=>!p.normalized_value||`${p.normalized_value.year}-${String(p.normalized_value.month).padStart(2,'0')}`!==checkpoint.expected_month))throw Error('REQUEST_FIELD_PERIOD_UNKNOWN');
 const rows=extraction.additional_components.filter(r=>r.component_id===input.componentId);
 if(rows.length!==1||extraction.fields.some(f=>f.candidate_id===input.componentId)||extraction.source_scope_observations?.some(o=>o.candidate.candidate_id===input.componentId))throw Error('REQUEST_FIELD_CANDIDATE_AMBIGUOUS');
 const body={schema_version:'document-row-cell-confirmation-v1' as const,case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,
  version_id:checkpoint.version_id,source_sha256:checkpoint.input_sha256,month:checkpoint.expected_month,policy_version:input.policyVersion,
  extraction_result_sha256:checkpoint.result_sha256,original_component:rows[0],cell:rowReadingCellSchema.parse(input.cell)};
 return deepFreeze(documentRowCellTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export const rowReadingCellLabels={quantity:'כמות',rate:'תעריף',amount:'סכום',percentage:'אחוז'} as const;
export function documentRowCellQuestion(input:unknown){
 const target=documentRowCellTargetSchema.parse(input),row=target.original_component;
 return {code:`document_field:${target.target_sha256}`,question:`בעמוד ${row.source.page} במסמך לחודש ${formatRequestMonth(target.month)}, בשורה "${row.source_label}", מהי הקריאה בתא ${rowReadingCellLabels[target.cell]}? יש להשוות את הקריאה המוצגת לתא המקור.`,
  answer_kind:'choice' as const,options:['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת'],field_crop:`row_cell.${target.cell}`,blocking:false};
}
/** Target equality includes the entire original row and the selected cell. */
export function documentRowCellCurrent(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;requestId:string;answerRevision:number;identityId:string;answeredAt:string}):boolean {
 const target=documentRowCellTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.string().datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return false;
 try{return documentRowCellTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,componentId:target.original_component.component_id,cell:target.cell}).target_sha256===target.target_sha256;}
 catch{return false;}
}
