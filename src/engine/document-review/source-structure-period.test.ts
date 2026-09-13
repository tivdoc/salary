import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizedPayslipExtractionSchema} from '../extraction/payslip.ts';
import {customerSourceStructureReadingV2Schema,type CustomerSourceStructureReading} from '../extraction/source-structure.ts';
import {sourceStructureCandidateSubject,sourceStructureSubject,sourceStructureSubjectKey,normalizeSourceStructureValue,type SourceStructureSelector} from '../extraction/source-structure-resolution.ts';
import {IDENTIFIED_PERIOD_STRUCTURE_POLICY,buildSourceStructurePeriodWitness,assertSourceStructurePeriodWitness,sourceStructureRefs} from '../extraction/source-structure-period.ts';
import {materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import {documentSourceStructureTarget,resolveDocumentSourceStructureVerification,materializeDocumentSourceStructureVerification} from '../../server/product/reports/document-source-structure.ts';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from './payslip-adapter.ts';
import {runDocumentReview,replayDocumentReview} from './service.ts';
import {documentReviewReadingDependencies} from './source-dependencies.ts';
import {documentReviewCalculationInputSchema,calculateDocumentReview,replayDocumentReviewCalculation} from './calculations.ts';
import type {DocumentReviewInput} from './contracts.ts';

const basis={page:1,locator:'Synthetic source block',text:'Synthetic January 2025 source evidence; no customer data'};
function fixture(options:{originalCurrent?:boolean;unknownRows?:boolean;unknownScope?:boolean;lowNumeric?:boolean;recordedTotal?:string}={}){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-identified-period-structure',mode:'real'}),document=f.stored.documents[0],template=f.stored.extractions[0];
 const period={from:'2025-01-01',to:'2025-01-31'},ids={base:randomUUID(),employee:randomUUID(),total:randomUUID(),row1:randomUUID(),row2:randomUUID(),scope:randomUUID()};
 const source=(label:string,current=!!options.originalCurrent)=>({document_id:document.document_id,page:1,text_fragment:label,...(current?{source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current synthetic source'}}:{})});
 const money=(field:string,id:string,raw:string)=>({candidate_id:id,field,raw_value:raw,normalized_value:{currency:'ILS',minor_units:Math.round(Number(raw)*100)},confidence:options.lowNumeric ? .94 : 1,source:source(field),extraction_method:'fixture',warning_flags:[]});
 const row=(id:string,raw:string)=>({component_id:id,source_label:`Synthetic row ${id}`,normalized_label:'deduction',semantic_kind:'deduction',quantity_raw:null,quantity:null,rate_raw:null,rate:null,percentage_raw:null,percentage:null,
  amount_raw:raw,amount:{currency:'ILS',minor_units:Math.round(Number(raw)*100)},confidence:options.lowNumeric ? .94 : 1,source:source(`Synthetic row ${id}`,!options.unknownRows),extraction_method:'fixture',warning_flags:[],normalization_warnings:[]});
 const machine=normalizedPayslipExtractionSchema.parse({...template,document_quality_confidence:1,fields:[...template.fields.filter(c=>c.field==='salary_period'),money('pension_base',ids.base,'2000.00'),money('pension_employee_contribution',ids.employee,'100.00'),money('total_deductions',ids.total,options.recordedTotal??'120.00')],additional_components:[row(ids.row1,'100.00'),row(ids.row2,'20.00')],
  source_scope_observations:options.unknownScope?[{policy_version:'payslip-explicit-source-scope-v1',scope:'voluntary_deduction',source_label:'Synthetic voluntary total',candidate:{candidate_id:ids.scope,field:'total_deductions',raw_value:'20.00',source:source('Synthetic voluntary total',false),confidence:1,extraction_method:'fixture',warning_flags:[]}}]:[]});
 const first=normalizedPayslipExtractionSchema.parse({...machine,extraction_id:randomUUID()}),result={final_extraction:machine,first_pass:{normalized_extraction:first}};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
 const policyVersion='synthetic-period-structure-v2',pins={case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,normalized_extraction_sha256:canonicalSha256(machine),first_pass_extraction_sha256:canonicalSha256(first),extraction_result_sha256:checkpoint.result_sha256,month:'2025-01',policy_version:policyVersion};
 const readings:CustomerSourceStructureReading[]=[],relationSelector:SourceStructureSelector={kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:ids.employee},base:{kind:'field',id:ids.base}};
 const current=()=>new Map(readings.map(r=>[sourceStructureSubjectKey(r.subject),r]));
 const readV1=(selector:SourceStructureSelector,value:unknown)=>{
  const target=documentSourceStructureTarget({checkpoint,policyVersion,selector}),receipt=resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion,caseId:document.case_id,month:'2025-01',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:{schema_version:'document-field-answer-v3',action:'correct',structured_value:value}});
  const parsed=materializeDocumentSourceStructureVerification(receipt,canonicalSha256(machine));if(!parsed)throw Error('SYNTHETIC_READING');readings.push(parsed.reading);return parsed.reading;
 };
 const readPeriod=(refs:{kind:'field'|'component';id:string}[],periodKind:'current'|'cumulative'='current')=>readV1({kind:'period_association',refs},{kind:'period_association',period_kind:periodKind,period,basis});
 const allPeriods=()=>readPeriod([{kind:'field',id:ids.base},{kind:'field',id:ids.employee},{kind:'field',id:ids.total}]);
 const witness=(selector:SourceStructureSelector=relationSelector)=>{
  const subject=sourceStructureCandidateSubject({extraction:machine,firstPass:first,selector}),built=buildSourceStructurePeriodWitness({refs:sourceStructureRefs(subject),period,pins,currentReadings:current()});
  if(!built.witness)throw Error(`SYNTHETIC_PERIOD_${built.state}`);return {subject,witness:built.witness};
 };
 // Synthetic server receipt oracle. The separate server suite proves account
 // and journal authentication; this suite exercises the ordinary engine path.
 const readV2=(selector:SourceStructureSelector,value:unknown)=>{
  const {subject,witness:period_witness}=witness(selector),body={schema_version:'document-source-structure-reading-v2',actor_kind:'customer',...pins,subject,period_witness,value:normalizeSourceStructureValue(subject,value,pins.month),
   target_sha256:canonicalSha256({subject,period_witness,pins}),request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2025-02-02T00:00:00Z',decision_sha256:canonicalSha256({synthetic:'decision',subject,period_witness,value})};
  const reading=customerSourceStructureReadingV2Schema.parse({...body,verification_sha256:canonicalSha256(body)});readings.push(reading);return reading;
 };
 const relation=(fund_kind='pension',relationship='same_base')=>readV2(relationSelector,{kind:'source_relationship',component_kind:'pension_employee',fund_kind,fund_label:'Synthetic product',source_kind:'explicit_reference',relationship,basis});
 const group=(inventory='complete',unknown=false)=>readV2({kind:'deduction_group'},{kind:'deduction_group',inventory,basis,members:[{component_id:ids.row1,group:'mandatory'},{component_id:ids.row2,group:unknown?'unknown':'mandatory'}]});
 const extraction=()=>normalizedPayslipExtractionSchema.parse({...machine,customer_source_structures:readings,source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:first}});
 const build=(optIn=true,topics:DocumentReviewInput['purchased_scope']['topics']=['pension','minimum_wage'])=>reviewInputFromPayslips({case_id:document.case_id,period,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY,...(optIn?{identified_period_structure_policy:IDENTIFIED_PERIOD_STRUCTURE_POLICY}:{}),
  purchased_scope:{order_id:'synthetic-only-order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics},snapshot:{...f.stored,documents:[document],extractions:[extraction()]},
  retained_unresolved_fields:[{case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,checkpoint_result:result,final_extraction_sha256:canonicalSha256(machine),first_pass:first}]});
 const materialize=()=>materializeValidatedPayslipReadings({document,case_id:document.case_id,extraction:extraction(),requireDistinctTargets:true});
 const run=()=>runDocumentReview(build(),'synthetic-period-structure');
 return {document,machine,first,pins,period,checkpoint,ids,readings,relationSelector,current,readV1,readPeriod,allPeriods,witness,readV2,relation,group,extraction,build,materialize,run};
}
function ratio(r:ReturnType<typeof runDocumentReview>){return r.checks.find(c=>c.check_id==='document.0.ratio.pension_employee_contribution')!.calculation;}

describe('versioned current-period structure witnesses',()=>{
 it('keeps the original v1 constructor strict and builds from exact current metadata without mutating the source',()=>{
  const f=fixture(),before=canonicalSha256(f.machine);expect(()=>sourceStructureSubject({extraction:f.machine,firstPass:f.first,selector:f.relationSelector})).toThrow('SOURCE_STRUCTURE_CURRENT_SOURCE_REQUIRED');
  f.allPeriods();const {subject,witness}=f.witness();expect(witness.refs.every(e=>e.basis==='identified_current')).toBe(true);
  expect(sourceStructureSubject({extraction:f.machine,firstPass:f.first,selector:f.relationSelector,period_witness:witness})).toEqual(subject);expect(canonicalSha256(f.machine)).toBe(before);
 });
 it('accepts one independent period receipt covering both exact refs and emits deduplicated period trace hashes',()=>{
  const f=fixture(),period=f.allPeriods();f.relation();const before=canonicalSha256(f.machine),r=f.run(),c=ratio(r);
  expect(c).toMatchObject({state:'calculated',observed_ratio:{numerator:'1',denominator:'20',unit:'ratio'},real_activation_allowed:false,human_attestation:null});
  expect(c).toHaveProperty('source_structure_trace_binding.period_reading_verification_sha256',[period.verification_sha256]);
  expect(c).toHaveProperty('source_structure_trace_binding.period_decision_sha256',[period.decision_sha256]);
  expect(c).toHaveProperty('source_structure_trace_binding.schema_version','document-review-source-structure-trace-v2');
  expect(replayDocumentReview(r)).toEqual(r);expect(canonicalSha256(f.machine)).toBe(before);
 });
 it('validates period readings first regardless of the annotation order',()=>{
  const f=fixture();f.allPeriods();f.relation();f.readings.reverse();expect(f.materialize().structureReadings.size).toBe(2);
 });
 it.each(['absent','negative_latest','changed_receipt','duplicate_overlap','foreign_case','foreign_checkpoint','wrong_ref','forged_hash','cumulative']as const)('rejects a stale or forged v2 prerequisite: %s',state=>{
  const f=fixture();const p=f.allPeriods();f.relation();
  if(state==='absent'||state==='negative_latest')f.readings.splice(0,1); // Authenticated negative decisions materialize no affirmative annotation.
  if(state==='changed_receipt'){
   const {verification_sha256:ignored,...body}=p;void ignored;const changed={...body,answer_revision:2,decision_sha256:'f'.repeat(64)};f.readings[0]={...changed,verification_sha256:canonicalSha256(changed)};
  }
  if(state==='duplicate_overlap')f.readPeriod([{kind:'field',id:f.ids.base}]);
  if(state==='foreign_case'||state==='foreign_checkpoint'||state==='wrong_ref'||state==='forged_hash'){
   const r=f.readings[1];if(r.schema_version!=='document-source-structure-reading-v2')throw Error('SYNTHETIC_V2');
   const w=structuredClone(r.period_witness),e=w.refs[0];if(e.basis!=='identified_current')throw Error('SYNTHETIC_PERIOD');
   const {verification_sha256:ignored,...body}=e.reading;void ignored;
   const changed={...body,...(state==='foreign_case'?{case_id:randomUUID()}:{}),...(state==='foreign_checkpoint'?{extraction_result_sha256:'b'.repeat(64)}:{})};
   e.reading={...changed,verification_sha256:canonicalSha256(changed)};
   if(state==='wrong_ref')e.ref={...e.ref,sha256:'c'.repeat(64)};
   const {verification_sha256:discard,...old}=r;void discard;const next={...old,period_witness:w};
   f.readings[1]={...next,verification_sha256:state==='forged_hash'?'d'.repeat(64):canonicalSha256(next)};
  }
  if(state==='cumulative'){f.readings.splice(0,1);f.readPeriod([{kind:'field',id:f.ids.base},{kind:'field',id:f.ids.employee},{kind:'field',id:f.ids.total}],'cumulative');}
  expect(()=>f.materialize()).toThrow();
 });
 it.each(['unknown','study','different_base']as const)('keeps the independent fund/relationship blocker after period verification: %s',state=>{
  const f=fixture();f.allPeriods();f.relation(state==='different_base'?'pension':state,state==='different_base'?'different_base':'same_base');expect(ratio(f.run()).state).toBe('blocked');
 });
 it('does not turn identified periods or relationships into numeric approval',()=>{
  const f=fixture({lowNumeric:true});f.allPeriods();f.relation();expect(ratio(f.run()).state).toBe('blocked');
 });
 it('emits period prerequisites before a relationship and an exact v2 target dependency afterwards',()=>{
  const f=fixture(),before=f.run(),pending=documentReviewReadingDependencies({review:before,document_id:f.document.document_id,extraction:f.extraction()});
  expect(pending.source_structures?.filter(e=>e.subject.kind==='period_association')).toHaveLength(3);
  expect(pending.row_cells).toEqual([]);f.allPeriods();
  const after=f.run(),dependencies=documentReviewReadingDependencies({review:after,document_id:f.document.document_id,extraction:f.extraction()});
  const relationship=dependencies.source_structures?.find(e=>e.subject.kind==='source_relationship');expect(relationship?.period_witness).toEqual(f.witness().witness);
  expect(ratio(after).state).toBe('blocked');expect(relationship?.check_ids).toEqual(['document.0.ratio.pension_employee_contribution']);
 });
 it('keeps source-period software gaps explicit instead of authorizing scope/deduction-row metadata targets',()=>{
  const f=fixture({unknownRows:true,unknownScope:true}),r=f.run(),deps=documentReviewReadingDependencies({review:r,document_id:f.document.document_id,extraction:f.extraction()});
  expect(deps.unmapped.filter(e=>e.reason==='period_target_unsupported').map(e=>e.operand_id).sort()).toEqual([f.ids.row1,f.ids.row2,f.ids.scope].sort());
  expect(deps.source_structures?.every(e=>e.subject.kind!=='period_association'||e.subject.refs.every(ref=>ref.kind==='field'))).toBe(true);
 });
 it.each(['partial','unknown_member','numeric_unknown']as const)('preserves the independent deduction group guard: %s',state=>{
  const f=fixture({lowNumeric:state==='numeric_unknown'});f.allPeriods();f.group(state==='numeric_unknown'?'complete':'partial',state==='unknown_member');
  expect(f.run().checks.find(c=>c.check_id==='document.0.deductions.mandatory')?.calculation.state).toBe('blocked');
 });
 it.each([['120.00',0],['117.00',300]]as const)('compares the complete identified deduction group with recorded %s after its exact total period is read',(recordedTotal,difference)=>{
  const f=fixture({recordedTotal});f.allPeriods();f.group();const c=f.run().checks.find(c=>c.check_id==='document.0.deductions.mandatory')!.calculation;
  expect(c).toMatchObject({state:'calculated',difference:{kind:'money',minor_units:difference}});expect(c.input.source_structure?.schema_version).toBe('document-review-source-structure-v2');
 });
 it('rejects a removed prerequisite ref even when the enclosing hashes are recomputed',()=>{
  const f=fixture();f.allPeriods();f.relation();const c=ratio(f.run()),input=documentReviewCalculationInputSchema.parse(c.input),s=input.source_structure;
  if(s?.schema_version!=='document-review-source-structure-v2')throw Error('SYNTHETIC_V2');
  expect(()=>calculateDocumentReview({...input,source_structure:{...s,period_witness:{...s.period_witness,refs:s.period_witness.refs.slice(1)}}})).toThrow();
  expect(()=>replayDocumentReviewCalculation({...c,result_sha256:'f'.repeat(64)})).toThrow();
 });
 it('does not accept a v2 reading in a historical v1 calculation witness',()=>{
  const f=fixture();f.allPeriods();f.relation();const c=ratio(f.run()),s=c.input.source_structure;if(!s||s.schema_version!=='document-review-source-structure-v2')throw Error('SYNTHETIC_V2');
  const {period_witness:ignored,...legacy}=s;void ignored;expect(()=>calculateDocumentReview({...c.input,source_structure:{...legacy,schema_version:'document-review-source-structure-v1'}})).toThrow();
 });
 it('keeps original-current v1 source witnesses byte-identical when the optional policy is absent',()=>{
  const f=fixture({originalCurrent:true});f.readV1(f.relationSelector,{kind:'source_relationship',component_kind:'pension_employee',fund_kind:'pension',fund_label:'Synthetic product',source_kind:'explicit_reference',relationship:'same_base',basis});
  const old=runDocumentReview(f.build(false),'synthetic-original-current'),enabled=runDocumentReview(f.build(true),'synthetic-original-current');
  expect(ratio(old)).toEqual(ratio(enabled));expect(ratio(old).input.source_structure?.schema_version).toBe('document-review-source-structure-v1');
  expect(old.input).not.toHaveProperty('source_structure_period_policy');expect(replayDocumentReview(old)).toEqual(old);
 });
 it('requires the complete exact witness ref set even with original-current metadata',()=>{
  const f=fixture({originalCurrent:true}),{subject,witness}=f.witness();
  expect(()=>assertSourceStructurePeriodWitness({witness,refs:sourceStructureRefs(subject).slice(1),period:f.period,pins:f.pins,currentReadings:f.current()})).toThrow();
 });
 it('does not let the original-current v1 fast path ignore a new conflicting period decision under opt-in',()=>{
  const f=fixture({originalCurrent:true});f.readV1(f.relationSelector,{kind:'source_relationship',component_kind:'pension_employee',fund_kind:'pension',fund_label:'Synthetic product',source_kind:'explicit_reference',relationship:'same_base',basis});
  f.readPeriod([{kind:'field',id:f.ids.base}],'cumulative');expect(ratio(f.run()).state).toBe('blocked');
  const legacy=runDocumentReview(f.build(false),'synthetic-legacy-conflict');expect(ratio(legacy).state).toBe('calculated');
 });
});
