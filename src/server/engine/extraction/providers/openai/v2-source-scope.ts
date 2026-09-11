import 'server-only';
import {extractionResultSchema,type ExtractionResult,type PayslipFieldKey,sourceScopeObservationSchema} from '@/engine/extraction/contracts';
import type {z} from 'zod';

export const OPENAI_V2_SOURCE_SCOPE_POLICY='payslip-explicit-source-scope-v1' as const;
type Scope=z.infer<typeof sourceScopeObservationSchema>['scope'];
function labelKey(value:string){return value.normalize('NFKC').replace(/["'״׳.]/gu,'').replace(/\s+/gu,' ').trim().toLowerCase();}

/** These are semantic exclusions established by literal headings, never a
 * numeric oracle, assumed fund percentage, employer name or arithmetic fit.
 * Ambiguous current/retro rows with the same literal label stay ambiguous. */
export function explicitSourceScope(field:PayslipFieldKey,label:string,context:{hasSalaryNet:boolean;hasVoluntaryDeduction:boolean;hasSeparateEmployeeFunds:boolean}):Scope|null {
 const key=labelKey(label),pension=field.startsWith('pension_')||field.startsWith('severance_');
 if(/(?:מצטבר|מצטברת|cumulative|year to date|\bytd\b)/u.test(key))return 'cumulative';
 if(/(?:^|[^\p{L}\p{N}])(?:הפרש(?:ים|י)?|רטרו|retroactive|prior period)(?=$|[^\p{L}\p{N}])/u.test(key))return 'retroactive';
 if(pension&&/(?:קרן השתלמות|קהש|study fund)/u.test(key))return 'study_fund';
 if(field==='total_deductions'&&/^(?:ניכויי רשות|סהכ ניכויי רשות|מקדמה|מקדמות|advance|voluntary deductions)$/u.test(key))return 'voluntary_deduction';
 if(field==='total_deductions'&&context.hasSeparateEmployeeFunds&&/^(?:ניכויי חובה|סהכ ניכויי חובה|mandatory deductions)$/u.test(key))return 'mandatory_deduction_subtotal';
 if(field==='net_salary'&&context.hasSalaryNet&&context.hasVoluntaryDeduction&&/^(?:לתשלום|נטו לתשלום|payable|final payable)$/u.test(key))return 'final_payable';
 if(field==='regular_hours'&&/^(?:שעות עבודה|שע בחברה|סהכ שעות|סהכ שעות עבודה|total hours|attendance hours)$/u.test(key))return 'attendance_total';
 if(field==='severance_contribution'&&/(?:לא חויב מס|פטור ממס|tax exempt)/u.test(key))return 'tax_exemption_reference';
 if(field==='pension_employer_contribution'&&/^(?:גמל מעסיק|תגמולים ופיצויים|combined employer funds)$/u.test(key))return 'combined_employer_funds';
 return null;
}

export function classifyOpenAiV2SourceScopes(input:ExtractionResult,labels:ReadonlyMap<string,string>,context:{hasSeparateEmployeeFunds:boolean}):ExtractionResult {
 const extraction=extractionResultSchema.parse(input);
 const hasSalaryNet=extraction.fields.some(candidate=>candidate.field==='net_salary'&&/^(?:שכר נטו|net salary)$/u.test(labelKey(labels.get(candidate.candidate_id)??'')));
 const hasVoluntaryDeduction=extraction.fields.some(candidate=>candidate.field==='total_deductions'&&/^(?:ניכויי רשות|סהכ ניכויי רשות|מקדמה|מקדמות|advance|voluntary deductions)$/u.test(labelKey(labels.get(candidate.candidate_id)??'')));
 const observations=[...(extraction.source_scope_observations??[])];
 const fields=extraction.fields.filter(candidate=>{
  const label=labels.get(candidate.candidate_id);
  if(!label)return true;
  const metadata=candidate.source.source_scope;
  const pension=candidate.field.startsWith('pension_')||candidate.field.startsWith('severance_');
  const sourceScoped:Scope|null=metadata?.period_kind==='cumulative'?'cumulative':metadata?.period_kind==='retroactive'?'retroactive':
   pension&&metadata?.fund_kind==='study'?'study_fund':candidate.field.startsWith('pension_')&&metadata?.fund_kind==='severance'?'severance_fund':
   pension&&metadata?.fund_kind==='combined'?'combined_employer_funds':null;
  const scope=sourceScoped??explicitSourceScope(candidate.field,label,{...context,hasSalaryNet,hasVoluntaryDeduction});
  if(!scope)return true;
  observations.push({policy_version:OPENAI_V2_SOURCE_SCOPE_POLICY,scope,source_label:label,candidate});
  return false;
 });
 if(observations.length===(extraction.source_scope_observations?.length??0))return extraction;
 return extractionResultSchema.parse({...extraction,fields,source_scope_observations:observations});
}
