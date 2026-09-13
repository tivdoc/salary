import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {sourceStructureBasisSchema} from '../../extraction/source-structure.ts';
import type {ExplicitObligation,ObligationsEntitlementInput} from './contracts.ts';
import {identifiedClauseTranscriptionSourceCurrent} from './identified-clause-transcriptions.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
const operand=documentReviewCalculationInputSchema.shape.operands.element,source=operand.shape.source;
export const obligationPaymentLinkTargetSchema=z.object({
 schema_version:z.literal('obligation-payment-link-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),policy_version:z.string().min(1).max(100),checkpoint_sha256:sha,
 obligation_id:z.string().min(1).max(64),period,clause:z.object({source,text_sha256:sha,effective_period:period}).strict(),
 payroll_document_reading_sha256:sha,amount:operand,target_sha256:sha,
}).strict().superRefine((t,c)=>{const {target_sha256,...body}=t;
 if(canonicalSha256(body)!==target_sha256)c.addIssue({code:'custom',message:'OBLIGATION_PAYMENT_TARGET_HASH'});
 if(t.amount.source.version_id!==t.version_id||t.amount.source.file_sha256!==t.source_sha256||t.amount.source.reading_receipt_sha256!==t.payroll_document_reading_sha256
  ||t.amount.state!=='observed'||t.amount.representation!=='money_ils'||!['identified_document_reading','provider_extraction'].includes(t.amount.source.reading)
  ||t.month!==t.period.from.slice(0,7)||t.month!==t.period.to.slice(0,7))c.addIssue({code:'custom',message:'OBLIGATION_PAYMENT_TARGET_SOURCE'});
});
export type ObligationPaymentLinkTarget=z.infer<typeof obligationPaymentLinkTargetSchema>;
export const obligationPaymentLinkAnswerSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('correct'),value:z.object({relationship:z.enum(['same_obligation','different_obligation']),basis:sourceStructureBasisSchema}).strict()}).strict(),
 z.object({action:z.literal('unknown')}).strict(),z.object({action:z.literal('unreadable')}).strict(),
]);
export const obligationPaymentLinkReadingSchema=z.object({schema_version:z.literal('obligation-payment-link-reading-v1'),target:obligationPaymentLinkTargetSchema,
 request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),
 answer:obligationPaymentLinkAnswerSchema,state:z.enum(['source_link_reading','unknown','unreadable']),verification_sha256:sha,
}).strict();
export type ObligationPaymentLinkReading=z.infer<typeof obligationPaymentLinkReadingSchema>;
type PayrollSource={version_id:string;product_document_id:string;checkpoint_sha256:string;policy_version:string};

/** Candidates are row amounts already admitted as observed by the ordinary
 * adapter. Their source provenance is retained; link answers grant no numeric
 * acceptance, classification or allocation beyond that existing admission. */
export function obligationPaymentOperands(review:DocumentReviewInput):DocumentReviewOperand[]{
 const amounts=new Map<string,DocumentReviewOperand>(),conflicts=new Set<string>();
 for(const check of review.checks){
  if(!check.check_id.startsWith('document.'))continue;
  const parsed=documentReviewCalculationInputSchema.safeParse(check.calculation);if(!parsed.success)continue;
  const c=parsed.data;if(c.case_id!==review.case_id||canonicalSha256(c.period)!==canonicalSha256(review.period)||c.operation.kind==='candidate_rule')continue;
  for(const a of c.operands){
   if(a.state!=='observed'||a.representation!=='money_ils'||a.quantity_unit!==null||a.printed_value===null||!['identified_document_reading','provider_extraction'].includes(a.source.reading)
    ||!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(a.printed_value)||!a.observation_id.endsWith(':amount')||!z.uuid().safeParse(a.observation_id.slice(0,-7)).success)continue;
   const docs=review.documents.filter(d=>d.case_id===review.case_id&&d.document_id===a.source.document_id&&d.version_id===a.source.version_id&&d.kind==='payslip');
   if(docs.length!==1||docs[0].file_sha256!==a.source.file_sha256||docs[0].reading_sha256!==a.source.reading_receipt_sha256||docs[0].page_count===null||a.source.page>docs[0].page_count)continue;
   // The amount ID carries the immutable component identity even when a long
   // source locator is represented by a digest in the ordinary adapter.
   const key=canonicalSha256({version:a.source.version_id,observation:a.observation_id}),old=amounts.get(key);
   if(old&&canonicalSha256({...old,id:'amount'})!==canonicalSha256({...a,id:'amount'}))conflicts.add(key);else amounts.set(key,a);
  }
 }
 return [...amounts].filter(([key])=>!conflicts.has(key)).map(([,a])=>a);
}
export function createObligationPaymentLinkTarget(input:{review:DocumentReviewInput;obligation:ExplicitObligation;observationId:string;productDocumentId:string;checkpointSha256:string;policyVersion:string;versionId?:string}){
 const {review,obligation:o}=input,c=o.clause.source;
 const clauses=review.documents.filter(d=>d.case_id===review.case_id&&d.document_id===c.document_id&&d.version_id===c.version_id&&d.kind==='contract');
 if(clauses.length!==1||clauses[0].file_sha256!==c.file_sha256
  ||clauses[0].reading_sha256!==c.reading_receipt_sha256&&!identifiedClauseTranscriptionSourceCurrent(review,c,o.clause.text_sha256)||c.reading!=='identified_document_reading'
  ||canonicalSha256(review.period)!==canonicalSha256(o.payment_period)||!review.purchased_scope.topics.includes(o.topic))throw Error('OBLIGATION_PAYMENT_CLAUSE_SCOPE');
 const matches=obligationPaymentOperands(review).filter(a=>a.observation_id===input.observationId&&(input.versionId===undefined||a.source.version_id===input.versionId));
 if(matches.length!==1)throw Error('OBLIGATION_PAYMENT_OPERAND_REQUIRED');
 const amount=matches[0],body={schema_version:'obligation-payment-link-v1' as const,case_id:review.case_id,product_document_id:input.productDocumentId,
  version_id:amount.source.version_id,source_sha256:amount.source.file_sha256,month:review.period.from.slice(0,7),policy_version:input.policyVersion,checkpoint_sha256:input.checkpointSha256,
  obligation_id:o.obligation_id,period:review.period,clause:{source:c,text_sha256:o.clause.text_sha256,effective_period:o.clause.effective_period},
  payroll_document_reading_sha256:amount.source.reading_receipt_sha256,amount};
 return deepFreeze(obligationPaymentLinkTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function obligationPaymentLinkTargets(input:{review:DocumentReviewInput;obligation:ExplicitObligation;payrollSources:readonly PayrollSource[]}){
 return obligationPaymentOperands(input.review).flatMap(amount=>{
  const sources=input.payrollSources.filter(s=>s.version_id===amount.source.version_id);if(sources.length!==1)return [];
  const s=sources[0];return [createObligationPaymentLinkTarget({...input,observationId:amount.observation_id,versionId:s.version_id,productDocumentId:s.product_document_id,checkpointSha256:s.checkpoint_sha256,policyVersion:s.policy_version})];
 });
}
export function resolveObligationPaymentLinkReading(input:{target:unknown;currentTarget:unknown;caseId:string;requestId:string;answerRevision:number;identityId:string;answeredAt:string;answer:unknown}){
 const target=obligationPaymentLinkTargetSchema.parse(input.target),current=obligationPaymentLinkTargetSchema.parse(input.currentTarget);
 if(target.case_id!==input.caseId||current.case_id!==input.caseId)throw Error('OBLIGATION_PAYMENT_READING_CASE');
 if(target.target_sha256!==current.target_sha256)return {state:'stale' as const};
 const answer=obligationPaymentLinkAnswerSchema.parse(input.answer);
 if(answer.action==='correct'&&answer.value.basis.page!==target.amount.source.page)throw Error('OBLIGATION_PAYMENT_BASIS_PAGE');
 const body={schema_version:'obligation-payment-link-reading-v1' as const,target,request_id:input.requestId,answer_revision:input.answerRevision,identity_id:input.identityId,
  answered_at:input.answeredAt,answer,state:answer.action==='correct'?'source_link_reading' as const:answer.action};
 return {state:'current' as const,reading:deepFreeze(obligationPaymentLinkReadingSchema.parse({...body,verification_sha256:canonicalSha256(body)}))};
}
export function parseObligationPaymentLinkReading(candidate:unknown){
 const r=obligationPaymentLinkReadingSchema.parse(candidate),replay=resolveObligationPaymentLinkReading({target:r.target,currentTarget:r.target,caseId:r.target.case_id,
  requestId:r.request_id,answerRevision:r.answer_revision,identityId:r.identity_id,answeredAt:r.answered_at,answer:r.answer});
 if(replay.state!=='current'||canonicalSha256(replay.reading)!==canonicalSha256(r))throw Error('OBLIGATION_PAYMENT_READING_REPLAY');return r;
}

/** Authenticated journal readings select source candidates only. They do not
 * manufacture the separate recorded-scope assessment or legal applicability. */
export function attachObligationPaymentLinks(input:ObligationsEntitlementInput,review:DocumentReviewInput,readings:readonly ObligationPaymentLinkReading[]):ObligationsEntitlementInput{
 if(input.case_id!==review.case_id||canonicalSha256(input.period)!==canonicalSha256(review.period))throw Error('OBLIGATION_PAYMENT_INPUT_SCOPE');
 const parsed=readings.map(parseObligationPaymentLinkReading),latest=new Map<string,ObligationPaymentLinkReading>();
 for(const r of parsed){const old=latest.get(r.request_id);if(old&&old.answer_revision===r.answer_revision&&canonicalSha256(old)!==canonicalSha256(r))throw Error('OBLIGATION_PAYMENT_REVISION_CONFLICT');if(!old||old.answer_revision<r.answer_revision)latest.set(r.request_id,r);}
 const manifests=[...input.source_manifest];
 const obligations=input.obligations.map(o=>{
  const relevant=[...latest.values()].filter(r=>r.target.obligation_id===o.obligation_id);
  if(!relevant.length)return o;
  const current=relevant.filter(r=>{try{const t=r.target;return createObligationPaymentLinkTarget({review,obligation:o,observationId:t.amount.observation_id,versionId:t.version_id,
   productDocumentId:t.product_document_id,checkpointSha256:t.checkpoint_sha256,policyVersion:t.policy_version}).target_sha256===t.target_sha256;}catch{return false;}});
  const positives=current.filter(r=>r.answer.action==='correct'&&r.answer.value.relationship==='same_obligation');
  // Two positive targets are an unresolved allocation, never a convenient sum.
  if(positives.length!==1||current.some(r=>r.target.target_sha256===positives[0]?.target.target_sha256&&r!==positives[0]))return {...o,recorded:null};
  const r=positives[0],amount=r.target.amount,payment_id='payment.'+canonicalSha256({version:amount.source.version_id,observation:amount.observation_id}).slice(0,48);
  const same=(a:typeof amount.source,b:typeof amount.source)=>canonicalSha256(a)===canonicalSha256(b);
  const existing=o.recorded?.scope_assessment;
  const valid=existing?.decision_id==='obligation.recorded_scope'&&existing.state==='accepted'&&existing.basis!=='customer_declaration'
   &&o.recorded!==null&&canonicalSha256(o.recorded.payment_period)===canonicalSha256(r.target.period)
   &&canonicalSha256({...o.recorded.amount,id:'amount'})===canonicalSha256({...amount,id:'amount'})
   &&existing.sources.some(s=>same(s,o.clause.source))&&existing.sources.some(s=>same(s,amount.source))
   &&(existing.valid_until===null||existing.valid_until>input.evaluated_at);
  const scope_assessment=valid?existing!:{decision_id:'obligation.recorded_scope',state:'missing' as const,basis:'ai_source_assessment' as const,
   explanation:JSON.stringify({schema_version:'obligation-payment-source-link-v1',reading_sha256:r.verification_sha256,allocation_assessment_required:true}),sources:[o.clause.source,amount.source],valid_until:null};
  const document=review.documents.find(d=>d.document_id===amount.source.document_id&&d.version_id===amount.source.version_id)!;
  if(!manifests.some(m=>m.document_id===document.document_id&&m.version_id===document.version_id))manifests.push({document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page_count:document.page_count!,kind:'case_document',case_id:review.case_id});
  return {...o,recorded:{payment_id,amount,payment_period:r.target.period,scope_assessment}};
 });
 return {...input,source_manifest:manifests,obligations};
}
