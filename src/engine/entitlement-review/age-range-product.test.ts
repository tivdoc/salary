import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import {sharedPersonalV3Fixture} from './shared-product-facts-v3.fixture.ts';
import {composeEntitlementReview} from './compose.ts';
import {runDocumentReview,applyDocumentReviewAnswer} from '../document-review/service.ts';
import {enableQuestionnaireAgeRangeReuse} from './age-range-materialization.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {assertEntitlementSourcePacket} from './source-admission.ts';
import {entitlementLegalDocuments} from './legal-documents.ts';
import {productAgeRangeSelection} from './product-age-range.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
function sample(year=1980,enabled=true){const input=sharedPersonalV3Fixture();
 const fact=canonicalFactSchema.parse({fact_id:'00000000-0000-4000-8000-000000000001',case_id:input.case_id,path:'person.birth_year',value:year,status:'confirmed',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'44444444-4444-4444-8444-444444444444'}}],conflicting_fact_ids:[],resolution:null,created_at:'2026-09-12T00:00:00Z'});
 input.entitlement_declarations={schema_version:'entitlement-questionnaire-evidence-v1',snapshot_id:'synthetic.year',snapshot_sha256:canonicalSha256([fact]),period:input.period,facts:[fact]};
 if(enabled)input.entitlement_evidence=enableQuestionnaireAgeRangeReuse(input.entitlement_evidence!);return input;
}
function branches(input:DocumentReviewInput){const e=input.entitlement_composition!.evidence;return [minimumWageEntitlementInputSchema.parse(e.minimum_wage),convalescenceEntitlementInputSchema.parse(e.convalescence),vacationEntitlementInputSchema.parse(e.vacation),...workingTimeEntitlementInputSchema.array().parse(e.working_time)];}
describe('ordinary source questionnaire year reuse',()=>{
 it('removes exactly one shared DOB action while retaining raw facts and independent legal conditions',()=>{
  const old=runDocumentReview(composeEntitlementReview(sample(1980,false)),'age.old'),input=sample(),hash=canonicalSha256(input.entitlement_evidence),composed=composeEntitlementReview(input),current=runDocumentReview(composed,'age.range');
  expect(old.input.entitlement_composition!.shared_personal_facts!.groups).toHaveLength(3);expect(current.input.entitlement_composition!.shared_personal_facts!.groups).toHaveLength(2);
  expect(old.completions.customer_requests.length-current.completions.customer_requests.length).toBe(1);
  expect(branches(composed).every(b=>b.product_age_range?.birth_year===1980&&b.product_facts!==undefined&&'birth_date' in b.product_facts&&b.product_facts.birth_date.state==='missing')).toBe(true);
  expect(canonicalSha256(composed.entitlement_evidence)).toBe(hash);expect(composed.answer_history).toEqual([]);
  expect(branches(composed).every(b=>b.applicability.every(d=>!d.explanation.includes('questionnaire-age-range-proof-v1')))).toBe(true);
 });
 it.each([1966,2005])('retains the actual DOB question for boundary year %i',year=>{
  const review=runDocumentReview(composeEntitlementReview(sample(year)),'age.boundary');expect(review.input.entitlement_composition!.shared_personal_facts!.groups.some(g=>g.fact==='birth_date')).toBe(true);
 });
 it('rejects an altered effective range instead of accepting its recalculated outer hash',()=>{
  const s=composeEntitlementReview(sample()),e=structuredClone(s.entitlement_composition!.evidence),m=minimumWageEntitlementInputSchema.parse(e.minimum_wage),proof=m.product_age_range!;
  proof.birth_year=1981;const {sha256:_,...body}=proof;void _;proof.sha256=canonicalSha256(body);e.minimum_wage=m;
  expect(()=>assertEntitlementSourcePacket(s,e,entitlementLegalDocuments(s.case_id))).toThrow('AGE_RANGE_MATERIALIZATION_REPLAY');
 });
 it('retains an earlier identified DOB answer and reports its conflict with the year without changing other facts',()=>{
  const old=composeEntitlementReview(sample(1980,false)),report=runDocumentReview(old,'age.before'),group=old.entitlement_composition!.shared_personal_facts!.groups.find(g=>g.fact==='birth_date')!,request=report.completions.customer_requests.find(r=>r.target.target_sha256===group.canonical_target_sha256)!;
  const answered=applyDocumentReviewAnswer(old,{request,actor:{case_id:old.case_id,identity_id:'22222222-2222-4222-8222-222222222222'},answer:{request_id:'55555555-5555-4555-8555-000000000001',revision:1,answered_at:'2026-09-12T12:00:00Z',state:'provided',value:'1981-04-15'}}).input;
  const history=canonicalSha256(answered.answer_history),upgraded=sample();upgraded.answer_history=answered.answer_history;upgraded.completion_input=answered.completion_input;
  const current=composeEntitlementReview(upgraded);
  expect(branches(current).every(b=>b.product_facts!==undefined&&'birth_date' in b.product_facts&&b.product_facts.birth_date.value==='1981-04-15'&&productAgeRangeSelection(b,b.product_facts.birth_date,current).reason==='birth_date_conflicts_with_retained_birth_year')).toBe(true);
  expect(canonicalSha256(current.answer_history)).toBe(history);expect(branches(current).every(b=>b.product_facts!==undefined&&'employment_relationship' in b.product_facts&&b.product_facts.employment_relationship.state==='missing')).toBe(true);
  const unknown=applyDocumentReviewAnswer(current,{request,actor:{case_id:current.case_id,identity_id:'22222222-2222-4222-8222-222222222222'},answer:{request_id:'55555555-5555-4555-8555-000000000001',revision:2,answered_at:'2026-09-12T12:01:00Z',state:'unknown',value:null}}).input;
  expect(branches(unknown).every(b=>b.product_facts!==undefined&&'birth_date' in b.product_facts&&b.product_facts.birth_date.state==='unknown'&&b.product_age_range===undefined)).toBe(true);
  expect(unknown.answer_history).toHaveLength(2);expect(unknown.answer_history[0]).toEqual(current.answer_history[0]);expect(unknown.entitlement_declarations).toEqual(current.entitlement_declarations);
 },15000);
});
