import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import {sourceStructureSubjectSchema,sourceStructureMonthSchema,sourceStructureValueSchema,sourceRelationshipValueSchema,customerSourceStructureReadingSchema,type SourceStructureSubject} from '@/engine/extraction/source-structure';
import {sourceStructureSubject,sourceStructureSelector,normalizeSourceStructureValue,type SourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const schemaForKind={source_relationship:'document-source-relationship-v1',deduction_group:'document-source-deduction-group-v1',balance_movement:'document-source-balance-movement-v1'} as const;
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,
 expected_month:sourceStructureMonthSchema,period_mismatch:z.boolean(),result_sha256:sha,run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema,
 first_pass:z.object({normalized_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()}).passthrough()});
export const documentSourceStructureTargetSchema=z.object({schema_version:z.enum(['document-source-relationship-v1','document-source-deduction-group-v1','document-source-balance-movement-v1']),
 case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,month:sourceStructureMonthSchema,policy_version:z.string().min(1).max(100),
 extraction_result_sha256:sha,normalized_extraction_sha256:sha,first_pass_extraction_sha256:sha,subject:sourceStructureSubjectSchema,
 // No provider proposal is invented. Relationship affirmation instead requires
 // a complete, explicitly identified v3 relationship decision and source basis.
 // Group/balance confirm still requires a future supported proposal policy.
 proposed_value:z.null(),target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 if(target.schema_version!==schemaForKind[target.subject.kind])ctx.addIssue({code:'custom',message:'Subject/target kind mismatch'});
 const {target_sha256,...body}=target;if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Source structure target hash mismatch'});
 const refs=target.subject.kind==='source_relationship'?[target.subject.contribution,target.subject.base]:target.subject.kind==='deduction_group'?[...target.subject.rows,target.subject.mandatory_total,...(target.subject.voluntary_total?[target.subject.voluntary_total]:[])]:[target.subject.anchor];
 if(refs.some(r=>r.source.document_id!==target.version_id))ctx.addIssue({code:'custom',message:'Foreign source structure observation'});
});
export type DocumentSourceStructureTarget=Readonly<z.infer<typeof documentSourceStructureTargetSchema>>;
export function documentSourceStructureTarget(input:{checkpoint:unknown;policyVersion:string;selector:SourceStructureSelector}):DocumentSourceStructureTarget {
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction,firstPass=checkpoint.run.result.first_pass.normalized_extraction;
 if(hasPayslipReadingAnnotations(extraction)||hasPayslipReadingAnnotations(firstPass))throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id||firstPass.document_id!==checkpoint.version_id)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(checkpoint.period_mismatch||!periods.length||periods.some(p=>!p.normalized_value||`${p.normalized_value.year}-${String(p.normalized_value.month).padStart(2,'0')}`!==checkpoint.expected_month))throw Error('REQUEST_FIELD_PERIOD_UNKNOWN');
 const subject=sourceStructureSubject({extraction,firstPass,selector:input.selector});
 const body={schema_version:schemaForKind[subject.kind],case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,
  source_sha256:checkpoint.input_sha256,month:checkpoint.expected_month,policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,
  normalized_extraction_sha256:canonicalSha256(extraction),first_pass_extraction_sha256:canonicalSha256(firstPass),subject,proposed_value:null};
 return deepFreeze(documentSourceStructureTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function documentSourceStructureTargetFromSubject(input:{checkpoint:unknown;policyVersion:string;subject:SourceStructureSubject}){
 const target=documentSourceStructureTarget({...input,selector:sourceStructureSelector(input.subject)});
 if(canonicalSha256(target.subject)!==canonicalSha256(input.subject))throw Error('REQUEST_FIELD_SOURCE_MISMATCH');return target;
}
export const documentFieldAnswerV3Schema=z.discriminatedUnion('action',[
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('confirm'),structured_value:sourceRelationshipValueSchema}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('correct'),structured_value:sourceStructureValueSchema}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('unknown')}).strict(),
 z.object({schema_version:z.literal('document-field-answer-v3'),action:z.literal('unreadable')}).strict(),
]);
export type DocumentFieldAnswerV3=z.infer<typeof documentFieldAnswerV3Schema>;
export function parseDocumentFieldAnswerV3(input:unknown):DocumentFieldAnswerV3 {
 let value:unknown=input;
 if(typeof input==='string'){if(input.length>2000)throw Error('REQUEST_ANSWER_INVALID');try{value=JSON.parse(input);}catch{throw Error('REQUEST_ANSWER_INVALID');}}
 const parsed=documentFieldAnswerV3Schema.safeParse(value);
 if(!parsed.success||JSON.stringify(parsed.data).length>2000)throw Error('REQUEST_ANSWER_INVALID');return parsed.data;
}
export function serializeDocumentFieldAnswerV3(input:unknown):string{return JSON.stringify(parseDocumentFieldAnswerV3(input));}
export function validateDocumentSourceStructureAnswer(targetInput:unknown,answerInput:unknown){
 const target=documentSourceStructureTargetSchema.parse(targetInput),answer=parseDocumentFieldAnswerV3(answerInput);
 if(answer.action==='confirm'&&(target.subject.kind!=='source_relationship'||answer.structured_value.relationship!=='same_base'))throw Error('REQUEST_ANSWER_INVALID');
 if(answer.action==='correct'||answer.action==='confirm')normalizeSourceStructureValue(target.subject,answer.structured_value,target.month);
 return answer;
}
export function documentSourceStructureQuestion(targetInput:unknown){
 const target=documentSourceStructureTargetSchema.parse(targetInput),subject=target.subject;
 const cells={opening:'יתרה קודמת',accrued:'צבירה',used:'ניצול',adjustments:'התאמות',closing:'יתרה חדשה'};
 const question=subject.kind==='source_relationship'?'האם הסכום ובסיס השכר המוצגים שייכים לאותו רכיב באותה תקופה? יש לציין היכן המסמך מראה את הקשר; אישור המספרים אינו מאשר את הקשר.'
  :subject.kind==='deduction_group'?'יש לזהות במקור אילו שורות שייכות לניכויי חובה ואילו לניכויי רשות, ולציין אם רשימת השורות מלאה. אין לבחור קבוצה לפי התאמת הסכום בלבד.'
  :`יש לקרוא מהמקור את התא בטבלת ${subject.balance_kind==='vacation'?'החופשה':'המחלה'} (${cells[subject.cell]}), ולציין בנפרד את המספר, היחידה והתקופה. אם היחידה אינה מודפסת, יש לציין זאת; אין להסיק ימים או שעות.`;
 return {code:`document_field:${target.target_sha256}`,question,answer_kind:'choice' as const,options:[...(subject.kind==='source_relationship'?['אישור הקשר על סמך המקור']:[]),'הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת'],field_crop:`source_structure.${subject.kind}`,blocking:false};
}
type ResolveInput={target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:unknown};
export function resolveDocumentSourceStructureVerification(input:ResolveInput){
 const target=documentSourceStructureTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.string().datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return deepFreeze({state:'stale' as const});
 try{if(documentSourceStructureTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,selector:sourceStructureSelector(target.subject)}).target_sha256!==target.target_sha256)return deepFreeze({state:'stale' as const});}
 catch{return deepFreeze({state:'stale' as const});}
 const answer=validateDocumentSourceStructureAnswer(target,input.answer),authority={actor_kind:'identified_account' as const,identity_id:input.identityId,request_id:input.requestId,answer_revision:input.answerRevision,answered_at:input.answeredAt};
 const body={policy_version:'document-source-structure-identified-v1' as const,scope:'source_structure_reading_only' as const,target,answer,authority,source_structure_subject:target.subject,
  state:answer.action==='correct'?'corrected_reading' as const:answer.action==='confirm'?'confirmed_reading' as const:answer.action,
  effective_value:answer.action==='correct'||answer.action==='confirm'?normalizeSourceStructureValue(target.subject,answer.structured_value,target.month):null,
  legal_applicability_verified:false as const,provider_numeric_observations_verified:false as const,
  balance_cell_transcribed:answer.action==='correct'&&target.subject.kind==='balance_movement'};
 return deepFreeze({...body,receipt_sha256:canonicalSha256(body)});
}
export function materializeDocumentSourceStructureVerification(verification:ReturnType<typeof resolveDocumentSourceStructureVerification>,normalizedExtractionSha256:string){
 if(verification.state!=='corrected_reading'&&verification.state!=='confirmed_reading'||verification.effective_value===null)return null;
 const {target,authority}=verification;
 if(normalizedExtractionSha256!==target.normalized_extraction_sha256)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const body={schema_version:'document-source-structure-reading-v1',actor_kind:'customer',case_id:target.case_id,document_id:target.version_id,
  source_sha256:target.source_sha256,normalized_extraction_sha256:normalizedExtractionSha256,first_pass_extraction_sha256:target.first_pass_extraction_sha256,extraction_result_sha256:target.extraction_result_sha256,
  target_sha256:target.target_sha256,subject:target.subject,month:target.month,policy_version:target.policy_version,request_id:authority.request_id,answer_revision:authority.answer_revision,identity_id:authority.identity_id,
  confirmed_at:authority.answered_at,value:verification.effective_value,decision_sha256:verification.receipt_sha256};
 const reading=customerSourceStructureReadingSchema.parse({...body,verification_sha256:canonicalSha256(body)});
 return {kind:'source_structure' as const,reading};
}
