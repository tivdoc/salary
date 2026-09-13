import {z} from 'zod';
import {isExplicitMandatorySubtotalCandidate} from '@/engine/extraction/deduction-source-scope';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {sourceTranscriptionSubjectSchema,type SourceTranscriptionSubject} from '@/engine/extraction/customer-reading';
import {hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import {normalizeDecimal} from '@/engine/extraction/normalization';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {formatRequestMonth} from '@/lib/request-display';
const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,
 expected_month:month,period_mismatch:z.boolean(),result_sha256:sha,run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema,
 first_pass:z.object({normalized_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()}).passthrough()});
export const documentSourceTranscriptionTargetSchema=z.object({schema_version:z.literal('document-source-transcription-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month,policy_version:z.string().min(1).max(100),extraction_result_sha256:sha,subject:sourceTranscriptionSubjectSchema,target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 if(target.subject.kind==='balance_unit'&&(target.subject.original_candidate.source.document_id!==target.version_id||normalizeDecimal(target.subject.original_candidate.raw_value)===null))
  ctx.addIssue({code:'custom',message:'Retained balance amount needs exact document source and numeric text'});
 const {target_sha256,...body}=target;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Source transcription target hash mismatch'});
});
export type DocumentSourceTranscriptionTarget=Readonly<z.infer<typeof documentSourceTranscriptionTargetSchema>>;
export type DocumentSourceTranscriptionSelector={kind:'reported_work_hours';page:number}|{kind:'balance_unit';candidateId:string}|{kind:'grand_total';page:1};
export function documentSourceTranscriptionTarget(input:{checkpoint:unknown;policyVersion:string;subject:DocumentSourceTranscriptionSelector}):DocumentSourceTranscriptionTarget {
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction,first=checkpoint.run.result.first_pass.normalized_extraction;
 if(hasPayslipReadingAnnotations(extraction)||hasPayslipReadingAnnotations(first))throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id||first.document_id!==checkpoint.version_id)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(checkpoint.period_mismatch||!periods.length||periods.some(p=>!p.normalized_value||`${p.normalized_value.year}-${String(p.normalized_value.month).padStart(2,'0')}`!==checkpoint.expected_month))throw Error('REQUEST_FIELD_PERIOD_UNKNOWN');
 let subject:SourceTranscriptionSubject;
 if(input.subject.kind==='reported_work_hours'){
  const page=z.number().int().min(1).max(100).parse(input.subject.page);
  if(page>extraction.quality_metrics.page_count||page>first.quality_metrics.page_count)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
  if([...(extraction.source_scope_observations??[]),...(first.source_scope_observations??[])].some(o=>o.scope==='attendance_total'))throw Error('SOURCE_TRANSCRIPTION_PRESENT_FIELD');
  subject={kind:'reported_work_hours',page,meaning:'document_reported_total_hours'};
 }else if(input.subject.kind==='grand_total'){
  if(input.subject.page!==1||extraction.quality_metrics.page_count!==1||first.quality_metrics.page_count!==1)throw Error('SOURCE_TRANSCRIPTION_SINGLE_PAGE_REQUIRED');
  if([...extraction.fields,...first.fields].some(f=>f.field==='total_deductions'&&!isExplicitMandatorySubtotalCandidate(f)))throw Error('SOURCE_TRANSCRIPTION_PRESENT_FIELD');
  subject={kind:'grand_total',page:1,meaning:'document_total_deductions',first_pass_extraction_sha256:canonicalSha256(first)};
 }else{
  const candidateId=z.uuid().parse(input.subject.candidateId),fields=first.fields.filter(f=>f.candidate_id===candidateId),field=fields[0];
  if(fields.length!==1||!field||!['vacation_balance','sick_balance'].includes(field.field)||field.normalized_value!==null||normalizeDecimal(field.raw_value)===null
   ||field.source.document_id!==checkpoint.version_id||field.source.page>first.quality_metrics.page_count||field.source.page>extraction.quality_metrics.page_count
   ||extraction.fields.some(f=>f.field===field.field))throw Error('SOURCE_TRANSCRIPTION_RETAINED_FIELD');
  subject=sourceTranscriptionSubjectSchema.parse({kind:'balance_unit',original_candidate:field,first_pass_extraction_sha256:canonicalSha256(first)});
 }
 const body={schema_version:'document-source-transcription-v1' as const,case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,
  source_sha256:checkpoint.input_sha256,month:checkpoint.expected_month,policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,subject};
 return deepFreeze(documentSourceTranscriptionTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function documentSourceTranscriptionQuestion(input:unknown){
 const target=documentSourceTranscriptionTargetSchema.parse(input),subject=target.subject;
 const question=subject.kind==='grand_total'
  ?`במסמך לחודש ${formatRequestMonth(target.month)}, יש לאתר בעמוד המקור את הסכום הכולל תחת כותרת סך הניכויים ולהעתיק את הסכום, הכותרת והמיקום. אין להעתיק סיכום ניכויי חובה, מסים או קופות גמל ואין לחשב סך חסר. אם הסכום הכולל אינו מודפס, יש לבחור לא יודע.`
  :subject.kind==='reported_work_hours'
  ?`במסמך לחודש ${formatRequestMonth(target.month)}, בעמוד ${subject.page}, האם מופיע סך שעות מדווחות? יש להעתיק את הסך המודפס בלבד. אין להסיק שעות רגילות או שעות בתשלום. אם לא מופיע נתון כזה, יש לבחור לא יודע.`
  :`במסמך לחודש ${formatRequestMonth(target.month)}, בעמוד ${subject.original_candidate.source.page}, באיזו יחידה מוצגת ${subject.original_candidate.field==='vacation_balance'?'יתרת החופשה':'יתרת המחלה'}: ימים או שעות? אין לשנות את המספר שנקרא; אם היחידה לא מצוינת, יש לבחור לא יודע.`;
 return {code:`document_field:${target.target_sha256}`,question,answer_kind:'choice' as const,options:['הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת'],field_crop:`source_transcription.${subject.kind}`,blocking:false};
}
export function documentSourceTranscriptionCurrent(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;requestId:string;answerRevision:number;identityId:string;answeredAt:string}):boolean {
 const target=documentSourceTranscriptionTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.string().datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');if(target.month!==input.month||target.policy_version!==input.policyVersion)return false;
 const subject:DocumentSourceTranscriptionSelector=target.subject.kind==='balance_unit'?{kind:'balance_unit',candidateId:target.subject.original_candidate.candidate_id}
  :target.subject.kind==='grand_total'?{kind:'grand_total',page:1}:{kind:'reported_work_hours',page:target.subject.page};
 try{return documentSourceTranscriptionTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,subject}).target_sha256===target.target_sha256;}catch{return false;}
}
