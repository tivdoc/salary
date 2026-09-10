import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {extractionResultSchema,type PayslipFieldKey} from './contracts.ts';
import {syntheticPayslipFixtures} from './fixtures/source-fixtures.ts';
import {normalizePayslipExtraction} from './normalization.ts';
import {assessExtractionConfidence,criticalFieldThresholds} from './confidence-policy.ts';
import {validatePayslipGate0,gate0ValidationSchema,type Gate0CriticalContext} from './validation.ts';
import {buildPassEvaluation,resolvePayslipExtractionPasses,payslipExtractionV2ResultSchema,PAYSLIP_V2_RESOLUTION_POLICY_VERSION} from './v2.ts';
import {PAYSLIP_V21_RESOLUTION_POLICY_VERSION,payslipExtractionV21ResultSchema,recoveryDecisionForV21,resolvePayslipExtractionPassesV21} from './v21.ts';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base=syntheticPayslipFixtures[0].extraction;
const observation=(fields:readonly {field:PayslipFieldKey;raw:string;confidence?:number}[])=>extractionResultSchema.parse({...structuredClone(base),
 document_quality_confidence:0.96,earnings_components_complete:false,additional_components:[],fields:fields.map((field,index)=>({
  candidate_id:uuid(91000+index),field:field.field,raw_value:field.raw,confidence:field.confidence??0.94,
  source:{document_id:base.document_id,page:1,text_fragment:`${field.field}: ${field.raw}`},extraction_method:'ai_vision',warning_flags:[],
 }))});
const assessment=(raw:ReturnType<typeof observation>,context:Gate0CriticalContext={})=>{
 const extraction=normalizePayslipExtraction(raw),validation=validatePayslipGate0(extraction,{reference_year:2026,critical_context:context});
 return {extraction,validation,result:assessExtractionConfidence(extraction,validation)};
};

describe('critical confidence decisions retain source and Gate0 signals',()=>{
 it('keeps the P95 thresholds unchanged',()=>{
  expect(Object.values(criticalFieldThresholds).every(value=>value===0.95)).toBe(true);
 });

 // Minimal observed values/context from live-checkpoint-he-scan-clear.json,
 // source SHA 6a7225348270f9b8351b053c8b274b9686e5d17ffdf547d3d456059911a9b526.
 // The source omitted salary_type/total_deductions. This does not repair the
 // provider's omitted cells, pension columns, or the original failed receipt.
 it('assesses observed scan hours without a salary-type cell and retains missing visible deductions',()=>{
  const raw=observation([{field:'salary_period',raw:'01/06/2026 - 30/06/2026'},{field:'regular_hours',raw:'100'},
   {field:'hourly_rate',raw:'35.40'},{field:'base_monthly_salary',raw:'3,540.00'},{field:'gross_salary',raw:'4,608.70'},
   {field:'net_salary',raw:'4,196.30'}]);
  const before=structuredClone(raw),{extraction,validation,result}=assessment(raw,{hourly_analysis_implied:true,totals_section_visible:true});
  expect(extraction.fields.some(field=>field.field==='salary_type')).toBe(false);
  expect(validation.issues).toContainEqual(expect.objectContaining({code:'critical_field_missing',field_keys:['total_deductions']}));
  for(const field of ['regular_hours','hourly_rate'])expect(result.decisions.find(d=>d.field===field)).toMatchObject({
   applicable:true,status:'needs_confirmation',effective_confidence:0.94,threshold:0.95,reason_codes:expect.arrayContaining(['below_field_threshold'])});
  expect(result.decisions.find(d=>d.field==='total_deductions')).toMatchObject({applicable:true,status:'needs_confirmation',candidate_ids:[],
   effective_confidence:0,reason_codes:expect.arrayContaining(['critical_field_missing'])});
  expect(raw).toEqual(before);expect(extraction.fields.every(field=>field.confidence===0.94)).toBe(true);
 });

 // he-missing-hours retained Gate0 critical_field_missing/recovery_conflict for
 // hourly_rate and regular_hours after refusing overtime-row recovery readings.
 it('does not mark missing or conflicting recovery hours as inapplicable',()=>{
  const {extraction,validation}=assessment(observation([{field:'gross_salary',raw:'4,608.70'},{field:'net_salary',raw:'4,196.30'}]),{hourly_analysis_implied:true});
  const withConflict=gate0ValidationSchema.parse({...validation,issues:[...validation.issues,{code:'recovery_conflict',severity:'confirmation',
   field_candidate_ids:[],field_keys:['hourly_rate','regular_hours'],message:'Retained recovery observations disagreed.'}]});
  const before=canonicalSha256({extraction,withConflict}),result=assessExtractionConfidence(extraction,withConflict);
  for(const field of ['regular_hours','hourly_rate'])expect(result.decisions.find(d=>d.field===field)).toMatchObject({
   applicable:true,status:'needs_confirmation',effective_confidence:0,candidate_ids:[],reason_codes:expect.arrayContaining(['critical_field_missing'])});
  expect(canonicalSha256({extraction,withConflict})).toBe(before);
  expect(extraction.fields.some(field=>field.field==='regular_hours'||field.field==='hourly_rate')).toBe(false);
 });

 it('retains monthly hours as not applicable when no hourly evidence or requirement exists',()=>{
  const fixture=syntheticPayslipFixtures.find(item=>item.fixture_id==='clean_monthly')!;
  const {result}=assessment(fixture.extraction);
  for(const field of ['regular_hours','hourly_rate'])expect(result.decisions.find(d=>d.field===field)).toMatchObject({
   applicable:false,status:'not_applicable',candidate_ids:[],reason_codes:[]});
 });

 it.each(['regular_hours','hourly_rate','salary_type','total_deductions'] as const)('treats a present but unreadable %s as needing confirmation',field=>{
  const {extraction,result}=assessment(observation([{field,raw:'?'}]));
  expect(extraction.fields[0].normalized_value).toBeNull();
  expect(result.decisions.find(d=>d.field===field)).toMatchObject({applicable:true,status:'needs_confirmation',effective_confidence:0,
   reason_codes:expect.arrayContaining(['critical_field_missing','below_field_threshold'])});
 });

 it('retains a missing visible pension base even if no pension candidate was returned',()=>{
  const {result}=assessment(observation([{field:'gross_salary',raw:'4608.70'}]),{pension_section_visible:true});
  expect(result.decisions.find(d=>d.field==='pension_base')).toMatchObject({applicable:true,status:'needs_confirmation',effective_confidence:0});
 });

 it('retains conflict and arithmetic review even for high-confidence observed hourly cells',()=>{
  const {result}=assessment(observation([{field:'regular_hours',raw:'110',confidence:0.99},{field:'regular_hours',raw:'100',confidence:0.99},
   {field:'hourly_rate',raw:'35.40',confidence:0.99},{field:'base_monthly_salary',raw:'3540.00',confidence:0.99}]));
  expect(result.decisions.find(d=>d.field==='regular_hours')).toMatchObject({applicable:true,status:'needs_confirmation',
   reason_codes:expect.arrayContaining(['critical_field_conflict','gate0_requires_review'])});
  expect(result.decisions.find(d=>d.field==='hourly_rate')).toMatchObject({applicable:true,status:'needs_confirmation',
   reason_codes:expect.arrayContaining(['gate0_requires_review'])});
 });

 it('does not reduce the threshold or promote a low-confidence observed cell',()=>{
  const {result}=assessment(observation([{field:'hourly_rate',raw:'35.40',confidence:0.42}]));
  expect(result.decisions.find(d=>d.field==='hourly_rate')).toMatchObject({applicable:true,status:'needs_confirmation',effective_confidence:0.42,
   threshold:0.95,reason_codes:expect.arrayContaining(['gate0_requires_review','below_field_threshold'])});
 });

 it('emits policy 4 while decoding historical policies 2/3 without recomputing their recorded decisions',()=>{
  const context={hourly_analysis_implied:true,totals_section_visible:true};
  const first=buildPassEvaluation({pass_id:uuid(92001),kind:'first_pass',requested_fields:[],selected_regions:[],prompt_version:'synthetic-no-provider',
   model:'synthetic-no-provider',raw_extraction:observation([{field:'gross_salary',raw:'4608.70'}]),
   salary_type_assessment:{documented:null,inferred:null},pension_section_visible:false,totals_section_visible:true,critical_context:context,reference_year:2026});
  const result=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:recoveryDecisionForV21(null),
   final_extraction_id:uuid(92002),critical_context:context,reference_year:2026});
  expect(PAYSLIP_V21_RESOLUTION_POLICY_VERSION).toBe('payslip-v2.1-non-degrading-resolution-4');expect(result.resolution_policy_version).toBe(PAYSLIP_V21_RESOLUTION_POLICY_VERSION);
  expect(result.final_confidence_assessment.decisions.find(d=>d.field==='regular_hours')?.status).toBe('needs_confirmation');
  const v2=resolvePayslipExtractionPasses({first_pass:first,recovery_passes:[],final_extraction_id:uuid(92003),critical_context:context,reference_year:2026});
  expect(v2.resolution_policy_version).toBe(PAYSLIP_V2_RESOLUTION_POLICY_VERSION);
  expect(PAYSLIP_V2_RESOLUTION_POLICY_VERSION).toBe('payslip-v2-resolution-2');
  const oldV2={...structuredClone(v2),resolution_policy_version:'payslip-v2-resolution-1'};
  expect(canonicalSha256(payslipExtractionV2ResultSchema.parse(oldV2))).toBe(canonicalSha256(oldV2));
  for(const policy of ['payslip-v2.1-non-degrading-resolution-2','payslip-v2.1-non-degrading-resolution-3']){
   const historical={...structuredClone(result),resolution_policy_version:policy,final_confidence_assessment:{decisions:result.final_confidence_assessment.decisions.map(d=>
    ['regular_hours','hourly_rate','total_deductions'].includes(d.field)?{...d,applicable:false,status:'not_applicable',effective_confidence:0,candidate_ids:[],reason_codes:[]}:d)}};
   const before=canonicalSha256(historical),decoded=payslipExtractionV21ResultSchema.parse(historical);
   expect(canonicalSha256(decoded)).toBe(before);expect(canonicalSha256(historical)).toBe(before);
   expect(decoded.final_confidence_assessment.decisions.find(d=>d.field==='regular_hours')?.status).toBe('not_applicable');
  }
 });
});

// Optional one-file offline check: reads the archived scan result as-is and
// computes a separate assessment. No corpus run, SDK, DB or artifact rewrite.
it.skipIf(process.env.TIVDOC_CONFIDENCE_RETAINED_SCAN_REPLAY!=='1')('keeps the actual archived scan immutable while exposing its suppressed required fields',()=>{
 const file='output/release-completion/live-provider-june2026/live-checkpoint-he-scan-clear.json',bytes=readFileSync(file);
 const checkpoint=JSON.parse(bytes.toString('utf8'));
 expect(checkpoint.input_sha256).toBe('6a7225348270f9b8351b053c8b274b9686e5d17ffdf547d3d456059911a9b526');
 const result=payslipExtractionV21ResultSchema.parse(checkpoint.run.result);expect(canonicalSha256(result)).toBe(checkpoint.result_sha256);
 for(const field of ['regular_hours','hourly_rate','total_deductions'])expect(result.final_confidence_assessment.decisions.find(d=>d.field===field)?.status).toBe('not_applicable');
 const derivative=assessExtractionConfidence(result.final_extraction,result.final_validation);
 for(const field of ['regular_hours','hourly_rate','total_deductions'])expect(derivative.decisions.find(d=>d.field===field)).toMatchObject({applicable:true,status:'needs_confirmation'});
 expect(result.final_validation.status).toBe('invalid');expect(canonicalSha256(checkpoint.run.result)).toBe(checkpoint.result_sha256);
 expect(readFileSync(file)).toEqual(bytes);
});
