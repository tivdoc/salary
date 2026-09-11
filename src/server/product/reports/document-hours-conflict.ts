import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {hoursConflictTargetSchema,createHoursConflictDeclaration,hasHoursConflictObservations,type HoursConflictTarget} from '@/engine/extraction/hours-conflict';
import {HOURS_CONFLICT_NAMESPACE,parseHoursConflictAnswer} from './document-hours-conflict-answer';
import {readSavedExtractionProvenance} from '../processing/live-extraction-provenance';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),product_document_id:z.uuid(),
 version_id:z.uuid(),input_sha256:sha,expected_month:z.string(),period_mismatch:z.boolean(),result_sha256:sha,
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()});

/** Pure content binding only. SQL proves current ownership, entitlement and
 * immutable checkpoint identity before opening or accepting this request. */
export function createDocumentHoursConflictTarget(input:{checkpoint:unknown;orderId:string;policyVersion:string}):HoursConflictTarget{
 const checkpoint=checkpointSchema.parse(input.checkpoint),extraction=checkpoint.run.result.final_extraction;
 if(canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256||extraction.document_id!==checkpoint.version_id
  ||extraction.customer_readings!==undefined)throw Error('HOURS_CONFLICT_SOURCE_BINDING');
 if(checkpoint.expected_month!=='2026-06'||checkpoint.period_mismatch)throw Error('HOURS_CONFLICT_PERIOD_UNSUPPORTED');
 const periods=extraction.fields.filter(row=>row.field==='salary_period');
 if(!periods.length||periods.some(row=>canonicalSha256(row.normalized_value)!==canonicalSha256({year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'})))
  throw Error('HOURS_CONFLICT_PERIOD_UNSUPPORTED');
 const provenance=readSavedExtractionProvenance(input.checkpoint);
 const pages=extraction.quality_metrics.page_count;
 if(provenance.kind==='unproven_legacy'||!provenance.allPassesSucceeded||!provenance.receipts.length||!pages
  ||provenance.receipts.some(receipt=>receipt.source_page_count!==pages))throw Error('HOURS_CONFLICT_RECEIPT_REQUIRED');
 if(extraction.detected_document_type!=='payslip'||!['completed','partial'].includes(extraction.status))throw Error('HOURS_CONFLICT_EXTRACTION_REQUIRED');
 const observations=extraction.fields.filter(row=>row.field==='regular_hours');
 const values=new Set(observations.filter(row=>row.normalized_value!==null).map(row=>canonicalSha256(row.normalized_value)));
 if(!hasHoursConflictObservations(extraction))throw Error('HOURS_CONFLICT_NOT_PRESENT');
 const body={schema_version:'document-hours-conflict-target-v1' as const,case_id:checkpoint.case_id,order_id:z.uuid().parse(input.orderId),
  product_document_id:checkpoint.product_document_id,version_id:checkpoint.version_id,source_sha256:checkpoint.input_sha256,month:'2026-06' as const,
  extraction_policy_version:input.policyVersion,extraction_result_sha256:checkpoint.result_sha256,source_page_count:pages,
  reason:values.size>=2?'conflicting_observations' as const:'provider_reported_conflict' as const,
  observations,source_warning_flags:extraction.warnings};
 return deepFreeze(hoursConflictTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function documentHoursConflictQuestion(candidate:HoursConflictTarget){
 const target=hoursConflictTargetSchema.parse(candidate);
 const introduction=target.reason==='conflicting_observations'?'נמצאו קריאות שעות שונות במקור.'
  :'החילוץ סימן סתירה אך לא שמר מספיק קריאות שעות כדי לברר אותה.';
 return {code:HOURS_CONFLICT_NAMESPACE+target.target_sha256,question:`בתלוש יוני 2026: ${introduction} יש לבדוק את המסמך ואת רישומי העבודה, לציין את מספר השעות הרגילות ואת הבסיס לתשובה, או לבחור שלא ניתן לקבוע. התשובה היא הצהרה לבירור ואינה מתקנת את המקור או מאשרת זכאות.`,
  answer_kind:'text' as const,field_crop:'regular_hours',blocking:false};
}
export function resolveDocumentHoursConflictAnswer(input:{target:unknown;currentCheckpoint:unknown;policyVersion:string;caseId:string;orderId:string;month:string;
 requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:string}){
 const target=hoursConflictTargetSchema.parse(input.target),answer=parseHoursConflictAnswer(input.answer);
 z.uuid().parse(input.caseId);z.uuid().parse(input.orderId);z.uuid().parse(input.requestId);z.uuid().parse(input.identityId);
 z.number().int().positive().safe().parse(input.answerRevision);z.iso.datetime({offset:true}).parse(input.answeredAt);
 if(target.case_id!==input.caseId||target.order_id!==input.orderId)throw Error('HOURS_CONFLICT_CASE_ORDER_MISMATCH');
 if(target.month!==input.month||target.extraction_policy_version!==input.policyVersion)return {state:'stale' as const};
 let current:HoursConflictTarget;
 try{current=createDocumentHoursConflictTarget({checkpoint:input.currentCheckpoint,orderId:input.orderId,policyVersion:input.policyVersion});}catch{return {state:'stale' as const};}
 if(current.target_sha256!==target.target_sha256)return {state:'stale' as const};
 if(answer.state==='unknown')return {state:'unknown' as const,target,answer};
 return {state:'declared' as const,declaration:createHoursConflictDeclaration({target,request_id:input.requestId,answer_revision:input.answerRevision,
  identity_id:input.identityId,answered_at:input.answeredAt,answer})};
}
