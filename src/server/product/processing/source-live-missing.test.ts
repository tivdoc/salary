import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {extractionResultSchema} from '@/engine/extraction/contracts';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {buildPassEvaluation,resolvePayslipExtractionPasses,payslipExtractionPassSchema} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21,recoveryDecisionSchema} from '@/engine/extraction/v21';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {calculateDevMinimumWage} from '@/engine/calculations/dev-minimum-wage';
import {classifyOpenAiV2AggregateTotalRows} from '@/server/engine/extraction/providers/openai/v2-aggregate-totals';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {savedDocumentFieldReadings} from './saved-field-readings';
import {assertDevFinancialExtractionSource} from './dev-financial-source';
import {devFinancialFacts} from './dev-financial-contract';
vi.mock('server-only',()=>({}));

// Exact machine observations retained from the failed ef03418 synthetic QA
// source. The receipt is NOT rewritten or reused as evidence of a new SDK call.
// Tests below are transparent offline mapping/resolution replay only.
const recordedRaw={
 "fields": [
  {
   "field": "document_type",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "document type"
   },
   "raw_value": "payslip",
   "confidence": 0.96,
   "candidate_id": "be07b7b5-df45-4035-8058-89daef49249f",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "salary_period",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Salary period: 06/2026"
   },
   "raw_value": "06/2026",
   "confidence": 0.94,
   "candidate_id": "4f507008-a72e-41d7-b8c9-40f4c0c3cea4",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "salary_type",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Salary type: hourly"
   },
   "raw_value": "hourly",
   "confidence": 0.94,
   "candidate_id": "4558a849-7637-4c1c-845d-231508f08fd2",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "hourly_rate",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Hourly rate (ILS): 33.00"
   },
   "raw_value": "33.00",
   "confidence": 0.94,
   "candidate_id": "c9d3cd05-443a-4d0f-bb35-069f039596b0",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "base_monthly_salary",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Hourly rate (ILS): 3,300.00"
   },
   "raw_value": "3,300.00",
   "confidence": 0.94,
   "candidate_id": "0ab9fbb0-f438-4b0a-8deb-d03a222cf336",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "gross_salary",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Gross salary (ILS): 3,300.00"
   },
   "raw_value": "3,300.00",
   "confidence": 0.94,
   "candidate_id": "c1384ef8-5006-40a7-a013-9a94cefc13f9",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "total_deductions",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Total deductions (ILS): 0.00"
   },
   "raw_value": "0.00",
   "confidence": 0.94,
   "candidate_id": "b0bb4504-82f8-48e8-91c4-77b451de892a",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  },
  {
   "field": "net_salary",
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Net salary (ILS): 3,300.00"
   },
   "raw_value": "3,300.00",
   "confidence": 0.94,
   "candidate_id": "fb776a0e-d026-4ccd-984b-64523f168818",
   "warning_flags": [],
   "extraction_method": "ai_vision"
  }
 ],
 "status": "completed",
 "provider": {
  "provider_id": "openai",
  "model_version": "gpt-4o-mini-2024-07-18",
  "extractor_version": "2.1"
 },
 "warnings": [
  "ambiguous_value"
 ],
 "operation": {
  "duration_ms": 8331,
  "token_usage": {
   "input_tokens": 40332,
   "total_tokens": 40956,
   "output_tokens": 624
  },
  "provider_response_id": "resp_0a092726be5dcf2e016aa1cba8fdb087d28c841efce803ef08"
 },
 "error_code": null,
 "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
 "extracted_at": "2026-09-09T21:12:16.064Z",
 "extraction_id": "c90f8806-dae0-4d83-a91b-ba6b6ffb61d7",
 "quality_metrics": {
  "page_count": 1,
  "text_coverage": null,
  "rotation_degrees": 0,
  "source_resolution_dpi": null
 },
 "sensitive_metadata": [],
 "additional_components": [
  {
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Regular hourly base"
   },
   "rate_raw": "33.00",
   "amount_raw": "3,300.00",
   "confidence": 0.94,
   "component_id": "24c7d600-e68f-44ef-8bff-b78c507da19b",
   "quantity_raw": null,
   "source_label": "Regular hourly base",
   "semantic_kind": "hourly_base",
   "warning_flags": [],
   "percentage_raw": null,
   "normalized_label": "hourly_base",
   "extraction_method": "ai_vision"
  },
  {
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Gross salary (ILS)"
   },
   "rate_raw": null,
   "amount_raw": "3,300.00",
   "confidence": 0.94,
   "component_id": "e09b1ed6-05e7-4990-bcfd-0276fc82cb3a",
   "quantity_raw": null,
   "source_label": "Gross salary (ILS)",
   "semantic_kind": "unknown",
   "warning_flags": [],
   "percentage_raw": null,
   "normalized_label": null,
   "extraction_method": "ai_vision"
  },
  {
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Total deductions (ILS)"
   },
   "rate_raw": null,
   "amount_raw": "0.00",
   "confidence": 0.94,
   "component_id": "16d29a7c-19ab-4bec-b9cd-40ed4756b93d",
   "quantity_raw": null,
   "source_label": "Total deductions (ILS)",
   "semantic_kind": "unknown",
   "warning_flags": [],
   "percentage_raw": null,
   "normalized_label": null,
   "extraction_method": "ai_vision"
  },
  {
   "source": {
    "page": 1,
    "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
    "text_fragment": "Net salary (ILS)"
   },
   "rate_raw": null,
   "amount_raw": "3,300.00",
   "confidence": 0.94,
   "component_id": "8ddaa180-099c-4cfe-ae1d-d88a10c81027",
   "quantity_raw": null,
   "source_label": "Net salary (ILS)",
   "semantic_kind": "unknown",
   "warning_flags": [],
   "percentage_raw": null,
   "normalized_label": null,
   "extraction_method": "ai_vision"
  }
 ],
 "detected_document_type": "payslip",
 "document_quality_confidence": 0.96,
 "earnings_components_complete": true
};
const recordedRecovery={
 "kind": "targeted_recovery",
 "model": "gpt-4o-mini-2024-07-18",
 "pass_id": "07617619-c328-4fb0-9e7c-012760d466cd",
 "validation": {
  "issues": [
   {
    "code": "critical_field_missing",
    "message": "A contextually critical field is missing: regular_hours.",
    "severity": "confirmation",
    "field_keys": [
     "regular_hours"
    ],
    "field_candidate_ids": []
   }
  ],
  "status": "requires_confirmation",
  "field_assessments": []
 },
 "prompt_version": "payslip-extraction-openai-v2-recovery-r3",
 "raw_extraction": {
  "fields": [],
  "status": "partial",
  "provider": {
   "provider_id": "openai",
   "model_version": "gpt-4o-mini-2024-07-18",
   "extractor_version": "2.1"
  },
  "warnings": [
   "salary_type_documented_pair_invalid"
  ],
  "operation": {
   "duration_ms": 5483,
   "token_usage": {
    "input_tokens": 40364,
    "total_tokens": 40688,
    "output_tokens": 324
   },
   "provider_response_id": "resp_0e0bfecdf796c60f016aa1cbb0836887d2a57eb6fbafadb1e7"
  },
  "error_code": null,
  "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
  "extracted_at": "2026-09-09T21:12:21.574Z",
  "extraction_id": "07617619-c328-4fb0-9e7c-012760d466cd",
  "quality_metrics": {
   "page_count": 1,
   "text_coverage": null,
   "rotation_degrees": null,
   "source_resolution_dpi": null
  },
  "sensitive_metadata": [],
  "additional_components": [],
  "detected_document_type": "payslip",
  "document_quality_confidence": 0.96,
  "earnings_components_complete": false
 },
 "requested_fields": [
  "regular_hours"
 ],
 "selected_regions": [],
 "confidence_assessment": {
  "decisions": [
   {
    "field": "salary_period",
    "status": "needs_confirmation",
    "threshold": 0.95,
    "applicable": true,
    "reason_codes": [
     "critical_field_missing",
     "below_field_threshold"
    ],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "salary_type",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "gross_salary",
    "status": "needs_confirmation",
    "threshold": 0.95,
    "applicable": true,
    "reason_codes": [
     "critical_field_missing",
     "below_field_threshold"
    ],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "total_deductions",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "net_salary",
    "status": "needs_confirmation",
    "threshold": 0.95,
    "applicable": true,
    "reason_codes": [
     "critical_field_missing",
     "below_field_threshold"
    ],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "hourly_rate",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "regular_hours",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "pension_base",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "pension_employee_contribution",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "pension_employer_contribution",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "severance_contribution",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "overtime_125_hours",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   },
   {
    "field": "overtime_150_hours",
    "status": "not_applicable",
    "threshold": 0.95,
    "applicable": false,
    "reason_codes": [],
    "candidate_ids": [],
    "effective_confidence": 0
   }
  ]
 },
 "normalized_extraction": {
  "fields": [],
  "status": "partial",
  "provider": {
   "provider_id": "openai",
   "model_version": "gpt-4o-mini-2024-07-18",
   "extractor_version": "2.1"
  },
  "warnings": [
   "salary_type_documented_pair_invalid"
  ],
  "operation": {
   "duration_ms": 5483,
   "token_usage": {
    "input_tokens": 40364,
    "total_tokens": 40688,
    "output_tokens": 324
   },
   "provider_response_id": "resp_0e0bfecdf796c60f016aa1cbb0836887d2a57eb6fbafadb1e7"
  },
  "error_code": null,
  "document_id": "eecc717f-6d64-44f7-ac5b-3b7e009d61de",
  "extracted_at": "2026-09-09T21:12:21.574Z",
  "extraction_id": "07617619-c328-4fb0-9e7c-012760d466cd",
  "quality_metrics": {
   "page_count": 1,
   "text_coverage": null,
   "rotation_degrees": null,
   "source_resolution_dpi": null
  },
  "sensitive_metadata": [],
  "additional_components": [],
  "detected_document_type": "payslip",
  "document_quality_confidence": 0.96,
  "earnings_components_complete": false
 },
 "salary_type_assessment": {
  "inferred": null,
  "documented": null
 },
 "totals_section_visible": false,
 "pension_section_visible": false
};
const recoveryDecision={"regions":["earnings"],"skipped":false,"requested":true,"reason_codes":["critical_field_missing"],"fields_requested":["regular_hours"],"expected_information_gain":"missing_critical_field"};
const sourceSha='520ff4644bedc7c4e1fe333f30662027e2bd4d94721e6338d325b03f175b18f5';
const raw=()=>extractionResultSchema.parse(structuredClone(recordedRaw));
const classify=(value=raw())=>classifyOpenAiV2AggregateTotalRows(value);
const normalize=(value=classify())=>normalizePayslipExtraction(value);
const validation=(value=normalize())=>validatePayslipGate0(value,{reference_year:2026,critical_context:{hourly_analysis_implied:true,required_fields:['salary_period']}});
const version=recordedRaw.document_id;
function firstPass(){
 const value=classify(),salary=value.fields.find(f=>f.field==='salary_type')!;
 return buildPassEvaluation({pass_id:value.extraction_id,kind:'first_pass',requested_fields:value.fields.map(f=>f.field),selected_regions:[],
  prompt_version:'payslip-extraction-openai-v2-first-r3',model:value.provider.model_version!,raw_extraction:value,
  salary_type_assessment:{documented:{value:'hourly',raw_value:salary.raw_value,confidence:salary.confidence,candidate_id:salary.candidate_id},inferred:null},
  pension_section_visible:false,totals_section_visible:true,critical_context:{hourly_analysis_implied:true,required_fields:['salary_period']},reference_year:2026});
}
describe('saved live missing-hours source has separately represented aggregate totals',()=>{
 it('reproduces the exact source guard failure independently of missing hours',()=>{
  const original=normalizePayslipExtraction(raw());
  expect(original.additional_components.map(r=>r.semantic_kind)).toEqual(['hourly_base','unknown','unknown','unknown']);
  expect(original.fields.some(f=>f.field==='regular_hours')).toBe(false);
  expect(()=>assertDevFinancialExtractionSource(original,version)).toThrow('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
  expect(validation(original).issues.some(i=>i.code==='gross_component_mismatch')).toBe(true);
 });
 it('retains both raw observations of every total with unchanged fields, source, confidence and input',()=>{
  const original=raw(),before=canonicalSha256(original),classified=classify(original);
  expect(canonicalSha256(original)).toBe(before);expect(classified.fields).toEqual(original.fields);
  expect(classified.additional_components).toEqual([original.additional_components[0]]);
  expect(classified.aggregate_total_observations?.map(o=>o.row)).toEqual(original.additional_components.slice(1));
  expect(classified.aggregate_total_observations?.map(o=>o.total_field)).toEqual(['gross_salary','total_deductions','net_salary']);
  for(const observation of classified.aggregate_total_observations??[]){
   expect(observation.total_candidate).toEqual(original.fields.find(f=>f.candidate_id===observation.total_candidate_id));
   expect(observation.row.confidence).toBe(.94);expect(observation.policy_version).toBe('payslip-explicit-aggregate-total-v1');
  }
  expect(normalize(classified).aggregate_total_observations).toEqual(classified.aggregate_total_observations);
  expect(classify(classified)).toEqual(classified);
  const changed=structuredClone(classified);changed.aggregate_total_observations![0].row.amount_raw='3301.00';
  expect(()=>extractionResultSchema.parse(changed)).toThrow();expect(canonicalSha256(changed)).not.toBe(canonicalSha256(classified));
 });
 it.each(['amount-mismatch','different-raw','unknown-label','ambiguous-candidates','ambiguous-rows','other-page','row-warning','candidate-warning','row-quantity','real-travel','net-bonus'] as const)(
  'keeps a genuine or ambiguous row in components: %s',change=>{
   const original=raw(),row=original.additional_components[1],candidate=original.fields.find(f=>f.field==='gross_salary')!;
   if(change==='amount-mismatch')row.amount_raw='3301.00';
   if(change==='different-raw')row.amount_raw='3300.00';
   if(change==='unknown-label')row.source_label='Unresolved component';
   if(change==='ambiguous-candidates')original.fields.push({...structuredClone(candidate),candidate_id:randomUUID()});
   if(change==='ambiguous-rows')original.additional_components.push({...structuredClone(row),component_id:randomUUID()});
   if(change==='other-page')row.source.page=2;
   if(change==='row-warning')row.warning_flags=['ambiguous_value'];
   if(change==='candidate-warning')candidate.warning_flags=['ambiguous_value'];
   if(change==='row-quantity')row.quantity_raw='1';
   if(change==='real-travel')row.semantic_kind='travel';
   if(change==='net-bonus'){row.source_label='net bonus';row.source.text_fragment='net bonus';row.semantic_kind='travel';}
   const result=classify(original);
   expect(result.additional_components.some(c=>c.component_id===row.component_id)).toBe(true);
   expect(result.aggregate_total_observations?.some(o=>o.row.component_id===row.component_id)??false).toBe(false);
   expect(()=>assertDevFinancialExtractionSource(normalize(result),version)).toThrow('DEV_FINANCIAL_SCENARIO_UNSUPPORTED');
  });
 it('does not add metadata or change historical hashes when no aggregate projection exists',()=>{
  const original=raw();original.additional_components=original.additional_components.slice(0,1);
  const before=canonicalSha256(original);expect(canonicalSha256(classify(original))).toBe(before);
  expect('aggregate_total_observations' in normalize(original)).toBe(false);
 });
 it('propagates the optional raw observations through both existing resolution versions',()=>{
  const first=firstPass(),context={hourly_analysis_implied:true,required_fields:['salary_period' as const]};
  const v2=resolvePayslipExtractionPasses({first_pass:first,recovery_passes:[],final_extraction_id:randomUUID(),critical_context:context,reference_year:2026});
  const v21=resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[payslipExtractionPassSchema.parse(recordedRecovery)],recovery_decision:recoveryDecisionSchema.parse(recoveryDecision),
   final_extraction_id:randomUUID(),critical_context:context,reference_year:2026});
  for(const resolved of [v2,v21]){
   expect(resolved.final_extraction.aggregate_total_observations).toEqual(first.raw_extraction.aggregate_total_observations);
   expect(resolved.final_validation.issues.some(i=>i.code==='gross_component_mismatch')).toBe(false);
   expect(resolved.final_extraction.fields.some(f=>f.field==='regular_hours'&&f.normalized_value!==null)).toBe(false);
   expect(()=>assertDevFinancialExtractionSource(resolved.final_extraction,version)).not.toThrow();
  }
 });
 it('requires identified cell confirmations and still returns missing_input for absent hours',()=>{
  const machine=normalize(),caseId='f0934b65-8af1-4797-a96a-2c55f1b3a33e',at='2026-09-09T21:30:00Z',identity=randomUUID();
  const document={...syntheticPayslipFixtures[0].request.document,case_id:caseId,document_id:version,content_sha256:sourceSha,
   size_bytes:3623,storage_path:`cases/${caseId}/documents/${version}/original.pdf`};
  const result={final_extraction:machine},checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:randomUUID(),version_id:version,
   input_sha256:sourceSha,expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
  const expected:Record<string,unknown>={salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},salary_type:'hourly',
   base_monthly_salary:{currency:'ILS',minor_units:330000},hourly_rate:{currency:'ILS',minor_units:3300},
   gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000}};
  const answers=machine.fields.filter(candidate=>Object.hasOwn(expected,candidate.field)).map(candidate=>{
   expect(candidate.normalized_value).toEqual(expected[candidate.field]);
   const target=documentFieldTarget({checkpoint,policyVersion:'offline-total-reclassification-test',candidateId:candidate.candidate_id});
   return {id:randomUUID(),case_id:caseId,scope_month:'2026-06',code:`document_field:${target.target_sha256}`,answer_kind:'choice',
    answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],answer_revision:1,answer_identity_id:identity,answer_created_at:at,field_target:target};
  });
  expect(answers).toHaveLength(6);
  const readings=savedDocumentFieldReadings({caseId,month:'2026-06',policyVersion:'offline-total-reclassification-test',journal:{answers},checkpoint});
  const context={snapshot_id:randomUUID(),case_id:caseId,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:at,
   fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,randomUUID()]))};
  const unconfirmed=resolvePayslipSnapshot({document,extraction:machine,validation:validation(machine),context});
  expect(unconfirmed.facts.find(f=>f.path==='compensation.base_monthly_salary')?.status).not.toBe('confirmed');
  const parent=resolvePayslipSnapshot({document,extraction:{...machine,customer_readings:[...readings]},validation:validation(machine),context});
  expect(parent.facts.find(f=>f.path==='compensation.base_monthly_salary')?.status).toBe('confirmed');
  expect(parent.facts.find(f=>f.path==='work.regular_hours')).toMatchObject({status:'missing',value:null});
  const facts=devFinancialFacts(parent,randomUUID(),null);
  expect(calculateDevMinimumWage({facts,month:'2026-06',calculatedAt:at})).toEqual({state:'missing_input',fields:['work.regular_hours']});
  const answered=devFinancialFacts(parent,randomUUID(),{request_id:randomUUID(),answer_revision:1,identity_id:identity,answered_at:at,
   answer:'100',version_id:version,checkpoint_sha256:canonicalSha256(checkpoint)});
  expect(calculateDevMinimumWage({facts:answered,month:'2026-06',calculatedAt:at})).toMatchObject({state:'calculated',expectedMinor:354000,recordedMinor:330000,gapMinor:24000});
  expect(parent.facts.find(f=>f.path==='work.regular_hours')?.value).toBeNull();
  expect(machine.fields.find(f=>f.field==='base_monthly_salary')?.confidence).toBe(.94);
  expect(checkpoint.run.result.final_extraction).not.toHaveProperty('customer_readings');
 });
});
