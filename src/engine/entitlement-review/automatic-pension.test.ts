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
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {PENSION_STATUTORY_FLOOR_POLICY} from './pension/source-fact-contracts.ts';
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

function savedBase(confidence=1,identified=false){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-automatic-pension-base',mode:'real'}),document={...f.stored.documents[0],document_period:{start_date:'2026-06-01',end_date:'2026-06-30'}},period={from:'2026-06-01',to:'2026-06-30'};
 const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const source={document_id:document.document_id,page:1,text_fragment:'Synthetic pension base current month',source_scope:{period_kind:'current',fund_kind:'pension',column_label:'current'}};
 const field=(field:string,id:number,value:unknown,raw_value:string,c=confidence)=>({candidate_id:uid(id),field,normalized_value:value,raw_value,source,confidence:c,extraction_method:'fixture',warning_flags:[]});
 const machine=normalizedPayslipExtractionSchema.parse({...f.stored.extractions[0],document_quality_confidence:1,fields:[field('salary_period',1,{year:2026,month:6,start_date:period.from,end_date:period.to},'06/2026',1),field('pension_base',2,{currency:'ILS',minor_units:500000},'5000.00')],additional_components:[]});
 const extraction=normalizedPayslipExtractionSchema.parse({...machine,...(identified?{customer_readings:[{actor_kind:'customer',case_id:document.case_id,document_id:document.document_id,candidate_id:uid(2),source_sha256:document.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(machine),candidate_sha256:canonicalSha256(machine.fields[1]),extraction_result_sha256:'c'.repeat(64),target_sha256:'d'.repeat(64),month:'2026-06',request_id:uid(3),answer_revision:1,identity_id:uid(4),confirmed_at:'2026-09-12T00:00:00Z'}]}:{})});
 const snapshot:StoredCaseInputSnapshot={...f.stored,documents:[document],extractions:[extraction],declared_fact_snapshot:{snapshot_id:'synthetic.empty',snapshot_sha256:canonicalSha256([]),facts:[]}};
 const input=reviewInputFromPayslips({case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.pension.order',receipt_sha256:'f'.repeat(64),origin:'saved_order',topics:['pension']},snapshot,review_policy:PAYSLIP_REVIEW_POLICY});
 return {snapshot,input};
}
describe('versioned ordinary pension source selection',()=>{
 it('selects the confirmed current base without a contribution or a ratio and leaves all legal decisions absent',()=>{
  const f=savedBase(),before=canonicalSha256(f.snapshot);expect(f.input.checks).toHaveLength(0);
  const r=attachAutomaticPensionEvidence(f.input,f.snapshot,{source_facts:true}),p=pensionEntitlementInputSchema.parse(r.entitlement_evidence!.pension);
  expect(p.pensionable_wage).toMatchObject({state:'observed',printed_value:'5000.00',source:{reading:'provider_extraction'}});expect(p.calculation_policy).toBe(PENSION_STATUTORY_FLOOR_POLICY);
  expect(p.source_facts?.wage_basis.state).toBe('missing');expect(p.applicability).toEqual([]);expect(p.recorded).toEqual([]);expect(canonicalSha256(f.snapshot)).toBe(before);
 });
 it('preserves the .94 guard and accepts the same base only after its exact identified reading',()=>{
  const f=savedBase(.94),r=attachAutomaticPensionEvidence(f.input,f.snapshot,{source_facts:true});expect(pensionEntitlementInputSchema.parse(r.entitlement_evidence!.pension).pensionable_wage).toBeNull();
  const identified=savedBase(.94,true),next=attachAutomaticPensionEvidence(identified.input,identified.snapshot,{source_facts:true});expect(pensionEntitlementInputSchema.parse(next.entitlement_evidence!.pension).pensionable_wage).toMatchObject({printed_value:'5000.00',source:{reading:'identified_document_reading'}});
 });
 it('does not trust an input-only numeric ratio when the saved snapshot has no such source',()=>{
  const f=sample();const r=attachAutomaticPensionEvidence(f.input,f.snapshot,{source_facts:true});expect(pensionEntitlementInputSchema.parse(r.entitlement_evidence!.pension).pensionable_wage).toBeNull();
 });
 it('preserves existing source branches and refuses a foreign saved document',()=>{
  const f=savedBase(),previous={schema_version:'entitlement-source-evidence-v1' as const,case_id:f.input.case_id,order_id:f.input.purchased_scope.order_id,receipt_sha256:f.input.purchased_scope.receipt_sha256,period:f.input.period,working_time:[{unparsed:'existing immutable branch'}]};
  const r=attachAutomaticPensionEvidence({...f.input,entitlement_evidence:previous},f.snapshot,{source_facts:true});expect(r.entitlement_evidence?.working_time).toEqual(previous.working_time);
  expect(()=>attachAutomaticPensionEvidence(f.input,{...f.snapshot,documents:f.snapshot.documents.map(d=>({...d,case_id:'55555555-5555-4555-8555-555555555555'}))},{source_facts:true})).toThrow('AUTOMATIC_PENSION_SOURCE_CASE');
 });
});
