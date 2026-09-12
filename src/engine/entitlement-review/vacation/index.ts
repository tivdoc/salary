import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewOperand,DocumentReviewSource} from '../../document-review/calculations.ts';
import {vacationEntitlementInputSchema,type VacationEntitlementInput,type VacationDecision,type VacationGap} from './contracts.ts';
import {VACATION_CATALOG,VACATION_SOURCE_REVIEW,VACATION_SOURCE_REVIEW_SHA256,isPinnedVacationLegalSource,vacationLegalSource} from './sources.ts';
import {vacationAnnualCalculation,vacationPayCalculation} from './rules.ts';
import {assertVacationDerivedFacts,vacationProductDecisionSources} from './product-facts.ts';
export * from './contracts.ts';export * from './sources.ts';

export const VACATION_APPLICABILITY=deepFreeze({
 'vacation.general_section3':'יש לבחון שהמסגרת הכללית של סעיף 3 חלה. עובד זמני לפי סעיפים 4 ו־15 או הסדר מיוחד מחייבים מסלול אחר.',
 'vacation.no_better_arrangement':'יש לבדוק הסכם קיבוצי, צו ענפי, חוזה או נוהג מיטיב, והוראות מיוחדות הנוגעות לעובד. מכסת המינימום אינה מחליפה אותם.',
 'vacation.seniority_basis':'יש לזהות את שנת הוותק הרלוונטית אצל אותו מעסיק או מקום עבודה. אין להסיק ותק משפטי ממספר חודש בודד.',
 'vacation.annual_workdays':'יש לזהות את ימי העבודה הנכללים במניין השנתי ואת סיווג ההיעדרויות. לא כל שורת נוכחות היא יום עבודה מזכה.',
 'vacation.pay_applicability':'יש לזהות חופשה שנלקחה בפועל והזכאות לתשלום בעדה. ענף זה אינו פדיון בסיום עבודה או תמורת חופשה לעובד זמני.',
 'vacation.pay_wage_basis':'יש לזהות את השכר הרגיל לפי סעיף 10, לרבות רכיביו והוצאות שאינן מתקיימות בחופשה. אין להשתמש בברוטו בלתי מסווג.',
 'vacation.pay_quarter_selection':'יש לזהות את רבע השנה הקודם לחופשה או, כשיש חודשי עבודה לא מלאה, את הרבע המתאים מתוך השנה הקודמת לפי בחירת העובד. אין בחירת רבע אוטומטית.',
 'vacation.pay_calendar_days':'יש לזהות את מספר ימי החופשה ביחידת ימי לוח ואת ימי המנוחה/החג שאינם נכללים. אין להמיר ימי עבודה או שעות באופן שקט.',
 'vacation.pay_monthly_period':'לעובד חודשי נדרש השכר שהיה מקבל עבור אותה תקופת חופשה אילו המשיך לעבוד, ללא מחלק יומי משוער.',
 'vacation.pay_rounding':'הענף השעתי משתמש ביחס מדויק ובעיגול חצי כלפי מעלה פעם אחת בסכום הכולל. יש לבחון הסדר עיגול מחייב אחר אם קיים.',
 'vacation.pay_recorded_allocation':'יש לקשור את הסכום שנרשם לתשלום חופשה לאותה תקופה ולאותם ימים. אין להשוות שורת תשלום כללית בלי הקצאה.',
});
type Key=keyof typeof VACATION_APPLICABILITY;
export const vacationCheckIds=(prefix:string)=>({quota:`${prefix}.annual.quota`,prorated:`${prefix}.annual.prorated`,pay:`${prefix}.pay.expected`,comparison:`${prefix}.pay.comparison`});
const available=(o:DocumentReviewOperand|null)=>o!==null&&['observed','declared'].includes(o.state)&&o.printed_value!==null;
const days=(from:string,to:string)=>Math.floor((Date.parse(to)-Date.parse(from))/86400000)+1;
function sourceBound(s:DocumentReviewSource,input:VacationEntitlementInput){
 const pins=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].file_sha256!==s.file_sha256||s.page>pins[0].page_count||pins[0].kind==='legal_source')throw Error('VACATION_CASE_SOURCE_BINDING');
 if((s.reading==='customer_declaration')!==(pins[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(pins[0].kind==='questionnaire'))throw Error('VACATION_DECLARATION_SOURCE');
}
function quantity(o:DocumentReviewOperand|null,unit:'count'|'days'|'calendar_days',max:number){
 if(!o)return;if(o.representation!=='integer'||o.quantity_unit!==unit)throw Error('VACATION_QUANTITY_UNIT');
 if(o.printed_value!==null&&(!/^(0|[1-9]\d{0,3})$/u.test(o.printed_value)||Number(o.printed_value)>max))throw Error('VACATION_QUANTITY_BOUNDS');
}
function money(o:DocumentReviewOperand|null){if(o&&(o.representation!=='money_ils'||o.quantity_unit!==null||o.printed_value!==null&&!/^(0|[1-9]\d{0,10})(?:\.\d{1,2})?$/u.test(o.printed_value)))throw Error('VACATION_MONEY_OPERAND');}

/** Source-bound candidates for statutory calendar-day quota, completed annual
 * proration and actual leave pay. These are independent of balance arithmetic. */
export function resolveVacationEntitlement(candidate:unknown){
 const input=vacationEntitlementInputSchema.parse(candidate),ids=vacationCheckIds(input.check_prefix),checks:DocumentReviewInput['checks']=[],gaps:VacationGap[]=[];
 assertVacationDerivedFacts(input);
 const last=new Date(Date.UTC(Number(input.period.from.slice(0,4)),Number(input.period.from.slice(5,7)),0)).toISOString().slice(0,10);
 if(input.period.from<VACATION_SOURCE_REVIEW.supported_period.from||input.period.to>VACATION_SOURCE_REVIEW.supported_period.to||input.period.from.slice(8)!=='01'||input.period.to!==last)throw Error('VACATION_SUPPORTED_MONTH_REQUIRED');
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!(d.decision_id in VACATION_APPLICABILITY)))throw Error('VACATION_DECISION_SET');
 for(const a of input.conditional_assumptions??[])if(!(a.decision_id in VACATION_APPLICABILITY))throw Error('VACATION_ASSUMPTION_SET');
 const add=(key:string,state:string,path:string,question:string,dependent:readonly string[],kind:VacationGap['kind']='missing_fact',answer:VacationGap['answer_kind']='text')=>{
  if(!gaps.some(g=>g.dependency_id===key&&canonicalSha256(g.dependent_check_ids)===canonicalSha256(dependent)))gaps.push({dependency_id:key,state,input_path:path,question,dependent_check_ids:dependent,kind,answer_kind:answer,source_required:true});
 };
 for(const d of input.applicability)for(const s of d.sources){if(s.reading==='source_research'){if(!isPinnedVacationLegalSource(s))throw Error('VACATION_LEGAL_SOURCE_PIN');}else sourceBound(s,input);}
 const a=input.annual_basis,p=input.leave_pay;
 const facts=[...Object.values(input.facts),...(a?[a.employment_start,a.employment_end,a.complete_year_evidence,a.covered_through]:[])];
 for(const f of facts)if(f.source){if(f.state==='derived'){if(!isPinnedVacationLegalSource(f.source))throw Error('VACATION_DERIVED_SOURCE');}else sourceBound(f.source,input);if((f.basis==='customer_declaration')!==['customer_declaration','questionnaire_declaration'].includes(f.source.reading))throw Error('VACATION_FACT_BASIS');}
 const operands=[input.seniority_year,a?.actual_workdays,p?.wage,p?.recorded,...(p?.mode==='hourly_quarter'?[p.leave_calendar_days]:[])];
 for(const o of operands)if(o)sourceBound(o.source,input);
 quantity(input.seniority_year,'count',60);if(input.seniority_year?.printed_value==='0')throw Error('VACATION_SENIORITY_POSITIVE');
 quantity(a?.actual_workdays??null,'days',365);money(p?.wage??null);money(p?.recorded??null);
 if(p?.mode==='hourly_quarter')quantity(p.leave_calendar_days,'calendar_days',31);
 const select=(keys:Key[],dependent:readonly string[])=>keys.map(decision_id=>{
  const d:VacationDecision=input.applicability.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation:VACATION_APPLICABILITY[decision_id],sources:[vacationLegalSource('law',decision_id.startsWith('vacation.pay')?3:1,decision_id)],valid_until:null};
  if(d.state!=='accepted'||d.basis==='customer_declaration'||!d.sources.length||d.valid_until!==null&&d.valid_until<=input.evaluated_at)add(decision_id,d.state==='accepted'?'unknown':d.state,`applicability.${decision_id}`,d.explanation,dependent,'missing_applicability');
  const extra=vacationProductDecisionSources(input,decision_id);
  return extra.length?{...d,sources:[...new Map([...d.sources,...extra].map(s=>[canonicalSha256(s),s])).values()]}:d;
 });
 const trace=(id:string,values:unknown,sources:DocumentReviewSource[]):VacationDecision=>({decision_id:id,state:'accepted',basis:'ai_source_assessment',
  explanation:JSON.stringify({schema_version:'vacation-factual-scope-v1',values,values_sha256:canonicalSha256(values),legal_applicability_approved:false}),
  sources:[...new Map(sources.map(s=>[canonicalSha256(s),s])).values()],valid_until:null});
 const finish=()=>deepFreeze({schema_version:'vacation-entitlement-resolution-v1' as const,input_sha256:canonicalSha256(input),catalog:VACATION_CATALOG,checks,gaps,
  rule_metadata:{source_review_sha256:VACATION_SOURCE_REVIEW_SHA256,review_period:input.period,annual_reference_period:{from:'2026-01-01',to:'2026-12-31'},
   annual_unit:'calendar_days',net_workday_conversion:false,payroll_balance_is_entitlement:false,redemption_assessed:false,
   annual_result_is_monthly_accrual:false,expected_is_cash_debt:false,human_attestation:null,real_activation_allowed:false}});
 let population=true;
 for(const [key,f]of Object.entries(input.facts))if(!['known','derived'].includes(f.state)||f.value!==true){population=false;add(`vacation.${key}`,f.state==='known'?'conflict':f.state,`facts.${key}`,'הענף הנוכחי מוגבל לעובדים בגיל 21–59; נדרש נתון גיל מתאים לתקופה.',Object.values(ids),'missing_applicability');}
 if(!population)return finish();
 const populationTrace=trace('vacation.population_scope',Object.fromEntries(Object.entries(input.facts).map(([key,f])=>[key,{value:f.value,source_sha256:canonicalSha256(f.source)}])),Object.values(input.facts).map(f=>f.source!));
 if(!available(input.seniority_year)&&!input.derived_seniority)add('vacation.seniority_year',input.seniority_year?.state??'missing','seniority_year','נדרשת שנת הוותק המזוהה לצורך מכסת החופשה השנתית.',[ids.quota,ids.prorated],'missing_source','number');
 else{
  const decisions=[...select(['vacation.general_section3','vacation.no_better_arrangement','vacation.seniority_basis'],[ids.quota,ids.prorated]),populationTrace];
  checks.push({check_id:ids.quota,topic:'vacation',title:'מכסה שנתית בסיסית לפני חישוב יחסי — ימי לוח',
   explanation:'מכסת המסגרת הכללית לשנת 2026 לפני יחס ימי העבודה. אינה יתרה זמינה, צבירה חודשית, ימי עבודה נטו או סכום כסף.',calculation:vacationAnnualCalculation(input,decisions)});
  let annualReady=true;
  if(!a){annualReady=false;add('vacation.annual_basis','missing','annual_basis','נדרשים נתוני שנת העבודה או מלוא תקופת ההעסקה שהסתיימה בה: תאריכים, ימי עבודה וסיווג ההיעדרויות. תלוש חודשי אינו בסיס שנתי מלא.',[ids.prorated],'missing_source');}
  else{
   for(const [key,f]of Object.entries({employment_start:a.employment_start,employment_end:a.employment_end,covered_through:a.covered_through,complete_year_evidence:a.complete_year_evidence}))if(f.state!=='known'||key==='complete_year_evidence'&&f.value!==true){annualReady=false;add(`vacation.annual.${key}`,f.state==='known'?'unknown':f.state,`annual_basis.${key}`,'נדרש בסיס שלם ומזוהה לכל תקופת החישוב השנתית; נתון חסר אינו אפס ימי עבודה.',[ids.prorated],'missing_source',key==='complete_year_evidence'?'text':'date');}
   if(!available(a.actual_workdays)){annualReady=false;add('vacation.actual_workdays',a.actual_workdays?.state??'missing','annual_basis.actual_workdays','כמה ימי עבודה מזוהים נכללים במניין בתקופת החישוב השנתית המלאה?', [ids.prorated],'missing_source','number');}
   if(annualReady){
    const start=a.employment_start.value!,end=a.employment_end.value!,covered=a.covered_through.value!;
    if(end!=='ongoing'&&end<start||start>'2026-12-31'||end!=='ongoing'&&end<'2026-01-01')throw Error('VACATION_ANNUAL_EMPLOYMENT_SCOPE');
    const final=end==='ongoing'||end>'2026-12-31'?'2026-12-31':end;
    if(covered<final||covered>input.evaluated_at.slice(0,10)){annualReady=false;add('vacation.annual_complete_interval','unknown','annual_basis.covered_through','תקופת החישוב השנתית טרם כוסתה במלואה. לא נהפוך נתונים חלקיים לתוצאת צבירה שנתית סופית.',[ids.prorated],'missing_source');}
    else{
     const first=start<'2026-01-01'?'2026-01-01':start;if(Number(a.actual_workdays!.printed_value)>days(first,final))throw Error('VACATION_WORKDAYS_EXCEED_EMPLOYMENT');
     const whole=start<='2026-01-01'&&final==='2026-12-31';
     const annualTrace=trace('vacation.complete_annual_scope',{calendar_year:2026,employment_start:start,employment_end:end,covered_through:covered,whole_calendar_year:whole,
      evidence_sha256:canonicalSha256({employment_start:a.employment_start,employment_end:a.employment_end,complete_year_evidence:a.complete_year_evidence,covered_through:a.covered_through})},[a.employment_start.source!,a.employment_end.source!,a.complete_year_evidence.source!,a.covered_through.source!]);
     // The source facts choose the statutory threshold through a pinned trace.
     // No derived boolean is presented as a printed or customer-provided value.
     const d=[...decisions,...select(['vacation.annual_workdays'],[ids.prorated]),annualTrace];
     checks.push({check_id:ids.prorated,topic:'vacation',title:'מכסה שנתית יחסית על בסיס תקופה מלאה — ימי לוח',
      explanation:'חישוב לשנת 2026 לפי יחס ימי העבודה וסף 200 או 240, עם השמטת חלק יום בסוף השנה. אינו צבירה בחודש הדוח או המרה לימי עבודה.',calculation:vacationAnnualCalculation(input,d,{wholeYear:whole,workdays:a.actual_workdays!})});
    }
   }
  }
 }
 if(!p){add('vacation.leave_pay_source','missing','leave_pay','לבדיקת דמי חופשה נדרשים חופשה שנלקחה בפועל, תקופתה ובסיס השכר המתאים. היעדר מקור אינו חוב או הוכחה שלא שולמה חופשה.',[ids.pay,ids.comparison],'missing_source');return finish();}
 if(p.leave_period.from<input.period.from||p.leave_period.to>input.period.to)throw Error('VACATION_LEAVE_REVIEW_PERIOD');
 let payReady=true;
 if(!available(p.wage)){payReady=false;add('vacation.leave_wage',p.wage?.state??'missing','leave_pay.wage','נדרש בסיס השכר הרגיל המזוהה לצורך תשלום החופשה.',[ids.pay,ids.comparison],'missing_source','number');}
 const payKeys:Key[]=['vacation.no_better_arrangement','vacation.pay_applicability','vacation.pay_wage_basis'];
 if(p.mode==='hourly_quarter'){
  const q=p.quarter_period,year=Number(q.from.slice(0,4)),month=Number(q.from.slice(5,7)),end=new Date(Date.UTC(year,month+2,0)).toISOString().slice(0,10);
  const lower=new Date(Date.UTC(Number(p.leave_period.from.slice(0,4)),Number(p.leave_period.from.slice(5,7))-13,Number(p.leave_period.from.slice(8)))).toISOString().slice(0,10);
  if(q.from.slice(8)!=='01'||q.to!==end||q.to>=p.leave_period.from||q.from<lower)throw Error('VACATION_QUARTER_PERIOD');
  if(!available(p.leave_calendar_days)){payReady=false;add('vacation.leave_calendar_days',p.leave_calendar_days?.state??'missing','leave_pay.leave_calendar_days','נדרש מספר ימי החופשה ביחידת ימי לוח. אין להעתיק שעות או ימי עבודה נטו לאותה יחידה.',[ids.pay,ids.comparison],'missing_source','number');}
  else if(Number(p.leave_calendar_days!.printed_value)<1||Number(p.leave_calendar_days!.printed_value)>days(p.leave_period.from,p.leave_period.to))throw Error('VACATION_LEAVE_DAYS_PERIOD');
  payKeys.push('vacation.pay_quarter_selection','vacation.pay_calendar_days','vacation.pay_rounding');
 }else payKeys.push('vacation.pay_monthly_period');
 if(!payReady)return finish();
 const payTrace=trace('vacation.leave_period_scope',{mode:p.mode,leave_period:p.leave_period,...(p.mode==='hourly_quarter'?{quarter_period:p.quarter_period}:{}),
  wage_source_sha256:canonicalSha256(p.wage!.source),...(p.mode==='hourly_quarter'?{leave_days_source_sha256:canonicalSha256(p.leave_calendar_days!.source)}:{})},[p.wage!.source,...(p.mode==='hourly_quarter'?[p.leave_calendar_days!.source]:[])]);
 const payDecisions=[...select(payKeys,[ids.pay,ids.comparison]),populationTrace,payTrace];
 checks.push({check_id:ids.pay,topic:'vacation',title:'דמי חופשה צפויים לתקופה מזוהה',explanation:'תשלום בעד חופשה שנלקחה, בכפוף לתחולה ולבסיס השכר. אינו פדיון יתרה ואינו תלוי בהוכחת הצבירה השנתית כאשר הזכאות לימי החופשה הוכחה בנפרד.',calculation:vacationPayCalculation(input,payDecisions)});
 if(!available(p.recorded))add('vacation.leave_recorded',p.recorded?.state??'missing','leave_pay.recorded','נדרש סכום דמי החופשה שנרשם לאותם ימים ולתקופה זו, לצורך השוואה בלבד.',[ids.comparison],'missing_source','number');
 else checks.push({check_id:ids.comparison,topic:'vacation',title:'דמי החופשה הצפויים לעומת הרשום לתקופה',explanation:'פער חתום בין צפוי לרשום לאחר שיוך לאותם ימים. אינו הוכחת העברה בפועל או חוב מזומן.',calculation:vacationPayCalculation(input,[...payDecisions,...select(['vacation.pay_recorded_allocation'],[ids.comparison])],true)});
 return finish();
}
