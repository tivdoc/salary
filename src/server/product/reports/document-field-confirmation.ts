import {documentSourcePeriodIntakeTargetSchema,documentSourcePeriodIntakeTarget} from './document-source-period-intake';
import {documentObligationPaymentTargetSchema,type DocumentObligationPaymentTarget} from './document-obligation-payment-link';
import {documentSourceStructureTargetSchema,documentSourceStructureTarget} from './document-source-structure';
import type {CustomerSourceStructureReading} from '@/engine/extraction/source-structure';
import {IDENTIFIED_PERIOD_STRUCTURE_POLICY} from '@/engine/extraction/source-structure-period';
import {documentEvidenceReadingTargetSchema} from '@/engine/extraction/document-evidence/reading';
import {documentEvidenceTarget} from './document-evidence-reading';
import {documentTravelTariffTargetSchema,documentTravelTariffTarget,type DocumentTravelTariffSource} from './document-travel-tariff';
import type {ImmutableDocument} from '@/engine/domain/documents';
import {sourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {hasPayslipReadingAnnotations} from '@/engine/extraction/reading-resolution';
import {documentSourceTranscriptionTargetSchema,documentSourceTranscriptionTarget} from './document-source-transcription';
import {documentSourceScopeTargetSchema,documentSourceScopeTarget} from './document-source-scope-confirmation';
import {documentRowCellTargetSchema,documentRowCellTarget} from './document-row-cell-confirmation';
import {z} from 'zod';
import {normalizedCandidateFieldSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {formatRequestMonth} from '@/lib/request-display';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export const DOCUMENT_FIELD_CONFIRMATION_ANSWERS=['כן, בדקתי במסמך והערך נכון','הערך שונה במסמך','לא ניתן לקרוא את השדה','לא יודע/ת'] as const;
export const confirmationFieldLabels={
 salary_type:'סוג השכר',salary_period:'תקופת השכר',
 base_monthly_salary:'סכום שכר הבסיס בתלוש',hourly_rate:'השכר לשעה',gross_salary:'שכר ברוטו',net_salary:'שכר נטו',
 regular_hours:'מספר השעות הרגילות',overtime_125_hours:'שעות נוספות 125%',overtime_150_hours:'שעות נוספות 150%',
 pension_base:'השכר המבוטח לפנסיה',travel_amount:'החזר הנסיעות',convalescence_amount:'דמי הבראה',
 vacation_balance:'יתרת החופשה',sick_balance:'יתרת המחלה',
 total_deductions:'סך הניכויים',pension_employee_contribution:'ניכוי העובד לפנסיה',pension_employer_contribution:'הפרשת המעסיק לפנסיה',
 severance_contribution:'הפרשה לפיצויים',pension_employee_rate:'שיעור ניכוי העובד לפנסיה',pension_employer_rate:'שיעור הפרשת המעסיק לפנסיה',severance_rate:'שיעור הפרשה לפיצויים',
} as const;
const field=z.enum(Object.keys(confirmationFieldLabels) as [keyof typeof confirmationFieldLabels,...(keyof typeof confirmationFieldLabels)[]]);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 input_sha256:sha,expected_month:month,period_mismatch:z.boolean(),result_sha256:sha,
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough(),
});
export const documentFieldTargetSchema=z.object({schema_version:z.literal('document-field-confirmation-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month,policy_version:z.string().min(1).max(100),extraction_result_sha256:sha,
 candidate:normalizedCandidateFieldSchema,target_sha256:sha,
}).strict().superRefine((target,ctx)=>{
 if(!field.safeParse(target.candidate.field).success||target.candidate.normalized_value===null)
  ctx.addIssue({code:'custom',message:'Only a supported present document field can be confirmed'});
 if(target.candidate.source.document_id!==target.version_id)ctx.addIssue({code:'custom',message:'Candidate must belong to the exact document version'});
 const {target_sha256,...body}=target;
 if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Confirmation target hash mismatch'});
});
export type DocumentFieldTarget=Readonly<z.infer<typeof documentFieldTargetSchema>>;

/** Constructed from the saved checkpoint, not a browser's proposed value.
 * A confirmation is a reading of one cell, not a legal or arithmetic approval. */
export function documentFieldTarget(input:{checkpoint:unknown;policyVersion:string;candidateId:string}):DocumentFieldTarget {
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction;
 if(hasPayslipReadingAnnotations(extraction))throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id)throw Error('REQUEST_FIELD_SOURCE_MISMATCH');
 const periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(checkpoint.period_mismatch||!periods.length||periods.some(p=>!p.normalized_value||`${p.normalized_value.year}-${String(p.normalized_value.month).padStart(2,'0')}`!==checkpoint.expected_month))throw Error('REQUEST_FIELD_PERIOD_UNKNOWN');
 const candidates=extraction.fields.filter(f=>f.candidate_id===input.candidateId);
 if(candidates.length!==1)throw Error('REQUEST_FIELD_CANDIDATE_AMBIGUOUS');
 const body={schema_version:'document-field-confirmation-v1' as const,case_id:checkpoint.case_id,product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,
  source_sha256:checkpoint.input_sha256,month:checkpoint.expected_month,policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,candidate:candidates[0]};
 return deepFreeze(documentFieldTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}

export function documentFieldQuestion(target:DocumentFieldTarget){
 const saved=documentFieldTargetSchema.parse(target),candidate=saved.candidate;
 const value=candidate.normalized_value;
 // Display the normalized, hashed value. Raw OCR text is untrusted evidence,
 // never a replacement instruction or an independently parsed salary amount.
 let shown:string;
 if(candidate.field==='salary_type'&&candidate.normalized_value!==null)shown=({monthly:'חודשי',hourly:'שעתי',mixed:'משולב'} as const)[candidate.normalized_value];
 else if(candidate.field==='salary_period'&&candidate.normalized_value!==null)shown=`מ־${candidate.normalized_value.start_date} עד ${candidate.normalized_value.end_date}`;
 else if(value&&typeof value==='object'&&'minor_units' in value){const minor=BigInt(value.minor_units),absolute=minor<BigInt(0)?-minor:minor;shown=`${minor<BigInt(0)?'-':''}${absolute/BigInt(100)}.${String(absolute%BigInt(100)).padStart(2,'0')} ${value.currency}`;}
 else if(value&&typeof value==='object'&&'basis_points' in value)shown=`${value.basis_points/100}%`;
 else if(value&&typeof value==='object'&&'amount' in value)shown=`${value.amount} ${'unit' in value&&value.unit==='days'?'ימים':'unit' in value&&value.unit==='hours'?'שעות':'שעות בחודש'}`;
 else throw Error('REQUEST_FIELD_VALUE_UNSUPPORTED');
 return {code:`document_field:${saved.target_sha256}`,question:`בעמוד ${candidate.source.page} במסמך לחודש ${formatRequestMonth(saved.month)} קראנו ${confirmationFieldLabels[field.parse(candidate.field)]}: ${shown}. האם זה הערך שמופיע במסמך?`,
  answer_kind:'choice' as const,options:[...DOCUMENT_FIELD_CONFIRMATION_ANSWERS],field_crop:candidate.field,blocking:false};
}

export type DocumentFieldReading={target:DocumentFieldTarget;requestId:string;answerRevision:number;identityId:string;answeredAt:string};
/** Caller supplies the authenticated immutable answer row. Exact current
 * source binding is checked again even if the customer previously confirmed.
 * Negative/unknown answers are retained evidence and never mean numeric zero. */
export function resolveDocumentFieldReading(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;month:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:string}):
 {state:'confirmed_reading';reading:DocumentFieldReading}|{state:'unconfirmed'|'stale'} {
 const target=documentFieldTargetSchema.parse(input.target);
 z.uuid().parse(input.caseId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);z.number().int().positive().parse(input.answerRevision);z.string().datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 if(!DOCUMENT_FIELD_CONFIRMATION_ANSWERS.includes(input.answer as typeof DOCUMENT_FIELD_CONFIRMATION_ANSWERS[number]))throw Error('REQUEST_ANSWER_INVALID');
 if(target.month!==input.month||target.policy_version!==input.policyVersion)return {state:'stale'};
 let current:DocumentFieldTarget;
 try{current=documentFieldTarget({checkpoint:input.currentCheckpoint,policyVersion:input.policyVersion,candidateId:target.candidate.candidate_id});}
 catch{return {state:'stale'};}
 if(current.target_sha256!==target.target_sha256)return {state:'stale'};
 if(input.answer!==DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0])return {state:'unconfirmed'};
 return deepFreeze({state:'confirmed_reading',reading:{target,requestId:input.requestId,answerRevision:input.answerRevision,identityId:input.identityId,answeredAt:input.answeredAt}});
}

/** Versioned union for new consumers; scalar v1 constructors and bytes stay intact. */
export const documentReadingTargetSchema=z.union([documentFieldTargetSchema,documentRowCellTargetSchema,documentSourceScopeTargetSchema,documentSourceTranscriptionTargetSchema,documentSourceStructureTargetSchema,documentEvidenceReadingTargetSchema,documentTravelTariffTargetSchema,documentSourcePeriodIntakeTargetSchema,documentObligationPaymentTargetSchema]);
export type DocumentReadingTarget=Readonly<z.infer<typeof documentReadingTargetSchema>>;

/** Reconstruct, do not mutate, from the exact saved checkpoint. Callers compare
 * the returned hash with the original target and retain their source fence. */
export function documentReadingTargetForCheckpoint(input:{target:unknown;currentCheckpoint?:unknown;nonPayslipDocument?:ImmutableDocument;nonPayslipProductDocumentId?:string;travelTariffSource?:DocumentTravelTariffSource;sourcePeriodIntake?:Parameters<typeof documentSourcePeriodIntakeTarget>[0];periodReadings?:ReadonlyMap<string,CustomerSourceStructureReading>;obligationPaymentTarget?:DocumentObligationPaymentTarget}):DocumentReadingTarget {
 const target=documentReadingTargetSchema.parse(input.target),base={checkpoint:input.currentCheckpoint,policyVersion:target.policy_version};
 if(target.schema_version==='obligation-payment-link-v1'||target.schema_version==='obligation-payment-choice-v1'){
  if(!input.obligationPaymentTarget)throw Error('OBLIGATION_PAYMENT_CONTEXT_REQUIRED');
  const current=documentObligationPaymentTargetSchema.parse(input.obligationPaymentTarget);
  if(current.case_id!==target.case_id||current.target_sha256!==target.target_sha256)throw Error('REQUEST_FIELD_SOURCE_CHANGED');
  return current;
 }
 if(target.schema_version==='document-source-period-intake-v1'){
  if(!input.sourcePeriodIntake)throw Error('SOURCE_INTAKE_CONTEXT_REQUIRED');
  return documentSourcePeriodIntakeTarget(input.sourcePeriodIntake);
 }
 if(target.schema_version==='document-travel-tariff-transcription-v1'){
  if(!input.travelTariffSource)throw Error('TRAVEL_TARIFF_PURPOSE_CONTEXT_REQUIRED');
  return documentTravelTariffTarget({source:input.travelTariffSource,subject:target.tariff.subject});
 }
 if(target.schema_version==='document-evidence-reading-v1'){
  if(!input.nonPayslipDocument||!input.nonPayslipProductDocumentId)throw Error('DOCUMENT_EVIDENCE_DOCUMENT_CONTEXT_REQUIRED');
  return documentEvidenceTarget({checkpoint:input.currentCheckpoint,document:input.nonPayslipDocument,productDocumentId:input.nonPayslipProductDocumentId,month:target.month,
   observationId:target.observation.observation_id});
 }
 if('proposed_value' in target)return documentSourceStructureTarget({...base,selector:sourceStructureSelector(target.subject),
  ...('period_witness' in target?{periodPolicy:IDENTIFIED_PERIOD_STRUCTURE_POLICY,periodReadings:input.periodReadings}:{})});
 if(target.schema_version==='document-field-confirmation-v1')return documentFieldTarget({...base,candidateId:target.candidate.candidate_id});
 if(target.schema_version==='document-row-cell-confirmation-v1')return documentRowCellTarget({...base,componentId:target.original_component.component_id,cell:target.cell});
 if(target.schema_version==='document-source-scope-confirmation-v1')return documentSourceScopeTarget({...base,candidateId:target.original_observation.candidate.candidate_id});
 return documentSourceTranscriptionTarget({...base,subject:target.subject.kind==='reported_work_hours'?{kind:'reported_work_hours',page:target.subject.page}:{kind:'balance_unit',candidateId:target.subject.original_candidate.candidate_id}});
}
