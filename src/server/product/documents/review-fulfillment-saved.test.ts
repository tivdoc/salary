import {beforeEach,expect,it,vi} from 'vitest';
import {generateReviewCompletions} from '@/engine/document-review/completions';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {assessReviewUpload,buildReviewUploadReceipt} from './review-fulfillment';
import {assessSavedReviewUploads} from './review-fulfillment-saved';
import type {SourceJob} from '../processing/source-dispatch';
const ports=vi.hoisted(()=>({lock:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../processing/source-dispatch',async load=>({...await load<typeof import('../processing/source-dispatch')>(),lockCurrentSource:ports.lock}));
beforeEach(()=>vi.resetAllMocks());
const caseId='11111111-1111-4111-8111-111111111111',orderId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333';
const documentId='44444444-4444-4444-8444-444444444444',versionId='55555555-5555-4555-8555-555555555555',batchId='66666666-6666-4666-8666-666666666666';
function fixture(){
 const period={from:'2026-06-01',to:'2026-06-30'},pin={case_id:caseId,document_id:documentId,version_id:versionId,source_sha256:'a'.repeat(64)};
 const request=generateReviewCompletions({case_id:caseId,period,documents:[],evidence:[],needs:[{fact_key:'payroll.complete',kind:'document',document_kind:'payslip',reason:'missing',
  required_evidence_kind:'document',question:'נא להעלות את התלוש המלא לחודש יוני.',answer_kind:'document',source_pins:[],dependent_check_ids:['payroll.reading'],general_question:false}]}).customer_requests[0];
 const scope={request_id:requestId,request,order_id:orderId,order_origin:'saved_order' as const,order_receipt_sha256:'b'.repeat(64)};
 const receipt=buildReviewUploadReceipt({scope,case_id:caseId,batch_id:batchId,received_at:'2026-09-11T18:00:00Z',existing_source_hashes:[],
  files:[{document_id:documentId,version_id:versionId,source_sha256:pin.source_sha256,document_kind:'payslip',period_month:'2026-06',duplicate_content:false}]});
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:orderId,receipt_sha256:scope.order_receipt_sha256,topics:['minimum_wage'],origin:'saved_order'},checks:[],
  coverage_gaps:[{check_id:'payroll.reading',topic:'minimum_wage',kind:'missing_rule',detail:'קריאת המסמך נבדקה; לא נטען כאן לחוב משפטי.',next_step:'בדיקת הדין נפרדת.'}],
  documents:[{case_id:caseId,document_id:documentId,version_id:versionId,file_sha256:pin.source_sha256,page_count:1,kind:'payslip',label:'תלוש סינתטי',period,reading_origin:'ai_document_review',reading_sha256:'c'.repeat(64)}],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'payslip',period,review:'complete'}],needs:[],
   evidence:[{evidence_id:'synthetic.observation',case_id:caseId,fact_key:'payroll.complete',period,origin:'document',state:'observed',value:'המסמך המלא נקרא',source_pins:[pin],source_reviewed:true}]}});
 const review=runDocumentReview(input,'synthetic-assessment-run'),item={scope,receipt},expected=assessReviewUpload({...item,review,current_source_pins:[pin]});
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:9,input_sha256:'d'.repeat(64),mode:'draft',authority_dependency_sha256:'e'.repeat(64)};
 const state={value:{review,current_source_pins:[pin],items:[item]},persisted:expected as unknown,queries:[] as PostgresStatement[]};
 const context:PostgresTransactionContext={transaction_id:'synthetic-assessment-transaction',client:{async query(query){
  state.queries.push(query);
  if(query.name==='review_upload_assessment_inputs')return {rows:[{value:state.value}],row_count:1};
  if(query.name==='review_upload_assess')return {rows:[{value:state.persisted}],row_count:1};
  throw Error('UNEXPECTED_SQL');
 }}};
 return {state,context,job,expected,run:()=>assessSavedReviewUploads(context,job,review.analysis_run_id)};
}
it('assesses actual persisted inputs after the source fence, sending identifiers rather than a client satisfaction flag',async()=>{
 const f=fixture();expect(await f.run()).toEqual([f.expected]);expect(ports.lock).toHaveBeenCalledWith(f.context,f.job);
 expect(f.state.queries.map(q=>q.name)).toEqual(['review_upload_assessment_inputs','review_upload_assess']);
 expect(f.state.queries.at(-1)?.values).toEqual([caseId,9,f.job.input_sha256,batchId,'synthetic-assessment-run',f.job.authority_dependency_sha256]);
 expect(f.state.queries.at(-1)?.text).not.toContain('jsonb');
 expect(await f.run()).toEqual([f.expected]);
});
it('does not persist or touch requests when this saved run has no received documents',async()=>{
 const f=fixture();f.state.value.items=[];expect(await f.run()).toEqual([]);expect(f.state.queries.map(q=>q.name)).toEqual(['review_upload_assessment_inputs']);
});
it('rejects mismatched saved case/run/hash and duplicate request assessments before any write',async()=>{
 for(const mode of ['case','run','duplicate'] as const){
  const f=fixture();
  if(mode==='case')f.state.value.review={...f.state.value.review,case_id:requestId};
  if(mode==='run')f.state.value.review={...f.state.value.review,analysis_run_id:'other'};
  if(mode==='duplicate')f.state.value.items.push(f.state.value.items[0]);
  await expect(f.run()).rejects.toThrow();expect(f.state.queries.map(q=>q.name)).toEqual(['review_upload_assessment_inputs']);
 }
});
it('refuses SQL/Pure assessment disagreement without presenting satisfaction',async()=>{
 const f=fixture();f.state.persisted={...f.expected,information_satisfied:false};await expect(f.run()).rejects.toThrow('ASSESSMENT_MISMATCH');
});
