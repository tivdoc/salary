import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {WorkingTimeEntitlementInput,WorkingTimeWorkday} from './contracts.ts';
import {WORKING_TIME_SOURCE_REVIEW_SHA256} from './source-policy.ts';
export const WORKING_TIME_PROTECTED_BREAK_POLICY='working-time-protected-breaks-v1' as const;
export const WORKING_TIME_PROTECTED_BREAK_AMENDMENT=deepFreeze({document_id:'il.hours-work-rest-law.amendment-13.2009',
 version_id:'IL_HOURS_WORK_REST_LAW_AMENDMENT_13@official-v1',file_sha256:'45f635d0b4a32bbba99e33c62eddd40329fb2f1319bce4092b25db6122dd36f0',page_count:3,
 url:'https://fs.knesset.gov.il/18/law/18_lsr_300963.pdf',label:'חוק שעות עבודה ומנוחה — תיקון 13, סעיפים 1–2; תחילה סעיף 5'});
export const WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW=deepFreeze({schema_version:WORKING_TIME_PROTECTED_BREAK_POLICY,
 baseline_source_review_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256,amendment:WORKING_TIME_PROTECTED_BREAK_AMENDMENT,
 effective_from:'2010-01-01',supported_period:{from:'2026-05-01',to:'2026-07-31'},
 method:'section1_includes_toilet_and_short_agreed_refreshment;section20_ordinary_free_meal_rest_only',
 short_ordinary_break:'requires_separate_assessment_below_30_minutes',human_attestation:null,publication_authority:false});
export const WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW_SHA256=canonicalSha256(WORKING_TIME_PROTECTED_BREAK_SOURCE_REVIEW);
export const WORKING_TIME_BREAK_TYPE_OPTIONS=['ordinary_meal_or_rest','toilet','short_refreshment','unknown'] as const;
export const WORKING_TIME_BREAK_TYPE_QUESTION='מה היה סוג ההפסקה במקטע השעות המזוהה: הפסקת אוכל או מנוחה רגילה, שימוש בשירותים, או התרעננות קצרה בהסכמת המעסיק?';
type Interval=WorkingTimeWorkday['intervals'][number];
type State='missing'|'unknown'|'conflict'|'stale'|'expired'|'unreadable'|'unsupported';
export type WorkingTimeIntervalTreatment={state:'included'|'excluded'}|{state:'unresolved';fact:'classification'|'break_type';reason:State};
export function workingTimeIntervalTreatment(input:WorkingTimeEntitlementInput,interval:Interval):WorkingTimeIntervalTreatment{
 const c=interval.classification,known=(f:{state:string;value:unknown;source:unknown}|undefined)=>f&&['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
 const state=(value:string|undefined):State=>['conflict','stale','expired','unreadable','unknown'].includes(value??'')?value as State:'missing';
 if(!known(c)||c.value==='unknown')return {state:'unresolved',fact:'classification',reason:c.value==='unknown'?'unknown':state(c.state)};
 if(input.protected_break_policy!==WORKING_TIME_PROTECTED_BREAK_POLICY)return {state:c.value==='free_break'?'excluded':'included'};
 const b=interval.break_type;
 if(c.value==='worked'&&known(b)&&b?.value==='ordinary_meal_or_rest')return {state:'unresolved',fact:'break_type',reason:'conflict'};
 if(c.value!=='free_break')return {state:'included'};
 if(!known(b)||b?.value==='unknown')return {state:'unresolved',fact:'break_type',reason:b?.value==='unknown'?'unknown':state(b?.state)};
 if(b!.value!=='ordinary_meal_or_rest')return {state:'included'};
 const minutes=(Date.parse(interval.end_at)-Date.parse(interval.start_at))/60000;
 return minutes>=30?{state:'excluded'}:{state:'unresolved',fact:'break_type',reason:'unsupported'};
}
/** Exact existing answer-target hash, with the original clock source preserved
 * after unknown/correction. An answer for a different interval is not reused. */
export function workingTimeBreakTarget(review:DocumentReviewInput,input:WorkingTimeEntitlementInput,inputPath:string){
 const match=/^workdays\.(\d+)\.intervals\.(\d+)\.break_type$/u.exec(inputPath);if(!match)throw Error('WT_BREAK_TARGET_PATH');
 const interval=input.workdays[Number(match[1])]?.intervals[Number(match[2])];if(!interval)throw Error('WT_BREAK_TARGET_PATH');
 const source=interval.clock_source;
 if(!review.documents.some(d=>d.case_id===input.case_id&&d.document_id===source.document_id&&d.version_id===source.version_id&&d.file_sha256===source.file_sha256))throw Error('WT_BREAK_TARGET_SOURCE');
 const pins=[{case_id:input.case_id,document_id:source.document_id,version_id:source.version_id,source_sha256:source.file_sha256}];
 const clock_scope_sha256=canonicalSha256({id:interval.id,start_at:interval.start_at,end_at:interval.end_at,printed_duration:interval.printed_duration,clock_source:source});
 return {fact_key:'entitlement.work.'+canonicalSha256({period:input.period,pins,prefix:input.check_id_prefix,path:inputPath,policy:WORKING_TIME_PROTECTED_BREAK_POLICY,clock_scope_sha256}).slice(0,32),pins};
}
export function assertWorkingTimeBreakAnswer(review:DocumentReviewInput,input:WorkingTimeEntitlementInput,inputPath:string,interval:Interval){
 const source=interval.break_type?.source;if(!source||source.reading!=='customer_declaration')return;
 const target=workingTimeBreakTarget(review,input,inputPath),h=review.answer_history.find(h=>h.receipt.case_id===input.case_id&&h.receipt.request_id===source.document_id
  &&`${h.receipt.request_id}:${h.receipt.answer_revision}`===source.version_id&&h.receipt.answer_sha256===source.reading_receipt_sha256);
 if(!h||h.request.target.fact_key!==target.fact_key||canonicalSha256(h.request.target.source_pins??[])!==canonicalSha256(target.pins))throw Error('WT_BREAK_ANSWER_TARGET');
}
