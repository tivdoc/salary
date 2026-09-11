import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from './contracts.ts';
import {documentReviewCalculationInputSchema} from './calculations.ts';
import {parseReviewCompletionInput} from './completions.ts';
import {runDocumentReview} from './service.ts';

/** A purchase is calendar-month scoped. An observation spanning more than that
 * month is retained in the original input, never silently apportioned here. */
export function projectDocumentReviewMonth(candidate:unknown,month:string){
 z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(month);
 const source=documentReviewInputSchema.parse(candidate),completion=parseReviewCompletionInput(source.completion_input);
 const period={from:month+'-01',to:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)};
 if(source.period.to<period.from||source.period.from>period.to)throw Error('REVIEW_MONTH_NO_SOURCE_OVERLAP');
 if(source.answer_history.length||completion.previous_answers?.length||completion.evidence.some(e=>e.origin==='answer'))throw Error('REVIEW_MONTH_IDENTIFIED_HISTORY');
 runDocumentReview(source,'monthly-source-validation');
 const excluded:{check_id:string;period:{from:string;to:string};calculation_sha256:string;reason:'outside_month'|'cross_month'}[]=[];
 const checks=source.checks.filter(check=>{
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
  if(calculation.period.from>=period.from&&calculation.period.to<=period.to)return true;
  excluded.push({check_id:check.check_id,period:calculation.period,calculation_sha256:canonicalSha256(calculation),
   reason:calculation.period.to<period.from||calculation.period.from>period.to?'outside_month':'cross_month'});
  return false;
 });
 const retainedIds=new Set([...checks.map(c=>c.check_id),...source.coverage_gaps.map(g=>g.check_id)]);
 const needs=completion.needs.map(need=>({...need,dependent_check_ids:need.dependent_check_ids.filter(id=>retainedIds.has(id))})).filter(n=>n.dependent_check_ids.length>0);
 const neededFacts=new Set(needs.map(n=>n.fact_key));
 // A broad-period observation cannot suppress a targeted monthly question.
 const evidence=completion.evidence.filter(e=>neededFacts.has(e.fact_key)&&(e.period===null||e.period.from>=period.from&&e.period.to<=period.to));
 const gaps:DocumentReviewInput['coverage_gaps']=excluded.map(row=>({check_id:row.check_id,
  topic:source.checks.find(c=>c.check_id===row.check_id)!.topic,kind:'missing_fact',
  detail:`הבדיקה המקורית מתייחסת לתקופה ${row.period.from} עד ${row.period.to}, מחוץ למסגרת המלאה של חודש ${month}. היא לא חושבה בדוח החודשי ולא בוצעה חלוקה יחסית של סכומים או שעות.`,
  next_step:'כדי לחשב בדיקה זו לחודש הנבחר, נדרשים נתוני מקור המפרידים את התקופה. הבדיקה המקורית נשמרה בהיסטוריית קלט המקור.'}));
 const input=documentReviewInputSchema.parse({...source,period,checks,coverage_gaps:[...source.coverage_gaps,...gaps],
  answer_bindings:source.answer_bindings.filter(b=>checks.some(c=>c.check_id===b.check_id)&&neededFacts.has(b.fact_key)),
  completion_input:{...completion,period,needs,evidence}});
 runDocumentReview(input,'monthly-projection-validation');
 const body={schema_version:'document-review-month-projection-v1' as const,source_input_sha256:canonicalSha256(source),source_period:source.period,
  projected_input_sha256:canonicalSha256(input),period,retained_check_ids:checks.map(c=>c.check_id),excluded_checks:excluded,
  retained_completion_fact_keys:[...neededFacts],proration_performed:false as const};
 return {input,receipt:{...body,receipt_sha256:canonicalSha256(body)}};
}
