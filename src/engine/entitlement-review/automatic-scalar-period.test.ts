import {describe,it,expect} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import type {CustomerSourceStructureReading} from '../extraction/source-structure.ts';
import {documentSourceStructureTarget,resolveDocumentSourceStructureVerification,materializeDocumentSourceStructureVerification} from '../../server/product/reports/document-source-structure.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {attachAutomaticPensionEvidence} from './automatic-pension.ts';
import {attachAutomaticBenefitsEvidence} from './automatic-benefits.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';

const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
function fixture(label:'unknown'|'current'|'cumulative'='unknown'){
 const base=buildSyntheticCaseFixture({fixture_id:'synthetic-scalar-period-consumers',mode:'real'}),period={from:'2026-06-01',to:'2026-06-30'};
 const document={...base.stored.documents[0],document_period:{start_date:period.from,end_date:period.to}};
 const field=(name:string,raw:string,value:unknown,confidence=.94)=>({candidate_id:uuid(name),field:name,raw_value:raw,normalized_value:value,confidence,warning_flags:[],extraction_method:'fixture',
  source:{document_id:document.document_id,page:1,text_fragment:`Synthetic ${name}: ${raw}`,source_scope:{period_kind:name==='salary_period'?'current':label,fund_kind:'unknown',column_label:'Synthetic marked column'}}});
 const machine=normalizedPayslipExtractionSchema.parse({...base.stored.extractions[0],extracted_at:'2026-07-02T00:00:00Z',document_quality_confidence:1,
  fields:[field('salary_period','06/2026',{year:2026,month:6,start_date:period.from,end_date:period.to},1),
   field('pension_base','5000.00',{currency:'ILS',minor_units:500000}),field('convalescence_amount','2257.50',{currency:'ILS',minor_units:225750})],additional_components:[]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:uuid('product-document'),version_id:document.document_id,
  input_sha256:document.content_sha256,expected_month:'2026-06',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:machine,first_pass:{normalized_extraction:machine}}}};
 checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const numbers=machine.fields.filter(f=>f.field!=='salary_period').map(f=>({actor_kind:'customer' as const,case_id:document.case_id,document_id:document.document_id,
  candidate_id:f.candidate_id,source_sha256:document.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(machine),candidate_sha256:canonicalSha256(f),
  extraction_result_sha256:checkpoint.result_sha256,target_sha256:canonicalSha256({numeric:f.candidate_id}),month:'2026-06',request_id:uuid(['numeric',f.candidate_id]),answer_revision:1,identity_id:uuid('identity'),confirmed_at:'2026-07-03T00:00:00Z'}));
 const read=(name:'pension_base'|'convalescence_amount',action:'correct'|'unknown'|'unreadable'='correct',kind:'current'|'retroactive'='current')=>{
  const target=documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-period-consumers-v1',selector:{kind:'period_association',refs:[{kind:'field',id:uuid(name)}]}});
  const answer=action==='correct'?{schema_version:'document-field-answer-v3',action,structured_value:{kind:'period_association',period_kind:kind,
   period:kind==='current'?period:{from:'2026-05-01',to:'2026-05-31'},basis:{page:1,locator:`Synthetic ${name} month label`,text:'Explicit source period of this exact field'}}}:{schema_version:'document-field-answer-v3',action};
  const verified=resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion:target.policy_version,caseId:document.case_id,month:'2026-06',
   requestId:uuid(['period',name]),answerRevision:1,identityId:uuid('identity'),answeredAt:'2026-09-12T12:00:00Z',answer});
  return materializeDocumentSourceStructureVerification(verified,canonicalSha256(machine))?.reading;
 };
 const snapshot=(structures:CustomerSourceStructureReading[]=[],numeric=true)=>({...base.stored,documents:[document],
  extractions:[normalizedPayslipExtractionSchema.parse({...machine,...(numeric?{customer_readings:numbers}:{}),customer_source_structures:structures,
   source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:machine}})],
  declared_fact_snapshot:{snapshot_id:'synthetic.scalar-period.questionnaire',snapshot_sha256:canonicalSha256([]),facts:[]}});
 const project=(structures:CustomerSourceStructureReading[]=[],numeric=true)=>{
  const saved=snapshot(structures,numeric),input=reviewInputFromPayslips({case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.scalar-period.order',receipt_sha256:'f'.repeat(64),origin:'saved_order',topics:['pension','convalescence']},snapshot:saved,review_policy:PAYSLIP_REVIEW_POLICY});
  const result=attachAutomaticBenefitsEvidence(attachAutomaticPensionEvidence(input,saved,{source_facts:true}),saved);
  return {result,pension:pensionEntitlementInputSchema.parse(result.entitlement_evidence!.pension),convalescence:convalescenceEntitlementInputSchema.parse(result.entitlement_evidence!.convalescence),saved};
 };
 const readings=()=>{const p=read('pension_base'),c=read('convalescence_amount');if(!p||!c)throw Error('TEST_PERIOD_READINGS');return [p,c];};
 return {machine,numbers,read,readings,project,snapshot};
}
describe('exact period metadata propagates into ordinary scalar consumers',()=>{
 it('requires a separate period receipt and then reuses the same already identified amounts',()=>{
  const f=fixture(),before=canonicalSha256(f.machine),pending=f.project();expect(pending.pension.pensionable_wage).toBeNull();expect(pending.convalescence.recorded).toBeNull();
  const readings=f.readings(),out=f.project(readings);
  expect(out.pension.pensionable_wage).toMatchObject({state:'observed',printed_value:'5000.00',source:{reading:'identified_document_reading'}});
  expect(out.convalescence.recorded).toMatchObject({state:'observed',printed_value:'2257.50',source:{reading:'identified_document_reading'}});
  expect(out.pension.applicability).toEqual([]);expect(out.convalescence.applicability).toEqual([]);expect(out.convalescence.payment_coverage.state).toBe('missing');
  expect(out.saved.extractions[0].customer_readings).toEqual(f.numbers);expect(canonicalSha256(f.machine)).toBe(before);
  expect(out.saved.extractions[0].fields).toEqual(f.machine.fields);expect(payslipMachineExtractionSha256(out.saved.extractions[0])).toBe(before);
  expect(f.project(readings)).toEqual(out);
 });
 it('does not let period metadata authorize unconfirmed .94 numeric cells',()=>{
  const f=fixture(),out=f.project(f.readings(),false);expect(out.pension.pensionable_wage).toBeNull();expect(out.convalescence.recorded).toBeNull();
 });
 it('consumes only the exact field association and keeps unrelated periods missing',()=>{
  const f=fixture(),reading=f.read('pension_base');if(!reading)throw Error('TEST_PERIOD_READING');const out=f.project([reading]);
  expect(out.pension.pensionable_wage?.printed_value).toBe('5000.00');expect(out.convalescence.recorded).toBeNull();
 });
 it.each(['unknown','unreadable'] as const)('%s metadata keeps amounts intact but cannot supply their period',action=>{
  const f=fixture();expect(f.read('pension_base',action)).toBeUndefined();expect(f.read('convalescence_amount',action)).toBeUndefined();
  const out=f.project();expect(out.pension.pensionable_wage).toBeNull();expect(out.convalescence.recorded).toBeNull();expect(out.saved.extractions[0].customer_readings).toEqual(f.numbers);
 });
 it('a correction to a prior month blocks only that field, never selecting it by amount',()=>{
  const f=fixture(),p=f.read('pension_base','correct','retroactive'),c=f.read('convalescence_amount');if(!p||!c)throw Error('TEST_PERIOD_READINGS');
  const out=f.project([p,c]);expect(out.pension.pensionable_wage).toBeNull();expect(out.convalescence.recorded?.printed_value).toBe('2257.50');
 });
 it('preserves a conflicting printed cumulative label despite an asserted current-month reading',()=>{
  const f=fixture('cumulative'),out=f.project(f.readings());expect(out.pension.pensionable_wage).toBeNull();expect(out.convalescence.recorded).toBeNull();
  expect(f.machine.fields[1].source.source_scope?.period_kind).toBe('cumulative');
 });
 it.each(['case_id','source_sha256','extraction_result_sha256'] as const)('rejects resealed foreign or stale %s metadata',key=>{
  const f=fixture(),readings=f.readings(),original=readings[0],{verification_sha256,...body}=original;void verification_sha256;
  const changed={...body,[key]:key==='case_id'?uuid('foreign'):'e'.repeat(64)};
  const forged={...changed,verification_sha256:canonicalSha256(changed)};
  expect(()=>f.project([forged,readings[1]])).toThrow('DOCUMENT_SOURCE_STRUCTURE_BINDING_MISMATCH');
 });
 it('preserves the historical already-current source path without metadata receipts',()=>{
  const f=fixture('current'),out=f.project();expect(out.pension.pensionable_wage?.printed_value).toBe('5000.00');expect(out.convalescence.recorded?.printed_value).toBe('2257.50');
  expect(out.saved.extractions[0].customer_source_structures).toEqual([]);
 });
});
