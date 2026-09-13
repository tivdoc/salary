import {it,expect,vi} from 'vitest';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizePayslipExtraction} from '@/engine/extraction/normalization';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {openAiPayslipV2R6StructuredOutputSchema,openAiPayslipV2R8StructuredOutputSchema,openAiPayslipV2AcceptedOutputSchema} from './v2-schema';
import {mapOpenAiV2Output} from './v2-mapper';
vi.mock('server-only',()=>({}));
function fixture(){
 const evidence={page:1,region:'pension',source_label:'קרן',source_scope:{period_kind:'current',fund_kind:'pension',column_label:'סכום עובד'}};
 const candidate=(raw_value:string,period_kind='current',fund_kind='pension')=>({raw_value,confidence:'high',evidence:{...evidence,source_scope:{...evidence.source_scope,period_kind,fund_kind}},warnings:[]});
 const empty={rate_candidates:[],amount_candidates:[]};
 return {schema_version:'payslip-v2-source-scope-r8',detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:null,documented_raw_value:null,documented_confidence:'low',documented_evidence:evidence,inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[],payroll_rows:[{source_label:'חג',semantic_kind:'other',quantity_raw:'2',rate_raw:null,percentage_raw:null,amount_raw:'80.00',confidence:'high',evidence,warnings:[]}],
  totals:{visible:false,gross_candidates:[],deductions_candidates:[],net_candidates:[]},
  pension:{visible:true,base_candidates:[],employee:{rate_candidates:[],amount_candidates:[candidate('300'),candidate('40','retroactive'),candidate('100','current','study')]},employer:empty,severance:empty},earnings_components_complete:false,warnings:[]};
}
it('keeps explicit current/fund scope, retains other originals and never fills a blank rate',()=>{
 const output=openAiPayslipV2R8StructuredOutputSchema.parse(fixture()),before=canonicalSha256(output);
 const mapped=mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,model:'synthetic',extractorVersion:'2.1',durationMs:0,providerResponseId:'synthetic',tokenUsage:null,extractedAt:'2026-09-11T00:00:00Z'});
 const normalized=normalizePayslipExtraction(mapped.extraction);
 expect(normalized.fields.filter(f=>f.field==='pension_employee_contribution').map(f=>f.normalized_value)).toEqual([{currency:'ILS',minor_units:30000}]);
 expect(normalized.source_scope_observations?.map(o=>[o.scope,o.candidate.raw_value])).toEqual([['retroactive','40'],['study_fund','100']]);
 expect(normalized.additional_components[0]).toMatchObject({source_label:'חג',rate_raw:null,rate:null,source:{source_scope:{period_kind:'current',fund_kind:'pension',column_label:'סכום עובד'}}});
 expect(normalized.fields.find(f=>f.field==='pension_employee_contribution')?.confidence).toBe(.94);expect(canonicalSha256(output)).toBe(before);
});
it('requires explicit bounded metadata in r8 while preserving legacy parser bytes',()=>{
 const value=fixture();value.pension.employee.amount_candidates[0].evidence.source_scope.period_kind='guessed';
 expect(openAiPayslipV2R8StructuredOutputSchema.safeParse(value).success).toBe(false);
 const original=fixture();const legacy=JSON.parse(JSON.stringify(original,(key,value)=>key==='source_scope'||key==='schema_version'?undefined:value));
 const r7=openAiPayslipV2R6StructuredOutputSchema.parse(legacy),parsed=openAiPayslipV2AcceptedOutputSchema.parse(legacy);
 expect(canonicalSha256(parsed)).toBe(canonicalSha256(r7));expect(parsed).not.toHaveProperty('schema_version');
 expect(openAiPayslipV2R8StructuredOutputSchema.safeParse(legacy).success).toBe(false);
});
it('independent synthetic scope test keeps conflicting current observations and excludes only explicitly cumulative evidence',()=>{
 const value=fixture(),template=value.pension.employee.amount_candidates[0];
 value.pension.employee.amount_candidates=[{...structuredClone(template),raw_value:'111.11'},{...structuredClone(template),raw_value:'222.22'},
  {...structuredClone(template),raw_value:'999.99',evidence:{...template.evidence,source_scope:{...template.evidence.source_scope,period_kind:'cumulative'}}}];
 const output=openAiPayslipV2R8StructuredOutputSchema.parse(value),mapped=mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,model:'synthetic',extractorVersion:'2.1',durationMs:0,providerResponseId:'synthetic',tokenUsage:null,extractedAt:'2026-09-11T00:00:00Z'});
 const normalized=normalizePayslipExtraction(mapped.extraction);
 expect(normalized.fields.filter(f=>f.field==='pension_employee_contribution').map(f=>f.raw_value)).toEqual(['111.11','222.22']);
 expect(normalized.source_scope_observations?.map(o=>[o.scope,o.candidate.raw_value])).toEqual([['cumulative','999.99']]);
 expect(validatePayslipGate0(normalized).issues.some(i=>i.code==='conflicting_candidates')).toBe(true);
});
it('unknown source scope does not repair two contradictory salary months or pick the expected one',()=>{
 const value=fixture(),template=value.pension.employee.amount_candidates[0];
 const unknown={...template.evidence,region:'header',source_label:'תקופת שכר',source_scope:{period_kind:'unknown',fund_kind:'unknown',column_label:null}};
 const output=openAiPayslipV2R8StructuredOutputSchema.parse({...value,generic_fields:[{field:'salary_period',candidates:[{...template,raw_value:'03/2026',evidence:unknown},{...template,raw_value:'04/2026',evidence:unknown}]}]});
 const mapped=mapOpenAiV2Output({request:syntheticPayslipFixtures[0].request,output,model:'synthetic',extractorVersion:'2.1',durationMs:0,providerResponseId:'synthetic',tokenUsage:null,extractedAt:'2026-09-11T00:00:00Z'});
 const normalized=normalizePayslipExtraction(mapped.extraction);
 expect(normalized.fields.filter(f=>f.field==='salary_period').map(f=>f.raw_value)).toEqual(['03/2026','04/2026']);
 expect(validatePayslipGate0(normalized).field_assessments.filter(a=>a.field==='salary_period').every(a=>a.issue_codes.includes('conflicting_candidates'))).toBe(true);
});
