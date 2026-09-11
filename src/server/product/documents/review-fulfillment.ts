import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {reviewCompletionSchema,reviewPeriodSchema,parseReviewCompletionInput,type ReviewSourcePin} from '@/engine/document-review/completions';
import {replayDocumentReview} from '@/engine/document-review/service';
import type {DocumentReviewResult} from '@/engine/document-review/contracts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),uuid=z.uuid();
export const REVIEW_UPLOAD_KINDS=['payslip','contract','attendance'] as const;
export const reviewUploadScopeSchema=z.object({request_id:uuid,request:reviewCompletionSchema,
 order_id:uuid,order_origin:z.enum(['saved_order','legacy_paid_receipt']),order_receipt_sha256:sha}).strict();
const receivedFileSchema=z.object({document_id:uuid,version_id:uuid,source_sha256:sha,
 document_kind:z.enum(REVIEW_UPLOAD_KINDS),period_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).nullable(),
 duplicate_content:z.boolean()}).strict();
const receiptBodySchema=z.object({schema_version:z.literal('document-review-upload-receipt-v1'),case_id:uuid,request_id:uuid,
 target_sha256:sha,order_id:uuid,order_origin:z.enum(['saved_order','legacy_paid_receipt']),order_receipt_sha256:sha,
 period:reviewPeriodSchema,batch_id:uuid,received_at:z.iso.datetime({offset:true}),state:z.literal('received_pending_review'),
 files:z.array(receivedFileSchema).min(1).max(602)}).strict();
export const reviewUploadReceiptSchema=receiptBodySchema.extend({receipt_sha256:sha}).superRefine((r,ctx)=>{
 const {receipt_sha256,...body}=r;
 if(canonicalSha256(body)!==receipt_sha256)ctx.addIssue({code:'custom',message:'Upload receipt hash mismatch'});
 if(new Set(r.files.map(f=>f.version_id)).size!==r.files.length)ctx.addIssue({code:'custom',message:'Duplicate receipt version'});
});
export type ReviewUploadScope=z.infer<typeof reviewUploadScopeSchema>;
export type ReviewUploadReceipt=z.infer<typeof reviewUploadReceiptSchema>;
export function supportedReviewUpload(target:ReviewUploadScope['request']['target']):boolean{
 return target.kind==='document'&&target.answer_kind==='document'&&REVIEW_UPLOAD_KINDS.some(kind=>target.document_kind===kind);
}

/** Called only with committed batch rows and verified Storage digests. Metadata
 * receipt means received, never that the requested information is satisfied. */
export function buildReviewUploadReceipt(input:{scope:ReviewUploadScope;case_id:string;batch_id:string;received_at:string;
 files:z.infer<typeof receivedFileSchema>[];existing_source_hashes:readonly string[]}):ReviewUploadReceipt{
 const scope=reviewUploadScopeSchema.parse(input.scope),target=scope.request.target;
 if(target.case_id!==input.case_id)throw Error('UPLOAD_FORBIDDEN');
 if(!supportedReviewUpload(target))throw Error('UPLOAD_REQUEST_CONFLICT');
 const all=input.files.map(f=>receivedFileSchema.parse(f)),matching=all.filter(f=>f.document_kind===target.document_kind);
 if(!matching.length||matching.some(f=>f.document_kind==='payslip'&&f.period_month!==target.period.from.slice(0,7)))throw Error('UPLOAD_REQUEST_CONFLICT');
 const prior=new Set(input.existing_source_hashes),counts=new Map<string,number>();
 for(const f of all)counts.set(f.source_sha256,(counts.get(f.source_sha256)??0)+1);
 const body=receiptBodySchema.parse({schema_version:'document-review-upload-receipt-v1',case_id:input.case_id,request_id:scope.request_id,
  target_sha256:target.target_sha256,order_id:scope.order_id,order_origin:scope.order_origin,order_receipt_sha256:scope.order_receipt_sha256,
  period:target.period,batch_id:input.batch_id,received_at:input.received_at,state:'received_pending_review',
  files:matching.map(f=>({...f,duplicate_content:f.duplicate_content||prior.has(f.source_sha256)||counts.get(f.source_sha256)!==1})).sort((a,b)=>a.version_id.localeCompare(b.version_id))});
 return deepFreeze(reviewUploadReceiptSchema.parse({...body,receipt_sha256:canonicalSha256(body)}));
}

export type ReviewUploadAssessment=Readonly<{state:'satisfied'|'insufficient'|'stale';reason:string;request_id:string;receipt_sha256:string;
 analysis_run_id:string;analysis_result_sha256:string;target_sha256:string;verified_source_pins:readonly ReviewSourcePin[];
 invalidated_check_ids:readonly string[];information_satisfied:boolean;customer_declaration_is_source:false;assessment_sha256:string}>;

/** Only the new financial-source inventory request may replace its exact
 * purchased-topic sentinels. A source-bound gap preserves missing legal/code
 * coverage; it does not turn that topic into an executed or successful check. */
function financialInventoryCovered(scope:ReviewUploadScope,review:DocumentReviewResult,pins:readonly ReviewSourcePin[]):boolean{
 const {target,dependent_check_ids:dependencies}=scope.request,topics=review.purchased_scope.topics;
 if(target.fact_key!=='payslip.financial_source'||target.kind!=='document'||target.document_kind!=='payslip'
  ||new Set(topics).size!==topics.length||dependencies.length!==topics.length||new Set(dependencies).size!==dependencies.length
  ||topics.some(topic=>!dependencies.includes(`missing.payslip.${topic}`)))return false;
 const matches=(source:ReviewSourcePin)=>pins.some(pin=>source.case_id===pin.case_id&&source.version_id===pin.version_id
  &&source.source_sha256===pin.source_sha256&&(source.document_id===pin.document_id||source.document_id===pin.version_id));
 return topics.every(topic=>review.coverage_gaps.some(g=>g.topic===topic&&g.source_pins?.some(matches))
  ||review.checks.some(check=>check.topic===topic&&check.calculation.input.source_manifest.some(source=>source.kind==='case_document'
   &&source.case_id===review.case_id&&matches({case_id:source.case_id,document_id:source.document_id,version_id:source.version_id,source_sha256:source.file_sha256})
   &&check.calculation.input.operands.some(operand=>operand.source.document_id===source.document_id
    &&operand.source.version_id===source.version_id&&operand.source.file_sha256===source.file_sha256))));
}

/** Authenticated caller loads the persisted SAME-run review and current source
 * pins. A complete document flag or the disappearance of a filtered check is
 * insufficient: the exact requested fact must have positive observed evidence. */
export function assessReviewUpload(input:{scope:ReviewUploadScope;receipt:ReviewUploadReceipt;review:unknown;current_source_pins:readonly ReviewSourcePin[]}):ReviewUploadAssessment{
 const scope=reviewUploadScopeSchema.parse(input.scope),r=reviewUploadReceiptSchema.parse(input.receipt),target=scope.request.target;
 const review=replayDocumentReview(input.review),planner=parseReviewCompletionInput(review.input.completion_input);
 if(r.case_id!==target.case_id||review.case_id!==r.case_id||scope.request_id!==r.request_id||target.target_sha256!==r.target_sha256
  ||scope.order_id!==r.order_id||scope.order_origin!==r.order_origin||scope.order_receipt_sha256!==r.order_receipt_sha256
  ||review.purchased_scope.order_id!==r.order_id||review.purchased_scope.origin!==r.order_origin||review.purchased_scope.receipt_sha256!==r.order_receipt_sha256
  ||canonicalSha256(target.period)!==canonicalSha256(r.period)||canonicalSha256(review.period)!==canonicalSha256(r.period))throw Error('REVIEW_UPLOAD_SCOPE');
 const result=(state:ReviewUploadAssessment['state'],reason:string,pins:ReviewSourcePin[]=[]):ReviewUploadAssessment=>{
  const body={state,reason,request_id:r.request_id,receipt_sha256:r.receipt_sha256,analysis_run_id:review.analysis_run_id,
   analysis_result_sha256:review.result_sha256,target_sha256:r.target_sha256,verified_source_pins:pins,
   invalidated_check_ids:scope.request.dependent_check_ids,information_satisfied:state==='satisfied',customer_declaration_is_source:false as const};
  return deepFreeze({...body,assessment_sha256:canonicalSha256(body)});
 };
 const pins=r.files.map(f=>({case_id:r.case_id,document_id:f.document_id,version_id:f.version_id,source_sha256:f.source_sha256}));
 if(pins.some(pin=>!input.current_source_pins.some(p=>canonicalSha256(p)===canonicalSha256(pin))))return result('stale','submitted_source_replaced');
 if(!supportedReviewUpload(target))return result('insufficient','unsupported_document_kind');
 if(r.files.some(f=>f.duplicate_content))return result('insufficient','duplicate_content');
 if(scope.request.dependent_check_ids.some(id=>!review.checks.some(c=>c.check_id===id)&&!review.coverage_gaps.some(g=>g.check_id===id))
  &&!financialInventoryCovered(scope,review,pins))return result('insufficient','dependent_check_not_evaluated');
 const relevant=planner.evidence.filter(e=>e.fact_key===target.fact_key&&e.period&&e.period.from<=target.period.from&&e.period.to>=target.period.to);
 if(relevant.some(e=>e.state==='conflicted'||e.state==='unknown'))return result('insufficient','requested_evidence_unresolved');
 const observed=relevant.filter(e=>e.state==='observed'&&e.source_reviewed&&e.value!==null
  &&e.origin===(target.required_evidence_kind==='actual_transfer'?'transfer_receipt':'document'));
 if(!observed.length)return result('insufficient','target_specific_observation_required');
 const verified=pins.filter(pin=>{
  const sameSubmittedSource=(p:ReviewSourcePin)=>p.case_id===pin.case_id&&p.version_id===pin.version_id&&p.source_sha256===pin.source_sha256
   &&(p.document_id===pin.document_id||p.document_id===pin.version_id);
  const document=review.documents.find(d=>d.case_id===pin.case_id&&(d.document_id===pin.document_id||d.document_id===pin.version_id)
   &&d.version_id===pin.version_id&&d.file_sha256===pin.source_sha256);
  const reviewed=planner.documents.find(d=>sameSubmittedSource(d.pin));
  return !!document&&document.kind===target.document_kind&&document.reading_origin!=='source_inventory'&&document.page_count!==null
   &&(reviewed?.review==='complete'||target.fact_key==='payslip.financial_source'&&reviewed?.review_completed_fact_keys?.includes('payslip.financial_source'))&&reviewed.period&&reviewed.period.from<=target.period.from&&reviewed.period.to>=target.period.to
   &&observed.some(e=>e.source_pins.some(sameSubmittedSource));
 });
 if(verified.length!==pins.length)return result('insufficient','submitted_document_not_fully_verified');
 return result('satisfied','target_specific_observed_source',verified);
}
