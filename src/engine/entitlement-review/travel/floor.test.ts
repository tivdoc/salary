import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,replayDocumentReviewCalculation} from '../../document-review/calculations.ts';
import {composeEntitlementReview} from '../compose.ts';
import {simpleEntitlementProduct} from '../simple-product.ts';
import {entitlementLegalDocuments} from '../legal-documents.ts';
import {resolveTravelEntitlement,TRAVEL_GENERAL_ORDER_FLOOR_POLICY,TRAVEL_FLOOR_SOURCE_REVIEW,TRAVEL_SOURCE_REVIEW_SHA256,travelProductFactQuestions} from './index.ts';
import {travelFloorFixture,travelFloorReview} from './floor.fixture.ts';
describe('additive travel general order floor',()=>{
 it.each([['190.00',1000],['200.00',0],['210.00',-1000]] as const)('retains expected 200 and signed difference against %s without approving complete rights',(paid,difference)=>{
  const t=travelFloorFixture();t.recorded!.printed_value=paid;const r=resolveTravelEntitlement(t),results=r.checks.map(c=>calculateDocumentReview(c.calculation));
  expect(results[0]).toMatchObject({state:'calculated',expected:{minor_units:20000}});expect(results[1].difference).toMatchObject({minor_units:difference});
  expect(results.map(replayDocumentReviewCalculation)).toEqual(results);expect(r.rule_metadata).toMatchObject({complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false,real_activation_allowed:false});
  expect(r.gaps).toEqual([expect.objectContaining({dependency_id:'travel.complete_arrangement',dependent_check_ids:['synthetic.travel.complete_arrangement']})]);
  expect(t.applicability.some(d=>d.decision_id==='travel.no_better_arrangement')).toBe(false);expect(r.checks.every(c=>c.title.includes('רצפ'))).toBe(true);
 });
 it.each(['no_need','employer_both','free_both','no_commute_days'] as const)('uses a sourced %s zero without asking tariff or better-arrangement awareness',kind=>{
  const t=travelFloorFixture();if(kind==='no_need')t.facts.needs_transport.value=false;if(kind==='employer_both')t.facts.employer_transport.value='both';if(kind==='free_both')t.facts.free_travel.value='both';if(kind==='no_commute_days')t.commute_days!.printed_value='0';
  t.discounted_daily_fare=null;t.monthly_pass_cost=null;t.monthly_pass={state:'unknown',value:null,source:null,basis:'ai_source_assessment'};
  const r=resolveTravelEntitlement(t);expect(calculateDocumentReview(r.checks[0].calculation)).toMatchObject({state:'calculated',expected:{minor_units:0}});
  expect(r.gaps.map(g=>g.dependency_id)).toEqual(['travel.complete_arrangement']);expect(travelProductFactQuestions(t)).toEqual([]);
 });
 it('keeps missing/unknown method and current-source uncertainty separate from the case facts',()=>{
  const t=travelFloorFixture();t.applicability=t.applicability.filter(d=>d.decision_id!=='travel.general_order_floor');
  const r=resolveTravelEntitlement(t);expect(r.checks.every(c=>calculateDocumentReview(c.calculation).state==='blocked')).toBe(true);
  expect(r.gaps.some(g=>g.dependency_id==='travel.general_order_floor')).toBe(true);expect(TRAVEL_FLOOR_SOURCE_REVIEW.currentness_index.complete_amendment_chain_verified).toBe(false);
  expect(r.gaps.find(g=>g.dependency_id==='travel.general_order_floor')!.question).toContain('שרשרת התיקונים');
 });
 it.each(['missing','unknown','unreadable','conflict','stale'] as const)('does not replace %s fare with the order cap',state=>{
  const t=travelFloorFixture();t.discounted_daily_fare={...t.discounted_daily_fare!,state,printed_value:null};const r=resolveTravelEntitlement(t);
  expect(r.checks).toEqual([]);expect(r.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'travel.discounted_daily_fare',state})]));
 });
 it('requires a current sourced floor assessment and preserves independent unknown no-better history',()=>{
  const t=travelFloorFixture(),floor=t.applicability.find(d=>d.decision_id==='travel.general_order_floor')!;
  floor.valid_until=t.evaluated_at;expect(resolveTravelEntitlement(t).checks.every(c=>calculateDocumentReview(c.calculation).state==='blocked')).toBe(true);
  floor.valid_until=null;t.applicability.push({decision_id:'travel.no_better_arrangement',state:'unknown',basis:'ai_source_assessment',explanation:'Retained unknown arrangement history',sources:[],valid_until:null});
  expect(calculateDocumentReview(resolveTravelEntitlement(t).checks[0].calculation).state).toBe('calculated');expect(t.applicability.at(-1)!.state).toBe('unknown');
  t.source_manifest[0].case_id='foreign';expect(()=>resolveTravelEntitlement(t)).toThrow('TRAVEL_CASE_SOURCE_BINDING');
 });
 it('selects v2 through ordinary composition and leaves v1 legal documents/source policy unchanged',()=>{
  const old=travelFloorFixture(false),oldResult=resolveTravelEntitlement(old);expect(oldResult.catalog.catalog_version).toBe('1.0.0');expect(oldResult.rule_metadata.source_review_sha256).toBe(TRAVEL_SOURCE_REVIEW_SHA256);
  expect(entitlementLegalDocuments(old.case_id,['travel'])).toHaveLength(1);
  expect(entitlementLegalDocuments(old.case_id,['travel'],{travel_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY})).toHaveLength(2);
  const t=travelFloorFixture(),input=travelFloorReview(t),out=composeEntitlementReview(input);
  expect(out.entitlement_composition!.selections[0].catalog_version).toBe('2.0.0');expect(composeEntitlementReview(out)).toEqual(out);
  const projected=simpleEntitlementProduct(input,'travel',t);expect(projected.needs.some(n=>n.dependent_check_ids.includes('synthetic.travel.complete_arrangement'))).toBe(false);
  expect(projected.gaps.some(g=>g.check_id==='synthetic.travel.complete_arrangement')).toBe(true);expect(canonicalSha256(resolveTravelEntitlement(old))).toBe(canonicalSha256(oldResult));
 });
});
