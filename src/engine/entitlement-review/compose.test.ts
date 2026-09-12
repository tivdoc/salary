import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from './compose.ts';
import {PENSION_APPLICABILITY,pensionEntitlementInputSchema,pensionLegalSource} from './pension/index.ts';

const caseId='11111111-1111-4111-8111-111111111111',actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
function fixture(){
 const sha='a'.repeat(64),period={from:'2026-06-01',to:'2026-06-30'},source={document_id:'synthetic.entitlement.doc',version_id:'synthetic.entitlement.v1',file_sha256:sha,page:1,locator:'synthetic pension wage and factual record',label:'synthetic fixture',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
 const known=<T>(value:T)=>({state:'known',value,source,basis:'ai_source_assessment'});
 const pension=pensionEntitlementInputSchema.parse({schema_version:'pension-entitlement-input-v1',catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',case_id:caseId,run_id:'source.facts',check_prefix:'entitlement.pension',period,evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:caseId}],
  facts:{employment_start:known('2025-01-01'),employment_end:known('ongoing'),prior_coverage_at_start:known(false),continuous_employment:known(true),aged_21_or_more:known(true),under_60:known(true)},
  pensionable_wage:{id:'insured.wage',observation_id:'synthetic.wage',state:'observed',printed_value:'5000.00',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source},eligible_interval_wage:null,
  applicability:Object.keys(PENSION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Isolated synthetic source assessment; no human signature or REAL activation',sources:[pensionLegalSource('order2011',4,decision_id)],valid_until:null})),recorded:[],remittance_status:'missing'});
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage','working_time','rest_day','pension','travel','convalescence','vacation','bonuses','contract'],origin:'legacy_paid_receipt'},
  documents:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'payslip',label:'Synthetic payslip, not a customer',period,reading_origin:'ai_document_review',reading_sha256:sha}],checks:[],coverage_gaps:[],
  completion_input:{case_id:caseId,period,documents:[{pin:{case_id:caseId,document_id:source.document_id,version_id:source.version_id,source_sha256:sha},kind:'payslip',period,review:'complete'}],needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),period,pension}});
 return {input,pension};
}
const answer=(value:string|boolean|null,state:'provided'|'unknown'='provided',revision=1)=>({request_id:'33333333-3333-4333-8333-333333333333',revision,answered_at:`2026-09-12T00:0${revision}:00Z`,state,value});
describe('source packet → ordinary catalog composition → review → identified answer',()=>{
 it('selects pinned rules and calculates same-run results without changing the nine-topic purchase',()=>{
  const {input}=fixture(),before=canonicalSha256(input),prepared=composeEntitlementReview(input),result=runDocumentReview(prepared,'normal.analysis.1');
  expect(result.checks.map(c=>c.calculation.expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(result.input.entitlement_composition?.selections[0]).toMatchObject({topic:'pension',status:'selected_for_review',publication_authority:false});
  expect(result.purchased_scope.topics).toHaveLength(9);expect(result.publication_authority).toBe(false);
  expect(canonicalSha256(input)).toBe(before);expect(composeEntitlementReview(prepared)).toEqual(prepared);expect(replayDocumentReview(result)).toEqual(result);
 });
 it('rejects generated checks changed after selection, and foreign or stale source packets',()=>{
  const {input}=fixture(),prepared=composeEntitlementReview(input);const tampered=structuredClone(prepared);tampered.checks[0].title='Changed without regeneration';
  expect(()=>runDocumentReview(tampered,'forged')).toThrow('ENTITLEMENT_COMPOSITION_REPLAY');
  const foreign=structuredClone(input);foreign.entitlement_evidence!.case_id='foreign';expect(()=>composeEntitlementReview(foreign)).toThrow();
  const stale=structuredClone(input);stale.documents[0].version_id='replaced.source';expect(()=>composeEntitlementReview(stale)).toThrow('ENTITLEMENT_MANIFEST_BINDING');
 });
 it('does not treat missing legal assessments as customer questions or financial approval',()=>{
  const {input,pension}=fixture();pension.applicability=[];input.entitlement_evidence!.pension=pension;
  const result=runDocumentReview(composeEntitlementReview(input),'blocked.real');
  expect(result.checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(result.completions.internal_tasks.length).toBeGreaterThan(0);expect(result.publication_authority).toBe(false);
  expect(result.completions.customer_requests.every(r=>r.target.kind==='factual')).toBe(true);
 });
 it('validates date format before accepting a receipt, and uses the answer in a new analysis',()=>{
  const {input,pension}=fixture();pension.facts.employment_start={...pension.facts.employment_start,state:'missing',value:null,source:null};input.entitlement_evidence!.pension=pension;
  const prepared=composeEntitlementReview(input),old=runDocumentReview(prepared,'before'),request=old.completions.customer_requests.find(r=>r.target.value_validation?.format==='iso_date')!;
  expect(request).toBeDefined();expect(()=>applyDocumentReviewAnswer(prepared,{request,actor,answer:answer('2026-02-30')})).toThrow('REVIEW_COMPLETION_ANSWER_INVALID');
  const next=applyDocumentReviewAnswer(prepared,{request,actor,answer:answer('2025-01-01')}),result=runDocumentReview(next.input,'after');
  expect(result.checks.filter(c=>c.calculation.state==='calculated')).toHaveLength(3);expect(result.input.answer_history).toHaveLength(1);
  expect(result.input.entitlement_evidence).toEqual(input.entitlement_evidence);expect(result.input_sha256).not.toBe(old.input_sha256);
  expect(result.input.entitlement_composition?.evidence.pension).toMatchObject({facts:{employment_start:{state:'known',basis:'customer_declaration',value:'2025-01-01'}}});
  expect(applyDocumentReviewAnswer(next.input,{request,actor,answer:answer('2025-01-01')}).input).toEqual(next.input);
  const unknown=applyDocumentReviewAnswer(next.input,{request,actor,answer:answer(null,'unknown',2)});
  expect(runDocumentReview(unknown.input,'unknown').checks).toHaveLength(0);expect(unknown.input.answer_history).toHaveLength(2);
 });
 it('preserves historic inputs without opting them into a new calculation policy',()=>{
  const {input}=fixture();delete input.entitlement_evidence;expect(composeEntitlementReview(input)).toEqual(input);
  const old=runDocumentReview(input,'historic');expect(old.input.entitlement_composition).toBeUndefined();expect(replayDocumentReview(old)).toEqual(old);
 });
});
