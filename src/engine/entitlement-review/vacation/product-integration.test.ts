import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../../document-review/service.ts';
import {composeEntitlementReview} from '../compose.ts';
import {vacationFixture} from '../product-branch.fixture.ts';
import {vacationEntitlementInputSchema} from './contracts.ts';
import {vacationProductFacts} from './product-facts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../../ai-release-decisions/apply.ts';
import type {AiReleaseDecisionMethod} from '../../ai-release-decisions/contracts.ts';

const caseId='11111111-1111-4111-8111-111111111111',actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'},at='2026-09-12T12:00:00Z';
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id==='ai-case.vacation.'+id);if(!r)throw Error('VACATION_TEST_COMPILED_RECIPE_REQUIRED');return {recipe_id:r.recipe_id,recipe_version:'1',recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,interpretation_receipt_sha256:canonicalSha256({synthetic:id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function base(options:{scenario?:true;money?:{wage:string;recorded:string}}={}){const p=vacationFixture();
 if(options.scenario){p.product_scenario_policy='vacation-qualified-statutory-scenario-v1';p.applicability=p.applicability.filter(d=>d.decision_id!=='vacation.no_better_arrangement');}
 if(options.money){const original=p.seniority_year!;p.leave_pay={mode:'monthly_maintained_wage',leave_period:{from:'2026-06-01',to:'2026-06-30'},wage:{...original,id:'source.wage',observation_id:'source.wage',printed_value:options.money.wage,representation:'money_ils',quantity_unit:null},recorded:{...original,id:'source.recorded',observation_id:'source.recorded',printed_value:options.money.recorded,representation:'money_ils',quantity_unit:null}};}
p.case_id=caseId;p.source_manifest[0].case_id=caseId;p.product_facts=vacationProductFacts();p.seniority_year=null;
 for(const key of ['aged_21_or_more','under_60'] as const)p.facts[key]={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 p.applicability=p.applicability.filter(d=>!['vacation.general_section3','vacation.seniority_basis'].includes(d.decision_id));
 const source=p.annual_basis!.employment_start.source!;
 return composeEntitlementReview(documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period:p.period,purchased_scope:{order_id:'synthetic-order',receipt_sha256:'a'.repeat(64),topics:['vacation'],origin:'saved_order'},documents:[{...p.source_manifest[0],kind:'payslip',period:p.period,label:'Synthetic accepted vacation inputs',reading_origin:'provider_extraction',reading_sha256:source.reading_receipt_sha256}],checks:[],coverage_gaps:[],completion_input:{case_id:caseId,period:p.period,documents:[{pin:{case_id:caseId,document_id:source.document_id,version_id:source.version_id,source_sha256:source.file_sha256},kind:'payslip',period:p.period,review:'partial'}],needs:[],evidence:[]},entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic-order',receipt_sha256:'a'.repeat(64),period:p.period,vacation:p}}));
}
function find(input:ReturnType<typeof base>,fragment:string){const r=runDocumentReview(input,'question.lookup').completions.customer_requests.find(r=>r.target.question.includes(fragment));if(!r)throw Error('VACATION_TEST_QUESTION_REQUIRED '+fragment);return r;}
function answers(initial=base()){let source=initial;const values=[['תאריך הלידה','1990-02-15'],['איך הועסקת','שכיר/ה'],['סוג מקום','מעסיק פרטי'],['השכר נקבע','חודשי'],['תקופת העבודה','כן']];
 for(const [i,[key,value]]of values.entries())source=applyDocumentReviewAnswer(source,{request:find(source,key),actor,answer:{request_id:`33333333-3333-4333-8333-${String(i+1).padStart(12,'0')}`,revision:1,answered_at:at,state:'provided',value}}).input;
 return source;
}
describe('vacation ordinary source questions, internal case recipe and RuleSpec',()=>{
 it('produces annual quota through five authenticated factual answers without a fake seniority observation',()=>{
  const s=answers(),rawBefore=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation),a=applyAiReleaseDecisionRecipes({source:s,methods:[method('general_section3'),method('seniority_basis')],at});expect(a.receipts).toHaveLength(2);
  const r=runDocumentReview(a.source,'vacation.ordinary'),q=r.checks.find(c=>c.check_id.endsWith('annual.quota'))!;
  expect(q.calculation).toMatchObject({state:'calculated',expected:{kind:'integer',value:16,unit:'calendar_days'}});
  expect(q.calculation.input.operands.some(o=>o.observation_id.includes('seniority'))).toBe(false);
  const p=vacationEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.vacation),raw=vacationEntitlementInputSchema.parse(a.source.entitlement_evidence!.vacation);
  expect(p.derived_seniority).toMatchObject({state:'derived',value:1,employment_start:'2026-01-01'});expect(p.facts.aged_21_or_more.state).toBe('derived');expect(raw.seniority_year).toBeNull();expect(raw.derived_seniority).toBeUndefined();expect(rawBefore.product_facts?.birth_date.state).toBe('missing');expect(a.source.answer_history).toHaveLength(5);expect(replayDocumentReview(r)).toEqual(r);
 });
 it('keeps unknown and later valid corrections stale until a fresh own decision receipt',()=>{
  const s=answers(),birth=find(base(),'תאריך הלידה'),a=applyAiReleaseDecisionRecipes({source:s,methods:[method('general_section3'),method('seniority_basis')],at});
  const unknown=applyDocumentReviewAnswer(a.source,{request:birth,actor,answer:{request_id:'33333333-3333-4333-8333-000000000001',revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}}).input;
  expect(runDocumentReview(unknown,'vacation.unknown').checks.some(c=>c.calculation.state==='calculated')).toBe(false);
  const changed=applyDocumentReviewAnswer(unknown,{request:birth,actor,answer:{request_id:'33333333-3333-4333-8333-000000000001',revision:3,answered_at:'2026-09-12T12:02:00Z',state:'provided',value:'1991-02-15'}}).input;
  expect(vacationEntitlementInputSchema.parse(changed.entitlement_composition!.evidence.vacation).applicability.find(d=>d.decision_id==='vacation.general_section3')?.state).toBe('stale');expect(changed.answer_history).toHaveLength(7);expect(vacationEntitlementInputSchema.parse(changed.entitlement_composition!.evidence.vacation).facts.aged_21_or_more.state).toBe('missing');
 });
 it('does not use a source-derived annual quota as monthly accrual or a money total',()=>{
  const a=applyAiReleaseDecisionRecipes({source:answers(),methods:[method('general_section3'),method('seniority_basis')],at}),r=runDocumentReview(a.source,'vacation.units');
  expect(r.checks.filter(c=>c.check_id.includes('annual.')).every(c=>c.calculation.expected===null||c.calculation.expected.kind==='integer')).toBe(true);
  expect(vacationEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.vacation).leave_pay).toBeNull();
 });
 it('keeps no-better applicability unresolved when the only new evidence is a factual awareness answer',()=>{
  let source=base({scenario:true});
  source=applyDocumentReviewAnswer(source,{request:find(source,'תנאי חופשה נוספים'),actor,answer:{request_id:'33333333-3333-4333-8333-000000000099',revision:1,answered_at:at,state:'provided',value:'לא ידועים לי תנאים נוספים'}}).input;
  expect(vacationEntitlementInputSchema.parse(source.entitlement_composition!.evidence.vacation).applicability.some(d=>d.decision_id==='vacation.no_better_arrangement'&&d.state==='accepted')).toBe(false);
 });
 it('keeps an opt-in statutory scenario explicitly conditional and removes it on unknown correction',()=>{
  let source=answers(base({scenario:true}));const request=find(source,'תנאי חופשה נוספים');
  source=applyDocumentReviewAnswer(source,{request,actor,answer:{request_id:'33333333-3333-4333-8333-000000000099',revision:1,answered_at:at,state:'provided',value:'לא ידועים לי תנאים נוספים'}}).input;
  const accepted=applyAiReleaseDecisionRecipes({source,methods:[method('general_section3'),method('seniority_basis')],at}).source;
  const result=runDocumentReview(accepted,'vacation.conditional').checks.find(c=>c.check_id.endsWith('annual.quota'))!.calculation;
  expect(result).toMatchObject({state:'calculated',counterfactual_only:true});expect(result.unresolved_conditions?.[0].decision.state).toBe('missing');
  const corrected=applyDocumentReviewAnswer(accepted,{request,actor,answer:{request_id:'33333333-3333-4333-8333-000000000099',revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}}).input;
  expect(vacationEntitlementInputSchema.parse(corrected.entitlement_composition!.evidence.vacation).conditional_assumptions).toBeUndefined();
  expect(runDocumentReview(corrected,'vacation.conditional.unknown').checks.find(c=>c.check_id.endsWith('annual.quota'))!.calculation.state).toBe('blocked');
 });
 it.each([{wage:'0.00',recorded:'0.00',difference:0},{wage:'600.00',recorded:'800.00',difference:-20000}])('preserves zero and signed comparison through ordinary executor: $difference',money=>{
  const source=answers(base({money})),a=applyAiReleaseDecisionRecipes({source,methods:[method('general_section3'),method('seniority_basis')],at}),r=runDocumentReview(a.source,'vacation.money');
  const result=r.checks.find(c=>c.check_id.endsWith('pay.comparison'))!.calculation;
  expect(result).toMatchObject({state:'calculated',difference:{kind:'money',currency:'ILS',minor_units:money.difference}});expect(replayDocumentReview(r)).toEqual(r);
 });
});
