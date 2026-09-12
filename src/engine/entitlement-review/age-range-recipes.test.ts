import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {sharedPersonalV3Fixture} from './shared-product-facts-v3.fixture.ts';
import {enableQuestionnaireAgeRangeReuse} from './age-range-materialization.ts';
import {composeEntitlementReview} from './compose.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {assertVacationDerivedFacts} from './vacation/product-facts.ts';
import {assertConvalescenceDerivedPopulation} from './convalescence/product-decisions.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../ai-release-decisions/apply.ts';
import type {AiReleaseDecisionMethod} from '../ai-release-decisions/contracts.ts';
const ids=['mw.population','cv.population','vacation.general_section3','wt.coverage'];
const at='2026-09-12T12:00:00Z';
function source(enabled=true){const input=sharedPersonalV3Fixture(),e=input.entitlement_evidence!;
 const fact=canonicalFactSchema.parse({fact_id:'00000000-0000-4000-8000-000000000001',case_id:input.case_id,path:'person.birth_year',value:1980,status:'confirmed',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'44444444-4444-4444-8444-444444444444'}}],conflicting_fact_ids:[],resolution:null,created_at:at});
 input.entitlement_declarations={schema_version:'entitlement-questionnaire-evidence-v1',snapshot_id:'synthetic.age.methods',snapshot_sha256:canonicalSha256([fact]),period:input.period,facts:[fact]};
 const populate=(p:object,manifest:readonly {document_id:string;kind:string}[],values:Record<string,string|boolean>)=>{
  const document=input.documents.find(d=>manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id))!;
  const s:DocumentReviewSource={document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:1,locator:'Synthetic explicit personal and work context',label:'Synthetic identified factual source',reading:'identified_document_reading',reading_receipt_sha256:document.reading_sha256};
  for(const [key,value]of Object.entries(values))Reflect.set(p,key,{state:'observed',value,source:s});
 };
 const common={employment_relationship:'employee',workplace_sector:'private'};
 const mw=minimumWageEntitlementInputSchema.parse(e.minimum_wage);populate(mw.product_facts!,mw.source_manifest,{...common,adapted_wage_approval:false,special_wage_arrangement:false});mw.applicability=mw.applicability.filter(d=>d.decision_id!=='mw.population');e.minimum_wage=mw;
 const cv=convalescenceEntitlementInputSchema.parse(e.convalescence);populate(cv.product_facts!,cv.source_manifest,{...common,public_wage_linked:false});cv.applicability=cv.applicability.filter(d=>d.decision_id!=='cv.population');e.convalescence=cv;
 const v=vacationEntitlementInputSchema.parse(e.vacation);populate(v.product_facts!,v.source_manifest,{...common,salary_basis:'monthly'});v.applicability=v.applicability.filter(d=>d.decision_id!=='vacation.general_section3');v.facts.aged_21_or_more={state:'missing',value:null,source:null,basis:'ai_source_assessment'};v.facts.under_60={state:'missing',value:null,source:null,basis:'ai_source_assessment'};e.vacation=v;
 e.working_time=workingTimeEntitlementInputSchema.array().parse(e.working_time).map(w=>{populate(w.product_facts!,w.source_manifest,{...common,salary_basis:'hourly',job_duties:'Synthetic ordinary office tasks',occupation_group:'ordinary',company_policy_authority:false,employer_personal_proxy:false,hours_trackable:true,other_hours_terms_known:false});w.applicability=w.applicability.filter(d=>d.decision_id!=='wt.coverage');return w;});
 input.entitlement_evidence=enabled?enableQuestionnaireAgeRangeReuse(e):e;return input;
}
function method(id:string,range=true):AiReleaseDecisionMethod{const recipeId='ai-case.'+id+(range?'.age-range-v1':''),r=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===recipeId);if(!r)throw Error('AGE_RECIPE_NOT_INSTALLED:'+recipeId);
 return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,interpretation_receipt_sha256:canonicalSha256({synthetic_age_recipe:recipeId}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic_source:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
}
function effective(i:DocumentReviewInput){const e=i.entitlement_composition!.evidence;return {mw:minimumWageEntitlementInputSchema.parse(e.minimum_wage),cv:convalescenceEntitlementInputSchema.parse(e.convalescence),vacation:vacationEntitlementInputSchema.parse(e.vacation),working:workingTimeEntitlementInputSchema.array().parse(e.working_time)};}
describe('new pinned age recipes, with old recipe semantics retained',()=>{
 it('admits exactly four factual case recipes and replays the same original year without manufacturing a DOB',()=>{
  const input=source(),result=applyAiReleaseDecisionRecipes({source:input,methods:ids.map(id=>method(id)),at});
  expect(result.receipts.map(r=>r.decision_id).sort()).toEqual([...ids].sort());expect(result.unresolved).toEqual([]);
  expect(result.receipts.every(r=>r.consumed.some(c=>c.path.endsWith('product_age_range')&&c.source_sha256s.length===3))).toBe(true);
  const e=effective(result.source);expect(e.mw.population.state).toBe('derived');expect(e.cv.population.state).toBe('derived');expect(e.vacation.facts.aged_21_or_more.state).toBe('derived');expect(e.working[0].applicability.find(d=>d.decision_id==='wt.coverage')?.state).toBe('accepted');
  expect(()=>assertVacationDerivedFacts(e.vacation)).not.toThrow();expect(()=>assertConvalescenceDerivedPopulation(e.cv)).not.toThrow();
  expect([e.mw,e.cv,e.vacation,...e.working].every(b=>b.product_facts!==undefined&&'birth_date' in b.product_facts&&b.product_facts.birth_date.state==='missing'&&b.product_age_range?.birth_year===1980)).toBe(true);
  expect(result.source.entitlement_declarations).toEqual(input.entitlement_declarations);
  expect(effective(composeEntitlementReview(result.source))).toEqual(e);
 },15000);
 it('does not let old recipes gain the new age semantics or new recipes activate without explicit opt-in',()=>{
  const historical=applyAiReleaseDecisionRecipes({source:source(false),methods:ids.map(id=>method(id,false)),at});expect(historical.receipts).toEqual([]);
  const unenabled=applyAiReleaseDecisionRecipes({source:source(false),methods:ids.map(id=>method(id)),at});expect(unenabled.receipts).toEqual([]);
 });
});
