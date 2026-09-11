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
