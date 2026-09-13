import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async original=>({...await original<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
const admission=vi.hoisted(()=>({order:null as unknown}));
vi.mock('./saved-order-scope',async original=>({...await original<typeof import('./saved-order-scope')>(),readSavedOrders:vi.fn(async()=>[admission.order]),purchasedMonths:()=>['2026-06'],savedOrderOrigin:()=> 'saved_order',savedOrderReceiptSha256:()=> 'a'.repeat(64)}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {fixture as contractFixture,uuid} from '@/engine/entitlement-review/obligations/product-flow.fixture';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizeMoney} from '@/engine/extraction/normalization';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '@/engine/document-review/payslip-adapter';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {obligationPaymentOperands} from '@/engine/entitlement-review/obligations/payment-link';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {savedObligationPaymentLinks,readSavedObligationPaymentLinks,attachSavedObligationPaymentLinks,openSavedObligationPaymentLinkRequests} from './saved-obligation-payment-links';
import type {PostgresTransactionContext,PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';

function fixture(){
 const c=contractFixture();c.identify();const original=c.run().review;
 const purchase={...original.purchased_scope,order_id:uuid(700)};
 const review=documentReviewInputSchema.parse({...original,purchased_scope:purchase,entitlement_evidence:{...original.entitlement_evidence,order_id:purchase.order_id}});
 const old=buildSyntheticCaseFixture({fixture_id:'saved-payment-bridge',mode:'real'}),id=uuid(600),caseId=review.case_id,period=review.period;
 const document={...old.stored.documents[0],case_id:caseId,document_id:id,storage_path:`cases/${caseId}/documents/${id}/original.pdf`,document_period:{start_date:period.from,end_date:period.to}};
 const source={document_id:id,page:1,text_fragment:'Synthetic payment row',source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current amount'}};
 const row={component_id:uuid(601),source_label:'בונוס סינתטי',normalized_label:'synthetic.bonus',semantic_kind:'bonus',quantity_raw:'1',rate_raw:'450.00',percentage_raw:null,amount_raw:'450.00',
  quantity:'1',rate:normalizeMoney('450.00'),percentage:null,amount:normalizeMoney('450.00'),confidence:1,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]};
 const p=old.stored.extractions[0].fields.find(p=>p.field==='salary_period')!;
 const machine=normalizedPayslipExtractionSchema.parse({...old.stored.extractions[0],document_id:id,extracted_at:'2026-07-02T00:00:00Z',
  fields:[{...p,source,raw_value:'06/2026',normalized_value:{year:2026,month:6,start_date:period.from,end_date:period.to}}],additional_components:[row],earnings_components_complete:false});
 const extraction=normalizedPayslipExtractionSchema.parse({...machine,customer_row_readings:[{schema_version:'document-row-cell-reading-v1',actor_kind:'customer',case_id:caseId,document_id:id,
  component_id:row.component_id,cell:'amount',source_sha256:document.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(machine),original_component_sha256:canonicalSha256(machine.additional_components[0]),
  extraction_result_sha256:'d'.repeat(64),target_sha256:'e'.repeat(64),month:'2026-06',request_id:uuid(602),answer_revision:1,identity_id:uuid(603),confirmed_at:'2026-07-03T00:00:00Z'}]});
 const payroll=reviewInputFromPayslips({case_id:caseId,period,purchased_scope:purchase,review_policy:PAYSLIP_REVIEW_POLICY,snapshot:{...old.stored,documents:[document],extractions:[extraction]}});
 const merged=documentReviewInputSchema.parse({...review,documents:[...review.documents,...payroll.documents],checks:payroll.checks});
 const pins=merged.documents.map(d=>({id:d.kind==='payslip'?uuid(604):d.document_id,version_id:d.version_id,sha256:d.file_sha256,type:d.kind}));
 const run={result:{final_extraction:machine}},resultHash=canonicalSha256(run.result);
 const checkpoint={product_document_id:uuid(604),version_id:id,input_sha256:document.content_sha256,policy_version:SAVED_EXTRACTION_POLICY,result_sha256:resultHash,
  result:{case_id:caseId,product_document_id:uuid(604),version_id:id,input_sha256:document.content_sha256,expected_month:'2026-06',result_sha256:resultHash,run}};
 const journal={case_id:caseId,documents:pins,answers:[] as Record<string,unknown>[]};
 const input={caseId,month:'2026-06',review:merged,journal,currentDocuments:pins,payrollCheckpoints:[checkpoint],currentRequestStates:[] as {request_id:string;target_sha256:string;current:boolean}[]};
 const load=()=>savedObligationPaymentLinks(input);
 const answer=(action:'correct'|'unknown'|'unreadable'='correct')=>{
  const target=load().dependencies[0].target!;
  input.currentRequestStates=[...input.currentRequestStates.filter(s=>s.request_id!==uuid(605)),{request_id:uuid(605),target_sha256:target.target_sha256,current:true}];
  return {id:uuid(605),case_id:caseId,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',
   answer:JSON.stringify(action==='correct'?{action,candidate_target_sha256:target.candidates[0].target_sha256,value:{relationship:'same_obligation',basis:{page:1,locator:'Synthetic explicit reference',text:'This synthetic payroll row identifies this clause'}}}:{action}),
   answer_revision:1,answer_identity_id:uuid(603),answer_created_at:'2026-07-03T00:00:00Z',field_target:target};
 };
 return {input,load,answer,checkpoint,journal};
}
function transaction(f=fixture()){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:f.input.caseId,revision:2,input_sha256:'b'.repeat(64),mode:'draft',processing_profile:'qualified_ai_v1'};
 const statements:PostgresStatement[]=[],opened:unknown[]=[];let corrupt=false;
 admission.order={id:f.input.review.purchased_scope.order_id,topics:f.input.review.purchased_scope.topics};
 const context:PostgresTransactionContext={transaction_id:'synthetic-links',client:{async query(q){
  statements.push(q);
  if(q.name==='saved_obligation_payment_journal')return {row_count:1,rows:[{input:f.journal,input_sha256:job.input_sha256,actual_sha256:corrupt?'c'.repeat(64):job.input_sha256,
   current_documents:f.input.currentDocuments,payroll_checkpoints:f.input.payrollCheckpoints,current_obligation_requests:f.input.currentRequestStates}]};
  if(q.name==='saved_obligation_payment_open'){opened.push(JSON.parse(String(q.values[3])));return {row_count:1,rows:[{id:uuid(900)}]};}
  throw Error('UNEXPECTED_QUERY:'+q.name);
 }}};
 return {f,job,context,opened,statements,tamper(){corrupt=true;}};
}
beforeEach(()=>vi.clearAllMocks());
describe('saved obligation clause → one identified payroll row choice',()=>{
 it('reconstructs a purchase-bound wrapper and replays the selected current candidate',()=>{
  const f=fixture(),before=canonicalSha256(f.input.review);f.journal.answers=[f.answer()];
  const saved=f.load(),attached=attachSavedObligationPaymentLinks(f.input.review,saved);
  expect(saved.dependencies).toHaveLength(1);expect(saved.dependencies[0]).toMatchObject({answered:true,target:{schema_version:'obligation-payment-choice-v1',order_id:f.input.review.purchased_scope.order_id}});
  expect(saved.readings).toHaveLength(1);expect(saved.readings[0]).toMatchObject({identity_id:uuid(603),state:'source_link_reading'});
  expect(attached.obligation_payment_link_readings).toEqual(saved.readings);expect(canonicalSha256(f.input.review)).toBe(before);
 });
 it.each(['unknown','unreadable'] as const)('retains %s history without selecting a fabricated row or reopening',action=>{
  const f=fixture();f.journal.answers=[f.answer(action)];const saved=f.load();
  expect(saved.readings).toEqual([]);expect(saved.history).toMatchObject([{current:true,action}]);expect(saved.dependencies[0].answered).toBe(true);
 });
 it('does not use a historical request as its own current source',()=>{
  const f=fixture();f.journal.answers=[f.answer()];f.checkpoint.result.run.result.final_extraction.extracted_at='2026-07-04T00:00:00Z';
  expect(()=>f.load()).toThrow('SAVED_OBLIGATION_PAYMENT_CHECKPOINT');
  f.checkpoint.result_sha256=canonicalSha256(f.checkpoint.result.run.result);f.checkpoint.result.result_sha256=f.checkpoint.result_sha256;
  expect(f.load().readings).toEqual([]);expect(f.load().history[0].current).toBe(false);
 });
 it('keeps an exact selected pair current when an unrelated candidate is added',()=>{
  const f=fixture();f.journal.answers=[f.answer()];const original=f.load().readings[0];
  const amount=obligationPaymentOperands(f.input.review)[0];
  const check=f.input.review.checks.find(c=>documentReviewCalculationInputSchema.safeParse(c.calculation).success&&documentReviewCalculationInputSchema.parse(c.calculation).operands.some(a=>a.observation_id===amount.observation_id))!;
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
  f.input.review.checks.push({...check,check_id:'document.synthetic.extra',calculation:{...calculation,operands:calculation.operands.map(a=>a.observation_id===amount.observation_id?{...a,observation_id:`${uuid(610)}:amount`,printed_value:'300.00'}:a)}});
  const next=f.load();expect(next.dependencies[0].target!.candidates).toHaveLength(2);expect(next.readings).toEqual([original]);
 });
 it('holds an oversized candidate inventory instead of silently choosing or truncating rows',()=>{
  const f=fixture(),amount=obligationPaymentOperands(f.input.review)[0];
  const check=f.input.review.checks.find(c=>documentReviewCalculationInputSchema.safeParse(c.calculation).success&&documentReviewCalculationInputSchema.parse(c.calculation).operands.some(a=>a.observation_id===amount.observation_id))!;
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
  for(let i=0;i<16;i++)f.input.review.checks.push({...check,check_id:`document.synthetic.extra.${i}`,calculation:{...calculation,operands:calculation.operands.map(a=>a.observation_id===amount.observation_id?{...a,observation_id:`${uuid(800+i)}:amount`}:a)}});
  expect(f.load().dependencies).toMatchObject([{target:null,answered:false,reason:'payroll_candidate_scope_required'}]);
 });
 it('invalidates a selected pair after its document reading receipt changes',()=>{
  const f=fixture();f.journal.answers=[f.answer()];
  const payroll=f.input.review.documents.find(d=>d.kind==='payslip')!;payroll.reading_sha256='f'.repeat(64);
  for(const c of f.input.review.checks){const parsed=documentReviewCalculationInputSchema.safeParse(c.calculation);if(parsed.success)c.calculation={...parsed.data,operands:parsed.data.operands.map(a=>a.source.version_id===payroll.version_id?{...a,source:{...a.source,reading_receipt_sha256:payroll.reading_sha256}}:a)};}
  expect(f.load().readings).toEqual([]);expect(f.load().history[0].current).toBe(false);
 });
 it('pins the complete source-reading journal and detects changed or newly added source answers',()=>{
  const f=fixture(),sourceAnswer={id:uuid(750),case_id:f.input.caseId,scope_month:'2026-06',code:'document_field:synthetic-source',answer_kind:'choice',
   answer:JSON.stringify({action:'confirm'}),answer_revision:1,answer_identity_id:uuid(603),answer_created_at:'2026-07-03T00:00:00Z',
   field_target:{schema_version:'document-row-cell-reading-v1',version_id:f.checkpoint.version_id}};
  f.journal.answers=[sourceAnswer];const link=f.answer();f.journal.answers.push(link);
  expect(link.field_target.reading_dependencies).toEqual([{version_id:f.checkpoint.version_id,request_id:sourceAnswer.id,answer_revision:1,answer_sha256:canonicalSha256(sourceAnswer.answer)}]);
  expect(f.load().readings).toHaveLength(1);
  f.journal.answers[0]={...sourceAnswer,answer_revision:2};expect(f.load().readings).toEqual([]);
  f.journal.answers=[sourceAnswer,link,{...sourceAnswer,id:uuid(751)}];expect(f.load().readings).toEqual([]);
  f.journal.answers=[sourceAnswer,link];expect(f.load().readings).toHaveLength(1);
 });
 it('retains foreign-purchase and legacy unbound pairs only as noncurrent history',()=>{
  const f=fixture(),answer=f.answer();f.journal.answers=[answer];
  f.input.review.purchased_scope.order_id=uuid(710);f.input.review.entitlement_evidence!.order_id=uuid(710);
  expect(f.load().readings).toEqual([]);expect(f.load().history[0].current).toBe(false);
  const pair=answer.field_target.candidates[0];f.journal.answers=[{...answer,code:`document_field:${pair.target_sha256}`,field_target:pair,answer:JSON.stringify({action:'unknown'})}];
  expect(f.load().history[0]).toMatchObject({current:false,action:'unknown'});
 });
 it('rejects source replacement, foreign identity metadata case, and duplicate request entries',()=>{
  const f=fixture(),a=f.answer();f.journal.answers=[a,{...a}];expect(()=>f.load()).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
  f.journal.answers=[{...a,case_id:uuid(720)}];expect(()=>f.load()).toThrow('SAVED_OBLIGATION_PAYMENT_ANSWER_CASE');
  f.journal.answers=[];f.input.currentDocuments=f.input.currentDocuments.map(p=>({...p,sha256:'e'.repeat(64)}));expect(()=>f.load()).toThrow('SAVED_OBLIGATION_PAYMENT_CURRENT_SOURCE');
 });
 it('retains superseded clause question history while only the active new request emits its reading',()=>{
  const f=fixture(),old=f.answer(),amount=obligationPaymentOperands(f.input.review)[0];
  const check=f.input.review.checks.find(c=>documentReviewCalculationInputSchema.safeParse(c.calculation).success&&documentReviewCalculationInputSchema.parse(c.calculation).operands.some(a=>a.observation_id===amount.observation_id))!;
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
  f.input.review.checks.push({...check,check_id:'document.synthetic.new.choice',calculation:{...calculation,operands:calculation.operands.map(a=>a.observation_id===amount.observation_id?{...a,observation_id:`${uuid(761)}:amount`}:a)}});
  const next={...f.answer(),id:uuid(760)};expect(next.field_target.target_sha256).not.toBe(old.field_target.target_sha256);
  f.journal.answers=[old,next];
  f.input.currentRequestStates=[{request_id:old.id,target_sha256:old.field_target.target_sha256,current:false},{request_id:next.id,target_sha256:next.field_target.target_sha256,current:true}];
  const saved=f.load();expect(saved.readings).toHaveLength(1);expect(saved.readings[0].request_id).toBe(next.id);
  expect(saved.history.map(h=>({id:h.request_id,current:h.current}))).toEqual([{id:old.id,current:false},{id:next.id,current:true}]);
 });
 it('fails closed when authenticated current-request state is missing or bound to another target',()=>{
  const f=fixture();f.journal.answers=[f.answer()];f.input.currentRequestStates=[];expect(()=>f.load()).toThrow('SAVED_OBLIGATION_PAYMENT_REQUEST_STATE_REQUIRED');
  f.input.currentRequestStates=[{request_id:uuid(605),target_sha256:'f'.repeat(64),current:true}];expect(()=>f.load()).toThrow('SAVED_OBLIGATION_PAYMENT_REQUEST_STATE_REQUIRED');
 });
 it('opens one wrapper per clause through the protected opener and verifies journal hash',async()=>{
  const t=transaction();await openSavedObligationPaymentLinkRequests(t.context,t.job,'2026-06',t.f.input.review);
  expect(t.opened).toHaveLength(1);expect(t.opened[0]).toMatchObject({schema_version:'obligation-payment-choice-v1',order_id:t.f.input.review.purchased_scope.order_id});
  expect(t.statements.find(q=>q.name==='saved_obligation_payment_journal')?.text).toContain("session_user='tivdoc_worker_runtime'");
  t.tamper();await expect(readSavedObligationPaymentLinks(t.context,t.job,'2026-06',t.f.input.review)).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');
 });
 it('does not reopen a current unknown answer',async()=>{
  const t=transaction();t.f.journal.answers=[t.f.answer('unknown')];expect(await openSavedObligationPaymentLinkRequests(t.context,t.job,'2026-06',t.f.input.review)).toEqual([]);expect(t.opened).toEqual([]);
 });
});
