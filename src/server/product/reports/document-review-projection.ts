import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import {renderDocumentReviewArtifacts,type DocumentReviewPresentationInput} from './document-review-artifacts';
import {DOCUMENT_REVIEW_RENDER_POLICY,type DocumentReviewRenderPolicy} from './document-review-render-policy';
const TOPICS={minimum_wage:'שכר ושעות',working_time:'זמני עבודה ונוכחות',pension:'רישומי פנסיה',travel:'נסיעות',convalescence:'הבראה',vacation:'חופשה',sick_leave:'מחלה',rest_day:'מנוחה שבועית',bonuses:'רכיבים נוספים',contract:'תנאי ההעסקה'} as const;
const customerTitle=(title:string)=>title.replace(/(?<=\p{Script=Hebrew})(?=\d)|(?<=\d)(?=\p{Script=Hebrew})/gu,' ');
export const GROUPED_REVIEW_GAP_PRESENTATION=DOCUMENT_REVIEW_RENDER_POLICY;
export type ReviewProjectionOptions={gapPresentation?:DocumentReviewRenderPolicy};

/** Explicit projection: arithmetic differences are not a collectible debt and
 * provider/source/debug metadata belongs in the private evidence appendix. */
export function renderReviewBundle(bundle:AnalysisResultBundle,reportId:string,options:ReviewProjectionOptions={}){
 const review=bundle.document_review;if(!review)throw Error('DOCUMENT_REVIEW_REQUIRED');
 const sourceId=(id:string,version:string,page:number)=>`${id}:${version}:${page}`;
 const sources=review.documents.flatMap(d=>Array.from({length:d.page_count??1},(_,i)=>({
  id:sourceId(d.document_id,d.version_id,i+1),title:d.label,document_label:d.label,...(d.page_count?{page:i+1}:{}),
 })));
 const findings:DocumentReviewPresentationInput['findings']=review.checks.map(check=>{
  const c=check.calculation;
  const refs=[...new Set(c.input.operands.map(o=>sourceId(o.source.document_id,o.source.version_id,o.source.page)))].filter(id=>sources.some(s=>s.id===id));
  // Display spacing does not change the preserved source label or reading.
  const title=customerTitle(check.title);
  const common={id:check.check_id,title,source_ids:refs};
  if(c.state==='blocked')return {...common,status:'unknown' as const,summary:check.explanation||'חסר נתון או בסיס מתאים להשלמת הבדיקה.',amounts:[]};
  const amounts:{label:string;currency:'ILS';minor_units:number}[]=[];
  if(c.expected?.kind==='money')amounts.push({label:c.claim==='conditional_entitlement_candidate'?'סכום מחושב בתנאים המפורטים':'סכום שחושב',currency:'ILS',minor_units:c.expected.minor_units});
  const recordedRef='recorded_ref' in c.input.operation?c.input.operation.recorded_ref:null;
  const recordedOperand=c.input.operands.find(o=>o.id===recordedRef);
  if(c.recorded?.kind==='money')amounts.push({label:c.comparison_basis==='document_allocation'?'סכום שיוחס מתוך רכיבי התלוש':recordedOperand?.source.reading==='customer_declaration'?'סכום שנמסר בתשובה מזוהה':'סכום במסמך',currency:'ILS',minor_units:c.recorded.minor_units});
  if(c.difference?.kind==='money')amounts.push({label:'הפרש חשבוני',currency:'ILS',minor_units:c.difference.minor_units});
  let detail=check.explanation;
  if(c.input.operands.some(o=>o.source.reading==='identified_document_reading'))detail+=' קריאת תאים מסוימים אושרה או תוקנה בתשובה מזוהה; האימות חל על תאים אלה בלבד.';
  if(c.input_basis==='includes_customer_declaration')detail+=' חלק מהקלט בחישוב מבוסס על תשובה מזוהה שנמסרה, ולא על תא שנקרא במסמך.';
  if(c.observed_ratio?.kind==='rational'){
   const r=c.observed_ratio;
   const percent=Number(r.numerator)*100/Number(r.denominator);
   detail+=` היחס הנצפה הוא ${percent.toLocaleString('he-IL',{maximumFractionDigits:6})}%. היחס אינו קובע את שיעור הזכאות ואינו מוכיח הפקדה.`;
  }else if(c.difference?.kind==='rational'){
   const r=c.difference;
   const value=Number(r.numerator)/Number(r.denominator);
   detail+=` הפרש הכמויות הוא ${value.toLocaleString('he-IL',{maximumFractionDigits:6})}. יחידות המקור נשמרו בחישוב; הפרש כמות אינו קובע חוב.`;
  }
  if(c.claim==='conditional_entitlement_candidate')return {...common,status:'conditional' as const,summary:detail,amounts,
   conditions:[...(c.unresolved_conditions??[]).map(condition=>condition.assumption),'החישוב מותנה בתחולה ובפרשנות המפורטות; הוא אינו אישור הפעלה או חוב שנקבע.']};
  return {...common,status:'derived_arithmetic' as const,summary:detail,amounts};
 });
 const missing=review.checks.filter(c=>c.calculation.state==='blocked').map(c=>({title:c.title,detail:c.explanation||'אין עדיין בסיס מספיק לתוצאה.',next_step:'יש לעיין בהשלמות הממוקדות להלן.'}));
 // Ownership is an internal delivery/admission task. It stays in the private
 // review appendix and must not expose account matching to a customer.
 const visibleGaps=review.coverage_gaps.filter(g=>g.kind!=='ownership');
 const gapGroups:typeof visibleGaps[]=[];
 if(options.gapPresentation===GROUPED_REVIEW_GAP_PRESENTATION){
  const index=new Map<string,number>();
  for(const gap of visibleGaps){
   // Exact presentation equality only. A different reason, kind or next action
   // remains separate; original check IDs and topics stay in the appendix.
   const key=JSON.stringify([gap.kind,gap.detail,gap.next_step]);
   const existing=index.get(key);
   if(existing===undefined){index.set(key,gapGroups.length);gapGroups.push([gap]);}
   else gapGroups[existing].push(gap);
  }
 }else for(const gap of visibleGaps)gapGroups.push([gap]);
 for(const group of gapGroups){
  const gap=group[0],count=new Set(group.map(g=>g.check_id)).size;
  const topics=[...new Set(group.map(g=>TOPICS[g.topic]))];
  const scope=group.length>1?` המידע החסר נוגע ל־${count} בדיקות בנושאים: ${topics.join(', ')}.`:'';
  missing.push({title:gap.kind==='missing_rule'?'בדיקה שטרם נתמכת במערכת':gap.kind==='missing_applicability'?'בירור תחולה':'מידע ממוקד להמשך',detail:gap.detail+scope,next_step:gap.next_step});
 }
 for(const request of review.completions.customer_requests)missing.push({title:'השלמה ממוקדת',detail:request.target.question,next_step:'התשובה נדרשת רק לבדיקות התלויות בנתון זה.'});
 const topicCounts=new Map<string,number>();
 for(const check of review.checks)topicCounts.set(check.topic,(topicCounts.get(check.topic)??0)+1);
 const coverage=review.coverage_inventory;
 const coverageLines:string[]=[];
 if(coverage){
  coverageLines.push(`היקף השירות שנרכש כולל ${coverage.purchased_topics.length} נושאים: ${coverage.purchased_topics.map(t=>TOPICS[t]).join(', ')}. מספר הבדיקות שחושבו אינו מעיד שכל נושאי השירות הושלמו.`);
  coverageLines.push(coverage.purchase_period_evidence.state==='recorded'
   ?`תקופות המופיעות במקור הרכישה: ${coverage.purchase_period_evidence.periods.map(p=>`${p.from} עד ${p.to}`).join('; ')}.`
   :coverage.purchase_period_evidence.state==='missing'?'במקור הרכישה לא נרשמה תקופת בדיקה. תקופת המסמך או הדוח אינה משלימה את החסר הזה.':'תקופת הרכישה אינה מתועדת בקלט הבדיקה; אין להסיק אותה מחודש התלוש.');
  coverageLines.push(`מסגרת הדוח הנוכחי: ${coverage.review_period.from} עד ${coverage.review_period.to}.`);
  for(const source of coverage.source_periods){
   const label=review.documents.find(d=>d.document_id===source.document_id&&d.version_id===source.version_id)?.label;
   if(label)coverageLines.push(source.period?`תקופת המקור — ${label}: ${source.period.from} עד ${source.period.to}.`:`תקופת המקור — ${label}: לא זוהתה.`);
  }
  if(coverage.period_projection?.excluded_checks.length){
   const excluded=coverage.period_projection.excluded_checks,whole=excluded.filter(c=>c.reason==='outside_month').length;
   coverageLines.push(`${excluded.length} בדיקות מהקלט המקורי לא חושבו במסגרת החודש: ${whole} מחוץ לחודש ו־${excluded.length-whole} חוצות את גבולותיו. התקופות המקוריות נשמרו, ולא בוצעה חלוקה יחסית של סכומים או שעות.`);
  }
  const unevaluated=coverage.topics.filter(t=>t.coverage==='not_evaluated');
  if(unevaluated.length)coverageLines.push(`נושאים שנרכשו אך עדיין לא נכללה בהם בדיקה בדוח זה: ${unevaluated.map(t=>TOPICS[t.topic]).join(', ')}.`);
  for(const observation of coverage.unresolved_source_observations){
   const label=observation.field==='vacation_balance'?'יתרת חופשה':'יתרת מחלה';
   coverageLines.push(`נתון מקור שנשמר ללא פענוח מלא — ${label}: ${observation.raw_value}. היחידה לא זוהתה; לא נקבע אם מדובר בימים או בשעות.`);
  }
  for(const observation of coverage.source_balance_observations.filter(o=>o.unit!==null)){
   const label=observation.field==='vacation_balance'?'יתרת חופשה':'יתרת מחלה';
   coverageLines.push(`נתון מקור עם יחידה שנקראה במענה מזוהה — ${label}: ${observation.raw_value} ${observation.unit==='hours'?'שעות':'ימים'}. רק היחידה אושרה; המספר שנקרא ב־AI עדיין לא אושר. אין כאן התאמת תנועות היתרה או קביעת זכאות.`);
  }
 }
 const candidates=review.checks.filter(c=>findings.some(f=>f.id===c.check_id&&f.amounts.length));
 const highlights:string[]=[];const highlightedTopics=new Set<string>();
 const addHighlight=(check:typeof candidates[number])=>{if(highlights.length<5&&!highlights.includes(check.check_id)){highlights.push(check.check_id);highlightedTopics.add(check.topic);}};
 for(const check of candidates){const c=check.calculation;if(c.state!=='blocked'&&c.difference?.kind==='money'&&c.difference.minor_units!==0)addHighlight(check);}
 for(const check of candidates)if(!highlightedTopics.has(check.topic))addHighlight(check);
 for(const check of candidates)addHighlight(check);
 const input:DocumentReviewPresentationInput={schema_version:'document-review-presentation-v1',report_id:reportId,report_revision:bundle.case_revision,
  analysis_run_id:bundle.analysis_run_id,analysis_result_sha256:bundle.result_sha256,generated_at:`${bundle.as_of.slice(0,10)}T00:00:00.000Z`,
  case_public_id:'סקירת המסמכים',period:review.period,coverage:'partial',
  what_checked:[...coverageLines,...(review.checks.length?[...topicCounts].map(([topic,count])=>`${TOPICS[topic as keyof typeof TOPICS]}: ${count} ${count===1?'בדיקה':'בדיקות'}`):['זיהוי המסמכים, התקופות והמידע הזמין לצורך הבדיקה'])],
  overview_finding_ids:highlights,
  documents_checked:review.documents.map(d=>({label:d.label,source_ids:Array.from({length:d.page_count??1},(_,i)=>sourceId(d.document_id,d.version_id,i+1))})),
  sources,findings,missing_inputs:missing};
 return renderDocumentReviewArtifacts(input,{document_review:review,analysis_run_id:bundle.analysis_run_id,
  analysis_result_sha256:bundle.result_sha256,legal_topic_results:bundle.topic_results,
  ...(options.gapPresentation===GROUPED_REVIEW_GAP_PRESENTATION?{render_policy:GROUPED_REVIEW_GAP_PRESENTATION}:{})});
}
