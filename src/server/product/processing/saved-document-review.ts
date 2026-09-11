import {z} from 'zod';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,DOCUMENT_REVIEW_POLICY,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {reviewInputFromPayslips} from '@/engine/document-review/payslip-adapter';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {readSavedReviewAnswers} from './saved-review-requests';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,type SourceJob} from './source-dispatch';
import {readSavedOrders,type SavedOrderScope} from './saved-order-scope';
import {admitSavedSource} from './saved-admission';

const policy=(order:string,month:string)=>`${DOCUMENT_REVIEW_POLICY}:${order}:${month}`;
async function verify(context:PostgresTransactionContext,job:SourceJob,input:DocumentReviewInput,order:SavedOrderScope,month:string){
 if(input.case_id!==job.case_id||input.purchased_scope.origin!=='saved_order'||input.purchased_scope.order_id!==order.id
  ||input.purchased_scope.receipt_sha256!==order.offer_sha256||canonicalSha256(input.purchased_scope.topics)!==canonicalSha256(order.topics)
  ||input.period.from!==month+'-01'||input.period.to!==new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10))throw Error('SAVED_REVIEW_ORDER_SCOPE');
 const rows=await context.client.query(statement('review_pinned_sources',
  `select d.id::text,d.version_id::text,d.content_sha256 from private.case_input_versions v
   cross join lateral jsonb_array_elements(v.input->'documents') p
   join public.documents d on d.case_id=v.case_id and d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d.content_sha256=p->>'sha256'`,[job.case_id,job.revision,job.input_sha256]));
 for(const document of input.documents){
  if(!rows.rows.some(r=>(r.id===document.document_id||r.version_id===document.document_id)&&r.version_id===document.version_id&&r.content_sha256===document.file_sha256))throw Error('SAVED_REVIEW_SOURCE_SCOPE');
 }
 // Parse and verify each operation, every operand and completion before a
 // source review can be checkpointed. This does not admit any legal rule.
 runDocumentReview(input,'source-review-validation');
}

/** Internal worker adapter for normalized/reviewed attendance, contract and
 * payslip evidence. No browser-controlled payload or service-role bypass.
 * Uses the existing append-only extraction checkpoint journal. */
export async function saveSavedDocumentReview(context:PostgresTransactionContext,job:SourceJob,candidate:unknown){
 await admitSavedSource(context,job);
 const input=documentReviewInputSchema.parse(candidate),month=input.period.from.slice(0,7);
 // This checkpoint records source readings. Identified answers enter only from
 // the append-only authenticated answer journal, below, never a caller receipt.
 if(input.answer_history.length||input.documents.some(d=>d.reading_origin==='identified_document_reading'))throw Error('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
 const [order]=await readSavedOrders(context,job,input.purchased_scope.order_id);
 await verify(context,job,input,order,month);
 const anchor=input.documents[0];z.uuid().parse(anchor.version_id);
 const sha=canonicalSha256(input);
 await context.client.query(statement('review_checkpoint_insert',
  `insert into private.case_extraction_checkpoints(case_id,revision,version_id,input_sha256,policy_version,result_sha256,result)
   values($1::uuid,$2,$3::uuid,$4,$5,$6,$7::jsonb) on conflict(case_id,revision,version_id,policy_version) do nothing`,
  [job.case_id,job.revision,anchor.version_id,anchor.file_sha256,policy(order.id,month),sha,JSON.stringify(input)]));
 const saved=await load(context,job,order,month);
 if(!saved||canonicalSha256(saved)!==sha)throw Error('SAVED_REVIEW_IMMUTABLE');
 return saved;
}
async function load(context:PostgresTransactionContext,job:SourceJob,order:SavedOrderScope,month:string){
 const rows=await context.client.query(statement('review_checkpoint_read',
  `select c.result,c.result_sha256 from private.case_extraction_checkpoints c
   join private.case_input_versions old on old.case_id=c.case_id and old.revision=c.revision
   join private.case_input_versions current on current.case_id=c.case_id and current.revision=$2
   where c.case_id=$1::uuid and c.revision<=$2 and c.policy_version=$3
    and (old.input-'answers')=(current.input-'answers')
   order by c.revision desc limit 2`,
  [job.case_id,job.revision,policy(order.id,month)]));
 if(rows.row_count===0)return null;
 if(rows.row_count>1&&rows.rows[0].result_sha256!==rows.rows[1].result_sha256)throw Error('SAVED_REVIEW_AMBIGUOUS');
 const row=rows.rows[0],input=documentReviewInputSchema.parse(row.result);
 if(canonicalSha256(input)!==row.result_sha256)throw Error('SAVED_REVIEW_HASH');
 if(input.answer_history.length)throw Error('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
 await verify(context,job,input,order,month);return input;
}
async function sourceReviewInput(context:PostgresTransactionContext,job:SourceJob,order:SavedOrderScope,month:string,snapshot:StoredCaseInputSnapshot){
 await lockCurrentSource(context,job);
 const prior=await load(context,job,order,month);if(prior)return prior;
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
   purchased_scope:{order_id:order.id,receipt_sha256:order.offer_sha256,topics:order.topics,origin:'saved_order'},documents,checks:[],
   coverage_gaps:order.topics.map(topic=>({check_id:`missing.payslip.${topic}`,topic,kind:'missing_source',detail:'אין תלוש כספי לתקופה שנרכשה. המסמכים שהועלו נשמרו.',next_step:'יש להעלות תלוש כספי מלא של התקופה; אין צורך להעלות שוב את המסמכים הקיימים.'})),
   completion_input:{case_id:job.case_id,period,documents:documents.map(d=>({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'not_reviewed',period:null})),evidence:[],
    needs:[{fact_key:'payslip.full',kind:'document',reason:'missing',required_evidence_kind:'document',question:`נא להעלות תלוש כספי מלא לחודש ${month}. המסמכים שכבר הועלו נשמרו.`,answer_kind:'document',document_kind:'payslip',source_pins:[],dependent_check_ids:order.topics.map(topic=>`missing.payslip.${topic}`),general_question:false}]}});
 }
 return reviewInputFromPayslips({case_id:job.case_id,period:{from:month+'-01',to:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)},
  purchased_scope:{order_id:order.id,receipt_sha256:order.offer_sha256,topics:order.topics,origin:'saved_order'},snapshot});
}

export async function savedDocumentReviewInput(context:PostgresTransactionContext,job:SourceJob,order:SavedOrderScope,month:string,snapshot:StoredCaseInputSnapshot){
 let input=await sourceReviewInput(context,job,order,month,snapshot);
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
