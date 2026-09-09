import {describe,expect,it,vi} from 'vitest';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {mapOpenAiV2Output} from './v2-mapper';
import type {OpenAiPayslipV2StructuredOutput} from './v2-schema';
vi.mock('server-only',()=>({}));

// Literal, synthetic observations of an hourly table; this is mapping evidence,
// not an OCR response or a legal entitlement fixture.
function fixture():OpenAiPayslipV2StructuredOutput{
 const evidence={page:1,region:'earnings' as const,source_label:'שכר יסוד שעתי'};
 const candidate=(raw_value:string)=>({raw_value,confidence:'high' as const,evidence,warnings:[]});
 const row=(semantic_kind:OpenAiPayslipV2StructuredOutput['payroll_rows'][number]['semantic_kind'],amount_raw:string,
  quantity_raw:string|null=null,rate_raw:string|null=null)=>({source_label:semantic_kind,semantic_kind,amount_raw,
   quantity_raw,rate_raw,percentage_raw:null,confidence:'high' as const,evidence,warnings:[]});
 return {detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:'hourly',documented_raw_value:'שעתי',documented_confidence:'high',documented_evidence:evidence,
   inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[{field:'salary_period',candidates:[candidate('06/2026')]}],
  payroll_rows:[row('hourly_base','3,540.00','100','35.40'),row('overtime_125','442.50','10','44.25'),
   row('overtime_150','106.20','2','53.10'),row('travel','220.00','20','11.00'),row('bonus','300.00')],
  totals:{visible:true,gross_candidates:[candidate('4,608.70')],deductions_candidates:[candidate('412.40')],net_candidates:[candidate('4,196.30')]},
  pension:{visible:false,base_candidates:[],employee:{rate_candidates:[],amount_candidates:[]},
   employer:{rate_candidates:[],amount_candidates:[]},severance:{rate_candidates:[],amount_candidates:[]}},
  earnings_components_complete:true,warnings:[],
 } satisfies OpenAiPayslipV2StructuredOutput;
}
function map(output:OpenAiPayslipV2StructuredOutput=fixture(),allowedFields?:readonly ['base_monthly_salary']){
 return normalizePayslipExtraction(mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,
  model:'synthetic-mapper-contract-only',extractorVersion:'2.1',durationMs:0,providerResponseId:'synthetic-not-a-provider-call',
  tokenUsage:null,extractedAt:'2026-09-09T18:00:00Z',allowedFields}).extraction);
}
function issues(value:ReturnType<typeof map>){return validatePayslipGate0(value,{reference_year:2026}).issues.map(issue=>issue.code);}

describe('hourly wage row keeps independent quantity, rate and amount',()=>{
 it('projects the same visible row amount without deriving it and retains all five components',()=>{
  const extraction=map();
  expect(extraction.fields.filter(f=>f.field==='base_monthly_salary').map(f=>f.normalized_value)).toEqual([{currency:'ILS',minor_units:354000}]);
  expect(extraction.fields.find(f=>f.field==='regular_hours')?.normalized_value).toEqual({amount:'100',unit:'hours_per_month'});
  expect(extraction.fields.find(f=>f.field==='hourly_rate')?.normalized_value).toEqual({currency:'ILS',minor_units:3540});
  expect(extraction.additional_components.map(c=>[c.semantic_kind,c.quantity,c.rate?.minor_units??null,c.amount?.minor_units]))
   .toEqual([['hourly_base','100',3540,354000],['overtime_125','10',4425,44250],['overtime_150','2',5310,10620],['travel','20',1100,22000],['bonus',null,null,30000]]);
  const projected=extraction.fields.find(f=>f.field==='base_monthly_salary')!;
  expect(projected.raw_value).toBe('3,540.00');expect(projected.confidence).toBe(0.94);
  expect(projected.source).toMatchObject({document_id:extraction.document_id,page:1});
 });
 it('reconciles every genuine component exactly once',()=>{expect(issues(map())).not.toContain('gross_component_mismatch');});
 it('preserves explicit deduction rows and their evidence without adding them to gross earnings',()=>{
  const source=fixture();
  for(const [source_label,amount_raw] of [['פנסיה עובד','212.40'],['ביטוח לאומי','80.00'],['ביטוח בריאות','120.00'],['מס הכנסה','0.00']]){
   source.payroll_rows.push({...source.payroll_rows[0],source_label,semantic_kind:'deduction',quantity_raw:null,rate_raw:null,amount_raw});
  }
  const extraction=map(source),before=structuredClone(extraction);
  expect(extraction.additional_components.filter(row=>row.semantic_kind==='deduction').map(row=>row.amount?.minor_units)).toEqual([21240,8000,12000,0]);
  expect(extraction.additional_components).toHaveLength(9);
  expect(issues(extraction)).not.toContain('gross_component_mismatch');expect(issues(extraction)).not.toContain('payslip_totals_mismatch');
  expect(extraction).toEqual(before);
 });
 it.each(['unknown','other'] as const)('does not hide a %s row based on its deduction-looking label',semantic_kind=>{
  const source=fixture();source.payroll_rows.push({...source.payroll_rows[0],source_label:'ניכוי',semantic_kind,quantity_raw:null,rate_raw:null,amount_raw:'412.40'});
  expect(issues(map(source))).toContain('gross_component_mismatch');
 });
 it('still rejects an inconsistent deduction total independently of gross component reconciliation',()=>{
  const source=fixture();source.payroll_rows.push({...source.payroll_rows[0],semantic_kind:'deduction',quantity_raw:null,rate_raw:null,amount_raw:'412.40'});
  source.totals.deductions_candidates[0].raw_value='400.00';
  const codes=issues(map(source));expect(codes).not.toContain('gross_component_mismatch');expect(codes).toContain('payslip_totals_mismatch');
 });
 it('still matches a separate base amount when an hourly detail row has no amount projection',()=>{
  const source=fixture();source.payroll_rows[0].semantic_kind='base_salary';
  source.payroll_rows.push({...source.payroll_rows[0],semantic_kind:'hourly_base',amount_raw:null});
  expect(issues(map(source))).not.toContain('gross_component_mismatch');
 });
 it('does not collapse a second base observation whose printed amount cannot be normalized',()=>{
  const source=fixture();source.payroll_rows.push({...source.payroll_rows[0],semantic_kind:'base_salary',amount_raw:'unreadable'});
  expect(issues(map(source))).toContain('gross_component_mismatch');
 });
 it('does not invent missing hours from rate and amount',()=>{
  const source=fixture();source.payroll_rows[0].quantity_raw=null;
  const extraction=map(source);expect(extraction.fields.some(f=>f.field==='regular_hours')).toBe(false);
  expect(extraction.fields.find(f=>f.field==='base_monthly_salary')?.normalized_value).toEqual({currency:'ILS',minor_units:354000});
 });
 it('preserves a conflicting printed amount rather than multiplying quantity by rate',()=>{
  const source=fixture();source.payroll_rows[0].quantity_raw='110';
  const extraction=map(source);expect(extraction.fields.find(f=>f.field==='base_monthly_salary')?.normalized_value).toEqual({currency:'ILS',minor_units:354000});
  expect(issues(extraction)).toContain('hourly_salary_mismatch');
 });
 it('keeps targeted recovery restricted to the requested amount field',()=>{
  const extraction=map(fixture(),['base_monthly_salary']);expect(extraction.fields.map(f=>f.field)).toEqual(['base_monthly_salary']);
  expect(extraction.additional_components).toEqual([]);
 });
 it.each(['second-base-kind','different-page','different-raw','real-gross-mismatch'] as const)('retains reconciliation guards: %s',change=>{
  const extraction=map();
  if(change==='second-base-kind')extraction.additional_components.push({...structuredClone(extraction.additional_components[0]),
   component_id:'00000000-0000-4000-8000-000000009999',semantic_kind:'base_salary',normalized_label:'base_salary'});
  if(change==='different-page')extraction.additional_components[0].source.page=2;
  if(change==='different-raw')extraction.additional_components[0].amount_raw='3540.00';
  if(change==='real-gross-mismatch'){
   const field=extraction.fields.find(f=>f.field==='gross_salary')!;field.normalized_value={currency:'ILS',minor_units:460000};
  }
  expect(issues(extraction)).toContain('gross_component_mismatch');
 });
});
