import {z} from 'zod';
import {normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {normalizeMoney} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {readSavedExtractionProvenance} from '../processing/live-extraction-provenance';

export const DOCUMENT_TRANSCRIPTION_NAMESPACE='document_transcription:';
export const SALARY_TYPE_TRANSCRIPTION_ANSWERS=['בתלוש כתוב שכר שעתי','בתלוש כתוב שכר חודשי','בתלוש כתוב שכר משולב','לא מופיע בתלוש','לא ניתן לקרוא'] as const;
export const COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS=['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה'] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const policy=z.string().min(1).max(100);
const money=z.object({currency:z.literal('ILS'),minor_units:z.number().int().safe().positive()}).strict();
const allowedWarnings=new Set(['salary_type_documented_pair_invalid','aggregate_total_rows_classified']);
const readingUncertainty=new Set(['low_field_confidence','moderate_field_confidence','ocr_value_ambiguous','recovery_reading_confirmation_required']);
const subject=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('salary_type'),page:z.literal(1)}).strict(),
 z.object({kind:z.literal('component_amount'),component:normalizedAdditionalComponentSchema}).strict(),
]);
export type DocumentTranscriptionSelector={kind:'salary_type'}|{kind:'component_amount';componentId:string};

function componentAmountValid(component:z.infer<typeof normalizedAdditionalComponentSchema>){
 return component.semantic_kind==='unknown'&&component.normalized_label===null
  &&component.source.page===1&&component.percentage===null&&component.percentage_raw===null
  &&component.warning_flags.length===0&&component.normalization_warnings.length===0
  &&money.safeParse(component.amount).success&&typeof component.amount_raw==='string'
  // The first admitted path shares this exact narrow grammar with SQL. Other
  // currency/grouping formats remain unsupported even if normalizeMoney knows them.
  &&/^[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?$/u.test(component.amount_raw)
  &&canonicalSha256(normalizeMoney(component.amount_raw))===canonicalSha256(component.amount);
}

/** This target binds an absent cell or an existing, semantically unknown row.
 * It does not manufacture an OCR candidate or classify a component legally. */
export const documentTranscriptionTargetSchema=z.object({
 schema_version:z.literal('document-transcription-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month:z.literal('2026-06'),policy_version:policy,extraction_result_sha256:sha,subject,target_sha256:sha,
}).strict().superRefine((target,context)=>{
 if(target.subject.kind==='component_amount'&&(!componentAmountValid(target.subject.component)||target.subject.component.source.document_id!==target.version_id))
  context.addIssue({code:'custom',message:'Transcription component must preserve one positive ILS reading in its exact single-page source'});
 const {target_sha256,...body}=target;
 if(canonicalSha256(body)!==target_sha256)context.addIssue({code:'custom',message:'Transcription target hash mismatch'});
});
export type DocumentTranscriptionTarget=Readonly<z.infer<typeof documentTranscriptionTargetSchema>>;
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 input_sha256:sha,expected_month:z.string(),period_mismatch:z.boolean(),result_sha256:sha,
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough(),
});

/** Caller loads the authenticated saved checkpoint and current purchased scope.
 * SQL independently checks those authorities again when opening/answering.
 * This pure builder checks content and receipt consistency, not DB authority. */
export function createDocumentTranscriptionTarget(input:{checkpoint:unknown;policyVersion:string;subject:DocumentTranscriptionSelector}):DocumentTranscriptionTarget{
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction;
 if(extraction.customer_readings!==undefined||extraction.customer_row_readings!==undefined||extraction.customer_scope_readings!==undefined
  ||extraction.customer_source_transcriptions!==undefined||extraction.source_reading_context!==undefined)throw Error('TRANSCRIPTION_PROVIDER_READINGS_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id)throw Error('TRANSCRIPTION_SOURCE_MISMATCH');
 if(checkpoint.expected_month!=='2026-06'||checkpoint.period_mismatch)throw Error('TRANSCRIPTION_PERIOD_UNSUPPORTED');
 const periods=extraction.fields.filter(field=>field.field==='salary_period');
 if(periods.length!==1||canonicalSha256(periods[0].normalized_value)!==canonicalSha256({year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'}))throw Error('TRANSCRIPTION_PERIOD_UNSUPPORTED');
 const provenance=readSavedExtractionProvenance(input.checkpoint);
 if(!['openai_live','injected_test_provider'].includes(provenance.kind)||!provenance.allPassesSucceeded||!provenance.receipts.length
  ||provenance.receipts.some(receipt=>receipt.source_page_count!==1)||extraction.quality_metrics.page_count!==1)throw Error('TRANSCRIPTION_SINGLE_PAGE_RECEIPT_REQUIRED');
 if(extraction.status!=='completed'||extraction.detected_document_type!=='payslip'||extraction.document_quality_confidence<0.9
  ||extraction.warnings.some(warning=>!allowedWarnings.has(warning))
  ||extraction.fields.some(field=>field.source.document_id!==checkpoint.version_id||field.source.page!==1||field.warning_flags.some(warning=>!readingUncertainty.has(warning)))
  ||validatePayslipGate0(extraction,{reference_year:2026}).issues.some(issue=>!readingUncertainty.has(issue.code)))throw Error('TRANSCRIPTION_EXTRACTION_UNSUPPORTED');
 let selected:z.infer<typeof subject>;
 if(input.subject.kind==='salary_type'){
  // Even null/low-confidence candidates stay in the existing review path.
  if(extraction.fields.some(field=>field.field==='salary_type'))throw Error('TRANSCRIPTION_PRESENT_FIELD_FORBIDDEN');
  selected={kind:'salary_type',page:1};
 }else{
  z.uuid().parse(input.subject.componentId);
  if(extraction.fields.some(field=>field.field==='base_monthly_salary'))throw Error('TRANSCRIPTION_PRESENT_FIELD_FORBIDDEN');
  const components=extraction.additional_components,component=components[0];
  if(!extraction.earnings_components_complete||components.length!==1||component.component_id!==input.subject.componentId||!componentAmountValid(component))throw Error('TRANSCRIPTION_COMPONENT_UNSUPPORTED');
  // A complete one-row earnings table must agree with its unique gross total.
  // The amount remains the row reading; the total is a consistency guard.
  const gross=extraction.fields.filter(field=>field.field==='gross_salary');
  if(gross.length!==1||canonicalSha256(gross[0].normalized_value)!==canonicalSha256(component.amount))throw Error('TRANSCRIPTION_COMPONENT_TOTAL_CONFLICT');
  selected={kind:'component_amount',component};
 }
 const body={schema_version:'document-transcription-v1' as const,case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,
  source_sha256:checkpoint.input_sha256,month:'2026-06' as const,policy_version:policy.parse(input.policyVersion),extraction_result_sha256:checkpoint.result_sha256,subject:selected};
 return deepFreeze(documentTranscriptionTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}

export function documentTranscriptionQuestion(candidate:DocumentTranscriptionTarget){
 const target=documentTranscriptionTargetSchema.parse(candidate),row=target.subject;
 let question:string;
 if(row.kind==='salary_type')question='בתלוש לחודש יוני 2026, בעמוד 1, איזה סוג שכר כתוב במפורש? יש להעתיק את סוג השכר מהמסמך; אין להסיק אותו מהשעות או מהתעריף.';
 else{
  const amount=BigInt(money.parse(row.component.amount).minor_units),shown=`${amount/BigInt(100)}.${String(amount%BigInt(100)).padStart(2,'0')}`;
  question=`בתלוש לחודש יוני 2026, בעמוד 1, בשורה «${row.component.source_label}» קראנו סכום ${shown} ₪. האם הסכום מופיע כך במסמך? האישור מתייחס לקריאת הסכום בלבד, ולא לסוג הרכיב או לזכאות.`;
 }
 if(question.length>400)throw Error('TRANSCRIPTION_QUESTION_TOO_LONG');
 return {code:DOCUMENT_TRANSCRIPTION_NAMESPACE+target.target_sha256,question,answer_kind:'choice' as const,
  options:row.kind==='salary_type'?[...SALARY_TYPE_TRANSCRIPTION_ANSWERS]:[...COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS],
  field_crop:row.kind==='salary_type'?'salary_type':'component_amount',blocking:false};
}

function normalizedAnswer(target:DocumentTranscriptionTarget,answer:string){
 if(target.subject.kind==='salary_type'){
  const index=SALARY_TYPE_TRANSCRIPTION_ANSWERS.indexOf(answer as typeof SALARY_TYPE_TRANSCRIPTION_ANSWERS[number]);
  if(index<0)throw Error('TRANSCRIPTION_ANSWER_INVALID');
  return index<3?(['hourly','monthly','mixed'] as const)[index]:null;
 }
 if(!COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS.includes(answer as typeof COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS[number]))throw Error('TRANSCRIPTION_ANSWER_INVALID');
 return answer===COMPONENT_AMOUNT_TRANSCRIPTION_ANSWERS[0]?money.parse(target.subject.component.amount):null;
}

export const documentTranscriptionReadingSchema=z.object({actor_kind:z.literal('customer'),reading_kind:z.literal('document_transcription'),
 target:documentTranscriptionTargetSchema,request_id:z.uuid(),answer_revision:z.number().int().positive().safe(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),
 answer:z.string(),normalized_value:z.union([z.enum(['monthly','hourly','mixed']),money]),
}).strict().superRefine((reading,context)=>{
 let expected;try{expected=normalizedAnswer(reading.target,reading.answer);}catch{context.addIssue({code:'custom',message:'Transcription answer is not an offered reading'});return;}
 if(expected===null||canonicalSha256(expected)!==canonicalSha256(reading.normalized_value))context.addIssue({code:'custom',message:'Transcription value must equal the exact identified reading'});
});
export type DocumentTranscriptionReading=Readonly<z.infer<typeof documentTranscriptionReadingSchema>>;

/** The authenticated journal supplies the actor and answer version. Confirmed
 * here means the customer read a cell; every legal activation gate is separate. */
export function resolveDocumentTranscriptionReading(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:string}):
 {state:'confirmed_reading';reading:DocumentTranscriptionReading}|{state:'unconfirmed'|'stale'}{
 const target=documentTranscriptionTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().safe().parse(input.answerRevision);z.iso.datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('TRANSCRIPTION_CASE_MISMATCH');
 const value=normalizedAnswer(target,input.answer);
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return {state:'stale'};
 let current:DocumentTranscriptionTarget;
 try{current=createDocumentTranscriptionTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,
  subject:target.subject.kind==='salary_type'?{kind:'salary_type'}:{kind:'component_amount',componentId:target.subject.component.component_id}});}catch{return {state:'stale'};}
 if(current.target_sha256!==target.target_sha256)return {state:'stale'};
 if(value===null)return {state:'unconfirmed'};
 return deepFreeze({state:'confirmed_reading',reading:documentTranscriptionReadingSchema.parse({actor_kind:'customer',reading_kind:'document_transcription',target,
  request_id:input.requestId,answer_revision:input.answerRevision,identity_id:input.identityId,answered_at:input.answeredAt,answer:input.answer,normalized_value:value})});
}
