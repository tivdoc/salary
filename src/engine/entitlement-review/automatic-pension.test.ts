import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {canonicalFactSchema} from '../facts/contracts.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {runDocumentReview} from '../document-review/service.ts';
import {fixture,caseId} from './compose.fixture.ts';
import {attachAutomaticPensionEvidence} from './automatic-pension.ts';
import {composeEntitlementReview} from './compose.ts';
import {pensionEntitlementInputSchema} from './pension/index.ts';
function sample(birthYear=1980){
 const {input,pension}=fixture();delete input.entitlement_evidence;
 const wage=pension.pensionable_wage!;
 input.checks=[{check_id:'synthetic.ratio',topic:'pension',title:'Synthetic observed ratio',explanation:'Independent observed arithmetic, not pension entitlement',calculation:documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'source',check_id:'synthetic.ratio',period:input.period,evaluated_at:'2026-09-12T00:00:00Z',source_manifest:pension.source_manifest,
  operands:[{...wage,id:'amount',observation_id:'synthetic.amount',printed_value:'300.00'},{...wage,id:'base'}],operation:{kind:'observed_ratio',numerator_ref:'amount',denominator_ref:'base',same_period_and_base:true,component_identity:'synthetic employee',basis:'Synthetic same-row source'},remittance_status:'missing'})}];
 const entries=[['employment.still_employed',true],['person.birth_year',birthYear],['pension.fund_at_hire',false]] as const;
 const facts=entries.map(([path,value],i)=>canonicalFactSchema.parse({fact_id:`00000000-0000-4000-8000-00000000000${i}`,case_id:caseId,path,value,status:'needs_confirmation',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:'44444444-4444-4444-8444-444444444444'}}],conflicting_fact_ids:[],resolution:null,created_at:'2026-09-12T00:00:00Z'}));
 const snapshot:StoredCaseInputSnapshot={document_snapshot_id:'synthetic',document_snapshot_sha256:canonicalSha256([]),documents:[],extraction_snapshot_id:'synthetic',extraction_snapshot_sha256:canonicalSha256([]),extractions:[],declared_fact_snapshot:{snapshot_id:'synthetic.questionnaire',snapshot_sha256:canonicalSha256(facts),facts}};
 return {input,snapshot};
}
describe('automatic entitlement evidence from ordinary saved readings and questionnaire',()=>{
 it('reuses scoped declarations without promoting them to legal acceptance or document observations',()=>{
  const {input,snapshot}=sample(),prepared=attachAutomaticPensionEvidence(input,snapshot),e=pensionEntitlementInputSchema.parse(prepared.entitlement_evidence!.pension);
  expect(e.pensionable_wage?.printed_value).toBe('5000.00');expect(e.applicability).toEqual([]);expect(e.recorded).toEqual([]);
  expect(e.facts.employment_end).toMatchObject({state:'known',value:'ongoing',basis:'customer_declaration',source:{reading:'questionnaire_declaration'}});
  expect(e.facts.aged_21_or_more.value).toBe(true);expect(e.facts.under_60.value).toBe(true);
  const r=runDocumentReview(composeEntitlementReview(prepared),'automatic.partial');
  expect(r.completions.customer_requests).toHaveLength(2);expect(r.checks[0].calculation.state).toBe('calculated');
  expect(r.completions.customer_requests.every(q=>!q.target.question.includes('גיל')&&!q.target.question.includes('נמשכת'))).toBe(true);
 });
 it('does not invent an exact birthday at the supported age boundary',()=>{
  const {input,snapshot}=sample(2005),prepared=attachAutomaticPensionEvidence(input,snapshot),e=pensionEntitlementInputSchema.parse(prepared.entitlement_evidence!.pension);
  expect(e.facts.aged_21_or_more.state).toBe('missing');expect(e.facts.under_60.value).toBe(true);
  expect(runDocumentReview(composeEntitlementReview(prepared),'age.boundary').completions.customer_requests).toHaveLength(3);
 });
 it('rejects altered snapshot hashes, foreign declarations and changed transformed values',()=>{
  const {input,snapshot}=sample();expect(()=>attachAutomaticPensionEvidence(input,{...snapshot,declared_fact_snapshot:{...snapshot.declared_fact_snapshot,snapshot_sha256:'f'.repeat(64)}})).toThrow('ENTITLEMENT_DECLARATION_SNAPSHOT_HASH');
  const facts=snapshot.declared_fact_snapshot.facts.map(f=>({...f,case_id:'55555555-5555-4555-8555-555555555555'}));
  expect(()=>attachAutomaticPensionEvidence(input,{...snapshot,declared_fact_snapshot:{...snapshot.declared_fact_snapshot,facts,snapshot_sha256:canonicalSha256(facts)}})).toThrow('ENTITLEMENT_DECLARATION_SCOPE');
  const prepared=attachAutomaticPensionEvidence(input,snapshot),e=pensionEntitlementInputSchema.parse(prepared.entitlement_evidence!.pension);e.facts.under_60.value=false;prepared.entitlement_evidence!.pension=e;
  expect(()=>composeEntitlementReview(prepared)).toThrow('ENTITLEMENT_QUESTIONNAIRE_VALUE');
 });
});
