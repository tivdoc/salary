import {replayCaseAnalysisAiRelease,assertCaseAnalysisAiReleaseScope,type CaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {AiReleaseRuntimeResult} from '@/engine/ai-release-runtime';
import type {DocumentReviewPresentationInput,DocumentReviewPresentationFinding,DocumentReviewDisplayAmount} from './document-review-artifacts';
import {renderReviewBundle} from './document-review-projection';
import {DOCUMENT_REVIEW_RENDER_POLICY} from './document-review-render-policy';

export const AI_RELEASE_REPORT_TEMPLATE='saved-qualified-ai-analysis-v1' as const;
const TOPICS={minimum_wage:'שכר מינימום',working_time:'שעות עבודה',rest_day:'מנוחה שבועית',pension:'פנסיה',travel:'נסיעות',
 convalescence:'דמי הבראה',vacation:'חופשה',contract:'תנאי העסקה',bonuses:'תוספות ובונוסים'} as const;
const AMOUNT_LABELS={expected_only:'סכום מחושב לפי הכלל והתנאים שנבדקו',difference_positive:'פער בין הסכום המחושב לסכום שנרשם',
 difference_zero:'לא נמצא הפרש ברישום שנבדק',recorded_above_expected:'הסכום שנרשם גבוה מהסכום המחושב',nonmonetary:'תוצאה כמותית',blocked:'הבדיקה טרם הושלמה'} as const;
type QualifiedCheck=AiReleaseRuntimeResult['checks'][number];
function unresolved(check:QualifiedCheck){
 const codes=check.blockers.map(b=>b.code);
 if(codes.some(c=>/EXPIRED|expired/u.test(c)))return 'תוקף אחד התנאים או מקורות הסמכות לבדיקה פג. יש לחדש את הבדיקה לפני שימוש בתוצאה.';
 if(codes.some(c=>/conflict|CONFLICT/u.test(c)))return 'נשמר מידע סותר. נדרש בירור של המקור לפני חישוב תוצאה תקפה.';
 if(codes.includes('AI_RUNTIME_COUNTERFACTUAL_ONLY'))return 'נותרו הנחות שטרם הוכרעו. תרחיש מותנה אינו מוצג כאן כתוצאה שאושרה במסגרת בדיקת AI.';
 if(codes.some(c=>c==='AI_RUNTIME_CASE_DECISION_NOT_ACCEPTED'))return 'טרם הושלמה הכרעה אם הכלל חל על הנתונים והתקופה של הבדיקה.';
 if(codes.some(c=>/POLICY|REGISTRY|NOT_REVIEWED|FAMILY_NOT_ADMITTED/u.test(c)))return 'תנאי הפעלת בדיקת AI או בדיקת המקורות טרם הושלמו. התוצאה ממתינה לבדיקה במערכת.';
 return 'אין עדיין בסיס מספיק להשלמת בדיקת AI זו. יש להשלים את הנתונים והתנאים הממוקדים באזור האישי.';
}
function amount(label:string,value:QualifiedCheck['expected']):DocumentReviewDisplayAmount[]{
 if(value?.kind!=='money')return [];
 if(value.currency!=='ILS')throw Error('AI_REPORT_CURRENCY_UNSUPPORTED');
 return [{label,currency:'ILS',minor_units:value.minor_units}];
}
/** Projection only: the admitted runtime owns every displayed amount. Source
 * observations, assessment payloads and internal reason IDs are never spread
 * into the customer presentation. Existing supplemental checks are retained. */
export function qualifiedAiPresentation(input:DocumentReviewPresentationInput,envelope:CaseAnalysisAiRelease):DocumentReviewPresentationInput{
 const result=envelope.result;
 if(input.analysis_run_id!==result.analysis_run_id||input.period.from!==result.current_scope.period.from||input.period.to!==result.current_scope.period.to)
  throw Error('AI_REPORT_PRESENTATION_SCOPE');
 const wrapped=new Map(result.checks.map(c=>[c.check_id,c]));
 if(result.checks.some(c=>!input.findings.some(f=>f.id===c.check_id)))throw Error('AI_REPORT_CHECK_PROJECTION_MISSING');
 const findings:DocumentReviewPresentationFinding[]=input.findings.map(original=>{
  const check=wrapped.get(original.id);
  if(!check){
   const nonmonetary=result.nonmonetary_outcomes.find(o=>o.source_outcome.check_ids[0]+'.condition'===original.id);
   return nonmonetary?.state==='blocked'?{...original,status:'unknown',amounts:[],summary:'לא הושלמה בדיקת התנאים להפעלת התוצאה. יש לעיין בהשלמות הנדרשות.'}:original;
  }
  const period=`תקופת הבדיקה: ${check.period.from} עד ${check.period.to}.`;
  const rule=`כלל החישוב: ${check.rule_id}, גרסה ${check.rule_version}.`;
  // A separately calculated counterfactual may remain visible as a scenario,
  // retaining the original amounts and assumptions; it is never qualified.
  if(check.state!=='calculated'&&check.blockers.some(b=>b.code==='AI_RUNTIME_COUNTERFACTUAL_ONLY')&&original.status==='conditional')
   return {...original,summary:`תרחיש מותנה בלבד; אינו תוצאה שאושרה במסגרת בדיקת AI. ${period} ${rule} ${original.summary}`,
    conditions:[...original.conditions,'אין להציג את סכום התרחיש כחוב או כסכום שאושר לתשלום.']};
  if(check.state!=='calculated')return {id:original.id,title:original.title,source_ids:original.source_ids,status:'unknown',amounts:[],
   summary:`${unresolved(check)} ${period} ${rule}${original.status==='conditional'?' התנאים שנותרו: '+original.conditions.join(' '):''}`};
  const recorded=check.source_operands.some(o=>o.source.reading==='customer_declaration'||o.source.reading==='questionnaire_declaration')
   ?'סכום רשום לפי הקלט המזוהה':'סכום שנרשם במקור';
  const amounts=[...amount('סכום מחושב לפי הכלל',check.expected),...amount(recorded,check.recorded),...amount('הפרש בחישוב ההשוואה',check.difference)];
  let summary=`תוצאה במסגרת בדיקת AI. ${AMOUNT_LABELS[check.outcome]}. ${period} ${rule}`;
  if(check.outcome==='nonmonetary')summary+=` ${original.summary}`;
  if(check.outcome==='expected_only')summary+=' לא בוצעה השוואה לתשלום או להפקדה בפועל; היעדר רישום אינו תשלום אפס.';
  if(check.input_basis==='includes_customer_declaration')summary+=' חלק מהקלט נמסר בתשובות מזוהות או בשאלון, ואינו קריאת מסמך מאומתת.';
  if(check.source_operands.some(o=>o.source.reading==='identified_document_reading'))summary+=' קריאות תאים מסוימות אושרו או תוקנו בתשובה מזוהה; האימות מוגבל לתאים אלה.';
  summary+=' אין כאן קביעה של חוב מאומת או אישור שהכסף הועבר. אין לחבר תוצאה זו עם בדיקות חופפות.';
  return {id:original.id,title:original.title,source_ids:original.source_ids,status:'supported',amounts,summary};
 });
 const what=[...input.what_checked,'הסכומים מוצגים לכל בדיקה בנפרד. סכום צפוי, רישום והפרש אינם סכומים מצטברים; אין בדוח סך חוב.',
  ...result.families.map(f=>`${TOPICS[f.topic]} — ${f.state==='qualified'?'תנאי בדיקת AI הושלמו':f.state==='partial'?'בדיקה חלקית; נותרו נתונים או תנאים':'טרם הושלמו תנאי בדיקת AI'}.`)];
 return {...input,coverage:'partial',findings,what_checked:what,
  overview_finding_ids:input.overview_finding_ids?.filter(id=>findings.some(f=>f.id===id&&f.amounts.length))};
}
export function renderAiReleaseBundle(bundle:AnalysisResultBundle,reportId:string){
 if(!bundle.ai_release)throw Error('AI_REPORT_ENVELOPE_REQUIRED');
 const envelope=replayCaseAnalysisAiRelease(bundle.ai_release);
 assertCaseAnalysisAiReleaseScope(envelope,bundle);
 return renderReviewBundle(bundle,reportId,{gapPresentation:DOCUMENT_REVIEW_RENDER_POLICY,
  transformPresentation:input=>qualifiedAiPresentation(input,envelope),
  privateReportEvidence:{template:AI_RELEASE_REPORT_TEMPLATE,ai_release:envelope,qualified_runtime_sha256:envelope.result.sha256,
   legal_debt_total:null,combined_amount:null,publication_performed:false}});
}
