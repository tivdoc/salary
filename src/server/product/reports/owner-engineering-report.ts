import {replayCaseAnalysisOwnerEngineering,assertCaseAnalysisOwnerEngineeringScope,type CaseAnalysisOwnerEngineering} from '@/engine/case-analysis/contracts';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {DocumentReviewPresentationInput,DocumentReviewPresentationFinding,DocumentReviewDisplayAmount} from './document-review-artifacts';
import {renderReviewBundle} from './document-review-projection';
import {DOCUMENT_REVIEW_RENDER_POLICY} from './document-review-render-policy';

export const OWNER_ENGINEERING_REPORT_TEMPLATE='saved-owner-engineering-analysis-v1' as const;
const DISCLAIMER='טיוטת בדיקה הנדסית פרטית לבעלים. אינה דוח שירות ללקוח, אישור מקצועי או קביעה של חוב.';
export function ownerEngineeringPresentation(input:DocumentReviewPresentationInput,envelope:CaseAnalysisOwnerEngineering):DocumentReviewPresentationInput{
 const result=envelope.result;
 if(input.analysis_run_id!==result.analysis_run_id||input.period.from!==result.current_scope.period.from||input.period.to!==result.current_scope.period.to)
  throw Error('OWNER_ENGINEERING_PRESENTATION_SCOPE');
 const checks=new Map(result.checks.map(c=>[c.check_id,c]));
 if(result.checks.some(c=>!input.findings.some(f=>f.id===c.check_id)))throw Error('OWNER_ENGINEERING_CHECK_PROJECTION_MISSING');
 const findings:DocumentReviewPresentationFinding[]=input.findings.map(original=>{
  const check=checks.get(original.id);
  if(!check){
   const outcome=result.nonmonetary_outcomes.find(o=>o.source_outcome.check_ids[0]+'.condition'===original.id);
   return outcome?.state==='blocked'?{...original,status:'unknown',amounts:[],
    summary:'טרם הושלמה בדיקת המקור או התנאים להפעלת הבדיקה. אי אפשר לקבוע שהתנאי לא התקיים על סמך תוצאה זו.'}:original;
  }
  if(check.state!=='calculated')return {id:original.id,title:original.title,source_ids:original.source_ids,status:'unknown',amounts:[],
   summary:'אין עדיין בסיס מספיק לחישוב בדיקה זו. הנתונים, התחולה או בדיקת המקור נשארו לא פתורים. '+original.summary};
  const amounts:DocumentReviewDisplayAmount[]=[];
  for(const [label,value] of [['צפוי לפי הכלל המועמד שנבדק',check.expected],['רשום בקלט המזוהה',check.recorded],['הפרש חשבוני בתרחיש',check.difference]] as const){
   if(value?.kind==='money'){
    if(value.currency!=='ILS')throw Error('OWNER_ENGINEERING_CURRENCY');
    amounts.push({label,currency:'ILS',minor_units:value.minor_units});
   }
  }
  const conditions=[DISCLAIMER,'החלטת הפעלת השירות נפרדת מתוצאת הבדיקה ההנדסית. אין לחבר בדיקות חופפות לסך חוב.'];
  if(check.human_law_review?.human_by_law.state==='unresolved')conditions.push('טרם הוכרעה דרישת סמכות לפי דין לגבי תוכן השירות. לא ניתן אישור אנושי באמצעות בדיקה זו.');
  let summary=`חישוב הנדסי לפי כלל ${check.rule_id}, גרסה ${check.rule_version}, לתקופה ${check.period.from} עד ${check.period.to}.`;
  if(check.input_basis==='includes_customer_declaration')summary+=' חלק מהקלט נמסר בתשובה מזוהה ואינו אימות של קריאת המסמך.';
  if(check.source_operands.some(o=>o.source.reading==='identified_document_reading'))summary+=' האימות מתייחס לתאים שנקראו בלבד.';
  if(check.outcome==='expected_only')summary+=' לא הוכח תשלום או העברה בפועל; היעדר רישום אינו אפס.';
  return {id:original.id,title:original.title,source_ids:original.source_ids,status:'conditional',conditions,amounts,summary};
 });
 return {...input,coverage:'partial',what_checked:[DISCLAIMER,...input.what_checked],findings,
  overview_finding_ids:input.overview_finding_ids?.filter(id=>findings.some(f=>f.id===id&&f.amounts.length))};
}
export function renderOwnerEngineeringBundle(bundle:AnalysisResultBundle,reportId:string){
 if(!bundle.owner_engineering||bundle.ai_release)throw Error('OWNER_ENGINEERING_ENVELOPE_REQUIRED');
 const envelope=replayCaseAnalysisOwnerEngineering(bundle.owner_engineering);
 assertCaseAnalysisOwnerEngineeringScope(envelope,bundle);
 return renderReviewBundle(bundle,reportId,{gapPresentation:DOCUMENT_REVIEW_RENDER_POLICY,
  transformPresentation:input=>ownerEngineeringPresentation(input,envelope),
  privateReportEvidence:{template:OWNER_ENGINEERING_REPORT_TEMPLATE,owner_engineering:envelope,engineering_runtime_sha256:envelope.result.sha256,
   legal_debt_total:null,combined_amount:null,release_authorized:false,publication_allowed:false,notification_allowed:false,publication_performed:false}});
}
