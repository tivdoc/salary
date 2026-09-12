import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeMissing,type WorkingTimeDecision,type WorkingTimeSourceFact} from './contracts.ts';
import {WORKING_TIME_CATALOG,workingTimeLegalSource} from './source-policy.ts';
import {atTime,sourceInterval,sourceNumber,sourcePin,usable,validateAllSources,type TimeReading} from './time-source.ts';
import {buildWorkingTimeRule,type WorkingDayReading} from './rules.ts';

export const WORKING_TIME_APPLICABILITY=deepFreeze({
 'wt.coverage':'יש לזהות את התפקיד וההסדר החל, לרבות חריגים לחוק והסדר ענפי או מיטיב. הצהרת הלקוח אינה הכרעת תחולה.',
 'wt.arrangement':'יש לזהות את מתכונת שבוע העבודה במקום העבודה, היום המקוצר והסדר שעות המשמרת; אין להסיק סף יומי מחלוקת 42 במספר הימים.',
 'wt.workday_assignment':'יש לוודא אילו מקטעים שייכים לאותו יום עבודה. הפסקה קצרה בין משמרות אינה מאחדת אותן אוטומטית.',
 'wt.regular_wage':'יש לזהות את השכר הרגיל והתוספות הנכללות בו לצורך הגמול, לרבות תוספת לילה חוזית אם קיימת.',
 'wt.payroll_allocation':'יש לוודא שהתשלום המשויך מכסה בדיוק את שעות היום הזה, ללא שיתוף אותו רכיב עם יום אחר וללא כפל בסיס ותוספת.',
 'wt.rounding':'נדרשת בחירת שיטת עיגול מפורשת; המועמד משתמש בחצי כלפי מעלה לסכום היום ולכל קבוצת תעריף משויכת.',
 'wt.weekly_aggregation':'יש לאמת את סדר הקצאת השעות הרגילות והנוספות ואת הטיפול בהיעדרויות בתשלום. שעות נוספות יומיות אינן נספרות שוב כשעות רגילות שבועיות.',
 'wt.rest_additive':'יש לאמת שמדובר במנוחה שבועית סטטוטורית ובהוספת 50% לשכר הרגיל, ולא בתוספת חוזית הנכללת בשכר הרגיל או בחג.',
 'wt.non_rest_scope':'חלון המנוחה השבועית לא זוהה. החישוב היומי המוצג מותנה בכך שהמקטע הוא יום רגיל; לא חושבה תוספת מנוחה שבועית.',
});
const baseDecisions=['wt.coverage','wt.arrangement','wt.workday_assignment','wt.regular_wage','wt.payroll_allocation','wt.rounding'] as const;
const absentState=(f:{state:string}):WorkingTimeMissing['state']=>['missing','unknown','conflict','stale','expired','unreadable'].includes(f.state)?f.state as WorkingTimeMissing['state']:'unknown';
const dateAt=(date:string,offset:number)=>new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);

/** Facts and source-time representations enter ordinary candidate_rule checks.
 * This function neither grants legal authority nor creates Findings/reports. */
export function resolveWorkingTimeEntitlement(raw:unknown){
 const input=workingTimeEntitlementInputSchema.parse(raw),missing:WorkingTimeMissing[]=[],checks:DocumentReviewInput['checks']=[];
 if(input.period.from<WORKING_TIME_CATALOG.supported_work_period.from||input.period.to>WORKING_TIME_CATALOG.supported_work_period.to||input.period.from>input.period.to)throw Error('WORKING_TIME_RESEARCH_PERIOD');
 validateAllSources(input);
 if(new Date(input.week_start+'T00:00:00Z').getUTCDay()!==0)throw Error('WORKING_TIME_WEEK_START');
 if(new Set(input.workdays.map(d=>d.id)).size!==input.workdays.length||new Set(input.workdays.map(d=>d.date)).size!==input.workdays.length)throw Error('WORKING_TIME_DUPLICATE_DAY');
 if(input.workdays.some(d=>d.date<input.week_start||d.date>dateAt(input.week_start,6)||d.date<input.period.from||d.date>input.period.to))throw Error('WORKING_TIME_DAY_PERIOD');
 if(input.workdays.reduce((n,d)=>n+d.intervals.length,0)>14)throw Error('WORKING_TIME_INTERVAL_BOUND');
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length)throw Error('WORKING_TIME_DUPLICATE_DECISION');
 const permitted=new Set([...Object.keys(WORKING_TIME_APPLICABILITY),...input.workdays.map(d=>'wt.worked_time.'+d.id)]);
 if(input.applicability.some(d=>!permitted.has(d.decision_id))||input.conditional_assumptions?.some(a=>!permitted.has(a.decision_id)))throw Error('WORKING_TIME_DECISION_ID');
 if(input.applicability.some(d=>d.state==='accepted'&&(d.basis==='customer_declaration'||!d.sources.length)))throw Error('WORKING_TIME_DECLARATION_NOT_APPLICABILITY');
 const targetIds=input.workdays.filter(d=>d.inventory.value!=='no_work').map(d=>`${input.check_id_prefix}.${d.id}`);
 const add=(fact_key:string,input_path:string,state:WorkingTimeMissing['state'],question:string,kind:WorkingTimeMissing['kind']='fact',sources:DocumentReviewSource[]=[],ids=targetIds,answer_kind:WorkingTimeMissing['answer_kind']='text',options?:string[])=>{
  const pins=[...new Map(sources.filter(s=>s.reading!=='source_research').map(s=>{const p=sourcePin(input,s);return [canonicalSha256(p),p];})).values()];
  const m:WorkingTimeMissing={fact_key,input_path,state,question,kind,answer_kind,customer_declaration_allowed:kind==='fact'&&/\.(?:classification|kind|no_work_credit)$/u.test(input_path),source_pins:pins,dependent_check_ids:ids,...(options?{options}:{})};
  if(!missing.some(x=>x.fact_key===fact_key&&canonicalSha256(x.dependent_check_ids)===canonicalSha256(ids)))missing.push(m);
 };
 const factGap=<T>(key:string,path:string,f:WorkingTimeSourceFact<T>,question:string,ids=targetIds,options?:string[])=>add(key,path,absentState(f),question,'fact',f.source?[f.source]:[],ids,options?'choice':'text',options);
 const sorted=[...input.workdays].sort((a,b)=>a.date.localeCompare(b.date));
 const allIntervals=sorted.flatMap(d=>d.intervals),intervalIds=allIntervals.map(i=>i.id);
 if(new Set(intervalIds).size!==intervalIds.length||new Set(allIntervals.map(i=>canonicalSha256({observation_id:i.printed_duration.observation_id,source:i.printed_duration.source}))).size!==allIntervals.length)throw Error('WORKING_TIME_DUPLICATE_INTERVAL_SOURCE');
 const allocations=sorted.flatMap(d=>d.recorded_pay?[d.recorded_pay]:(d.payroll_allocations??[]).map(a=>a.hours));
 if(new Set(allocations.map(a=>canonicalSha256({observation_id:a.observation_id,source:a.source}))).size!==allocations.length)throw Error('WORKING_TIME_DUPLICATE_PAYMENT_SOURCE');
 let rest:{start:number;end:number}|null=null;
 if(usable(input.rest_window)){
  const window=input.rest_window.value!;rest={start:atTime(window.start_at),end:atTime(window.end_at)};
  if(rest.end-rest.start<36*3600000||rest.end-rest.start>168*3600000)throw Error('WORKING_TIME_REST_WINDOW_BOUND');
  const weekStart=Date.parse(input.week_start+'T00:00:00+03:00');
  if(rest.start<weekStart-36*3600000||rest.end>weekStart+204*3600000)throw Error('WORKING_TIME_REST_WINDOW_PERIOD');
 }else factGap('wt.rest_window','rest_window',input.rest_window,'מהו חלון המנוחה השבועית שנקבע בפועל: תאריך ושעת התחלה וסיום? יש לציין את ההסדר אם נקבעה מנוחה קצרה יותר.');
 const arrangementsValid=usable(input.arrangement)&&input.arrangement.value!=='unsupported';
 if(!arrangementsValid)factGap('wt.arrangement_fact','arrangement',input.arrangement,'מהי מתכונת שבוע העבודה במקום העבודה, ומהו היום המקוצר? יש לצרף חוזה או הסדר משמרות קיים; אין צורך לבחור נוסחה משפטית.',targetIds,['adult_hourly_five_day_42','adult_hourly_six_day_42','unsupported']);
 const schedule=usable(input.scheduled_weekdays)?input.scheduled_weekdays.value:null;
 if(schedule&&(new Set(schedule).size!==schedule.length||schedule.length!==(input.arrangement.value==='adult_hourly_five_day_42'?5:6)))throw Error('WORKING_TIME_SCHEDULE_ARRANGEMENT');
 const views:WorkingDayReading[]=[],traces:TimeReading[]=[],paymentReadyDays=new Set<string>();
 for(const day of sorted){
  const inputIndex=input.workdays.findIndex(d=>d.id===day.id),path=`workdays.${inputIndex}`,ids=[`${input.check_id_prefix}.${day.id}`];
  if(!usable(day.inventory)||day.inventory.value==='incomplete'){factGap(`wt.inventory.${day.id}`,path+'.inventory',day.inventory,'יש להשלים את כל מקטעי היום הזה, לרבות הפסקות ועבודה נוספת, או לזהות במקור שלא הייתה עבודה.',ids);continue;}
  if(day.inventory.value==='no_work'){
   if(day.intervals.length)throw Error('WORKING_TIME_NO_WORK_HAS_INTERVALS');
   if(schedule?.includes(new Date(day.date+'T00:00:00Z').getUTCDay())){
    const credit=day.no_work_credit;
    if(!credit||!usable(credit))factGap(`wt.no_work_credit.${day.id}`,path+'.no_work_credit',credit??{state:'missing',value:null,source:day.inventory.source},'ביום המזוהה ללא עבודה, האם שולם שכר עבור חופשה, מחלה או חג? יש לזהות את סוג ההיעדרות; הוא עשוי להשפיע על המניין השבועי.',targetIds,['no_credit','paid_absence','unknown']);
    else if(credit.value!=='no_credit')add(`wt.absence_policy.${day.id}`,path+'.no_work_credit','unknown','נדרשת הכרעה בהסדר שלפיו היעדרות זו נכללת במניין השבועי. השעות אינן מושלמות באפס.','applicability',credit.source?[credit.source]:[],targetIds);
   }
   views.push({day,readings:[],sevenHourDay:false,noWork:true});continue;
  }
  if(!day.intervals.length){add(`wt.attendance.${day.id}`,path+'.intervals','missing','יש לצרף רישום מתוארך עם כניסה, יציאה ומשך לכל מקטע; סך חודשי אינו מזהה יום עבודה.','source',[],ids,'document');continue;}
  if(!usable(day.kind)||day.kind.value==='holiday'||day.kind.value==='unsupported'){
   add(`wt.day_kind.${day.id}`,path+'.kind',day.kind.value==='holiday'||day.kind.value==='unsupported'?'unsupported':absentState(day.kind),'יש לזהות אם מדובר ביום רגיל, ערב מנוחה או חג. זכאות חג והסדרים מיוחדים אינם נכללים בענף הזה.','fact',day.kind.source?[day.kind.source]:[],ids,'choice',['ordinary','pre_rest','holiday','unsupported']);continue;}
  let hard=false;const eligible:TimeReading[]=[];
  for(const [i,interval]of day.intervals.entries()){
   const r=sourceInterval(input,day,interval,rest);if(!r){add(`wt.duration.${interval.id}`,`${path}.intervals.${i}.printed_duration`,absentState(interval.printed_duration),'יש לאמת את התאריכים, הכניסה, היציאה והמשך המקורי של המקטע.','source',[interval.clock_source],ids,'document');hard=true;continue;}
   traces.push(r);const c=interval.classification;
   const classified=usable(c)&&c.value!=='unknown';
   if(!classified){
    factGap(`wt.classification.${interval.id}`,`${path}.intervals.${i}.classification`,c,'במקטע ההפסקה המזוהה, האם הייתם פנויים לצאת וללא חובת זמינות, או שנדרשתם להישאר לרשות העבודה? יש לציין את השעות המדויקות.',ids,['worked','free_break','required_presence','unknown']);
    const decisionId='wt.worked_time.'+day.id;
    if(input.applicability.some(d=>d.decision_id===decisionId&&d.state==='accepted'))throw Error('WORKING_TIME_UNRESOLVED_CLASSIFICATION_ACCEPTED');
    const assumable=['missing','unknown','observed','declared'].includes(c.state);
    if(input.mode!=='explicit_presence_scenario'||!assumable||!input.conditional_assumptions?.some(a=>a.decision_id===decisionId)){hard=true;continue;}
   }
   if(!classified||c.value!=='free_break')eligible.push(r);
  }
  if(hard)continue;
  if(!eligible.length){add(`wt.actual_work.${day.id}`,path+'.intervals','missing','המקטעים המזוהים אינם שעות עבודה. אין להשוות שכר יומי בלי הקצאה מדויקת לזמן עבודה.','fact',day.intervals.map(i=>i.clock_source),ids);continue;}
  const seven=day.kind.value==='pre_rest'||eligible.reduce((n,r)=>n+r.night_minutes,0)>=120;
  if(['conflict','stale','expired'].includes(day.ordinary_limit.state)){
   add(`wt.daily_limit.${day.id}`,path+'.ordinary_limit',absentState(day.ordinary_limit),'יש ליישב את המקור לסף היומי ואת ההסדר התקף לפני חישוב; סף הלילה אינו מוחק מקור סותר או שפג תוקפו.','source',[day.ordinary_limit.source],ids,'document');continue;
  }
  if(!seven){const limit=sourceNumber(day.ordinary_limit,'hours');
   if(limit===null){add(`wt.daily_limit.${day.id}`,path+'.ordinary_limit',absentState(day.ordinary_limit),'יש לזהות את שעות התקן של היום הזה ואת היום המקוצר מתוך ההסדר או לוח המשמרות; אין להסיק סף יומי מסך שבועי.','source',[day.ordinary_limit.source],ids,'document');continue;}
   if(limit<=0||limit>(input.arrangement.value==='adult_hourly_six_day_42'?480:540)){
    add(`wt.daily_limit.${day.id}`,path+'.ordinary_limit','unsupported','סף היום שנמסר דורש הסדר אחר או פירוש נוסף; הוא אינו מאומץ כסף לשעות נוספות.','applicability',[day.ordinary_limit.source],ids);continue;}
  }
  if(!arrangementsValid&&['conflict','stale','expired'].includes(input.arrangement.state)||input.arrangement.value==='unsupported')continue;
  views.push({day,readings:eligible,sevenHourDay:seven,noWork:false});
  if(day.recorded_pay&&(day.payroll_allocations?.length??0)>0)throw Error('WORKING_TIME_PAYMENT_ALTERNATIVES');
  const direct=day.recorded_pay?sourceNumber(day.recorded_pay,'money'):null,bands=day.payroll_allocations??[];
  let paymentReady=direct!==null||bands.length>0;
  let allocatedMinutes=0;
  for(const a of bands){const h=sourceNumber(a.hours,'hours'),rate=sourceNumber(a.hourly_rate,'money'),percentage=a.percentage?sourceNumber(a.percentage,'percent'):100;
   if(h===null||rate===null||percentage===null)paymentReady=false;
   if(percentage!==null&&percentage<100)throw Error('WORKING_TIME_PREMIUM_ONLY_ALLOCATION');
   if(h!==null)allocatedMinutes+=h;
  }
  if(allocatedMinutes>eligible.reduce((n,r)=>n+r.minutes,0))throw Error('WORKING_TIME_ALLOCATED_HOURS_OVERLAP');
  if(!paymentReady||!usable(day.payment_allocation)||day.payment_allocation.value!=='full_pay_for_workday'){
   add(`wt.payment.${day.id}`,path+'.payment_allocation',absentState(day.payment_allocation),'יש לזהות תשלום מלא המשויך בדיוק לשעות היום הזה, באמצעות סכום או כמויות ותעריפים נפרדים. ברוטו חודשי אינו תחליף ולא נרשם תשלום אפס.','source',day.payment_allocation.source?[day.payment_allocation.source]:[],ids,'document');continue;}
  if(sourceNumber(input.regular_hourly_wage,'money')===null){add('wt.regular_hourly_wage','regular_hourly_wage',absentState(input.regular_hourly_wage),'יש לזהות תעריף שעתי ורכיבי שכר רגיל באותו מקור ותקופה.','source',[input.regular_hourly_wage.source],ids,'document');continue;}
  paymentReadyDays.add(day.id);
 }
 const sortedTraces=[...traces].sort((a,b)=>a.start-b.start);
 if(sortedTraces.some((r,i)=>i>0&&r.start<sortedTraces[i-1].end))throw Error('WORKING_TIME_INTERVAL_OVERLAP');
 const complete=usable(input.week_inventory)&&input.week_inventory.value==='complete'&&views.length===7&&sorted.length===7
  &&sorted.every((d,i)=>d.date===dateAt(input.week_start,i))&&schedule!==null&&arrangementsValid
  &&views.every(v=>!v.noWork||!schedule.includes(new Date(v.day.date+'T00:00:00Z').getUTCDay())||v.day.no_work_credit&&usable(v.day.no_work_credit)&&v.day.no_work_credit.value==='no_credit');
 if(!complete)add('wt.week_inventory','week_inventory',absentState(input.week_inventory),'לבדיקה השבועית נדרש שבוע מלא, לרבות יתר ימי העבודה והיעדרויות בתשלום שעשויות להיספר. הבדיקות היומיות נשמרות; אין השלמת ימים חסרים באפס.','source',input.week_inventory.source?[input.week_inventory.source]:[],targetIds,'document');
 if(!schedule)factGap('wt.scheduled_weekdays','scheduled_weekdays',input.scheduled_weekdays,'מהם ימי העבודה שנקבעו במקום העבודה והיום המקוצר? ההיקף האישי עשוי להיות חלקי ואינו משנה לבדו את ההסדר המפעלי.');
 const evidenceSha=canonicalSha256(input);
 for(const [i,view]of views.entries()){
  if(view.noWork||!paymentReadyDays.has(view.day.id))continue;
  const ids=[`${input.check_id_prefix}.${view.day.id}`],required:string[]=[...baseDecisions,'wt.worked_time.'+view.day.id];
  if(complete)required.push('wt.weekly_aggregation');
  if(!rest)required.push('wt.non_rest_scope');else if(view.readings.some(r=>(r.rest_minutes??0)>0))required.push('wt.rest_additive');
  const decisions:WorkingTimeDecision[]=required.map(decision_id=>{
   const question=decision_id.startsWith('wt.worked_time.')?'יש להעריך את סיווג זמן העבודה וההפסקות ביום המזוהה.':WORKING_TIME_APPLICABILITY[decision_id as keyof typeof WORKING_TIME_APPLICABILITY];
   let d:WorkingTimeDecision=input.applicability.find(d=>d.decision_id===decision_id)??{decision_id,state:'missing',basis:'ai_source_assessment',explanation:question,sources:[workingTimeLegalSource('law',1,decision_id)],valid_until:null};
   if(d.valid_until)d={...d,valid_until:new Date(d.valid_until).toISOString()};
   if(decision_id==='wt.non_rest_scope'&&['conflict','stale','expired'].includes(input.rest_window.state))d={...d,state:input.rest_window.state as 'conflict'|'stale'|'expired',sources:input.rest_window.source?[input.rest_window.source]:d.sources};
   if(d.valid_until&&Date.parse(d.valid_until)<=Date.parse(input.evaluated_at))d={...d,state:'expired'};
   if(!rest&&decision_id==='wt.non_rest_scope'&&d.state==='accepted')throw Error('WORKING_TIME_UNKNOWN_REST_ACCEPTED');
   if(d.state!=='accepted')add(decision_id,`applicability.${decision_id}`,d.state,question,'applicability',d.sources,ids);
   return d;
  });
  const consumedDays=complete?views.slice(0,i+1):[view];
  const hourEvidence=consumedDays.map(v=>({id:v.day.id,date:v.day.date,kind:v.day.kind,inventory:v.day.inventory,intervals:v.day.intervals,
   ordinary_limit:v.day.ordinary_limit,...(v.noWork?{no_work_credit:v.day.no_work_credit??null}:{})}));
  const checkEvidence={schema_version:'working-time-check-evidence-v1',case_id:input.case_id,workdays:hourEvidence,
   arrangement:input.arrangement,rest_window:input.rest_window,regular_hourly_wage:input.regular_hourly_wage,
   payment:{recorded_pay:view.day.recorded_pay,payroll_allocations:view.day.payroll_allocations??[],allocation:view.day.payment_allocation},
   weekly:complete?{week_start:input.week_start,inventory:input.week_inventory,scheduled_weekdays:input.scheduled_weekdays}:null,mode:input.mode};
  const factualSources:DocumentReviewSource[]=[];
  for(const v of consumedDays){const sources=[v.day.kind.source,v.day.inventory.source,...v.day.intervals.map(r=>r.classification.source),...(v.noWork?[v.day.no_work_credit?.source??null]:[])];
   for(const s of sources)if(s&&!factualSources.some(existing=>canonicalSha256(existing)===canonicalSha256(s)))factualSources.push(s);}
  for(const s of [input.arrangement.source,input.rest_window.source,view.day.payment_allocation.source,...(complete?[input.week_inventory.source,input.scheduled_weekdays.source]:[])])
   if(s&&!factualSources.some(existing=>canonicalSha256(existing)===canonicalSha256(s)))factualSources.push(s);
  // Decision source arrays are bounded. Split factual witnesses rather than
  // dropping a customer-answer citation from the normal calculation manifest.
  for(let start=0;start<Math.max(1,factualSources.length);start+=16)decisions.push({decision_id:'wt.evidence_binding.'+start,state:'accepted',basis:'ai_source_assessment',
   explanation:`Source-time representation and consumed facts only; no cryptographic authority verification: ${canonicalSha256(checkEvidence)}`,
   sources:factualSources.slice(start,start+16),valid_until:null});
  const calculation=buildWorkingTimeRule(input,view,complete?views.slice(0,i):[],complete,rest!==null,decisions);
  const scenario=input.mode==='explicit_presence_scenario',restIncluded=rest!==null&&view.readings.some(r=>(r.rest_minutes??0)>0);
  checks.push({check_id:calculation.check_id,topic:restIncluded?'rest_day':'working_time',title:`${scenario?'תרחיש מותנה: ':''}גמול עבודה ${view.day.date}${view.sevenHourDay?' — סף שבע שעות':''}`,
   explanation:(scenario?'מקטעים שסיווגם חסר נספרים רק בתרחיש אם כל המקטע נחשב עבודה. ':'')+
    (complete?'הסף היומי והשבועי משולבים ללא ספירה כפולה; שתי השעות הראשונות נבחנות לכל יום. ':'חישוב יומי בלבד; התוספת השבועית טרם נבדקה, ואין לסכום אותו עם חישוב חלופי של אותו יום. ')+
    (restIncluded?'נוספת תוספת מנוחה שבועית לאותן שעות: 150%, ובחפיפת שעות נוספות 175% או 200%. ':!rest?'חלון מנוחה חסר: אין כאן קביעה שהיום רגיל ואין חישוב תוספת מנוחה. ':'חלון המנוחה המזוהה אינו חופף את שעות היום. ')+
    'ההפרש מול הקצאת השכר במסמך אינו מוכיח העברה בפועל או חוב משפטי מאושר.',calculation});
 }
 const coverage_gaps:DocumentReviewInput['coverage_gaps']=missing.map(m=>({check_id:`${input.check_id_prefix}.gap.${m.fact_key}`,topic:m.fact_key==='wt.rest_window'?'rest_day':'working_time',
  kind:m.kind==='source'?'missing_source':m.kind==='applicability'?'missing_applicability':'missing_fact',detail:m.question,next_step:m.question,...(m.source_pins.length?{source_pins:[...m.source_pins]}:{})}));
 const allocation_receipt={schema_version:'working-time-allocation-v1',input_sha256:evidenceSha,weekly_inventory_complete:complete,
  weekly_strategy:complete?'exclude_daily_overtime_then_chronological_weekly_prefix':'not_evaluated',rest_window_known:rest!==null,
  transformations:traces,check_ids:checks.map(c=>c.check_id),check_sha256:checks.map(c=>canonicalSha256(c)),no_double_count_scope:'one_alternative_per_workday'};
 return deepFreeze({catalog_descriptor:WORKING_TIME_CATALOG,checks,coverage_gaps,missing,allocation_receipt:{...allocation_receipt,sha256:canonicalSha256(allocation_receipt)}});
}
