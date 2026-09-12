import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {runDocumentReview,applyDocumentReviewAnswer,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from './compose.ts';

import {fixture,caseId,actor} from './compose.fixture.ts';
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
  expect(result.checks.filter(c=>c.calculation.state==='calculated')).toHaveLength(3);expect(result.input.answer_history).toHaveLength(1);expect(result.checks.every(c=>c.calculation.input_basis==='includes_customer_declaration')).toBe(true);
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
