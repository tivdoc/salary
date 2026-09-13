import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {reviewCompletionSchema,reviewCompletionTargetSchema,validateReviewAnswerFormat,type ReviewCompletionTarget} from '@/engine/document-review/completions';
import {replayDocumentReview} from '@/engine/document-review/service';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from './source-dispatch';
import {readSavedOrders,savedOrderOrigin,savedOrderReceiptSha256,purchasedMonths} from './saved-order-scope';
import {supportedReviewUpload} from '../documents/review-fulfillment';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from '../reports/document-field-confirmation';
import {reviewRequestsCoveredByFieldReadings,reviewRequestsCoveredByFieldReadingGroups,type ExistingFieldReadingRequest} from '../reports/review-field-coverage';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {openSavedReadingDependencies} from './saved-reading-dependencies';

export const REVIEW_REQUEST_NAMESPACE='document_review:';
export const REVIEW_UNKNOWN_ANSWER='לא יודע';
export const REVIEW_CONFLICT_ANSWER='יש סתירה';

/** Presentation instruction is deterministic but is not added to the hashed
 * factual target. SQL derives exactly the same request question. */
export function savedReviewRequestQuestion(candidate:unknown){
 const target=reviewCompletionTargetSchema.parse(candidate);
 const question=target.question+(target.answer_kind==='document'?'':'\nאפשר להשיב "לא יודע".');
 if(question.length<4||question.length>400)throw Error('REVIEW_REQUEST_QUESTION_LENGTH');
 return question;
}

/** Plain user text only. Actor, timestamps and revision always come from the
 * authenticated answer journal. No JSON receipt or OCR confirmation is accepted. */
export function normalizeSavedReviewAnswer(candidate:ReviewCompletionTarget,text:string):
 Readonly<{state:'provided'|'unknown'|'conflicted';value:string|number|boolean|null}>{
 const target=reviewCompletionTargetSchema.parse(candidate),answer=z.string().max(2000).parse(text).trim();
 if(target.answer_kind==='document'||!answer)throw Error('REVIEW_REQUEST_ANSWER_INVALID');
 if(answer===REVIEW_UNKNOWN_ANSWER)return {state:'unknown',value:null};
 if(answer===REVIEW_CONFLICT_ANSWER)return {state:'conflicted',value:null};
 if(target.answer_kind==='boolean'){
  if(!['כן','לא'].includes(answer))throw Error('REVIEW_REQUEST_ANSWER_INVALID');
  return {state:'provided',value:answer==='כן'};
 }
 if(target.answer_kind==='number'){
  if(!/^-?(?:0|[1-9][0-9]{0,12})(?:\.[0-9]{1,6})?$/.test(answer)||!Number.isFinite(Number(answer))||Math.abs(Number(answer))>1e12)throw Error('REVIEW_REQUEST_ANSWER_INVALID');
  return {state:'provided',value:Number(answer)};
 }
 if(target.answer_kind==='choice'&&!target.options?.includes(answer))throw Error('REVIEW_REQUEST_ANSWER_INVALID');
 validateReviewAnswerFormat(target,answer);
 return {state:'provided',value:answer};
}

/** Must run after topic_results was persisted, in the same existing source
 * transaction. Every target is loaded from that stage; the caller supplies no
 * question payload. SQL independently repeats the currentness checks. */
export async function openSavedReviewRequests(context:PostgresTransactionContext,candidate:SourceJob,analysisRunId:string,snapshot?:StoredCaseInputSnapshot){
 const job=sourceJobSchema.parse(candidate);z.string().min(1).max(200).parse(analysisRunId);
 await lockCurrentSource(context,job);
 const rows=await context.client.query(statement('review_requests_stage',
  `select s.payload,s.payload_sha256 from public.engine_analysis_stage_versions s
   join public.analysis_runs ar on ar.id=s.analysis_run_id
   where ar.canonical_analysis_run_id=$1 and ar.canonical_case_id=$2
    and ar.tenant_id='saved-case:'||$2 and s.tenant_id=ar.tenant_id and s.stage='topic_results'`,[analysisRunId,job.case_id]));
 if(rows.row_count!==1)throw Error('REVIEW_REQUEST_STAGE_REQUIRED');
 const row=rows.rows[0];if(canonicalSha256(row.payload)!==row.payload_sha256)throw Error('REVIEW_REQUEST_STAGE_HASH');
 const payload=z.object({bundle:z.object({document_review:z.unknown()})}).parse(row.payload);
 const review=replayDocumentReview(payload.bundle.document_review);
 if(review.case_id!==job.case_id||review.analysis_run_id!==analysisRunId)throw Error('REVIEW_REQUEST_STAGE_SCOPE');
 const [order]=await readSavedOrders(context,job,review.purchased_scope.order_id);
 const month=review.period.from.slice(0,7),lastDay=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
 if(!order||savedOrderReceiptSha256(order)!==review.purchased_scope.receipt_sha256||savedOrderOrigin(order)!==review.purchased_scope.origin||canonicalSha256(order.topics)!==canonicalSha256(review.purchased_scope.topics)
  ||review.period.from!==month+'-01'||review.period.to!==lastDay||order.from>review.period.from||order.to<review.period.from||!purchasedMonths(order).includes(month))throw Error('REVIEW_REQUEST_ORDER_SCOPE');
 const planned=review.completions.customer_requests.map(r=>reviewCompletionSchema.parse(r));
 if(snapshot)await openSavedReadingDependencies(context,job,review,snapshot);
 // Only upload kinds supported by the actual reserve/commit protocol can open
 // a bound request. Receiving bytes keeps it pending until source assessment.
 const unsupported=planned.filter(r=>(r.target.kind==='document'||r.target.answer_kind==='document')&&!supportedReviewUpload(r.target));
 const candidates=planned.filter(r=>!unsupported.includes(r));
 const numeric=candidates.filter(r=>r.target.kind==='factual'&&r.target.answer_kind==='number'&&r.target.required_evidence_kind==='observed_reading'
  &&review.input.answer_bindings.some(b=>b.fact_key===r.target.fact_key));
 let covered:ReturnType<typeof reviewRequestsCoveredByFieldReadings>=[];
 let coveredGroups:ReturnType<typeof reviewRequestsCoveredByFieldReadingGroups>=[];
 if(numeric.length){
  const targets=await context.client.query(statement('review_existing_field_targets',
   `select t.request_id,t.target,r.code,r.answered_at,r.expires_at,r.expired_at,c.result checkpoint
    from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id
    join private.case_extraction_checkpoints c on c.case_id=t.case_id and c.version_id::text=t.target->>'version_id'
     and c.policy_version=t.target->>'policy_version' and c.result_sha256=t.target->>'extraction_result_sha256'
    join private.case_input_versions v on v.case_id=c.case_id and v.revision=c.revision
    join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id and d.content_sha256=c.input_sha256
    where t.case_id=$1::uuid and c.revision=$2 and v.input_sha256=$3 and r.answered_at is null
     and r.expired_at is null and r.expires_at>clock_timestamp()`,[job.case_id,job.revision,job.input_sha256]));
  const fieldRequests:ExistingFieldReadingRequest[]=targets.rows.flatMap(row=>{
   const target=documentReadingTargetSchema.parse(row.target);
   // This independent source-intake target cannot replace a monthly numeric
   // request or be rebuilt from a payroll checkpoint.
   if(target.schema_version==='document-source-period-intake-v1')return [];
   const current=documentReadingTargetForCheckpoint({target,currentCheckpoint:row.checkpoint});
   if(target.case_id!==job.case_id||canonicalSha256(current)!==canonicalSha256(target))throw Error('REVIEW_FIELD_COVERAGE_CHECKPOINT');
   return [{request_id:z.uuid().parse(row.request_id),code:z.string().parse(row.code),target,source_current:true,
    answered_at:row.answered_at===null?null:z.string().parse(row.answered_at),expires_at:new Date(String(row.expires_at)).toISOString(),
    expired_at:row.expired_at==null?null:new Date(String(row.expired_at)).toISOString()}];
  });
  covered=reviewRequestsCoveredByFieldReadings({review,fieldRequests,nowMs:Date.now()});
  coveredGroups=reviewRequestsCoveredByFieldReadingGroups({review,fieldRequests,nowMs:Date.now()});
 }
 const requests=candidates.filter(request=>![...covered,...coveredGroups].some(match=>match.target_sha256===request.target.target_sha256));
 // Fail before the first SQL insert if any question cannot be represented.
 for(const request of requests)savedReviewRequestQuestion(request.target);
 const opened:string[]=[];
 for(const request of requests){
  const saved=await context.client.query(statement('review_request_open',
   'select private.document_review_request_open($1::uuid,$2,$3,$4,$5,$6) id',
   [job.case_id,job.revision,job.input_sha256,analysisRunId,request.target.target_sha256,job.authority_dependency_sha256??null]));
  if(saved.row_count!==1)throw Error('REVIEW_REQUEST_RECEIPT_MISSING');
  const id=z.uuid().nullable().parse(saved.rows[0]?.id);if(id!==null)opened.push(id);
 }
 return {opened_request_ids:opened,...(covered.length?{covered_by_field_requests:covered}:{}),...(coveredGroups.length?{covered_by_field_request_groups:coveredGroups}:{}),skipped_document_targets:unsupported.map(r=>({
  target_sha256:r.target.target_sha256,reason:'unsupported_upload_document_kind' as const}))};
}

const historyEntry=z.object({request_id:z.uuid(),revision:z.number().int().positive(),identity_id:z.uuid(),
 answered_at:z.iso.datetime({offset:true}),answer_text:z.string().min(1).max(2000)}).strict();
const historyRow=z.object({request:reviewCompletionSchema,source_current:z.boolean(),answers:z.array(historyEntry).max(1024)}).strict();
/** Reads only versions present in the selected immutable case journal. A new
 * answer arriving after that journal is not injected into an earlier analysis. */
export async function readSavedReviewAnswers(context:PostgresTransactionContext,candidate:SourceJob){
 const job=sourceJobSchema.parse(candidate);await lockCurrentSource(context,job);
 const rows=await context.client.query(statement('review_request_answer_history',
  'select private.document_review_answer_history($1::uuid,$2,$3) value',[job.case_id,job.revision,job.input_sha256]));
 if(rows.row_count!==1)throw Error('REVIEW_REQUEST_JOURNAL_REQUIRED');
 const history=z.array(historyRow).max(256).parse(rows.rows[0]?.value);
 if(new Set(history.map(r=>r.request.target.target_sha256)).size!==history.length)throw Error('REVIEW_REQUEST_HISTORY_AMBIGUOUS');
 return history.map(row=>{
  if(row.request.target.case_id!==job.case_id)throw Error('REVIEW_REQUEST_HISTORY_SCOPE');
  const requestIds=new Set(row.answers.map(a=>a.request_id));
  if(requestIds.size!==1||row.answers.some((a,i)=>a.revision!==i+1))throw Error('REVIEW_REQUEST_HISTORY_REVISION');
  return {request:row.request,source_current:row.source_current,answers:row.answers.map(a=>({
   actor:{case_id:job.case_id,identity_id:a.identity_id},answer:{request_id:a.request_id,revision:a.revision,
    answered_at:a.answered_at,...normalizeSavedReviewAnswer(row.request.target,a.answer_text)}}))};
 });
}
