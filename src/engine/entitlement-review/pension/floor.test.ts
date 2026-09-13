import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview} from '../../document-review/calculations.ts';
import {fixture} from '../compose.fixture.ts';
import {resolvePensionEntitlement,PENSION_FLOOR_APPLICABILITY,pensionLegalSource} from './index.ts';
import {PENSION_STATUTORY_FLOOR_POLICY} from './source-fact-contracts.ts';
import {pensionProductReview} from '../pension-product.ts';
function floor(){const f=fixture();f.pension.calculation_policy=PENSION_STATUTORY_FLOOR_POLICY;
 f.pension.applicability=f.pension.applicability.filter(d=>d.decision_id!=='pension.no_better_arrangement');
 f.pension.applicability.push({decision_id:'pension.statutory_floor',state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic scoped floor assessment for this unit test only',sources:[pensionLegalSource('order2016',2,'section 3'),pensionLegalSource('order2011',4,'sections 5 and 6')],valid_until:null});return f;}
describe('versioned pension statutory floor',()=>{
 it('leaves every v1 output byte unchanged when the opt-in is absent',()=>{
  const f=fixture(),before=canonicalSha256(resolvePensionEntitlement(f.pension));const changed=structuredClone(f.pension);delete changed.calculation_policy;
  expect(canonicalSha256(resolvePensionEntitlement(changed))).toBe(before);expect(resolvePensionEntitlement(changed).catalog.catalog_version).toBe('1.0.0');
 });
 it('calculates 300/325/300 as a floor while the complete arrangement stays explicitly unresolved',()=>{
  const f=floor(),r=resolvePensionEntitlement(f.pension);expect(r.checks.map(c=>calculateDocumentReview(c.calculation).expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(r.gaps.find(g=>g.dependency_id==='pension.complete_arrangement')).toMatchObject({kind:'missing_applicability',dependent_check_ids:['entitlement.pension.complete_arrangement']});
  expect(r.rule_metadata).toMatchObject({complete_arrangement_compliance_assessed:false,zero_difference_establishes_compliance:false});
  expect(r.checks.every(c=>c.title.includes('רצפה בלבד'))).toBe(true);expect(f.pension.applicability.some(d=>d.decision_id==='pension.no_better_arrangement')).toBe(false);
  expect(pensionProductReview(f.input,f.pension).selections[0]).toMatchObject({catalog_version:'2.0.0',source_policy_sha256:r.rule_metadata.source_review_sha256});
 });
 it('does not let the policy flag accept its new method or the source-base decision',()=>{
  const f=floor();f.pension.applicability=f.pension.applicability.filter(d=>d.decision_id!=='pension.statutory_floor');
  expect(resolvePensionEntitlement(f.pension).checks.every(c=>calculateDocumentReview(c.calculation).state==='blocked')).toBe(true);
  expect(Object.keys(PENSION_FLOOR_APPLICABILITY)).toContain('pension.pensionable_wage');
 });
 it('keeps sourced zero and the statutory cap and never replaces missing wages with zero',()=>{
  const f=floor();f.pension.pensionable_wage!.printed_value='0.00';expect(resolvePensionEntitlement(f.pension).checks.map(c=>calculateDocumentReview(c.calculation).expected)).toEqual([0,0,0].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  f.pension.pensionable_wage!.printed_value='20000.00';expect(resolvePensionEntitlement(f.pension).checks.map(c=>calculateDocumentReview(c.calculation).expected)).toEqual([82614,89499,82614].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  f.pension.pensionable_wage=null;expect(resolvePensionEntitlement(f.pension).checks).toEqual([]);
 });
 it('retains an explicit counterfactual when the printed-base classification remains unknown',()=>{
  const f=floor(),d=f.pension.applicability.find(d=>d.decision_id==='pension.pensionable_wage')!;d.state='unknown';f.pension.conditional_assumptions=[{decision_id:d.decision_id as 'pension.pensionable_wage',explanation:'If this identified printed base is the relevant pensionable wage; classification has not been established.'}];
  const out=resolvePensionEntitlement(f.pension).checks.map(c=>calculateDocumentReview(c.calculation));expect(out.every(c=>c.state==='calculated'&&c.unresolved_conditions?.length===1)).toBe(true);
  d.state='conflict';expect(()=>resolvePensionEntitlement(f.pension).checks.map(c=>calculateDocumentReview(c.calculation))).toThrow('DOCUMENT_REVIEW_ASSUMPTION_NOT_UNRESOLVED_SOURCED_DECISION');
 });
});
