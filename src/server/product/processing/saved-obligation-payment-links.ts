import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {assertEntitlementComposition} from '@/engine/entitlement-review/compose';
import {obligationsEntitlementInputSchema} from '@/engine/entitlement-review/obligations/contracts';
import {obligationPaymentLinkTargets,resolveObligationPaymentLinkReading,type ObligationPaymentLinkReading} from '@/engine/entitlement-review/obligations/payment-link';
import {createObligationPaymentChoiceTarget,documentObligationPaymentTargetSchema,documentObligationPaymentLinkQuestion,obligationReadingDependencySchema,
 selectedObligationPaymentTarget,validateDocumentObligationPaymentLinkAnswer} from '../reports/document-obligation-payment-link';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,type SourceJob} from './source-dispatch';
import {readSavedOrders,purchasedMonths,savedOrderOrigin,savedOrderReceiptSha256} from './saved-order-scope';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const pin=z.object({id:z.uuid(),version_id:z.uuid(),sha256:sha,type:z.string()});
const answerRow=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),field_target:documentObligationPaymentTargetSchema});
const checkpointRow=z.object({product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,policy_version:z.string(),result_sha256:sha,
 result:z.object({case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,expected_month:month,result_sha256:sha,
  run:z.object({result:z.unknown()}).passthrough()}).passthrough()});
type History={request_id:string;answer_revision:number;target_sha256:string;current:boolean;action:string};
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const requestStatesSchema=z.array(z.object({request_id:z.uuid(),target_sha256:sha,current:z.boolean()}).strict())
 .refine(states=>new Set(states.map(s=>s.request_id)).size===states.length,'SAVED_OBLIGATION_PAYMENT_REQUEST_STATE_DUPLICATE');

/** Only the authenticated reader below may supply journal/checkpoint rows.
 * Reconstruct candidates from today's composed source operands, never from an
 * old target's own checkpoint, amount, clause or candidate inventory. */
export function savedObligationPaymentLinks(input:{caseId:string;month:string;review:DocumentReviewInput;journal:unknown;currentDocuments:unknown;payrollCheckpoints:unknown;currentRequestStates:unknown}){
 const caseId=z.uuid().parse(input.caseId),selectedMonth=month.parse(input.month),review=documentReviewInputSchema.parse(input.review);
 if(review.case_id!==caseId||review.period.from.slice(0,7)!==selectedMonth||review.period.to.slice(0,7)!==selectedMonth)throw Error('SAVED_OBLIGATION_PAYMENT_SCOPE');
 if(review.entitlement_composition)assertEntitlementComposition(review);
 const journal=z.object({case_id:z.uuid(),documents:z.array(pin),answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 if(journal.case_id!==caseId)throw Error('SAVED_OBLIGATION_PAYMENT_CASE');
 const requestStates=requestStatesSchema.parse(input.currentRequestStates);
 const current=z.array(pin).parse(input.currentDocuments),checkpoints=z.array(checkpointRow).parse(input.payrollCheckpoints);
 const documents=review.documents.filter(d=>d.kind==='contract'||d.kind==='payslip');
 for(const d of documents){
  const pinned=journal.documents.filter(p=>(p.id===d.document_id||p.version_id===d.document_id)&&p.version_id===d.version_id&&p.sha256===d.file_sha256);
  if(d.case_id!==caseId||pinned.length!==1||current.filter(p=>same(p,pinned[0])).length!==1)throw Error('SAVED_OBLIGATION_PAYMENT_CURRENT_SOURCE');
 }
 const payrollSources=checkpoints.flatMap(row=>{
  const d=documents.find(d=>d.kind==='payslip'&&d.version_id===row.version_id),p=journal.documents.find(p=>p.id===row.product_document_id&&p.version_id===row.version_id);
  if(!d||!p)return [];
  const result=row.result;
  if(row.policy_version!==SAVED_EXTRACTION_POLICY||row.input_sha256!==d.file_sha256||p.sha256!==d.file_sha256||result.case_id!==caseId
   ||result.version_id!==row.version_id||result.product_document_id!==p.id||result.input_sha256!==p.sha256||result.expected_month!==selectedMonth
   ||row.result_sha256!==result.result_sha256||canonicalSha256(result.run.result)!==row.result_sha256)throw Error('SAVED_OBLIGATION_PAYMENT_CHECKPOINT');
  return [{version_id:row.version_id,product_document_id:p.id,checkpoint_sha256:row.result_sha256,policy_version:row.policy_version}];
 });
 if(new Set(payrollSources.map(s=>s.version_id)).size!==payrollSources.length)throw Error('SAVED_OBLIGATION_PAYMENT_CHECKPOINT_AMBIGUOUS');
 const evidence=review.entitlement_composition?.evidence.obligations??review.entitlement_evidence?.obligations;
 const obligations=evidence?obligationsEntitlementInputSchema.parse(evidence).obligations:[];
 const groups=obligations.filter(o=>review.purchased_scope.topics.includes(o.topic)).map(obligation=>({obligationId:obligation.obligation_id,
  candidates:obligation.clause.source.reading==='identified_document_reading'?obligationPaymentLinkTargets({review,obligation,payrollSources}):[]}));
 const currentDependencies=(journal.answers??[]).flatMap(raw=>{
  if(typeof raw.code!=='string'||!raw.code.startsWith('document_field:')||!raw.field_target||typeof raw.field_target!=='object'
   ||!('version_id'in raw.field_target)||!('schema_version'in raw.field_target)
   ||['obligation-payment-link-v1','obligation-payment-choice-v1'].includes(String(raw.field_target.schema_version)))return [];
  const target=raw.field_target;
  if(!documents.some(d=>d.version_id===target.version_id))return [];
  const a=z.object({id:z.uuid(),case_id:z.uuid(),answer_revision:z.number().int().positive(),answer:z.string(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true})}).parse(raw);
  if(a.case_id!==caseId)throw Error('SAVED_OBLIGATION_PAYMENT_DEPENDENCY_CASE');
  return [obligationReadingDependencySchema.parse({version_id:target.version_id,request_id:a.id,answer_revision:a.answer_revision,answer_sha256:canonicalSha256(a.answer)})];
 }).sort((a,b)=>a.request_id.localeCompare(b.request_id));
 if(new Set(currentDependencies.map(d=>d.request_id)).size!==currentDependencies.length)throw Error('SAVED_REQUEST_ID_AMBIGUOUS');
 const pairDependencies=(dependencies:readonly z.infer<typeof obligationReadingDependencySchema>[],pair:{version_id:string;clause:{source:{version_id:string}}})=>dependencies.filter(d=>d.version_id===pair.version_id||d.version_id===pair.clause.source.version_id).sort((a,b)=>a.request_id.localeCompare(b.request_id));
 const readings:ObligationPaymentLinkReading[]=[],history:History[]=[],seen=new Set<string>(),answered=new Set<string>();
 for(const raw of journal.answers??[]){
  if(!raw.field_target||typeof raw.field_target!=='object'||!('schema_version'in raw.field_target)
   ||!['obligation-payment-link-v1','obligation-payment-choice-v1'].includes(String(raw.field_target.schema_version)))continue;
  const a=answerRow.parse(raw),target=a.field_target,answer=validateDocumentObligationPaymentLinkAnswer(target,a.answer);
  if(a.case_id!==caseId||target.case_id!==caseId)throw Error('SAVED_OBLIGATION_PAYMENT_ANSWER_CASE');
  if(a.scope_month!==target.month||a.code!==`document_field:${target.target_sha256}`)throw Error('SAVED_OBLIGATION_PAYMENT_ANSWER_TARGET');
  if(seen.has(a.id))throw Error('SAVED_REQUEST_ID_AMBIGUOUS');seen.add(a.id);
  const requestState=target.schema_version==='obligation-payment-choice-v1'?requestStates.find(s=>s.request_id===a.id):undefined;
  if(target.schema_version==='obligation-payment-choice-v1'&&(!requestState||requestState.target_sha256!==target.target_sha256))throw Error('SAVED_OBLIGATION_PAYMENT_REQUEST_STATE_REQUIRED');
  let isCurrent=false;
  // Unbound historical pair requests stay readable history. Only the new
  // purchase-bound wrapper can authorize a relationship in this order.
  if(target.schema_version==='obligation-payment-choice-v1'&&requestState?.current===true&&target.month===selectedMonth
   &&target.order_id===review.purchased_scope.order_id&&target.order_origin===review.purchased_scope.origin&&target.order_receipt_sha256===review.purchased_scope.receipt_sha256
   &&same(target.purchased_topics,review.purchased_scope.topics)){
   const group=groups.find(g=>g.obligationId===target.candidates[0].obligation_id);
   if(answer.action==='correct'){
    const selected=selectedObligationPaymentTarget(target,answer.candidate_target_sha256),fresh=group?.candidates.find(t=>t.target_sha256===selected.target_sha256);
    if(fresh&&same(pairDependencies(target.reading_dependencies,selected),pairDependencies(currentDependencies,fresh))){
     const replay=resolveObligationPaymentLinkReading({target:selected,currentTarget:fresh,caseId,requestId:a.id,answerRevision:a.answer_revision,
      identityId:a.answer_identity_id,answeredAt:a.answer_created_at,answer:{action:'correct',value:answer.value}});
     if(replay.state==='current'){readings.push(replay.reading);isCurrent=true;answered.add(group!.obligationId);}
    }
   }else{
    // Unknown/unreadable belongs to the clause question, not an invented row.
    // Require a surviving current clause+row candidate; retain only history.
    isCurrent=!!group?.candidates.some(fresh=>target.candidates.some(old=>old.target_sha256===fresh.target_sha256
     &&same(pairDependencies(target.reading_dependencies,old),pairDependencies(currentDependencies,fresh))));
    if(isCurrent)answered.add(group!.obligationId);
   }
  }
  history.push({request_id:a.id,answer_revision:a.answer_revision,target_sha256:target.target_sha256,current:isCurrent,action:answer.action});
 }
 const dependencies=groups.map(group=>({obligationId:group.obligationId,answered:answered.has(group.obligationId),
  target:group.candidates.length>0&&group.candidates.length<=16?createObligationPaymentChoiceTarget(group.candidates,review.purchased_scope,
   currentDependencies.filter(d=>group.candidates.some(p=>p.version_id===d.version_id||p.clause.source.version_id===d.version_id))):null,
  reason:group.candidates.length===0?'identified_payroll_row_required' as const:group.candidates.length>16?'payroll_candidate_scope_required' as const:null}));
 return deepFreeze({readings,history,dependencies});
}
export type SavedObligationPaymentLinks=ReturnType<typeof savedObligationPaymentLinks>;

/** One locked source revision and current purchase. Named statements preserve
 * the production prepared-statement protocol across callers and retries. */
export async function readSavedObligationPaymentLinks(context:PostgresTransactionContext,job:SourceJob,selectedMonth:string,review:DocumentReviewInput){
 month.parse(selectedMonth);await lockCurrentSource(context,job);
 const [order]=await readSavedOrders(context,job,review.purchased_scope.order_id);
 if(!order||!purchasedMonths(order).includes(selectedMonth)||savedOrderOrigin(order)!==review.purchased_scope.origin
  ||savedOrderReceiptSha256(order)!==review.purchased_scope.receipt_sha256||!same(order.topics,review.purchased_scope.topics))throw Error('SAVED_OBLIGATION_PAYMENT_PURCHASE');
 const rows=await context.client.query(statement('saved_obligation_payment_journal',
  `select v.input,v.input_sha256,encode(sha256(convert_to(v.input::text,'UTF8')),'hex') actual_sha256,
   private.obligation_payment_request_states(v.case_id) current_obligation_requests,
   coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'version_id',d.version_id,'sha256',d.content_sha256,'type',d.document_type))
    from public.documents d where d.case_id=v.case_id),'[]'::jsonb) current_documents,
   coalesce((select jsonb_agg(jsonb_build_object('product_document_id',d.id,'version_id',c.version_id,'input_sha256',c.input_sha256,
    'policy_version',c.policy_version,'result_sha256',c.result_sha256,'result',c.result))
    from private.case_extraction_checkpoints c join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id
    where c.case_id=v.case_id and c.revision=v.revision and c.policy_version=$4
     and exists(select 1 from jsonb_array_elements(v.input->'documents') p where p->>'id'=d.id::text and p->>'version_id'=d.version_id::text
      and p->>'sha256'=d.content_sha256)),'[]'::jsonb) payroll_checkpoints
   from private.case_input_versions v where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3
    and session_user='tivdoc_worker_runtime' and private.runtime_verified_tenant()='saved-case:'||v.case_id::text`,
  [job.case_id,job.revision,job.input_sha256,SAVED_EXTRACTION_POLICY]));
 const row=rows.rows[0];
 if(rows.row_count!==1||!row||row.input_sha256!==job.input_sha256||row.actual_sha256!==job.input_sha256)throw Error('SAVED_INPUT_HASH_MISMATCH');
 return savedObligationPaymentLinks({caseId:job.case_id,month:selectedMonth,review,journal:row.input,currentDocuments:row.current_documents,payrollCheckpoints:row.payroll_checkpoints,currentRequestStates:row.current_obligation_requests});
}

/** Attach authenticated current readings only. The ordinary entitlement
 * composer applies them once and keeps legal allocation assessment separate. */
export function attachSavedObligationPaymentLinks(review:DocumentReviewInput,saved:SavedObligationPaymentLinks){
 return documentReviewInputSchema.parse({...review,obligation_payment_link_readings:saved.readings});
}

export async function openSavedObligationPaymentLinkRequests(context:PostgresTransactionContext,job:SourceJob,selectedMonth:string,review:DocumentReviewInput){
 const saved=await readSavedObligationPaymentLinks(context,job,selectedMonth,review),opened=[];
 for(const dependency of saved.dependencies){
  if(dependency.answered||!dependency.target)continue;
  const target=dependency.target;
  const row=await context.client.query(statement('saved_obligation_payment_open','select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),documentObligationPaymentLinkQuestion(target).question]));
  if(row.row_count!==1)throw Error('SAVED_OBLIGATION_PAYMENT_REQUEST_ACK');
  const requestId=z.uuid().nullable().parse(row.rows[0]?.id);if(requestId)opened.push({requestId,month:selectedMonth,obligationId:dependency.obligationId,targetSha256:target.target_sha256});
 }
 return opened;
}
