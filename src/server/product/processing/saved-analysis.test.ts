import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {runSavedMonthAnalysis} from './saved-analysis';
import {savedOrderSchema,savedMonthIdempotencyKey,savedOrderLegalTopics,type SavedOrderScope} from './saved-order-scope';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {SAVED_DRAFT_TEMPLATE} from './saved-draft-report';
import {CASE_ANALYSIS_CODE_VERSION} from '@/engine/case-analysis/contracts';
import {resolveSavedDocumentReviewKey} from './document-review-key';
import type {SourceJob} from './source-dispatch';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {createIntegratedFullSystemHarness} from '@/server/engine/case-analysis/integrated-harness';
import {buildLegacyPaidScope,LEGACY_PAID_TOPICS} from '../orders/legacy-paid-receipt';
import {readSavedJune2026Collection} from './saved-june2026-collection';
import {loadSavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
import {SavedCaseSnapshot} from './saved-snapshot';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {createAdmissionTestFixture,createTestAssessment,admissionTestNow} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
vi.mock('server-only',()=>({}));

vi.mock('./source-dispatch',async importOriginal=>({...await importOriginal<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
vi.mock('./saved-june2026-admitted-context',async original=>({...await original<typeof import('./saved-june2026-admitted-context')>(),loadSavedJune2026AdmittedContext:vi.fn()}));
vi.mock('./saved-june2026-collection',async original=>({...await original<typeof import('./saved-june2026-collection')>(),readSavedJune2026Collection:vi.fn()}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(loadSavedJune2026AdmittedContext).mockRejectedValue(Error('UNEXPECTED_CANONICAL_CONTEXT'));
 vi.mocked(readSavedJune2026Collection).mockImplementation(async(_context,job)=>({schema_version:'saved-june2026-collection-evidence-v1',case_id:job.case_id,
  month:'2026-06',evaluated_at:admissionTestNow,resolutions:[],customer_declarations:0,unknown:0,conflicted:0,legal_confirmation:false,rule_activation:false}));});
afterEach(()=>vi.restoreAllMocks());
const caseId='11111111-1111-4111-8111-111111111111';
function setup(){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'22222222-2222-4222-8222-222222222222',kind:'initial',from:'2026-08-01',to:'2026-08-01',topics:['pension'],offer_sha256:'b'.repeat(64)};
 const current:SavedOrderScope[]=[{...order}];
 const journal={input:{case_id:caseId,month:'2026-08',documents:[{id:'33333333-3333-4333-8333-333333333333',
  version_id:'44444444-4444-4444-8444-444444444444',sha256:'c'.repeat(64),type:'attendance',month:'2026-08'}],answers:[]},
  input_sha256:job.input_sha256,actual_sha256:job.input_sha256,created_at:'2026-09-08T00:00:00.000Z'};
 const inventory=[{id:journal.input.documents[0].id,version_id:journal.input.documents[0].version_id,document_type:'attendance',content_sha256:'c'.repeat(64)}];
 const replay={command:{case_id:caseId,document_review_sha256:''},bundle:{analysis_run_id:'cached-review-run'},report:{}};
 let resolvedReview:Awaited<ReturnType<typeof resolveSavedDocumentReviewKey>>['review']|undefined;
 const events:string[]=[];
 const cached=vi.fn(async(key:string)=>{expect(key).toMatch(/^review:[a-f0-9]{64}$/u);events.push('cached_result');return replay;});
 const context:PostgresTransactionContext={transaction_id:'unit-only',client:{async query(s){
  events.push(s.name);
  if(s.name==='saved_order_entitlements')return {rows:[{orders:[order],current_orders:current}],row_count:1};
  if(s.name==='saved_analysis_order')return {rows:[{input:{orders:[order]},created_at:'2026-09-08T00:00:00.000Z',engine_revision:1}],row_count:1};
  if(s.name==='saved_non_payslip_snapshot')return {rows:inventory.map(d=>({...d,case_id:caseId,storage_path:`cases/${caseId}/versions/${d.version_id}.pdf`,original_filename:'synthetic-attendance.pdf',mime_type:'application/pdf',size:100,period_month:'2026-08',created_at:journal.created_at,result:null,has_uncertain_dispatch:false})),row_count:inventory.length};
  if(s.name==='saved_snapshot_journal')return {rows:[journal],row_count:1};
  if(s.name==='review_source_read')return {rows:[{source:{state:'legacy'}}],row_count:1};
  if(s.name==='review_checkpoint_read')return {rows:[],row_count:0};
  if(s.name==='review_source_inventory')return {rows:inventory,row_count:inventory.length};
  if(s.name==='review_upload_assessment_inputs'){
   if(!resolvedReview)throw Error('TEST_REVIEW_NOT_RESOLVED');
   expect(s.values[3]).toBe(replay.bundle.analysis_run_id);
   return {rows:[{value:{review:runDocumentReview(resolvedReview,replay.bundle.analysis_run_id),current_source_pins:[],items:[]}}],row_count:1};
  }
  throw new Error(`UNEXPECTED_SQL:${s.name}`);
 }}};
 // Resolve the baseline using the actual journal/snapshot/review adapters, then
 // mutate the mock stored rows in negative cases. No early-cache shortcut.
 const prepareReplay=async()=>{
  const resolved=await resolveSavedDocumentReviewKey(context,job,order,'2026-08',savedMonthIdempotencyKey(job,order.id,'2026-08'));
  resolvedReview=resolved.review;replay.command.document_review_sha256=resolved.reviewSha256;events.length=0;return resolved;
 };
 return {order,current,cached,replay,journal,inventory,events,prepareReplay,input:{context,analysis:{caseAnalysis:{getCompletedByIdempotencyKey:cached}} as unknown as PostgresAnalysisRepositories,tenantId:`saved-case:${caseId}`,job,orderId:order.id,month:'2026-08'}};
}
describe('saved monthly analysis admission before replay',()=>{
 it('creates a distinct June analysis key for the acquired-source catalog while preserving other month keys',()=>{
  const {input}=setup();
  const previous=(month:string)=>`saved-month:${canonicalSha256({job:input.job,order_id:input.orderId,month,template:SAVED_DRAFT_TEMPLATE,engine:CASE_ANALYSIS_CODE_VERSION})}`;
  expect(savedMonthIdempotencyKey(input.job,input.orderId,'2026-06')).not.toBe(previous('2026-06'));
  expect(savedMonthIdempotencyKey(input.job,input.orderId,'2026-08')).toBe(previous('2026-08'));
 });
 it('does not reuse a pre-retention analysis key while retaining exact current retries',()=>{
  const {input}=setup();const old=`saved-month:${canonicalSha256({job:input.job,order_id:input.orderId,month:input.month,template:SAVED_DRAFT_TEMPLATE,engine:'case-analysis@0.6.3'})}`;
  const current=savedMonthIdempotencyKey(input.job,input.orderId,input.month);expect(current).not.toBe(old);expect(savedMonthIdempotencyKey(input.job,input.orderId,input.month)).toBe(current);
 });
 it.each(['revoked entitlement','another order','changed offer'] as const)('refuses %s before reading cached results',async defect=>{
  const s=setup();
  if(defect==='revoked entitlement')s.current.length=0;
  if(defect==='another order')s.current[0].id='33333333-3333-4333-8333-333333333333';
  if(defect==='changed offer')s.current[0].offer_sha256='c'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
  expect(s.cached).not.toHaveBeenCalled();
 });
 it('resolves the current saved journal and review before replaying an exact currently entitled order',async()=>{
  const s=setup(),resolved=await s.prepareReplay();
  expect(resolved.review.documents[0].kind).toBe('attendance');
  expect(resolved.review.checks).toEqual([]);expect(resolved.review.coverage_gaps[0].kind).toBe('missing_source');
  expect(await runSavedMonthAnalysis(s.input)).toBe(s.replay);expect(s.cached).toHaveBeenCalledExactlyOnceWith(resolved.key);
  expect(s.events.indexOf('saved_snapshot_journal')).toBeLessThan(s.events.indexOf('cached_result'));
  expect(s.events.lastIndexOf('review_source_read')).toBeLessThan(s.events.indexOf('cached_result'));
  expect(s.events.slice(-4)).toEqual(['review_checkpoint_read','review_source_inventory','cached_result','review_upload_assessment_inputs']);
 });
 it.each(['input_sha256','actual_sha256'] as const)('refuses changed journal %s before reading cached results',async hashField=>{
  const s=setup();await s.prepareReplay();s.journal[hashField]='f'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');
  expect(s.cached).not.toHaveBeenCalled();
 });
 it('refuses a source removed from the current inventory before reading cached results',async()=>{
  const s=setup();await s.prepareReplay();s.inventory.length=0;
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_NON_PAYSLIP_SOURCE_CHANGED');expect(s.cached).not.toHaveBeenCalled();
 });
 it('refuses a cached result with an unrelated review hash after resolving current inputs',async()=>{
  const s=setup();await s.prepareReplay();s.replay.command.document_review_sha256='d'.repeat(64);
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow('SAVED_REPLAY_SCOPE');expect(s.cached).toHaveBeenCalledOnce();
 });
 it('refuses a saved initial order wider than the purchased three-topic product',async()=>{
  const s=setup();s.order.topics=['pension','travel','vacation','sick_leave'];s.current[0]={...s.order};
  await expect(runSavedMonthAnalysis(s.input)).rejects.toThrow();expect(s.cached).not.toHaveBeenCalled();
 });
 it('applies the same initial scope rule to the finalizer contract while preserving seven-topic full orders',()=>{
  const s=setup();s.order.topics=['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave'];
  expect(savedOrderSchema.safeParse(s.order).success).toBe(false);
  expect(savedOrderSchema.safeParse({...s.order,kind:'full'}).success).toBe(true);
 });
});

describe('June source review versus admitted canonical composition',()=>{
 it('runs a nine-topic receipt-derived June review through the real service without invoking the narrow canonical context loader',async()=>{
  const s=setup(),h=createIntegratedFullSystemHarness([]);s.input.month='2026-06';s.journal.input.month='2026-06';s.journal.input.documents[0].month='2026-06';
  const admission=buildLegacyPaidScope({case:{id:caseId,public_id:'SYNTHETIC-WIDE-JUNE',payment_status:'verified',is_qa:false},
   payment:{id:s.order.id,case_id:caseId,provider:'invoice4u',amount:'9.99',currency:'ILS',status:'verified',verified_at:'2026-08-30T00:00:00Z',
    idempotency_key:caseId+':initial-check',provider_order_id:'tivdoc-salary:SYNTHETIC-WIDE-JUNE',provider_payment_id:'1001',provider_reference:'2001',provider_clearing_log_id:'2001',provider_confirmation_number:'3001'},
   source:{project_ref:'a'.repeat(20),captured_at:'2026-09-11T00:00:00Z',snapshot_sha256:'b'.repeat(64)},
   periods:[{period:{from:'2026-06-01',to:'2026-06-30'},evidence_sha256:'c'.repeat(64),source_pins:[{case_id:caseId,
    document_id:s.inventory[0].id,version_id:s.inventory[0].version_id,source_sha256:s.inventory[0].content_sha256}]}]});
  if(admission.state!=='admitted')throw Error('EXPECTED_SYNTHETIC_RECEIPT');
  const events:string[]=[],opened:string[]=[];
  const context:PostgresTransactionContext={transaction_id:'wide-review-unit',client:{async query(q){events.push(q.name);
   if(q.name==='saved_order_entitlements')return {rows:[{orders:[],current_orders:[],legacy_orders:[admission.scope],current_legacy_orders:[admission.scope]}],row_count:1};
   if(q.name==='review_requests_stage'){
    const saved=await h.repository.getByRunId(String(q.values[0])),stage=saved?.stages.find(stage=>stage.stage==='topic_results');
    if(!stage)throw Error('EXPECTED_PERSISTED_REVIEW_STAGE');return {rows:[{payload:stage.payload,payload_sha256:canonicalSha256(stage.payload)}],row_count:1};
   }
   if(q.name==='review_request_open'){opened.push(String(q.values[4]));return {rows:[{id:'55555555-5555-4555-8555-555555555555'}],row_count:1};}
   if(q.name==='review_upload_assessment_inputs'){
    const saved=await h.repository.getByRunId(String(q.values[3]));if(!saved?.bundle?.document_review)throw Error('EXPECTED_PERSISTED_REVIEW');
    return {rows:[{value:{review:saved.bundle.document_review,current_source_pins:[],items:[]}}],row_count:1};
   }
   return s.input.context.client.query(q);
  }}};
  const input={...s.input,context,analysis:{caseAnalysis:h.repository,reports:h.review} as unknown as PostgresAnalysisRepositories};
  const result=await runSavedMonthAnalysis(input);
  expect(result.completed).toBe(true);expect(result.command.idempotency_key).toMatch(/^review:/u);expect(result.command.mode).toBe('real');
  const review=result.bundle?.document_review;if(!review)throw Error('EXPECTED_WIDE_REVIEW');
  expect(review.purchased_scope).toMatchObject({origin:'legacy_paid_receipt',receipt_sha256:admission.scope.receipt_sha256,topics:LEGACY_PAID_TOPICS});
  expect(review.coverage_gaps.map(g=>g.topic)).toEqual([...LEGACY_PAID_TOPICS,'working_time']);
  const pending=review.coverage_gaps.at(-1)!;
  expect(pending).toMatchObject({check_id:`entitlement.nonpay.${canonicalSha256(s.journal.input.documents[0].version_id).slice(0,16)}.source`,topic:'working_time',kind:'missing_source',
   source_pins:[{case_id:caseId,document_id:s.journal.input.documents[0].version_id,version_id:s.journal.input.documents[0].version_id,source_sha256:s.journal.input.documents[0].sha256}]});
  expect(pending.next_step).toContain('המסמך שכבר הועלה');expect(opened).toHaveLength(1);
  expect(result.command.requested_topics).toEqual(savedOrderLegalTopics({...s.order,kind:'full',topics:['working_time','pension','vacation','convalescence','travel','minimum_wage']}));
  expect(vi.mocked(readSavedJune2026Collection)).not.toHaveBeenCalled();expect(vi.mocked(loadSavedJune2026AdmittedContext)).not.toHaveBeenCalled();
  expect(events).not.toContain('june_test_authority');expect(events).not.toContain('june_regular_authority');
  expect(result.bundle?.topic_results.every(t=>t.amount===null&&t.trace===null)).toBe(true);expect(review.publication_authority).toBe(false);
  expect(result.stages.find(stage=>stage.stage==='review_pending')?.payload).not.toHaveProperty('diagnostics.factual_context');
  const repeats=await runSavedMonthAnalysis(input);expect(repeats.report?.report_sha256).toBe(result.report?.report_sha256);expect(opened).toHaveLength(1);
  expect(events.filter(event=>event==='review_upload_assessment_inputs')).toHaveLength(2);
 });

 it.each(['loader_refusal','foreign_case','foreign_run'] as const)('retains canonical preexecution refusal for %s before any report or outcome',async defect=>{
  const f=createAdmissionTestFixture(),packet=f.packet(),assessment=createTestAssessment(packet);
  const fixture=buildSyntheticCaseFixture({fixture_id:'june2026-admission-boundary',mode:'real'}),h=createIntegratedFullSystemHarness([fixture.stored]);
  expect(fixture.command.case_id).toBe(packet.current.case_id);
  const job:SourceJob={schema_version:'saved-case-work-v1',case_id:packet.current.case_id,revision:packet.current.input_revision,input_sha256:packet.current.input_sha256,mode:'draft'};
  const order:SavedOrderScope={id:packet.current.order_id,kind:'initial',from:'2026-06-01',to:'2026-06-01',topics:['minimum_wage'],offer_sha256:'b'.repeat(64)};
  const queries:string[]=[],context:PostgresTransactionContext={transaction_id:'canonical-guard-unit',client:{async query(q){queries.push(q.name);
   if(q.name==='saved_order_entitlements')return {rows:[{orders:[order],current_orders:[order]}],row_count:1};
   if(q.name==='saved_analysis_order')return {rows:[{created_at:admissionTestNow,engine_revision:1}],row_count:1};
   if(q.name==='june_test_authority')return {rows:[{authority:{assessment,assessment_sha256:canonicalSha256(assessment),evaluated_at:admissionTestNow}}],row_count:1};
   throw Error(`UNEXPECTED_CANONICAL_SQL:${q.name}`);
  }}};
  // Supply a synthetic saved snapshot, while keeping the real snapshot's
  // loadPinned/test-authority gate and the actual persisted service stages.
  vi.spyOn(SavedCaseSnapshot.prototype,'read').mockResolvedValue(fixture.stored);
  let runId='';vi.mocked(loadSavedJune2026AdmittedContext).mockImplementation(async input=>{
   runId=input.analysisRunId;const saved=await h.repository.getByRunId(runId);
   expect(saved?.completed).toBe(false);expect(saved?.stages.map(stage=>stage.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs','analysis_run']);
   expect(saved?.command.document_review_sha256).toBeUndefined();expect(saved?.command.idempotency_key).toMatch(/^june-test:/u);
   if(defect==='loader_refusal')throw Error('SAVED_WORKER_SCOPE_FORBIDDEN');
   return {schema_version:'saved-june2026-factual-context-v1',state:'context_blocked',code:'multiple_documents',
    case_id:defect==='foreign_case'?caseId:job.case_id,analysis_run_id:defect==='foreign_run'?'foreign-run':runId,legal_activation:false,publication_allowed:false};
  });
  const input={context,analysis:{caseAnalysis:h.repository,reports:h.review} as unknown as PostgresAnalysisRepositories,tenantId:'saved-case:'+job.case_id,job,orderId:order.id,month:'2026-06'};
  await expect(runSavedMonthAnalysis(input)).rejects.toThrow(defect==='loader_refusal'?'SAVED_WORKER_SCOPE_FORBIDDEN':'SAVED_JUNE_CONTEXT_PREEXECUTION_BINDING');
  expect(vi.mocked(readSavedJune2026Collection)).toHaveBeenCalledOnce();expect(vi.mocked(loadSavedJune2026AdmittedContext)).toHaveBeenCalledOnce();
  expect(queries).not.toContain('review_source_read');expect(queries).not.toContain('review_upload_assessment_inputs');
  const saved=await h.repository.getByRunId(runId);expect(saved?.completed).toBe(false);expect(saved?.report).toBeNull();
  expect(saved?.stages.map(stage=>stage.stage)).toEqual(['input_snapshot','canonical_facts','rule_inputs','analysis_run']);
 });
});
