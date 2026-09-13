import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {extractionResultSchema,type RawCandidateField} from '@/engine/extraction/contracts';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {classifyOpenAiV2SourceScopes,explicitSourceScope} from './v2-source-scope';
const context={hasSalaryNet:true,hasVoluntaryDeduction:true,hasSeparateEmployeeFunds:true};
it.each([
 ['pension_base','קרן השתלמות','study_fund'],['pension_employee_rate','קה״ש מסלול','study_fund'],
 ['gross_salary','ברוטו מצטבר','cumulative'],['pension_base','שכר מבוטח הפרשים','retroactive'],
 ['total_deductions','ניכויי רשות','voluntary_deduction'],['net_salary','לתשלום','final_payable'],
 ['regular_hours','שעות עבודה','attendance_total'],['total_deductions','ניכויי חובה','mandatory_deduction_subtotal'],
 ['severance_contribution','לפיצ. לא חויב מס','tax_exemption_reference'],['pension_employer_contribution','גמל מעסיק','combined_employer_funds'],
] as const)('preserves source role of %s / %s', (field,label,scope)=>expect(explicitSourceScope(field,label,context)).toBe(scope));
it('does not choose current versus retro rows from amounts, order or identical fund labels',()=>{
 expect(explicitSourceScope('pension_base','קצבה שכיר-תג.',context)).toBeNull();
 expect(explicitSourceScope('pension_employee_rate','קצבה שכיר-תג.',context)).toBeNull();
 expect(explicitSourceScope('net_salary','נטו לתשלום',{...context,hasSalaryNet:false})).toBeNull();
 expect(explicitSourceScope('net_salary','לתשלום',{...context,hasVoluntaryDeduction:false})).toBeNull();
 expect(explicitSourceScope('regular_hours','שעות רגילות',context)).toBeNull();
});
it.each(['ניכויי חובה','סה״כ ניכויי חובה','ניכויי חובה-מסים','ניכויי חובה - מסים','ניכויי חובה־מסים','ניכויי חובה – מסים','סה״כ ניכויי חובה - מסים','mandatory deductions'])(
 'keeps the exact subtotal heading %s out of grand totals even without an extracted fund section',label=>{
  expect(explicitSourceScope('total_deductions',label,{hasSalaryNet:false,hasVoluntaryDeduction:false,hasSeparateEmployeeFunds:false})).toBe('mandatory_deduction_subtotal');
 });
it.each(['סך ניכויים','סה״כ ניכויים','total deductions','ניכויי חובה ורשות','ניכויי חובה וקופות גמל','מסים','ניכויי חובה משוערים'])(
 'does not broaden the bounded mandatory-subtotal label grammar: %s',label=>{
  expect(explicitSourceScope('total_deductions',label,context)).toBeNull();
 });
it('retains two separately printed subtotal observations and never manufactures an unextracted grand total',()=>{
 const f=buildSyntheticCaseFixture({fixture_id:'mandatory-subtotal-no-funds',mode:'real'}),e=f.stored.extractions[0];
 const {normalized_value,...money}=e.fields.find(field=>field.field==='gross_salary')!;void normalized_value;
 const original={...money,field:'total_deductions' as const};
 const labels=['סה״כ ניכויי חובה','ניכויי חובה-מסים'];
 const fields=labels.map((label,i)=>({...original,candidate_id:`00000000-0000-4000-8000-00000000000${i+1}`,raw_value:'120.00',confidence:0.94,
  source:{...original.source,text_fragment:label+': 120.00'},warning_flags:['ocr_ambiguous']}));
 const raw=extractionResultSchema.parse({...e,fields,additional_components:[]});
 const before=structuredClone(raw),labelMap=new Map(fields.map((field,i)=>[field.candidate_id,labels[i]]));
 const result=classifyOpenAiV2SourceScopes(raw,labelMap,{hasSeparateEmployeeFunds:false});
 expect(result.fields).toEqual([]);expect(result.source_scope_observations).toEqual(fields.map((candidate,i)=>({
  policy_version:'payslip-explicit-source-scope-v1',scope:'mandatory_deduction_subtotal',source_label:labels[i],candidate})));
 expect(normalizePayslipExtraction(result).fields).toEqual([]);
 expect(normalizePayslipExtraction(result).source_scope_observations).toEqual(result.source_scope_observations);
 expect(raw).toEqual(before);
});
it('preserves a separately printed grand total without adding its subtotal again',()=>{
 const f=buildSyntheticCaseFixture({fixture_id:'mandatory-and-grand-total',mode:'real'}),e=f.stored.extractions[0];
 const {normalized_value,...money}=e.fields.find(field=>field.field==='gross_salary')!;void normalized_value;
 const original={...money,field:'total_deductions' as const};
 const subtotal={...original,candidate_id:'00000000-0000-4000-8000-000000000001',raw_value:'120.00',source:{...original.source,text_fragment:'ניכויי חובה-מסים: 120.00'}};
 const grand={...original,candidate_id:'00000000-0000-4000-8000-000000000002',raw_value:'200.00',source:{...original.source,page:2,text_fragment:'סך ניכויים: 200.00'}};
 const raw=extractionResultSchema.parse({...e,quality_metrics:{...e.quality_metrics,page_count:2},fields:[subtotal,grand],additional_components:[]});
 const result=classifyOpenAiV2SourceScopes(raw,new Map([[subtotal.candidate_id,'ניכויי חובה-מסים'],[grand.candidate_id,'סך ניכויים']]),{hasSeparateEmployeeFunds:false});
 expect(result.fields).toEqual([grand]);expect(result.source_scope_observations?.[0].candidate).toEqual(subtotal);
 expect(normalizePayslipExtraction(result).fields[0]).toMatchObject({candidate_id:grand.candidate_id,normalized_value:{currency:'ILS',minor_units:20000}});
});
it('retains every excluded original through normal normalization with no warning/value/confidence rewriting',()=>{
 const f=buildSyntheticCaseFixture({fixture_id:'source-scope-audit',mode:'real'}),normalized=f.stored.extractions[0];
 const raw=extractionResultSchema.parse({...normalized,fields:normalized.fields.map(({normalized_value,...field})=>{void normalized_value;return field;}),additional_components:[]});
 const candidate=raw.fields.find(f=>f.field==='gross_salary')!;const before=structuredClone(raw);
 const result=classifyOpenAiV2SourceScopes(raw,new Map([[candidate.candidate_id,'ברוטו מצטבר']]),{hasSeparateEmployeeFunds:false});
 expect(result.fields.some(f=>f.candidate_id===candidate.candidate_id)).toBe(false);
 expect(result.source_scope_observations).toEqual([{policy_version:'payslip-explicit-source-scope-v1',scope:'cumulative',source_label:'ברוטו מצטבר',candidate}]);
 expect(normalizePayslipExtraction(result).source_scope_observations?.[0].candidate).toEqual(candidate);expect(raw).toEqual(before);
});
it('rejects foreign or duplicate observation identities',()=>{
 const f=buildSyntheticCaseFixture({fixture_id:'source-scope-fences',mode:'real'}),e=f.stored.extractions[0],{normalized_value,...candidate}=e.fields[0];void normalized_value;
 const raw={...e,fields:e.fields.map(({normalized_value,...field})=>{void normalized_value;return field;}),additional_components:[]};
 const observation={policy_version:'payslip-explicit-source-scope-v1',scope:'cumulative',source_label:'מצטבר',candidate:candidate as RawCandidateField};
 expect(extractionResultSchema.safeParse({...raw,source_scope_observations:[observation]}).success).toBe(false);
 expect(extractionResultSchema.safeParse({...raw,fields:[],source_scope_observations:[{...observation,candidate:{...candidate,source:{...candidate.source,document_id:'00000000-0000-4000-8000-000000000099'}}}]}).success).toBe(false);
});

it.each(['בסיס להפרשות','הפרשות עובד','הפרשה לפנסיה'])('does not confuse pension contributions with prior-period differences: %s',label=>{
 expect(explicitSourceScope('pension_base',label,context)).toBeNull();
});
it.each(['הפרש','הפרשים','הפרשי שכר','שכר מבוטח - הפרשים','retroactive pension'])('retains explicit prior-period wording: %s',label=>{
 expect(explicitSourceScope('pension_base',label,context)).toBe('retroactive');
});
