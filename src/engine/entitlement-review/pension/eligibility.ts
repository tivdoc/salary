import type {PensionEntitlementInput,PensionEligibility,PensionGap} from './contracts.ts';

const question={employment_start:'מהו תאריך תחילת העבודה אצל המעסיק הנוכחי?',employment_end:'האם העבודה נמשכת? אם הסתיימה, מהו תאריך הסיום?',
 prior_coverage_at_start:'האם היה ביטוח פנסיוני בתוקף בעת תחילת העבודה? יש לצרף ראיה המתייחסת לאותו מועד.',
 continuous_employment:'האם נשמרה רציפות העבודה אצל המעסיק בתקופה שנבדקת?',
 aged_21_or_more:'האם מלאו לעובד או לעובדת 21 לפני תחילת החודש הנבדק? לעובדת בגיל 20 נדרשת בחינת תחולה נפרדת.',
 under_60:'האם גיל העובד או העובדת נמוך מ־60 בתקופה הנבדקת? אחרת נדרשת בחינת גיל פרישה והסדרים מתאימים.'};
function addMonths(date:string,months:number){
 const [y,m,d]=date.split('-').map(Number),first=new Date(Date.UTC(y,m-1+months,1));
 const last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
 return new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth(),Math.min(d,last))).toISOString().slice(0,10);
}
export function pensionCheckIds(prefix:string){return ['employee','employer','severance'].flatMap(s=>[`${prefix}.${s}.expected`,`${prefix}.${s}.comparison`]);}
export function pensionOrdinaryWaitingElapsed(input:PensionEntitlementInput){
 return input.facts.employment_start.state==='known'&&input.facts.employment_start.value!==null&&addMonths(input.facts.employment_start.value,6)<=input.period.from;
}
export function resolvePensionEligibility(input:PensionEntitlementInput):{eligibility:PensionEligibility;gaps:PensionGap[]}{
 const gaps:PensionGap[]=[],ids=pensionCheckIds(input.check_prefix);
 const priorNotNeeded=pensionOrdinaryWaitingElapsed(input);
 for(const [key,f]of Object.entries(input.facts))if(f.state!=='known'&&!(key==='prior_coverage_at_start'&&priorNotNeeded))gaps.push({dependency_id:`pension.${key}`,state:f.state,kind:'missing_fact',
  question:question[key as keyof typeof question],answer_kind:key==='employment_start'?'date':key==='employment_end'?'text':'choice',
  ...(key==='employment_start'||key==='employment_end'?{value_validation:{schema_version:'document-review-value-validation-v1' as const,format:key==='employment_start'?'iso_date' as const:'iso_date_or_ongoing' as const}}:{}),
  ...(['prior_coverage_at_start','continuous_employment','aged_21_or_more','under_60'].includes(key)?{options:['כן','לא','לא ידוע']}:{}),
  input_path:`facts.${key}`,dependent_check_ids:ids,source_required:key==='prior_coverage_at_start'});
 const unknown:PensionEligibility={state:'unknown',accrual_from:null,eligible_interval:null,first_execution_due:null,retroactive_to_start:false,
  partial_waiting_month:false,date_policy:'calendar_month_anniversary_clamped_v1',termination_before_initial_execution:false};
 if(gaps.length)return {eligibility:unknown,gaps};
 if(input.facts.continuous_employment.value!==true||input.facts.aged_21_or_more.value!==true||input.facts.under_60.value!==true){
  const key=input.facts.continuous_employment.value!==true?'continuous_employment':input.facts.aged_21_or_more.value!==true?'aged_21_or_more':'under_60';
  gaps.push({dependency_id:`pension.${key}`,state:'unknown',kind:'missing_applicability',question:key==='aged_21_or_more'?'הענף המצומצם אינו מכריע זכאות מתחת לגיל 21. יש לבחון גיל, מין לצורך סף הצו וספירת ותק קודמת.':key==='under_60'?question.under_60:'נדרשת בחינה של הפסקות ורציפות אצל אותו מעסיק לפני קביעת מועד הזכאות.',answer_kind:'text',input_path:`facts.${key}`,dependent_check_ids:ids,source_required:true});
  return {eligibility:unknown,gaps};
 }
 const start=input.facts.employment_start.value!,end=input.facts.employment_end.value!,priorKnown=input.facts.prior_coverage_at_start.state==='known',prior=priorKnown&&input.facts.prior_coverage_at_start.value===true;
 if(end!=='ongoing'&&end<start){gaps.push({dependency_id:'pension.employment_dates',state:'conflict',kind:'missing_fact',question:'תאריך סיום העבודה מוקדם מתאריך ההתחלה שנשמר. יש לברר ולתקן את התאריך המתאים תוך שמירת שני המקורות.',answer_kind:'text',value_validation:{schema_version:'document-review-value-validation-v1',format:'iso_date_or_ongoing'},input_path:'facts.employment_end',dependent_check_ids:ids,source_required:true});return {eligibility:unknown,gaps};}
 const accrual=prior?start:addMonths(start,6),three=addMonths(start,3),yearEnd=start.slice(0,4)+'-12-31';
 const due=prior?(three<yearEnd?three:yearEnd):accrual;
 const early=prior&&end!=='ongoing'&&end<due;
 if(early){gaps.push({dependency_id:'pension.early_insured_termination',state:'unknown',kind:'missing_applicability',question:'העבודה הסתיימה לפני מועד ביצוע ההפרשות הראשונות למבוטח קודם. נדרשת הכרעה נפרדת לפני הצגת חבות רטרואקטיבית.',answer_kind:'text',input_path:'facts.employment_end',dependent_check_ids:ids,source_required:true});return {eligibility:{...unknown,accrual_from:accrual,first_execution_due:due,retroactive_to_start:true,termination_before_initial_execution:true},gaps};}
 const from=accrual>input.period.from?accrual:input.period.from,to=end!=='ongoing'&&end<input.period.to?end:input.period.to;
 return {eligibility:{state:from>to?(start>input.period.to||end!=='ongoing'&&end<input.period.from?'outside_employment':'waiting_period'):'eligible',accrual_from:priorKnown?accrual:null,
  eligible_interval:from>to?null:{from,to},first_execution_due:priorKnown?due:null,retroactive_to_start:priorKnown?prior:null,
  partial_waiting_month:!prior&&accrual>input.period.from&&accrual<=input.period.to,date_policy:'calendar_month_anniversary_clamped_v1',termination_before_initial_execution:false},gaps};
}
