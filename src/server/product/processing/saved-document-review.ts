import {attachAutomaticNonPayslipEvidence} from '@/engine/entitlement-review/automatic-nonpay';
import {openSavedDocumentEvidenceRequests} from './saved-document-evidence-requests';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {attachNonPayslipInventory} from '@/engine/document-review/non-payslip';
import {attachAutomaticPayrollEvidence} from '@/engine/entitlement-review/automatic-payroll';
import {attachAutomaticBenefitsEvidence} from '@/engine/entitlement-review/automatic-benefits';
import {attachAutomaticPensionEvidence} from '@/engine/entitlement-review/automatic-pension';
import {composeEntitlementReview} from '@/engine/entitlement-review/compose';
import {enableTypedEntitlementPersonalFacts} from '@/engine/entitlement-review/typed-product-facts';
import {enableSharedPersonalFacts} from '@/engine/entitlement-review/shared-product-facts';
import {savedReviewSourceEvidence} from './saved-review-source-proof';
import {z} from 'zod';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,DOCUMENT_REVIEW_POLICY,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {attachDocumentReviewCoverage} from '@/engine/document-review/coverage';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {readSavedReviewAnswers} from './saved-review-requests';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from './source-dispatch';
import {readSavedOrders,purchasedMonths,savedOrderOrigin,savedOrderReceiptSha256,type SavedExecutionOrder} from './saved-order-scope';
import {admitSavedSource} from './saved-admission';
import {enhanceDocumentReviewNightEntitlements,isPinnedNightEntitlementLegalDocument,type NightEntitlementSelection} from '@/engine/document-review/night-entitlement-adapter';

const policy=(order:string,month:string)=>`${DOCUMENT_REVIEW_POLICY}:${order}:${month}`;
export const savedDocumentReviewRefSchema=z.object({schema_version:z.literal('document-review-source-ref-v1'),order_id:z.uuid(),
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),review_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const sourceAdmissionSchema=z.object({source_job:sourceJobSchema,review_ref:savedDocumentReviewRefSchema,changed:z.boolean()}).strict();
async function verify(context:PostgresTransactionContext,job:SourceJob,input:DocumentReviewInput,order:SavedExecutionOrder,month:string){
 if(input.entitlement_declarations)throw Error('SAVED_REVIEW_DECLARATION_JOURNAL_REQUIRED');
 if(input.case_id!==job.case_id||input.purchased_scope.origin!==savedOrderOrigin(order)||input.purchased_scope.order_id!==order.id
  ||input.purchased_scope.receipt_sha256!==savedOrderReceiptSha256(order)||canonicalSha256(input.purchased_scope.topics)!==canonicalSha256(order.topics)
  ||input.period.from!==month+'-01'||input.period.to!==new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10))throw Error('SAVED_REVIEW_ORDER_SCOPE');
 const rows=await context.client.query(statement('review_pinned_sources',
  `select d.id::text,d.version_id::text,d.content_sha256 from private.case_input_versions v
   cross join lateral jsonb_array_elements(v.input->'documents') p
   join public.documents d on d.case_id=v.case_id and d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d.content_sha256=p->>'sha256'`,[job.case_id,job.revision,job.input_sha256]));
 for(const document of input.documents){
  if(isPinnedNightEntitlementLegalDocument(document,job.case_id))continue;
  if(!rows.rows.some(r=>(r.id===document.document_id||r.version_id===document.document_id)&&r.version_id===document.version_id&&r.content_sha256===document.file_sha256))throw Error('SAVED_REVIEW_SOURCE_SCOPE');
 }
 // Parse and verify each operation, every operand and completion before a
 // source review can be checkpointed. This does not admit any legal rule.
 runDocumentReview(composeEntitlementReview(input),'source-review-validation');
}

/** Internal worker adapter for normalized/reviewed attendance, contract and
 * payslip evidence. No browser-controlled payload or service-role bypass.
 * Source revisions are admitted append-only and captured in a NEW case input.
 * The returned source_job must be scheduled/claimed before analysis: the old
 * job is intentionally stale after a changed source review. */
export async function saveSavedDocumentReview(context:PostgresTransactionContext,job:SourceJob,candidate:unknown,nightSelections:readonly NightEntitlementSelection[]=[]){
 await admitSavedSource(context,job);
 const input=enhanceDocumentReviewNightEntitlements(documentReviewInputSchema.parse(candidate),nightSelections),month=input.period.from.slice(0,7);
 // This checkpoint records source readings. Identified answers enter only from
 // the append-only authenticated answer journal, below, never a caller receipt.
 if(input.entitlement_declarations||input.answer_history.length||input.documents.some(d=>d.reading_origin==='identified_document_reading'))throw Error('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
 const [order]=await readSavedOrders(context,job,input.purchased_scope.order_id);
 await verify(context,job,input,order,month);
 const sha=canonicalSha256(input);
 const result=await context.client.query(statement('review_source_admit',
  `select private.document_review_source_admit($1::uuid,$2,$3,$4::uuid,$5::date,$6,$7::jsonb,$8) admission`,
  [job.case_id,job.revision,job.input_sha256,order.id,month+'-01',sha,JSON.stringify(input),job.authority_dependency_sha256??null]));
 if(result.row_count!==1)throw Error('SAVED_REVIEW_ADMISSION_REQUIRED');
 const admitted=sourceAdmissionSchema.parse(result.rows[0].admission);
 if(admitted.source_job.case_id!==job.case_id||admitted.source_job.mode!==job.mode||admitted.source_job.revision<job.revision
  ||admitted.review_ref.order_id!==order.id||admitted.review_ref.month!==month||admitted.review_ref.review_sha256!==sha
  ||admitted.changed!==(admitted.source_job.revision!==job.revision)
  ||!admitted.changed&&canonicalSha256(admitted.source_job)!==canonicalSha256(job))throw Error('SAVED_REVIEW_ADMISSION_BINDING');
 // Re-read the journal through the newly captured immutable reference. Never
 // accept a caller result or a mutable latest checkpoint as the source input.
 const saved=await load(context,admitted.source_job,order,month);
 if(!saved||canonicalSha256(saved)!==sha)throw Error('SAVED_REVIEW_IMMUTABLE');
 return {input:saved,...admitted};
}
async function load(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,pinnedOnly=false){
 const pinned=await context.client.query(statement('review_source_read',
  `select private.document_review_source_read($1::uuid,$2,$3,$4::uuid,$5::date,$6) source`,
  [job.case_id,job.revision,job.input_sha256,order.id,month+'-01',job.authority_dependency_sha256??null]));
 if(pinned.row_count!==1)throw Error('SAVED_REVIEW_SOURCE_REF_REQUIRED');
 const source=z.discriminatedUnion('state',[
  z.object({state:z.literal('pinned'),review_ref:savedDocumentReviewRefSchema,input:z.unknown()}).strict(),
  z.object({state:z.literal('legacy')}).strict(),z.object({state:z.literal('invalidated')}).strict(),
 ]).parse(pinned.rows[0].source);
 if(source.state==='invalidated')return null;
 if(source.state==='pinned'){
  const input=documentReviewInputSchema.parse(source.input);
  if(source.review_ref.order_id!==order.id||source.review_ref.month!==month||canonicalSha256(input)!==source.review_ref.review_sha256)throw Error('SAVED_REVIEW_HASH');
  if(input.answer_history.length||input.documents.some(d=>d.reading_origin==='identified_document_reading'))throw Error('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
  await verify(context,job,input,order,month);return input;
 }
 if(pinnedOnly)return null;
 // Compatibility only for source inputs that predate the revision journal.
 // The RPC refuses this fallback once this order/month has a journal head.
 const rows=await context.client.query(statement('review_checkpoint_read',
  `select c.result,c.result_sha256 from private.case_extraction_checkpoints c
   join private.case_input_versions old on old.case_id=c.case_id and old.revision=c.revision
   join private.case_input_versions current on current.case_id=c.case_id and current.revision=$2 and current.input_sha256=$4
   where c.case_id=$1::uuid and c.revision<=$2 and c.policy_version=$3
    and (old.input-'answers')=(current.input-'answers')
   order by c.revision desc limit 2`,
  [job.case_id,job.revision,policy(order.id,month),job.input_sha256]));
 if(rows.row_count===0)return null;
 if(rows.row_count>1&&rows.rows[0].result_sha256!==rows.rows[1].result_sha256)throw Error('SAVED_REVIEW_AMBIGUOUS');
 const row=rows.rows[0],input=documentReviewInputSchema.parse(row.result);
 if(canonicalSha256(input)!==row.result_sha256)throw Error('SAVED_REVIEW_HASH');
 if(input.answer_history.length)throw Error('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
 await verify(context,job,input,order,month);return input;
}
export type SavedDocumentReviewSourceScope=Readonly<{orderId:string;reviewSha256:string;sourceVersionIds:readonly string[]}>;
/** Only the authenticated immutable journal path can replace an OCR snapshot.
 * A historical checkpoint fallback remains readable but never grants this scope. */
export async function savedDocumentReviewSourceScope(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string):Promise<SavedDocumentReviewSourceScope|undefined>{
 await lockCurrentSource(context,job);
 const [currentOrder]=await readSavedOrders(context,job,order.id);
 if(!purchasedMonths(currentOrder).includes(month)||canonicalSha256(currentOrder)!==canonicalSha256(order))throw Error('SAVED_REVIEW_ORDER_SCOPE');
 const source=await load(context,job,currentOrder,month,true);
 if(!source)return undefined;
 return {orderId:order.id,reviewSha256:canonicalSha256(source),sourceVersionIds:[...new Set(source.documents
  .filter(d=>!isPinnedNightEntitlementLegalDocument(d,job.case_id)).map(d=>d.version_id))].sort()};
}
export async function assertSavedDocumentReviewSourceScope(context:PostgresTransactionContext,job:SourceJob,month:string,scope:SavedDocumentReviewSourceScope){
 const [order]=await readSavedOrders(context,job,scope.orderId);
 const current=await savedDocumentReviewSourceScope(context,job,order,month);
 if(!current||canonicalSha256(current)!==canonicalSha256(scope))throw Error('SAVED_REVIEW_SOURCE_REF_CHANGED');
}

async function sourceReviewInput(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,snapshot:StoredCaseInputSnapshot,automaticOnly=false){
 await lockCurrentSource(context,job);
 const prior=automaticOnly?null:await load(context,job,order,month);if(prior)return prior;
 if(snapshot.documents.length===0){
  const rows=await context.client.query(statement('review_source_inventory',
   `select d.id::text,d.version_id::text,d.document_type,d.content_sha256 from private.case_input_versions v
    cross join lateral jsonb_array_elements(v.input->'documents') p
    join public.documents d on d.case_id=v.case_id and d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid
    where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d.content_sha256=p->>'sha256'`,[job.case_id,job.revision,job.input_sha256]));
  if(!rows.row_count)throw Error('SAVED_REVIEW_DOCUMENT_REQUIRED');
  const period={from:month+'-01',to:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)};
  const documents=rows.rows.map((d,index)=>({case_id:job.case_id,document_id:String(d.id),version_id:String(d.version_id),file_sha256:String(d.content_sha256),page_count:null,
   kind:['contract','attendance','payslip','transfer'].includes(String(d.document_type))?d.document_type:'other',label:`מסמך שהועלה ${index+1}`,period:null,
   reading_origin:'source_inventory',reading_sha256:job.input_sha256}));
  return documentReviewInputSchema.parse({schema_version:DOCUMENT_REVIEW_POLICY,case_id:job.case_id,period,
   purchased_scope:{order_id:order.id,receipt_sha256:savedOrderReceiptSha256(order),topics:[...order.topics],origin:savedOrderOrigin(order)},documents,checks:[],
   coverage_gaps:order.topics.map(topic=>({check_id:`missing.payslip.${topic}`,topic,kind:'missing_source',detail:'אין תלוש כספי לתקופה שנרכשה. המסמכים שהועלו נשמרו.',next_step:'יש להעלות תלוש כספי מלא של התקופה; אין צורך להעלות שוב את המסמכים הקיימים.'})),
   completion_input:{case_id:job.case_id,period,documents:documents.map(d=>({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'not_reviewed',period:null})),evidence:[],
    needs:[{fact_key:'payslip.financial_source',kind:'document',reason:'missing',required_evidence_kind:'document',question:`נא להעלות תלוש לחודש ${month}. נדרשים חודש התלוש, ברוטו, סך הניכויים ונטו. המסמכים שכבר הועלו נשמרו.`,answer_kind:'document',document_kind:'payslip',source_pins:[],dependent_check_ids:order.topics.map(topic=>`missing.payslip.${topic}`),general_question:false}]}});
 }
 const evidence=await savedReviewSourceEvidence(context,job,snapshot);
 return withSavedPurchaseCoverage(reviewInputFromPayslips({case_id:job.case_id,period:{from:month+'-01',to:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)},
  purchased_scope:{order_id:order.id,receipt_sha256:savedOrderReceiptSha256(order),topics:[...order.topics],origin:savedOrderOrigin(order)},snapshot,
  financial_source_proofs:evidence.proofs,retained_unresolved_fields:evidence.retained,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY}),order);
}

export function withSavedPurchaseCoverage(input:DocumentReviewInput,order:SavedExecutionOrder){
 // Legacy receipts record source-observed months, not a purchase-period field.
 // They retain all nine topics; a monthly execution must not invent that field.
 const recordedEnd=new Date(Date.UTC(Number(order.to.slice(0,4)),Number(order.to.slice(5,7)),0)).toISOString().slice(0,10);
 return attachDocumentReviewCoverage(input,{schema_version:'document-review-purchase-period-v1',receipt_sha256:savedOrderReceiptSha256(order),
  state:order.kind==='legacy_initial'?'missing':'recorded',periods:order.kind==='legacy_initial'?[]:[{from:order.from,to:recordedEnd}]});
}

export async function savedDocumentReviewInput(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,snapshot:StoredCaseInputSnapshot,automaticOnly=false){
 let input=composeEntitlementReview((await automaticDocumentReview(context,job,order,month,snapshot,automaticOnly)).input);
 if(!snapshot.has_document_review_answers)return input;
 const history=await readSavedReviewAnswers(context,job);
 for(const row of history){
  // Old or foreign-month targets remain in history but cannot affect this run.
  if(!row.source_current||canonicalSha256(row.request.target.period)!==canonicalSha256(input.period))continue;
  for(const answer of row.answers){
   const next=applyDocumentReviewAnswer(input,{request:row.request,...answer});
   if(next.resolution.state==='stale')break;
   input=next.input;
  }
 }
 return input;
}

async function automaticDocumentReview(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,snapshot:StoredCaseInputSnapshot,automaticOnly=false){
 const sources=attachNonPayslipInventory(await sourceReviewInput(context,job,order,month,snapshot,automaticOnly),snapshot);
 const payroll=attachAutomaticBenefitsEvidence(attachAutomaticPayrollEvidence(attachAutomaticPensionEvidence(sources,snapshot),snapshot),snapshot);
 const prepared=attachAutomaticNonPayslipEvidence(payroll,snapshot);
 // This new profile owns its command hash. Historical packets and previously
 // generated answer targets retain their original shape and reading rules.
 if(automaticOnly&&prepared.input.entitlement_evidence)return {...prepared,input:documentReviewInputSchema.parse({...prepared.input,
  entitlement_evidence:enableSharedPersonalFacts(enableTypedEntitlementPersonalFacts(prepared.input.entitlement_evidence))})};
 return prepared;
}
/** Open only source cells used by this purchased month's actual branch mapping.
 * Recomputes from authenticated snapshots; no client list can authorize a cell. */
export async function openSavedNonPayslipReviewRequests(context:PostgresTransactionContext,job:SourceJob,order:SavedExecutionOrder,month:string,snapshot:StoredCaseInputSnapshot,automaticOnly=false){
 if(!snapshot.non_payslip_evidence?.some(e=>e.extraction))return [];
 const prepared=await automaticDocumentReview(context,job,order,month,snapshot,automaticOnly);
 const opened=[];
 for(const dependency of prepared.reading_dependencies){
  const rows=await context.client.query(statement('review_nonpay_dependency_checkpoint',
   'select result from private.case_extraction_checkpoints where case_id=$1::uuid and revision=$2 and version_id=$3::uuid and policy_version=$4 and result_sha256=$5',
   [job.case_id,job.revision,dependency.version_id,DOCUMENT_EVIDENCE_POLICY,dependency.checkpoint_sha256]));
  if(rows.row_count!==1)throw Error('DOCUMENT_EVIDENCE_READING_SOURCE_CHANGED');
  opened.push(await openSavedDocumentEvidenceRequests(context,job,rows.rows[0].result,{month,observationIds:dependency.observation_ids}));
 }
 return opened;
}
