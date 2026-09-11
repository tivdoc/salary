import {SavedCaseSnapshot} from './saved-snapshot';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {beforeEach,expect,it,vi} from 'vitest';
import type {StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {saveSavedDocumentReview,savedDocumentReviewInput,savedDocumentReviewSourceScope,assertSavedDocumentReviewSourceScope} from './saved-document-review';
import type {SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';

const ports=vi.hoisted(()=>({admit:vi.fn(),lock:vi.fn(),orders:vi.fn(),answers:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission',()=>({admitSavedSource:ports.admit}));
vi.mock('./source-dispatch',async load=>({...await load<typeof import('./source-dispatch')>(),lockCurrentSource:ports.lock}));
vi.mock('./saved-order-scope',async load=>({...await load<typeof import('./saved-order-scope')>(),readSavedOrders:ports.orders}));
vi.mock('./saved-review-requests',()=>({readSavedReviewAnswers:ports.answers}));
beforeEach(()=>vi.resetAllMocks());
const caseId='11111111-1111-4111-8111-111111111111',doc='22222222-2222-4222-8222-222222222222',orderId='33333333-3333-4333-8333-333333333333';
const period={from:'2026-06-01',to:'2026-06-30'};
function fixture(){
 const pin={case_id:caseId,document_id:doc,version_id:doc,source_sha256:'a'.repeat(64)};
 return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:orderId,receipt_sha256:'b'.repeat(64),topics:['working_time'],origin:'saved_order'},
  documents:[{case_id:caseId,document_id:doc,version_id:doc,file_sha256:pin.source_sha256,page_count:1,kind:'attendance',label:'מסמך סינתטי',period,reading_origin:'ai_document_review',reading_sha256:'c'.repeat(64)}],
  checks:[],coverage_gaps:[{check_id:'hours.check',topic:'working_time',kind:'missing_fact',detail:'נדרשת כמות שעות.',next_step:'השלמת הנתון.'}],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'attendance',period,review:'partial'}],evidence:[],needs:[{fact_key:'hours.quantity',kind:'factual',reason:'unknown',required_evidence_kind:'customer_declaration',question:'כמה שעות עבודה היו?',answer_kind:'number',source_pins:[pin],dependent_check_ids:['hours.check'],general_question:false}]}});
}
function setup(){
 const input=fixture(),job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:3,input_sha256:'d'.repeat(64),mode:'draft',authority_dependency_sha256:'e'.repeat(64)};
 const order:SavedOrderScope={id:orderId,kind:'initial',from:period.from,to:period.from,topics:['working_time'],offer_sha256:'b'.repeat(64)};
 const nextJob:SourceJob={...job,revision:4,input_sha256:'f'.repeat(64)};
 const ref={schema_version:'document-review-source-ref-v1',order_id:orderId,month:'2026-06',review_sha256:canonicalSha256(input)};
 const snapshot:StoredCaseInputSnapshot={document_snapshot_id:'synthetic',document_snapshot_sha256:job.input_sha256,documents:[],extraction_snapshot_id:'synthetic',extraction_snapshot_sha256:'a'.repeat(64),extractions:[],declared_fact_snapshot:{snapshot_id:'synthetic',snapshot_sha256:'a'.repeat(64),facts:[]}};
 const state:{source:unknown;admission:unknown;sources:readonly Record<string,unknown>[];legacy:unknown[];queries:PostgresStatement[]}={
  source:{state:'pinned',review_ref:ref,input},admission:{source_job:nextJob,review_ref:ref,changed:true},sources:[{id:doc,version_id:doc,content_sha256:'a'.repeat(64),document_type:'attendance'}],legacy:[],queries:[]};
 const context:PostgresTransactionContext={transaction_id:'synthetic.mocked.transaction',client:{async query(q){
  state.queries.push(q);
  if(q.name==='saved_snapshot_journal')return {rows:[{input:{case_id:caseId,month:'2026-06',documents:[{id:doc,version_id:doc,sha256:'a'.repeat(64),type:'payslip',month:'2026-06'}],answers:[{id:'99999999-9999-4999-8999-999999999999',case_id:caseId,code:'document_review:synthetic-history'}]},created_at:'2026-07-01T00:00:00Z',input_sha256:job.input_sha256,actual_sha256:job.input_sha256}],row_count:1};
  if(q.name==='review_source_read')return {rows:[{source:state.source}],row_count:1};
  if(q.name==='review_source_admit')return {rows:[{admission:state.admission}],row_count:1};
  if(q.name==='review_pinned_sources'||q.name==='review_source_inventory')return {rows:state.sources,row_count:state.sources.length};
  if(q.name==='review_checkpoint_read')return {rows:state.legacy as Record<string,unknown>[],row_count:state.legacy.length};
  throw Error('UNEXPECTED_SYNTHETIC_QUERY:'+q.name);
 }}};
 ports.orders.mockResolvedValue([order]);ports.answers.mockResolvedValue([]);
 return {input,job,nextJob,order,ref,snapshot,state,context,load:()=>savedDocumentReviewInput(context,job,order,'2026-06',snapshot)};
}
it('admits immutable source input and returns the captured NEW job before source analysis',async()=>{
 const s=setup();expect(await saveSavedDocumentReview(s.context,s.job,s.input)).toEqual({input:s.input,source_job:s.nextJob,review_ref:s.ref,changed:true});
 expect(ports.admit).toHaveBeenCalledWith(s.context,s.job);
 const admit=s.state.queries.find(q=>q.name==='review_source_admit')!;
 expect(admit.values).toEqual([caseId,3,s.job.input_sha256,orderId,period.from,canonicalSha256(s.input),JSON.stringify(s.input),s.job.authority_dependency_sha256]);
 expect(s.state.queries.find(q=>q.name==='review_source_read')?.values.slice(0,3)).toEqual([caseId,4,s.nextJob.input_sha256]);
 expect(s.state.queries.some(q=>q.name==='review_checkpoint_insert')).toBe(false);
});
it('returns exact pinned journal bytes, never the newer mutable legacy checkpoint',async()=>{
 const s=setup();s.state.legacy=[{result:{...s.input,checks:[]},result_sha256:'0'.repeat(64)}];
 expect(await s.load()).toEqual(s.input);expect(s.state.queries.some(q=>q.name==='review_checkpoint_read')).toBe(false);
});
it('retains historical v1 checkpoint reads only after explicit legacy admission',async()=>{
 const s=setup();s.state.source={state:'legacy'};s.state.legacy=[{result:s.input,result_sha256:canonicalSha256(s.input)}];
 expect(await s.load()).toEqual(s.input);
 expect(s.state.queries.find(q=>q.name==='review_checkpoint_read')?.values.at(-1)).toBe(s.job.input_sha256);
});
it('an invalidated review returns source inventory, never a cached old review',async()=>{
 const s=setup();s.state.source={state:'invalidated'};s.state.legacy=[{result:s.input,result_sha256:canonicalSha256(s.input)}];
 const input=await s.load();expect(input.documents[0].reading_origin).toBe('source_inventory');
 expect(s.state.queries.some(q=>q.name==='review_checkpoint_read')).toBe(false);expect(input.checks).toEqual([]);
 expect(runDocumentReview(input,'synthetic.current.inventory').completions.customer_requests[0].target.fact_key).toBe('payslip.financial_source');
});
it.each(['hash','order','month','source'] as const)('refuses pinned %s mismatch before ordinary analysis',async kind=>{
 const s=setup();
 if(kind==='source')s.state.sources=[{id:doc,version_id:doc,content_sha256:'f'.repeat(64)}];
 else s.state.source={state:'pinned',input:s.input,review_ref:{...s.ref,...(kind==='hash'?{review_sha256:'f'.repeat(64)}:kind==='order'?{order_id:'44444444-4444-4444-8444-444444444444'}:{month:'2026-05'})}};
 await expect(s.load()).rejects.toThrow(kind==='source'?'SAVED_REVIEW_SOURCE_SCOPE':'SAVED_REVIEW_HASH');
});
it('same-hash admission retry uses the same current job, and forged advancement is refused',async()=>{
 const s=setup();s.state.admission={source_job:s.job,review_ref:s.ref,changed:false};
 expect((await saveSavedDocumentReview(s.context,s.job,s.input)).changed).toBe(false);
 s.state.admission={source_job:s.nextJob,review_ref:s.ref,changed:false};
 await expect(saveSavedDocumentReview(s.context,s.job,s.input)).rejects.toThrow('SAVED_REVIEW_ADMISSION_BINDING');
});
it('applies identified answers after loading the unchanged source journal and keeps its raw input immutable',async()=>{
 const s=setup(),request=runDocumentReview(s.input,'before.answer').completions.customer_requests[0];
 ports.answers.mockResolvedValue([{source_current:true,request,answers:[{actor:{case_id:caseId,identity_id:'55555555-5555-4555-8555-555555555555'},answer:{request_id:'66666666-6666-4666-8666-666666666666',revision:1,answered_at:'2026-09-11T16:00:00Z',state:'provided',value:10}}]}]);
 const next=await savedDocumentReviewInput(s.context,s.job,s.order,'2026-06',{...s.snapshot,has_document_review_answers:true});
 expect(next.answer_history).toHaveLength(1);expect(s.input.answer_history).toHaveLength(0);expect(canonicalSha256(next)).not.toBe(s.ref.review_sha256);
 expect(s.state.queries.some(q=>q.name==='review_source_admit')).toBe(false);
});
it('does not save caller-supplied identified document readings or cross-month scope',async()=>{
 const s=setup();
 await expect(saveSavedDocumentReview(s.context,s.job,{...s.input,documents:s.input.documents.map(d=>({...d,reading_origin:'identified_document_reading'}))})).rejects.toThrow('SAVED_REVIEW_ANSWER_JOURNAL_REQUIRED');
 await expect(saveSavedDocumentReview(s.context,s.job,{...s.input,period:{from:'2026-05-20',to:'2026-06-30'}})).rejects.toThrow('SAVED_REVIEW_ORDER_SCOPE');
 expect(s.state.queries.some(q=>q.name==='review_source_admit')).toBe(false);
});

it('opens the ordinary source-review snapshot without manufacturing or requiring an OCR checkpoint',async()=>{
 const s=setup(),scope=await savedDocumentReviewSourceScope(s.context,s.job,s.order,'2026-06');
 expect(scope).toEqual({orderId:s.order.id,reviewSha256:s.ref.review_sha256,sourceVersionIds:[doc]});
 const reader=new SavedCaseSnapshot(s.context,s.job,'2026-06',undefined,undefined,true,scope),snapshot=await reader.read();
 expect(snapshot.documents).toEqual([]);expect(snapshot.extractions).toEqual([]);expect(snapshot.has_document_review_answers).toBe(true);
 expect(snapshot.declared_fact_snapshot.facts).toEqual([]);expect(s.state.queries.some(q=>q.name==='saved_snapshot_document')).toBe(false);
 const reviewed=await savedDocumentReviewInput(s.context,s.job,s.order,'2026-06',snapshot);
 expect(reviewed).toEqual(s.input);expect(reviewed.documents[0].reading_origin).toBe('ai_document_review');
 const fixture=buildSyntheticCaseFixture({fixture_id:'synthetic-source-review-snapshot',mode:'real'});
 const command={...fixture.command,case_id:caseId,period:{start_date:period.from,end_date:period.to},document_review_sha256:canonicalSha256(reviewed),
  document_snapshot_id:snapshot.document_snapshot_id,document_snapshot_sha256:snapshot.document_snapshot_sha256,
  extraction_snapshot_id:snapshot.extraction_snapshot_id,extraction_snapshot_sha256:snapshot.extraction_snapshot_sha256,
  declared_fact_snapshot_id:snapshot.declared_fact_snapshot.snapshot_id,declared_fact_snapshot_sha256:snapshot.declared_fact_snapshot.snapshot_sha256};
 expect(await reader.loadPinned(command)).toEqual(snapshot);
 await expect(reader.loadPinned({...command,document_review_sha256:undefined})).rejects.toThrow('SAVED_REVIEW_COMMAND_REQUIRED');
 await expect(reader.loadPinned({...command,period:{start_date:'2026-05-01',end_date:'2026-05-31'}})).rejects.toThrow('SAVED_COMMAND_SCOPE');
 s.state.source={state:'invalidated'};await expect(reader.read()).rejects.toThrow('SAVED_REVIEW_SOURCE_REF_CHANGED');
});
it.each(['legacy','invalidated'])('never turns %s fallback into permission to skip OCR',async state=>{
 const s=setup();s.state.source={state};s.state.legacy=[{result:s.input,result_sha256:canonicalSha256(s.input)}];
 expect(await savedDocumentReviewSourceScope(s.context,s.job,s.order,'2026-06')).toBeUndefined();
 expect(s.state.queries.some(q=>q.name==='review_checkpoint_read')).toBe(false);
});
it.each(['hash','version_list','paid_scope','source'])('rechecks immutable source-review %s instead of trusting caller scope',async kind=>{
 const s=setup(),original=(await savedDocumentReviewSourceScope(s.context,s.job,s.order,'2026-06'))!,scope={...original};
 if(kind==='hash')scope.reviewSha256='f'.repeat(64);
 if(kind==='version_list')scope.sourceVersionIds=[];
 if(kind==='paid_scope')ports.orders.mockRejectedValue(Error('SAVED_ORDER_SCOPE'));
 if(kind==='source')s.state.sources=[];
 await expect(assertSavedDocumentReviewSourceScope(s.context,s.job,'2026-06',scope)).rejects.toThrow();
});
