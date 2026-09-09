import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {NormalizedPayslipExtraction} from '@/engine/extraction/payslip';
import type {Gate0Validation} from '@/engine/extraction/validation';

const minor=z.number().int().safe().nonnegative();
const component=z.object({semanticKind:z.enum(['hourly_base','overtime_125','overtime_150','travel','bonus']),
 sourceLabel:z.string().min(1),quantity:z.string().nullable(),rateMinor:minor.nullable(),amountMinor:minor,page:z.literal(1)});
const baseOracle=z.object({hours:z.array(z.string()),baseMinor:minor,hourlyRateMinor:minor,
 outcome:z.enum(['readable','essential_input_missing','conflicting_observations'])});
const hebrewOracle=baseOracle.extend({language:z.literal('he'),salaryType:z.literal('hourly'),employmentStartDate:z.literal('2025-01-15'),
 month:z.literal('2026-06'),grossMinor:minor,deductionsMinor:minor,netMinor:minor,overtime125Hours:z.string(),overtime150Hours:z.string(),
 travelMinor:minor,pensionBaseMinor:minor,pensionEmployeeMinor:minor,pensionEmployerMinor:minor,severanceMinor:minor,
 pensionEmployeeBasisPoints:minor,pensionEmployerBasisPoints:minor,severanceBasisPoints:minor,
 expectedMinor:z.null(),gapMinor:z.null(),financialScenario:z.literal('outside_single_regular_base_engineering_scope'),
 equation:z.string().min(1),components:z.array(component).length(5),
 deductions:z.array(z.object({sourceLabel:z.string().min(1),amountMinor:minor,page:z.literal(1)})).length(4)});
export const liveCorpusEntrySchema=z.object({id:z.string().regex(/^[a-z0-9-]+$/u),path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 sizeBytes:z.number().int().positive(),mimeType:z.enum(['application/pdf','image/png','image/jpeg']),pageCount:z.literal(1).optional(),
 oracle:z.union([hebrewOracle,baseOracle])});
export type LiveCorpusEntry=z.infer<typeof liveCorpusEntrySchema>;
export const LIVE_EXTRACTION_CORPUS_PATHS={
 legacy:'docs/release-evidence/automatic-dev-live-extraction/independent-input-oracles.json',
 'hebrew-june2026':'docs/release-evidence/live-provider-june2026/independent-input-oracles.json',
} as const;
export function loadLiveExtractionCorpus(selection:string='hebrew-june2026',ids?:string){
 if(!['legacy','hebrew-june2026','all'].includes(selection))throw Error('LIVE_CORPUS_SELECTION_INVALID');
 const kinds=selection==='all'?['legacy','hebrew-june2026'] as const:[selection as keyof typeof LIVE_EXTRACTION_CORPUS_PATHS];
 const all=kinds.flatMap(kind=>{
  const input=z.object({synthetic:z.literal(true),providerCalled:z.literal(false),humanReview:z.literal(false),legalGoldenApproval:z.literal(false),
   files:z.array(liveCorpusEntrySchema).length(kind==='legacy'?7:4)}).parse(JSON.parse(readFileSync(LIVE_EXTRACTION_CORPUS_PATHS[kind],'utf8')));
  const root=LIVE_EXTRACTION_CORPUS_PATHS[kind].slice(0,LIVE_EXTRACTION_CORPUS_PATHS[kind].lastIndexOf('/')+1);
  for(const entry of input.files){
   if(!entry.path.startsWith(root)||entry.path.slice(root.length).includes('/')||entry.path.includes('..')||entry.path.includes('\\'))
    throw Error('LIVE_CORPUS_PATH_INVALID');
   if(kind==='hebrew-june2026')hebrewOracle.parse(entry.oracle);
  }
  return input.files;
 });
 if(new Set(all.map(entry=>entry.id)).size!==all.length||new Set(all.map(entry=>entry.sha256)).size!==all.length)
  throw Error('LIVE_CORPUS_DUPLICATE');
 const selected=ids===undefined?all:ids.split(',').map(id=>{
  const entry=all.find(entry=>entry.id===id.trim());if(!entry)throw Error('LIVE_CORPUS_ID_INVALID');return entry;
 });
 if(new Set(selected.map(entry=>entry.id)).size!==selected.length||!selected.length)throw Error('LIVE_CORPUS_ID_INVALID');
 return selected;
}

/** Independent literal observations are compared with the saved normalized
 * extraction. This validator computes no entitlement, findings or reports. */
export function checkLiveExtractionCorpus(input:{entry:LiveCorpusEntry;extraction:NormalizedPayslipExtraction;validation:Gate0Validation}){
 const {entry,extraction,validation}=input,oracle=entry.oracle,failures:string[]=[];
 const values=(field:string)=>extraction.fields.filter(value=>value.field===field&&value.normalized_value!==null).map(value=>value.normalized_value);
 const check=(field:string,expected:unknown)=>{
  const actual=[...new Set(values(field).map(value=>canonicalSha256(value)))];
  if(actual.length!==1||actual[0]!==canonicalSha256(expected))failures.push(`FIELD_${field}`);
 };
 check('salary_period',{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'});check('salary_type','hourly');
 check('base_monthly_salary',{currency:'ILS',minor_units:oracle.baseMinor});
 check('hourly_rate',{currency:'ILS',minor_units:oracle.hourlyRateMinor});
 const expectedHours=oracle.hours.map(amount=>canonicalSha256({amount,unit:'hours_per_month'})).sort();
 const actualHours=[...new Set(values('regular_hours').map(value=>canonicalSha256(value)))].sort();
 if(canonicalSha256(expectedHours)!==canonicalSha256(actualHours))failures.push('FIELD_regular_hours');
 if(oracle.outcome==='essential_input_missing'&&!validation.issues.some(issue=>issue.field_keys.includes('regular_hours')))
  failures.push('MISSING_HOURS_NOT_FLAGGED');
 if(oracle.outcome==='conflicting_observations'&&!validation.issues.some(issue=>issue.field_keys.includes('regular_hours')
  &&['conflicting_candidates','recovery_conflict','hourly_salary_mismatch'].includes(issue.code)))failures.push('CONFLICTING_HOURS_NOT_FLAGGED');
 if([...extraction.fields,...extraction.additional_components].some(value=>value.source.document_id!==extraction.document_id
  ||value.source.page!==1||!value.source.text_fragment?.trim()))failures.push('SOURCE_BINDING');
 if('language' in oracle){
  check('employment_start_date',oracle.employmentStartDate);
  const monies={gross_salary:oracle.grossMinor,total_deductions:oracle.deductionsMinor,net_salary:oracle.netMinor,
   travel_amount:oracle.travelMinor,pension_base:oracle.pensionBaseMinor,pension_employee_contribution:oracle.pensionEmployeeMinor,
   pension_employer_contribution:oracle.pensionEmployerMinor,severance_contribution:oracle.severanceMinor};
  for(const [field,value] of Object.entries(monies))check(field,{currency:'ILS',minor_units:value});
  for(const [field,value] of Object.entries({pension_employee_rate:oracle.pensionEmployeeBasisPoints,
   pension_employer_rate:oracle.pensionEmployerBasisPoints,severance_rate:oracle.severanceBasisPoints}))check(field,{basis_points:value});
  check('overtime_125_hours',{amount:oracle.overtime125Hours,unit:'hours_per_month'});
  check('overtime_150_hours',{amount:oracle.overtime150Hours,unit:'hours_per_month'});
  const paidRows=extraction.additional_components.filter(row=>row.amount!==null&&row.semantic_kind!=='deduction');
  if(paidRows.length!==oracle.components.length)failures.push('WAGE_COMPONENT_COUNT');
  for(const expected of oracle.components){
   const matches=paidRows.filter(row=>row.semantic_kind===expected.semanticKind&&row.quantity===expected.quantity
    &&(row.rate?.minor_units??null)===expected.rateMinor&&row.amount?.currency==='ILS'&&row.amount.minor_units===expected.amountMinor
    &&row.source.page===expected.page&&row.source_label.normalize('NFKC').replace(/\s+/gu,' ').trim()===expected.sourceLabel);
   if(matches.length!==1)failures.push(`ROW_${expected.semanticKind}`);
  }
  const deductionRows=extraction.additional_components.filter(row=>row.semantic_kind==='deduction');
  if(deductionRows.length!==oracle.deductions.length)failures.push('DEDUCTION_ROW_COUNT');
  for(const [index,expected] of oracle.deductions.entries()){
   if(deductionRows.filter(row=>row.amount?.currency==='ILS'&&row.amount.minor_units===expected.amountMinor
    &&row.source.page===expected.page&&row.source_label.normalize('NFKC').replace(/\s+/gu,' ').trim()===expected.sourceLabel).length!==1)
    failures.push(`DEDUCTION_ROW_${index}`);
  }
  if(!extraction.earnings_components_complete)failures.push('EARNINGS_COMPLETENESS');
  if(validation.issues.some(issue=>['gross_component_mismatch','payslip_totals_mismatch','pension_contribution_mismatch','severance_contribution_mismatch'].includes(issue.code)))
   failures.push('SOURCE_TOTALS_RECONCILIATION');
 }
 return {passed:failures.length===0,failures,observedFieldCount:extraction.fields.length,observedComponentCount:extraction.additional_components.length,
  financialResultGenerated:false,legalReadinessProved:false};
}
