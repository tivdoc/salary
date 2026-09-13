import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from './contracts.ts';
import {runDocumentReview,applyDocumentReviewAnswer} from './service.ts';
import {enhanceDocumentReviewNightEntitlements,isNightEntitlementReviewDocument,isPinnedNightEntitlementLegalDocument,nightEntitlementReviewDocument} from './night-entitlement-adapter.ts';
import {syntheticNightInput} from '../legal-operations/document-review-entitlement-night-work.fixture.ts';

const caseId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const raw=syntheticNightInput(),e={...raw,case_id:caseId,source_manifest:raw.source_manifest.map(s=>({...s,case_id:caseId}))};
 const source=e.intervals[0].clock_source;
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period:e.period,
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['working_time'],origin:'saved_order'},
  documents:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'attendance',label:'מסמך בדיקה',period:e.period,reading_origin:'ai_document_review',reading_sha256:source.reading_receipt_sha256}],checks:[],coverage_gaps:[],
  completion_input:{case_id:caseId,period:e.period,documents:[{pin:{case_id:caseId,document_id:source.document_id,version_id:source.version_id,source_sha256:source.file_sha256},kind:'attendance',period:e.period,review:'complete'}],needs:[],evidence:[]}});
 return {e,input};
}
describe('ordinary document-review entitlement composition',()=>{
 it('uses the constructor, same-run ordinary review, exact-law pin and repeatable result',()=>{
  const {e,input}=fixture(),before=canonicalSha256(input),enhanced=enhanceDocumentReviewNightEntitlements(input,[{entitlement:e}]);
  const result=runDocumentReview(enhanced,'synthetic.analysis.new');expect(result.analysis_run_id).toBe('synthetic.analysis.new');
  expect(result.checks[0].calculation).toMatchObject({state:'calculated',input:{run_id:'synthetic.analysis.new'},expected:{minor_units:44000},difference:{minor_units:4000}});
  expect(result.legal_debt_total).toBeNull();expect(result.publication_authority).toBe(false);
  expect(enhanced.documents.filter(isNightEntitlementReviewDocument)).toHaveLength(1);expect(canonicalSha256(input)).toBe(before);
  expect(enhanceDocumentReviewNightEntitlements(enhanced,[{entitlement:e}])).toEqual(enhanced);
 });
 it('routes unknown coverage to internal research, not a customer legal approval',()=>{
  const {e,input}=fixture();const changed={...e,applicability:e.applicability.map(d=>d.decision_id==='night.coverage'?{...d,state:'unknown' as const}:d)};
  const result=runDocumentReview(enhanceDocumentReviewNightEntitlements(input,[{entitlement:changed}]),'synthetic.analysis.new');
  expect(result.checks[0].calculation.state).toBe('blocked');expect(result.completions.internal_tasks).toHaveLength(1);expect(result.completions.customer_requests).toHaveLength(0);
 });
 it('preserves unknown conditions beside calculated counterfactual output',()=>{
  const {e,input}=fixture();const changed={...e,mode:'all_presence_is_work_scenario' as const,intervals:e.intervals.map(i=>({...i,classification:'unresolved_rest' as const})),
   applicability:e.applicability.map(d=>d.decision_id==='night.breaks'?{...d,state:'unknown' as const}:d),conditional_assumptions:[{decision_id:'night.breaks',explanation:'Only if all presence was work; no fact acceptance.'}]};
  const result=runDocumentReview(enhanceDocumentReviewNightEntitlements(input,[{entitlement:changed}]),'synthetic.analysis.new');
  expect(result.checks[0].calculation).toMatchObject({counterfactual_only:true,unresolved_conditions:[{decision:{state:'unknown'}}]});
  expect(result.completions.customer_requests).toHaveLength(1);expect(result.completions.customer_requests[0].target.required_evidence_kind).toBe('customer_declaration');
 });
 it('keeps free-text answer history and internal reassessment without automatic legal acceptance',()=>{
  const {e,input}=fixture();const changed={...e,mode:'all_presence_is_work_scenario' as const,intervals:e.intervals.map(i=>({...i,classification:'unresolved_rest' as const})),
   applicability:e.applicability.map(d=>d.decision_id==='night.breaks'?{...d,state:'unknown' as const}:d),conditional_assumptions:[{decision_id:'night.breaks',explanation:'If all presence was work; not established.'}]};
  const enhanced=enhanceDocumentReviewNightEntitlements(input,[{entitlement:changed}]);const previous=runDocumentReview(enhanced,'before.answer');
  const next=applyDocumentReviewAnswer(enhanced,{request:previous.completions.customer_requests[0],actor:{case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'},
   answer:{request_id:'33333333-3333-4333-8333-333333333333',revision:1,answered_at:'2026-09-11T13:00:00Z',state:'provided',value:'Synthetic identified statement about availability; no legal conclusion.'}});
  const result=runDocumentReview(next.input,'after.answer');expect(result.input_sha256).not.toBe(previous.input_sha256);expect(result.input.answer_history).toHaveLength(1);
  expect(result.completions.customer_requests).toHaveLength(0);expect(result.completions.internal_tasks).toHaveLength(1);
  expect(result.checks[0].calculation).toMatchObject({counterfactual_only:true,unresolved_conditions:[{decision:{state:'unknown'}}],real_activation_allowed:false});
 });
 it('pins the public law document to the current case without accepting extra metadata',()=>{
  const law=nightEntitlementReviewDocument(caseId);expect(isPinnedNightEntitlementLegalDocument(law,caseId)).toBe(true);
  expect(isPinnedNightEntitlementLegalDocument(law,'foreign')).toBe(false);expect(isPinnedNightEntitlementLegalDocument({...law,extra:undefined},caseId)).toBe(false);
  expect(isPinnedNightEntitlementLegalDocument({...law,accepted_reading_sha256:['f'.repeat(64)]},caseId)).toBe(false);
 });
 it('does not invent calculations for missing dated attendance and reuses an explicit existing upload target',()=>{
  const {e,input}=fixture();const missing={...e,intervals:[],payroll_allocations:[]};
  const base:DocumentReviewInput={...input,coverage_gaps:[{check_id:'existing.attendance.gap',topic:'working_time',kind:'missing_source',detail:'Missing source',next_step:'Upload dated attendance'}],completion_input:{case_id:caseId,period:e.period,documents:[],evidence:[],needs:[{fact_key:'existing.dated.hours',kind:'document',reason:'missing',required_evidence_kind:'document',question:'נא לצרף נוכחות מתוארכת',answer_kind:'document',document_kind:'attendance',source_pins:[],dependent_check_ids:['existing.attendance.gap'],general_question:false}]}};
  const result=runDocumentReview(enhanceDocumentReviewNightEntitlements(base,[{entitlement:missing,completion_fact_keys:{'night.dated_attendance':'existing.dated.hours'}}]),'synthetic.analysis');
  expect(result.checks).toHaveLength(0);expect(result.completions.customer_requests.filter(r=>r.target.fact_key==='existing.dated.hours')).toHaveLength(1);
  expect(result.completions.customer_requests.find(r=>r.target.fact_key==='existing.dated.hours')?.dependent_check_ids).toContain(e.check_id);
 });
 it('refuses different case/source reading/law pin or unpurchased subject',()=>{
  const {e,input}=fixture();expect(()=>enhanceDocumentReviewNightEntitlements(input,[{entitlement:{...e,case_id:'foreign'}}])).toThrow('NIGHT_REVIEW_CONTEXT');
  expect(()=>enhanceDocumentReviewNightEntitlements(input,[{entitlement:{...e,hourly_wage:{...e.hourly_wage,source:{...e.hourly_wage.source,reading_receipt_sha256:'e'.repeat(64)}}}}])).toThrow('NIGHT_REVIEW_READING_SOURCE');
  expect(()=>enhanceDocumentReviewNightEntitlements({...input,purchased_scope:{...input.purchased_scope,topics:['pension']}},[{entitlement:e}])).toThrow('NIGHT_REVIEW_UNPURCHASED');
  const enhanced=enhanceDocumentReviewNightEntitlements(input,[{entitlement:e}]);enhanced.documents[1]={...enhanced.documents[1],file_sha256:'e'.repeat(64)};
  expect(()=>enhanceDocumentReviewNightEntitlements(enhanced,[{entitlement:e}])).toThrow('NIGHT_REVIEW_LAW_PIN');
 });
});
