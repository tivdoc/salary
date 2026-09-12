import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {PENSION_STATUTORY_FLOOR_POLICY} from '../entitlement-review/pension/source-fact-contracts.ts';
import {PENSION_FLOOR_SOURCE_REVIEW_SHA256} from '../entitlement-review/pension/sources.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import {sharedPersonalV3Fixture} from '../entitlement-review/shared-product-facts-v3.fixture.ts';
import {enableQuestionnaireAgeRangeReuse} from '../entitlement-review/age-range-materialization.ts';
import {vacationEntitlementInputSchema} from '../entitlement-review/vacation/contracts.ts';
import {assertVacationDerivedFacts,replayVacationProductFacts,vacationProductDecisionSources} from '../entitlement-review/vacation/product-facts.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {runDocumentReview,replayDocumentReview} from '../document-review/service.ts';

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
function vacationAgeSource(enabled=true){
 const input=sharedPersonalV3Fixture(),packet=input.entitlement_evidence!;
 // This regression exercises one vacation receipt; other independent branches
 // belong to the existing shared-age suite and add no coverage here.
 delete packet.minimum_wage;delete packet.pension;delete packet.travel;delete packet.working_time;delete packet.convalescence;delete packet.obligations;
 const fact=canonicalFactSchema.parse({fact_id:'00000000-0000-4000-8000-000000000001',case_id:input.case_id,path:'person.birth_year',value:1980,status:'confirmed',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'44444444-4444-4444-8444-444444444444'}}],conflicting_fact_ids:[],resolution:null,created_at:at});
 input.entitlement_declarations={schema_version:'entitlement-questionnaire-evidence-v1',snapshot_id:'synthetic.locator.age',snapshot_sha256:canonicalSha256([fact]),period:input.period,facts:[fact]};
 const v=vacationEntitlementInputSchema.parse(packet.vacation),doc=input.documents.find(d=>v.source_manifest.some(s=>s.kind==='case_document'&&s.document_id===d.document_id))!;
 const source={document_id:doc.document_id,version_id:doc.version_id,file_sha256:doc.file_sha256,page:1,locator:'Synthetic identified employment facts',label:'Synthetic source',reading:'identified_document_reading' as const,reading_receipt_sha256:doc.reading_sha256};
 const p=v.product_facts!;p.employment_relationship={state:'observed',value:'employee',source};p.workplace_sector={state:'observed',value:'private',source};p.salary_basis={state:'observed',value:'monthly',source};
 v.applicability=v.applicability.filter(d=>d.decision_id!=='vacation.general_section3');
 v.facts.aged_21_or_more={state:'missing',value:null,source:null,basis:'ai_source_assessment'};v.facts.under_60={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 packet.vacation=v;input.entitlement_evidence=enabled?enableQuestionnaireAgeRangeReuse(packet):packet;return input;
}

describe('additive age interval and pension floor case recipes',()=>{
 it('replays a source-corrected vacation age method through the ordinary composer without inventing a birth date',()=>{
  const input=vacationAgeSource(),before=canonicalSha256(input),id='ai-case.vacation.general_section3.age-range-v1.source-page-v2';
  const result=applyAiReleaseDecisionRecipes({source:input,methods:[method(id)],at});
  expect(result.unresolved).toEqual([]);expect(result.receipts).toHaveLength(1);expect(result.receipts[0].recipe_id).toBe(id);
  const effective=vacationEntitlementInputSchema.parse(result.source.entitlement_composition!.evidence.vacation);
  expect(effective.facts.aged_21_or_more.state).toBe('derived');expect(effective.product_facts?.birth_date.state).toBe('missing');
  expect(effective.product_age_range?.birth_year).toBe(1980);expect(result.receipts[0].consumed.some(c=>c.path.endsWith('product_age_range')&&c.source_sha256s.length===3)).toBe(true);
  expect(vacationProductDecisionSources(effective,'vacation.general_section3').some(s=>s.reading==='questionnaire_declaration')).toBe(true);
  expect(()=>assertVacationDerivedFacts(effective)).not.toThrow();expect(composeEntitlementReview(result.source)).toEqual(result.source);
  const review=runDocumentReview(result.source,'synthetic.locator.age');expect(replayDocumentReview(review)).toEqual(review);expect(canonicalSha256(input)).toBe(before);
 });
 it('retains the exact age opt-in guard for both corrected vacation descendants',()=>{
  const age='ai-case.vacation.general_section3.age-range-v1.source-page-v2',ordinary='ai-case.vacation.general_section3.source-page-v2';
  for(const [input,id]of [[vacationAgeSource(false),age],[vacationAgeSource(true),ordinary]] as const){
   const result=applyAiReleaseDecisionRecipes({source:input,methods:[method(id)],at});expect(result.receipts).toEqual([]);expect(result.unresolved[0].reason).toBe('age_recipe_policy_not_selected');
  }
 });
 it('makes a corrected vacation receipt stale after a consumed employment fact changes and rejects tampered pins',()=>{
  const input=vacationAgeSource(),id='ai-case.vacation.general_section3.age-range-v1.source-page-v2',m=method(id);
  const result=applyAiReleaseDecisionRecipes({source:input,methods:[m],at}),effective=vacationEntitlementInputSchema.parse(result.source.entitlement_composition!.evidence.vacation),raw=vacationEntitlementInputSchema.parse(result.source.entitlement_evidence!.vacation);
  raw.product_facts!.employment_relationship={...raw.product_facts!.employment_relationship,state:'unknown',value:null};
  const replayed=replayVacationProductFacts({...effective,product_facts:raw.product_facts},raw,result.source);
  expect(replayed.applicability.find(d=>d.decision_id==='vacation.general_section3')?.state).toBe('stale');expect(replayed.facts.aged_21_or_more.state).toBe('missing');
  expect(applyAiReleaseDecisionRecipes({source:input,methods:[{...m,recipe_sha256:h('tampered locator pin')}],at}).unresolved[0].reason).toBe('method_pin_mismatch');
 });
 it('adds four travel floor recipes to the 54 existing recipes and retains each age parent separately',()=>{
  const beforePageCorrections=AI_RELEASE_DECISION_RECIPES.filter(r=>!('source_locator_policy'in r)&&!('protected_break_policy'in r));
  expect(beforePageCorrections).toHaveLength(58);
  expect(new Set(beforePageCorrections.map(r=>r.recipe_id)).size).toBe(58);
  const additions=AI_RELEASE_DECISION_RECIPES.filter(r=>r.recipe_id.startsWith('ai-case.travel.')&&r.recipe_id.endsWith('.floor-v2'));
  expect(additions.map(r=>r.decision_id)).toEqual(['travel.general_coverage','travel.fare_basis','travel.ticket_options','travel.general_order_floor']);
  expect(beforePageCorrections.filter(r=>!additions.includes(r))).toHaveLength(54);
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
