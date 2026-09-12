import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {PENSION_STATUTORY_FLOOR_POLICY} from '../entitlement-review/pension/source-fact-contracts.ts';
import {PENSION_FLOOR_SOURCE_REVIEW_SHA256} from '../entitlement-review/pension/sources.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';

const at='2026-09-12T10:00:00Z',h=(label:string)=>canonicalSha256({synthetic:label});
const ageIds=['ai-case.mw.population','ai-case.cv.population','ai-case.vacation.general_section3','ai-case.wt.coverage'];
function recipe(id:string){const result=AI_RELEASE_DECISION_RECIPES.find(value=>value.recipe_id===id);if(!result)throw Error('RECIPE_FIXTURE');return result;}
function method(id:string):AiReleaseDecisionMethod{
 const r=recipe(id);
 return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
  interpretation_receipt_sha256:h('bounded synthetic method'),source_receipts:[...new Map(r.legal_sources.map(source=>[source.version_id,
   {receipt_sha256:h(source.version_id),source_version_id:source.version_id,artifact_sha256:source.file_sha256}])).values()],
  issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
}
function floorSource(){
 const source=nineTopicRuntimeSource(),packet=source.entitlement_evidence;
 if(!packet)throw Error('PACKET_FIXTURE');
 const pension=pensionEntitlementInputSchema.parse(packet.pension);
 pension.calculation_policy=PENSION_STATUTORY_FLOOR_POLICY;
 pension.applicability=pension.applicability.filter(decision=>decision.decision_id!=='pension.statutory_floor');
 packet.pension=pension;
 return source;
}

describe('additive age interval and pension floor case recipes',()=>{
 it('adds four travel floor recipes to the 54 existing recipes and retains each age parent separately',()=>{
  expect(AI_RELEASE_DECISION_RECIPES).toHaveLength(58);
  expect(new Set(AI_RELEASE_DECISION_RECIPES.map(r=>r.recipe_id)).size).toBe(58);
  const additions=AI_RELEASE_DECISION_RECIPES.filter(r=>r.recipe_id.startsWith('ai-case.travel.')&&r.recipe_id.endsWith('.floor-v2'));
  expect(additions.map(r=>r.decision_id)).toEqual(['travel.general_coverage','travel.fare_basis','travel.ticket_options','travel.general_order_floor']);
  expect(AI_RELEASE_DECISION_RECIPES.filter(r=>!additions.includes(r))).toHaveLength(54);
  for(const id of ageIds){
   const parent=recipe(id),next=recipe(id+'.age-range-v1');
   expect(next).toMatchObject({decision_id:parent.decision_id,parent_recipe_sha256:parent.recipe_sha256,
    age_range_policy:'questionnaire-age-range-reuse-v1',source_policy_sha256:parent.source_policy_sha256});
   expect(next.legal_sources).toEqual(parent.legal_sources);
   expect(next.recipe_sha256).not.toBe(parent.recipe_sha256);
   expect('age_range_policy'in parent).toBe(false);
   const {recipe_sha256,...body}=parent;expect(canonicalSha256(body)).toBe(recipe_sha256);
  }
 });
 it.each(ageIds)('does not upgrade a historical packet merely because %s age method is supplied',id=>{
  const source=nineTopicRuntimeSource(),before=canonicalSha256(source);
  const result=applyAiReleaseDecisionRecipes({source,methods:[method(id+'.age-range-v1')],at});
  expect(result.source).toBe(source);expect(canonicalSha256(source)).toBe(before);expect(result.receipts).toEqual([]);
  expect(result.unresolved.some(row=>row.decision_id===recipe(id).decision_id&&row.reason==='age_recipe_policy_not_selected')).toBe(true);
 });
 it('requires the floor packet and preserves the separate complete-arrangement gap',()=>{
  const m=method('ai-case.pension.statutory_floor.floor-v2');
  expect(m.source_policy_sha256).toBe(PENSION_FLOOR_SOURCE_REVIEW_SHA256);
  const historical=applyAiReleaseDecisionRecipes({source:nineTopicRuntimeSource(),methods:[m],at});
  expect(historical.receipts).toEqual([]);expect(historical.unresolved[0].reason).toBe('pension_recipe_policy_not_selected');
  const source=floorSource(),before=canonicalSha256(source),result=applyAiReleaseDecisionRecipes({source,methods:[m],at});
  expect(result.receipts).toHaveLength(1);expect(result.receipts[0]).toMatchObject({decision_id:'pension.statutory_floor',actor_kind:'ai_reviewer',human_attestation:null});
  expect(result.source.coverage_gaps.some(gap=>gap.check_id.includes('complete_arrangement'))).toBe(true);
  expect(canonicalSha256(source)).toBe(before);
 });
 it('rejects a v1 case method in a floor packet before it can create incompatible bindings',()=>{
  const result=applyAiReleaseDecisionRecipes({source:floorSource(),methods:[method('ai-case.pension.general_coverage')],at});
  expect(result.receipts).toEqual([]);expect(result.unresolved[0].reason).toBe('pension_recipe_policy_not_selected');
 });
 it('preserves an explicit unknown floor decision and checks the exact method window/source',()=>{
  const source=floorSource(),p=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension),r=recipe('ai-case.pension.statutory_floor.floor-v2');
  p.applicability.push({decision_id:r.decision_id,state:'unknown',basis:'ai_source_assessment',explanation:'Synthetic deliberate unresolved decision.',sources:[...r.legal_sources],valid_until:null});
  source.entitlement_evidence!.pension=p;
  const kept=applyAiReleaseDecisionRecipes({source,methods:[method(r.recipe_id)],at});
  expect(kept.receipts).toEqual([]);expect(kept.unresolved[0].reason).toBe('existing_decision_preserved');
  const expired=method(r.recipe_id);expired.expires_at=at;
  expect(applyAiReleaseDecisionRecipes({source:floorSource(),methods:[expired],at}).unresolved[0].reason).toBe('method_not_current');
  const foreign=method(r.recipe_id);foreign.source_receipts[0].artifact_sha256=h('foreign source bytes');
  expect(applyAiReleaseDecisionRecipes({source:floorSource(),methods:[foreign],at}).unresolved[0].reason).toBe('legal_source_receipt_mismatch');
 });
});
