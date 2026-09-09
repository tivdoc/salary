import {describe,it,expect,vi} from 'vitest';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {buildPassEvaluation,selectTargetedRecovery} from '@/engine/extraction/v2';
import {mapOpenAiV2Output} from './v2-mapper';
import type {OpenAiPayslipV2StructuredOutput} from './v2-schema';
vi.mock('server-only',()=>({}));

// Independent fabricated provider-shaped data reproduces a mapper contract
// failure only. It is not the missing raw output of the actual 14719d1 call.
function fixture():OpenAiPayslipV2StructuredOutput{
 const evidence={page:1,region:'earnings' as const,source_label:'Regular hourly base'};
 const candidate=(raw_value:string)=>({raw_value,confidence:'high' as const,evidence,warnings:[]});
 return {detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:'hourly',documented_raw_value:'hourly',documented_confidence:'high',documented_evidence:evidence,
   inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[{field:'salary_period',candidates:[candidate('06/2026')]}],
  payroll_rows:[{source_label:'Regular hourly base',semantic_kind:'hourly_base',quantity_raw:null,rate_raw:'33.00',amount_raw:'3300.00',
   percentage_raw:null,confidence:'high',evidence,warnings:[]}],
  totals:{visible:true,gross_candidates:[candidate('3300.00')],deductions_candidates:[candidate('0.00')],net_candidates:[candidate('3300.00')]},
  pension:{visible:false,base_candidates:[],employee:{rate_candidates:[],amount_candidates:[]},
   employer:{rate_candidates:[],amount_candidates:[]},severance:{rate_candidates:[],amount_candidates:[]}},earnings_components_complete:true,warnings:[]};
}
function map(output=fixture()){
 return mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,model:'synthetic-mapper-only',extractorVersion:'2.1',durationMs:1,
  providerResponseId:'synthetic-no-api-call',tokenUsage:null,extractedAt:'2026-09-09T21:00:00Z'});
}
const observations=(mapped:ReturnType<typeof map>)=>mapped.extraction.fields.filter(f=>f.field!=='salary_type')
 .map(({candidate_id:unused,...f})=>{void unused;return f;});

describe('an inconsistent salary-type branch cannot erase independent extracted evidence',()=>{
 it.each(['missing-raw','missing-value'] as const)('omits only the invalid documented branch: %s',kind=>{
  const source=fixture();if(kind==='missing-raw')source.salary_type.documented_raw_value=null;else source.salary_type.documented_value=null;
  const before=structuredClone(source),result=map(source);
  expect(result.extraction.status).not.toBe('failed');expect(result.salary_type_assessment.documented).toBeNull();
  expect(result.extraction.fields.some(f=>f.field==='salary_type')).toBe(false);
  expect(result.extraction.warnings).toContain('salary_type_documented_pair_invalid');
  expect(result.critical_context.required_fields).toContain('salary_type');
  expect(observations(result)).toEqual(observations(map()));expect(result.extraction.additional_components).toEqual(map().extraction.additional_components);
  expect(result.extraction.fields.find(f=>f.field==='base_monthly_salary')?.confidence).toBe(.94);expect(source).toEqual(before);
 });
 it.each(['basis-without-value','value-without-basis','duplicate-basis'] as const)('retains documented hourly evidence despite invalid inference: %s',kind=>{
  const source=fixture();
  if(kind==='basis-without-value')source.salary_type.inference_basis=['payroll_structure'];
  if(kind==='value-without-basis')source.salary_type.inferred_value='hourly';
  if(kind==='duplicate-basis'){source.salary_type.inferred_value='hourly';source.salary_type.inference_basis=['hourly_rate','hourly_rate'];}
  const result=map(source);expect(result.salary_type_assessment.inferred).toBeNull();
  expect(result.salary_type_assessment.documented).toMatchObject({value:'hourly',raw_value:'hourly',confidence:.94});
  expect(result.extraction.warnings).toContain('salary_type_inferred_pair_invalid');
  expect(result.extraction.fields).toEqual(map().extraction.fields);expect(result.extraction.additional_components).toEqual(map().extraction.additional_components);
  expect(result.extraction.fields.some(f=>f.field==='regular_hours')).toBe(false);
 });
 it('keeps a valid inference separate when documentary evidence is incomplete',()=>{
  const source=fixture();source.salary_type.documented_raw_value=null;source.salary_type.inferred_value='hourly';source.salary_type.inference_basis=['hourly_rate'];
  const result=map(source);expect(result.salary_type_assessment.documented).toBeNull();expect(result.salary_type_assessment.inferred?.value).toBe('hourly');
  expect(result.extraction.fields.some(f=>f.field==='salary_type')).toBe(false);
 });
 it('requires recovery of the missing documentary type instead of treating an inference as confirmed',()=>{
  const source=fixture();source.salary_type.documented_raw_value=null;const result=map(source),request=syntheticPayslipFixtures[0].request;
  const pass=buildPassEvaluation({pass_id:request.extraction_id,kind:'first_pass',requested_fields:['salary_type'],selected_regions:[],
   prompt_version:'synthetic-salary-isolation',model:'synthetic-mapper-only',raw_extraction:result.extraction,
   salary_type_assessment:result.salary_type_assessment,pension_section_visible:false,totals_section_visible:true,
   critical_context:result.critical_context,reference_year:2026});
  expect(selectTargetedRecovery(pass)?.fields).toContain('salary_type');
  expect(pass.validation.issues.some(i=>i.code==='critical_field_missing'&&i.field_keys.includes('salary_type'))).toBe(true);
  expect(pass.confidence_assessment.decisions.find(d=>d.field==='salary_type')?.status).not.toBe('confirmed');
 });
});
