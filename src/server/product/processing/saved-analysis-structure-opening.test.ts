import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {documentReadingTargetSchema} from '../reports/document-field-confirmation';
import {createIntegratedFullSystemHarness} from '@/server/engine/case-analysis/integrated-harness';
import type {PostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {runSavedMonthAnalysis} from './saved-analysis';
import {SavedCaseSnapshot} from './saved-snapshot';
import {savedDocumentReviewInput,savedDocumentReviewSourceScope} from './saved-document-review';
import type {SavedOrderScope} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',async original=>({...await original<typeof import('./source-dispatch')>(),lockCurrentSource:vi.fn(async()=>{})}));
vi.mock('./saved-document-review',async original=>({...await original<typeof import('./saved-document-review')>(),savedDocumentReviewInput:vi.fn(),savedDocumentReviewSourceScope:vi.fn(async()=>undefined)}));
afterEach(()=>vi.restoreAllMocks());
function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-review-source-structures',mode:'real'}),d=f.stored.documents[0],template=f.stored.extractions[0];
 const period={from:'2025-01-01',to:'2025-01-31'};
 const source={document_id:d.document_id,page:1,text_fragment:'synthetic current source',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'current'}};
 const ids={base:randomUUID(),employee:randomUUID(),total:randomUUID(),voluntary:randomUUID(),combined:randomUUID(),row1:randomUUID(),row2:randomUUID(),row3:randomUUID(),vacation:randomUUID(),sick:randomUUID()};
 const field=(name:string,id:string,raw:string,value:unknown)=>({candidate_id:id,field:name,raw_value:raw,normalized_value:value,confidence:1,source,extraction_method:'fixture',warning_flags:[]});
 const money=(name:string,id:string,raw:string)=>field(name,id,raw,{currency:'ILS',minor_units:Math.round(Number(raw)*100)});
 const row=(id:string,raw:string)=>({component_id:id,source_label:`synthetic deduction ${id.slice(0,4)}`,normalized_label:'deduction',semantic_kind:'deduction',
  quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:raw,quantity:null,rate:null,percentage:null,amount:{currency:'ILS',minor_units:Number(raw)*100},confidence:1,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]});
 const scope=(id:string,scope:string,field:string,raw:string)=>({scope,source_label:`synthetic ${scope}`,policy_version:'payslip-explicit-source-scope-v1',candidate:{candidate_id:id,field,raw_value:raw,confidence:1,source,extraction_method:'fixture',warning_flags:[]}});
 const machine=normalizedPayslipExtractionSchema.parse({...template,document_quality_confidence:1,fields:[...template.fields.filter(f=>f.field==='salary_period'),money('pension_base',ids.base,'2000.00'),
  money('pension_employee_contribution',ids.employee,'100.00'),money('total_deductions',ids.total,'120.00')],additional_components:[row(ids.row1,'100.00'),row(ids.row2,'20.00'),row(ids.row3,'50.00')],
  source_scope_observations:[scope(ids.voluntary,'voluntary_deduction','total_deductions','50.00'),scope(ids.combined,'combined_employer_funds','pension_employer_contribution','250.00')]});
 const first=normalizedPayslipExtractionSchema.parse({...machine,extraction_id:randomUUID(),fields:[...machine.fields,field('vacation_balance',ids.vacation,'9.00',null),field('sick_balance',ids.sick,'12.00',null)]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2025-01',period_mismatch:false,
  result_sha256:'',run:{result:{final_extraction:machine,first_pass:{normalized_extraction:first}}}};
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};rehash();
 const order:SavedOrderScope={id:randomUUID(),kind:'initial',from:'2025-01-01',to:'2025-01-01',topics:['minimum_wage','pension','vacation'],offer_sha256:'a'.repeat(64)};
 const stored={...f.stored,documents:[d],document_snapshot_sha256:canonicalSha256([d]),extractions:[machine],extraction_snapshot_sha256:canonicalSha256([machine])};
 const review=reviewInputFromPayslips({case_id:d.case_id,period,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY,
  purchased_scope:{order_id:order.id,receipt_sha256:order.offer_sha256,origin:'saved_order',topics:order.topics},snapshot:stored,
  retained_unresolved_fields:[{case_id:d.case_id,document_id:d.document_id,source_sha256:d.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,
   checkpoint_result:checkpoint.run.result,final_extraction_sha256:canonicalSha256(machine),first_pass:first}]});
 // The historical generic questions have no remaining needs in this scenario.
 // Source-structure dependencies are derived independently from actual blocked
 // calculations; they are not fabricated completion entries or findings.
 review.completion_input={...parseReviewCompletionInput(review.completion_input),needs:[]};
 return {stored,review,checkpoint,order};
}
it('opens exact source targets after a real saved analysis even when generic completions are empty',async()=>{
 const f=fixture(),h=createIntegratedFullSystemHarness([]),job:SourceJob={schema_version:'saved-case-work-v1',case_id:f.stored.documents[0].case_id,revision:1,input_sha256:'b'.repeat(64),mode:'draft'};
 vi.spyOn(SavedCaseSnapshot.prototype,'read').mockResolvedValue(f.stored);
 vi.mocked(savedDocumentReviewSourceScope).mockResolvedValue(undefined);
 vi.mocked(savedDocumentReviewInput).mockResolvedValue(f.review);
 const opened:ReturnType<typeof documentReadingTargetSchema.parse>[]=[],events:string[]=[];
 const context:PostgresTransactionContext={transaction_id:'structure-opening-regression',client:{async query(q){events.push(q.name);
  if(q.name==='saved_order_entitlements')return {rows:[{orders:[f.order],current_orders:[f.order]}],row_count:1};
  if(q.name==='saved_analysis_order')return {rows:[{created_at:'2025-02-02T00:00:00Z',engine_revision:1}],row_count:1};
  if(q.name==='review_requests_stage'){
   const saved=await h.repository.getByRunId(String(q.values[0])),stage=saved?.stages.find(s=>s.stage==='topic_results');
   if(!stage)throw Error('EXPECTED_PERSISTED_STAGE');
   return {rows:[{payload:stage.payload,payload_sha256:canonicalSha256(stage.payload)}],row_count:1};
  }
  if(q.name==='review_dependency_checkpoint')return {rows:[{result:f.checkpoint,result_sha256:f.checkpoint.result_sha256}],row_count:1};
  if(q.name==='review_dependency_existing_targets')return {rows:[],row_count:0};
  if(q.name==='review_dependency_request_open'){opened.push(documentReadingTargetSchema.parse(JSON.parse(String(q.values[3]))));return {rows:[{id:randomUUID()}],row_count:1};}
  if(q.name==='review_upload_assessment_inputs'){
   const saved=await h.repository.getByRunId(String(q.values[3]));if(!saved?.bundle?.document_review)throw Error('EXPECTED_SAVED_REVIEW');
   return {rows:[{value:{review:saved.bundle.document_review,current_source_pins:[],items:[]}}],row_count:1};
  }
  throw Error(`UNEXPECTED_SQL:${q.name}`);
 }}};
 const input={context,job,orderId:f.order.id,month:'2025-01',tenantId:`saved-case:${job.case_id}`,
  analysis:{caseAnalysis:h.repository,reports:h.review} as unknown as PostgresAnalysisRepositories};
 const completed=await runSavedMonthAnalysis(input),review=completed.bundle?.document_review;
 expect(completed.completed).toBe(true);expect(review?.completions.customer_requests).toEqual([]);
 expect(events).toContain('review_requests_stage');expect(opened).toHaveLength(8);
 expect(opened.filter(t=>t.schema_version==='document-source-relationship-v1')).toHaveLength(2);
 expect(opened.filter(t=>t.schema_version==='document-source-deduction-group-v1')).toHaveLength(1);
 expect(opened.filter(t=>t.schema_version==='document-source-balance-movement-v1')).toHaveLength(5);
 expect(opened.every(t=>'extraction_result_sha256' in t&&t.extraction_result_sha256===f.checkpoint.result_sha256)).toBe(true);
 expect(events).not.toContain('review_request_open');
 const retry=await runSavedMonthAnalysis(input);expect(retry.report?.report_sha256).toBe(completed.report?.report_sha256);expect(opened).toHaveLength(8);
});
