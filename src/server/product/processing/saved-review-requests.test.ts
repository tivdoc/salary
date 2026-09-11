import {beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {generateReviewCompletions,type ReviewCompletionNeed} from '@/engine/document-review/completions';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {normalizeSavedReviewAnswer,openSavedReviewRequests,readSavedReviewAnswers,savedReviewRequestQuestion} from './saved-review-requests';
import type {SourceJob} from './source-dispatch';

const ports=vi.hoisted(()=>({lock:vi.fn(),orders:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async load=>({...await load<typeof import('./source-dispatch')>(),lockCurrentSource:ports.lock}));
vi.mock('./saved-order-scope',async load=>({...await load<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
beforeEach(()=>vi.resetAllMocks());
const caseId='11111111-1111-4111-8111-111111111111',doc='22222222-2222-4222-8222-222222222222',orderId='33333333-3333-4333-8333-333333333333';
const requestId='44444444-4444-4444-8444-444444444444',actor='55555555-5555-4555-8555-555555555555';
const period={from:'2026-06-01',to:'2026-06-30'},pin={case_id:caseId,document_id:doc,version_id:doc,source_sha256:'a'.repeat(64)};
function fixture(overrides:Partial<ReviewCompletionNeed>={}){
 const need:ReviewCompletionNeed={fact_key:'hours.quantity',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',
  question:'כמה שעות עבודה היו בתקופה המסומנת?',answer_kind:'number',source_pins:[pin],dependent_check_ids:['hours.check'],general_question:false,...overrides};
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:orderId,receipt_sha256:'b'.repeat(64),topics:['working_time'],origin:'saved_order'},
  documents:[{case_id:caseId,document_id:doc,version_id:doc,file_sha256:pin.source_sha256,page_count:1,kind:'payslip',label:'מסמך סינתטי',period,reading_origin:'ai_document_review',reading_sha256:'c'.repeat(64)}],
  checks:[],coverage_gaps:[{check_id:'hours.check',topic:'working_time',kind:'missing_fact',detail:'נדרשת כמות שעות.',next_step:'השלמת הנתון.'}],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'payslip',period,review:'partial'}],needs:[need],evidence:[]}});
}
function setup(input=fixture()){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:3,input_sha256:'d'.repeat(64),mode:'draft',authority_dependency_sha256:'e'.repeat(64)};
 const review=runDocumentReview(input,'synthetic-review-run'),payload={bundle:{document_review:review}};
 const order={id:orderId,kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['working_time'],offer_sha256:'b'.repeat(64)};
 const state:{stage:unknown;stageHash:string;ack:string|null;history:unknown;queries:PostgresStatement[];events:string[]}={stage:payload,stageHash:canonicalSha256(payload),ack:requestId,history:[],queries:[],events:[]};
 const context:PostgresTransactionContext={transaction_id:'synthetic-review-unit',client:{async query(query){
  state.queries.push(query);state.events.push(query.name);
  if(query.name==='review_requests_stage')return {rows:[{payload:state.stage,payload_sha256:state.stageHash}],row_count:1};
  if(query.name==='review_request_answer_history')return {rows:[{value:state.history}],row_count:1};
  if(query.name==='review_request_open')return {rows:[{id:state.ack}],row_count:1};
  throw Error('Unexpected query');
 }}};
 ports.lock.mockImplementation(async()=>{state.events.push('lock');});ports.orders.mockImplementation(async()=>{state.events.push('orders');return [order];});
 return {job,review,order,state,context,run:()=>openSavedReviewRequests(context,job,'synthetic-review-run')};
}

it('opens only independently generated persisted targets after the source fence and exact paid order, with no target payload argument',async()=>{
 const s=setup();expect(await s.run()).toEqual({opened_request_ids:[requestId],skipped_document_targets:[]});
 expect(s.state.events).toEqual(['lock','review_requests_stage','orders','review_request_open']);
 expect(s.state.queries.at(-1)?.values).toEqual([caseId,3,s.job.input_sha256,'synthetic-review-run',s.review.completions.customer_requests[0].target.target_sha256,s.job.authority_dependency_sha256]);
 expect(s.state.queries.at(-1)?.text).not.toContain('jsonb');
});
it('refuses a mismatched stage hash before requesting paid scopes or opening questions',async()=>{
 const s=setup();s.state.stageHash='f'.repeat(64);await expect(s.run()).rejects.toThrow('STAGE_HASH');expect(s.state.events).toEqual(['lock','review_requests_stage']);
});
it('refuses a foreign run or unpurchased period/topic/offer instead of borrowing a paid scope',async()=>{
 for(const kind of ['run','period','topic','offer'] as const){
  const s=setup();
  if(kind==='run'){s.state.stage={bundle:{document_review:runDocumentReview(fixture(),'different-run')}};s.state.stageHash=canonicalSha256(s.state.stage);}
  if(kind==='period')s.order.from=s.order.to='2026-07-01';
  if(kind==='topic')s.order.topics=['pension'];
  if(kind==='offer')s.order.offer_sha256='f'.repeat(64);
  await expect(s.run()).rejects.toThrow(kind==='run'?'STAGE_SCOPE':'ORDER_SCOPE');
  expect(s.state.events).not.toContain('review_request_open');
 }
});
it('preflights the entire question inventory before inserts and never truncates an immutable target',async()=>{
 const f=fixture({question:'ש'.repeat(390)}),s=setup(f);
 await expect(s.run()).rejects.toThrow('QUESTION_LENGTH');expect(s.state.events).not.toContain('review_request_open');
 expect(s.review.completions.customer_requests[0].target.question).toHaveLength(390);
});
it('preserves expired-null acknowledgment and legacy absent dependency without reissuing a question',async()=>{
 const s=setup();s.state.ack=null;delete s.job.authority_dependency_sha256;
 expect(await s.run()).toEqual({opened_request_ids:[],skipped_document_targets:[]});expect(s.state.queries.at(-1)?.values.at(-1)).toBeNull();
});
it('adds a readable unknown-answer instruction; document requests remain upload-only',()=>{
 const document=setup(fixture({kind:'document',document_kind:'attendance',answer_kind:'document',required_evidence_kind:'document'})).review.completions.customer_requests[0].target;
 expect(savedReviewRequestQuestion(document)).toBe(document.question);expect(()=>normalizeSavedReviewAnswer(document,'לא יודע')).toThrow('ANSWER_INVALID');
 expect(savedReviewRequestQuestion(setup().review.completions.customer_requests[0].target)).toContain('אפשר להשיב "לא יודע".');
});
it('keeps a document request in the product review and reports its missing fulfillment binding without opening an unanswerable row',async()=>{
 const s=setup(fixture({kind:'document',document_kind:'attendance',answer_kind:'document',required_evidence_kind:'document'}));
 expect(await s.run()).toEqual({opened_request_ids:[],skipped_document_targets:[{
  target_sha256:s.review.completions.customer_requests[0].target.target_sha256,reason:'verified_upload_fulfillment_not_integrated'}]});
 expect(s.review.completions.customer_requests).toHaveLength(1);expect(s.state.events).not.toContain('review_request_open');
});
it('normalizes only exact typed declarations and never accepts a client receipt or converts unknown to zero',()=>{
 const target=setup().review.completions.customer_requests[0].target;
 expect(normalizeSavedReviewAnswer(target,' 100.25 ')).toEqual({state:'provided',value:100.25});
 expect(normalizeSavedReviewAnswer(target,'0')).toEqual({state:'provided',value:0});
 expect(normalizeSavedReviewAnswer(target,'לא יודע')).toEqual({state:'unknown',value:null});
 expect(normalizeSavedReviewAnswer(target,'יש סתירה')).toEqual({state:'conflicted',value:null});
 for(const bad of ['1e2','010','1,000','NaN','100 שעות','1000000000001','{"state":"provided","value":100}'])expect(()=>normalizeSavedReviewAnswer(target,bad)).toThrow('ANSWER_INVALID');
 const boolean=setup(fixture({answer_kind:'boolean'})).review.completions.customer_requests[0].target;
 expect(normalizeSavedReviewAnswer(boolean,'כן')).toEqual({state:'provided',value:true});expect(normalizeSavedReviewAnswer(boolean,'לא')).toEqual({state:'provided',value:false});
 expect(()=>normalizeSavedReviewAnswer(boolean,'false')).toThrow('ANSWER_INVALID');
 const choice=setup(fixture({answer_kind:'choice',options:['אפשר לצאת','צריך להישאר']})).review.completions.customer_requests[0].target;
 expect(()=>normalizeSavedReviewAnswer(choice,'אחר')).toThrow('ANSWER_INVALID');
});
it('reads identified append-only versions up to the journal revision, preserving stale state and unknown declarations',async()=>{
 const s=setup(),request=s.review.completions.customer_requests[0];
 s.state.history=[{request,source_current:false,answers:[{request_id:requestId,revision:1,identity_id:actor,answered_at:'2026-09-11T01:00:00.000000Z',answer_text:'לא יודע'},
  {request_id:requestId,revision:2,identity_id:actor,answered_at:'2026-09-11T01:01:00.000000Z',answer_text:'100'}]}];
 const rows=await readSavedReviewAnswers(s.context,s.job);expect(rows[0].source_current).toBe(false);
 expect(rows[0].answers.map(a=>a.answer)).toEqual([expect.objectContaining({state:'unknown',value:null,revision:1}),expect.objectContaining({state:'provided',value:100,revision:2})]);
 expect(rows[0].answers[0].actor).toEqual({case_id:caseId,identity_id:actor});
});
it('rejects missing history revisions and a foreign journal target',async()=>{
 const s=setup(),request=s.review.completions.customer_requests[0];
 const entry={request_id:requestId,revision:2,identity_id:actor,answered_at:'2026-09-11T01:01:00Z',answer_text:'100'};
 s.state.history=[{request,source_current:true,answers:[entry]}];await expect(readSavedReviewAnswers(s.context,s.job)).rejects.toThrow('HISTORY_REVISION');
 const foreign='66666666-6666-4666-8666-666666666666';
 const foreignPlan=generateReviewCompletions({case_id:foreign,period,documents:[],evidence:[],needs:[{fact_key:'hours.quantity',kind:'factual',reason:'missing',required_evidence_kind:'customer_declaration',question:'כמה שעות?',answer_kind:'number',source_pins:[],dependent_check_ids:['hours.check'],general_question:false}]});
 s.state.history=[{request:foreignPlan.customer_requests[0],source_current:true,answers:[{...entry,revision:1}]}];await expect(readSavedReviewAnswers(s.context,s.job)).rejects.toThrow('HISTORY_SCOPE');
});
