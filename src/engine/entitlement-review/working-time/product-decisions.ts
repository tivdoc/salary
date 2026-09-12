import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand,type DocumentReviewSource} from '../../document-review/calculations.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {workingTimeEntitlementInputSchema,workingTimeSourceFactSchema,type WorkingTimeEntitlementInput,type WorkingTimeMissing,type WorkingTimeWorkday} from './contracts.ts';
import {assertSource,sourceInterval,sourceNumber,type TimeReading} from './time-source.ts';
import {WORKING_TIME_SOURCE_REVIEW_SHA256} from './source-policy.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const id=z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'WT_PRODUCT_PERIOD');
/** An identified source association, not a statement that a numeric answer is
 * legally the regular wage. Admission of the reading remains with the server. */
export const workingTimeRegularWageBasisSchema=workingTimeSourceFactSchema(z.object({
 period,hourly_wage_operand_sha256:sha,
 composition:z.enum(['single_rate_no_regular_supplements','total_rate_including_all_regular_supplements','base_rate_only','incomplete','unknown']),
}).strict());
export const workingTimeAssignmentWitnessSchema=z.object({day_id:id,fact:workingTimeSourceFactSchema(z.object({
 assigned_date:z.iso.date(),assignment:z.enum(['same_workday','separate_workdays','unknown']),
 intervals:z.array(z.object({interval_id:id,source_interval_sha256:sha}).strict()).min(1).max(8),
}).strict())}).strict();
export const workingTimeProductFactsSchema=z.object({schema_version:z.literal('working-time-product-facts-v1'),
 regular_wage_basis:workingTimeRegularWageBasisSchema.optional(),assignment_witnesses:z.array(workingTimeAssignmentWitnessSchema).max(7).optional(),
}).strict();
export type WorkingTimeProductFacts=z.infer<typeof workingTimeProductFactsSchema>;
export type WorkingTimeCaseOptions={review?:DocumentReviewInput;product_facts?:WorkingTimeProductFacts;day_id?:string};
type Fact={state:string;value:unknown;source:DocumentReviewSource|null};
const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const dayPath=(i:number)=>`workdays.${i}`;
const identity=(s:DocumentReviewSource)=>({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page:s.page,reading_receipt_sha256:s.reading_receipt_sha256});
function sourcesIn(value:unknown){const sources:DocumentReviewSource[]=[];const visit=(v:unknown):void=>{const parsed=sourceSchema.safeParse(v);if(parsed.success){sources.push(parsed.data);return;}if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(value);return [...new Map(sources.map(s=>[canonicalSha256(s),s])).values()];}
function at(input:WorkingTimeEntitlementInput,facts:WorkingTimeProductFacts|undefined,path:string){let value:unknown=path.startsWith('product_facts.')?facts:input;for(const k of path.replace(/^product_facts\./u,'').split('.'))value=value&&typeof value==='object'?Reflect.get(value,k):null;return value??null;}
function sourceValid(s:DocumentReviewSource,input:WorkingTimeEntitlementInput,review?:DocumentReviewInput){
 assertSource(input,s);const pins=input.source_manifest.filter(p=>p.document_id===s.document_id&&p.version_id===s.version_id);
 if(pins.length!==1||pins[0].case_id!==input.case_id||pins[0].kind==='legal_source')throw Error('WT_CASE_SOURCE_BINDING');
 if((s.reading==='customer_declaration')!==(pins[0].kind==='customer_answer')||(s.reading==='questionnaire_declaration')!==(pins[0].kind==='questionnaire'))throw Error('WT_CASE_DECLARATION_SOURCE');
 if(review&&!['customer_declaration','questionnaire_declaration'].includes(s.reading)&&!review.documents.some(d=>d.case_id===input.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page_count!==null&&s.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256)))throw Error('WT_CASE_CURRENT_SOURCE');
}
function factReason(f:Fact|undefined,identifiedOnly=false):string|null{
 if(!f)return 'missing';if(!['observed','declared'].includes(f.state)||f.value===null||f.source===null)return f.state==='observed'||f.state==='declared'?'missing':f.state;
 if(f.state==='declared')return !identifiedOnly&&['customer_declaration','questionnaire_declaration'].includes(f.source.reading)?null:'identified_source_required';
 return f.source.reading==='identified_document_reading'?null:'identified_source_required';
}
function operandReason(o:DocumentReviewOperand|null,kind:'money'|'hours'|'percent'){
 if(!o||!['observed','declared'].includes(o.state)||o.printed_value===null)return o?.state==='observed'?'missing':o?.state??'missing';
 if(o.state!=='observed'||o.source.reading!=='identified_document_reading')return 'identified_source_required';
 sourceNumber(o,kind);return null;
}
/** Classification is deliberately excluded: assigning source clock rows and
 * deciding whether an interval is work are independently invalidatable facts. */
export function workingTimeAssignmentIntervalSha256(interval:WorkingTimeWorkday['intervals'][number]){
 return canonicalSha256({id:interval.id,start_at:interval.start_at,end_at:interval.end_at,printed_duration:interval.printed_duration,clock_source:interval.clock_source});
}
export function workingTimeCaseConsumed(input:WorkingTimeEntitlementInput,paths:readonly string[],facts?:WorkingTimeProductFacts){return paths.map(path=>{const value=at(input,facts,path);return {path:'entitlement_evidence.working_time.'+path,state:value&&typeof value==='object'&&'state' in value?String(value.state):value===null?'missing':'structural',value_sha256:canonicalSha256(value),source_sha256s:sourcesIn(value).map(s=>canonicalSha256(s))};});}
export type WorkingTimeCaseReadiness={allowed:boolean;reason:string|null;missing:WorkingTimeMissing[];producer_gaps:string[];consumed_paths:string[];consumed_sha256:string;source_sha256s:string[];source_policy_sha256:string;dependent_check_ids:string[];publication_authority:false};

/** These are factual intake requirements for a later, separately sourced
 * coverage assessment. The current working-time packet cannot establish them. */
export const WORKING_TIME_COVERAGE_FACT_REQUIREMENTS=[
 {fact_key:'employment_relationship',answer_kind:'choice',question:'באיזה אופן הועסקת: כשכיר/ה, כעצמאי/ת, או במסגרת אחרת?'},
 {fact_key:'date_of_birth',answer_kind:'text',question:'מהו תאריך הלידה, לצורך בדיקת הגיל בתקופת העבודה?'},
 {fact_key:'employer_sector',answer_kind:'text',question:'באיזה ענף פועל המעסיק, והאם מדובר בגוף ציבורי או פרטי?'},
 {fact_key:'actual_job_responsibilities',answer_kind:'text',question:'מה היו התפקידים והסמכויות שביצעת בפועל, לרבות סמכות ניהול וקבלת החלטות?'},
 {fact_key:'special_trust_responsibilities',answer_kind:'text',question:'האם התפקיד כלל סמכויות אישיות מיוחדות או חשיפה למידע רגיש? נא לתאר את האחריות בפועל.'},
 {fact_key:'hours_tracking',answer_kind:'text',question:'כיצד תועדו שעות העבודה, והאם המעסיק יכול היה לעקוב אחריהן בפועל?'},
] as const;

/** Fact readiness only. It neither issues applicability decisions nor executes
 * a second pay formula. Source numbers/clocks use the existing branch readers. */
export function evaluateWorkingTimeCaseRecipe(decisionId:string,candidate:WorkingTimeEntitlementInput,options:WorkingTimeCaseOptions={}):WorkingTimeCaseReadiness{
 const input=workingTimeEntitlementInputSchema.parse(candidate),facts=options.product_facts?workingTimeProductFactsSchema.parse(options.product_facts):undefined;
 const dynamicDay=decisionId.startsWith('wt.worked_time.')?decisionId.slice('wt.worked_time.'.length):null;
 if(dynamicDay&&options.day_id&&dynamicDay!==options.day_id)throw Error('WT_CASE_DAY_BINDING');
 const selectedId=dynamicDay??options.day_id,selected=input.workdays.map((day,i)=>({day,i})).filter(x=>!selectedId||x.day.id===selectedId);
 const comparison=decisionId==='wt.payroll_allocation',ids=selected.flatMap(({day})=>comparison||!input.calculation_policy?[`${input.check_id_prefix}.${day.id}`]:[`${input.check_id_prefix}.${day.id}.expected`,`${input.check_id_prefix}.${day.id}`]);
 const paths:string[]=['period','week_start','calculation_policy'];const consume=(...p:string[])=>{for(const path of p)if(!paths.includes(path))paths.push(path);};
 const finish=(reason:string|null,missing:WorkingTimeMissing[]=[],producer_gaps:string[]=[]):WorkingTimeCaseReadiness=>{
  for(const path of paths)for(const s of sourcesIn(at(input,facts,path)))sourceValid(s,input,options.review);
  const consumed=workingTimeCaseConsumed(input,paths,facts);return {allowed:reason===null,reason,missing,producer_gaps,consumed_paths:paths,consumed_sha256:canonicalSha256(consumed),source_sha256s:[...new Set(consumed.flatMap(c=>c.source_sha256s))],source_policy_sha256:WORKING_TIME_SOURCE_REVIEW_SHA256,dependent_check_ids:ids,publication_authority:false};
 };
 const block=(path:string,reason:string,question:string,kind:WorkingTimeMissing['kind']='source',declaration=false,choices?:readonly string[],producer?:string)=>{
  const state:WorkingTimeMissing['state']=['conflict','stale','expired','unreadable','unknown'].includes(reason)?reason as WorkingTimeMissing['state']:['missing','identified_source_required'].includes(reason)?'missing':['incomplete','incomplete_composition','partial','incomplete_or_excess_hours'].includes(reason)?'unknown':'unsupported';
  const sources=sourcesIn(at(input,facts,path));
  return finish(path+':'+reason,[{fact_key:'wt.case.'+path,input_path:path,state,kind,question,answer_kind:choices?'choice':declaration?'text':kind==='applicability'?'text':'document',...(choices?{options:choices}:{}),customer_declaration_allowed:declaration,source_pins:sources.map(s=>({case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256})),dependent_check_ids:ids}],producer?[producer]:[]);
 };
 if(options.review&&(options.review.case_id!==input.case_id||!same(options.review.period,input.period)))throw Error('WT_CASE_SCOPE');
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from>input.period.to)return finish('unsupported_source_period');
 if(decisionId==='wt.coverage')return finish('coverage_requires_separate_factual_packet_and_assessment',[],['working_time_coverage_facts_and_assessment']);
 if(!dynamicDay&&!['wt.workday_assignment','wt.arrangement','wt.regular_wage','wt.payroll_allocation'].includes(decisionId))return finish('unsupported_case_recipe');
 if(!selected.length)return block('workdays','missing','יש לצרף רישום נוכחות מתוארך לתקופה המבוקשת.');
 if(new Set(input.workdays.map(d=>d.id)).size!==input.workdays.length||new Set(input.workdays.map(d=>d.date)).size!==input.workdays.length)return block('workdays','conflict','יש ליישב רישומים כפולים של אותו יום עבודה.');
 const weekStart=Date.parse(input.week_start+'T00:00:00Z');
 if(new Date(weekStart).getUTCDay()!==0)throw Error('WT_CASE_WEEK_START');
 for(const {day,i}of selected){consume(dayPath(i)+'.id',dayPath(i)+'.date');if(day.date<input.period.from||day.date>input.period.to||Date.parse(day.date+'T00:00:00Z')<weekStart||Date.parse(day.date+'T00:00:00Z')>=weekStart+7*86400000)return block(dayPath(i)+'.date','conflict','יש להתאים את תאריך הרישום לשבוע ולתקופה הנבדקים.');}

 if(decisionId==='wt.regular_wage'){
  consume('regular_hourly_wage','product_facts.regular_wage_basis');const r=operandReason(input.regular_hourly_wage,'money');
  if(r)return block('regular_hourly_wage',r,'יש לזהות את התעריף השעתי במסמך השכר או בהסכם.');
  if(sourceNumber(input.regular_hourly_wage,'money')!<=0)return block('regular_hourly_wage','zero_rate','תעריף אפס דורש בירור מקור ואינו משמש בסיס לגמול עבודה.');
  const basis=facts?.regular_wage_basis,reason=factReason(basis,true);if(reason)return block('product_facts.regular_wage_basis',reason,'יש לזהות במסמך אילו רכיבי שכר רגילים כלולים בתעריף, לרבות תוספות קבועות או תוספת משמרת.', 'source',false,undefined,'identified_regular_wage_basis_association');
  if(!same(basis!.value!.period,input.period)||basis!.value!.hourly_wage_operand_sha256!==canonicalSha256(input.regular_hourly_wage))return block('product_facts.regular_wage_basis','conflict','יש להתאים את זיהוי רכיבי השכר לאותו תעריף ולאותה תקופה.');
  return ['single_rate_no_regular_supplements','total_rate_including_all_regular_supplements'].includes(basis!.value!.composition)?finish(null):block('product_facts.regular_wage_basis','incomplete_composition','יש להשלים את זיהוי רכיבי השכר הרגילים הכלולים בתעריף; תעריף בסיס לבדו אינו מוכיח שכל התוספות נכללו.');
 }

 const classified=(day:WorkingTimeWorkday,i:number):{reason:string;path:string}|null=>{
  const p=dayPath(i);consume(p+'.inventory',p+'.intervals');
  const inventory=factReason(day.inventory);if(inventory)return {path:p+'.inventory',reason:inventory};
  if(day.inventory.value==='incomplete')return {path:p+'.inventory',reason:'incomplete'};
  if(day.inventory.value==='no_work')return day.intervals.length?{path:p+'.inventory',reason:'conflict'}:{path:p+'.intervals',reason:'no_work_not_paid_time'};
  if(!day.intervals.length)return {path:p+'.intervals',reason:'missing'};
  const usedIds=new Set<string>(),usedSources=new Set<string>();const times:TimeReading[]=[];
  for(const [j,interval]of day.intervals.entries()){
   const q=p+`.intervals.${j}`,key=canonicalSha256({observation_id:interval.printed_duration.observation_id,source:interval.printed_duration.source});
   if(usedIds.has(interval.id)||usedSources.has(key))return {path:q,reason:'conflict'};usedIds.add(interval.id);usedSources.add(key);
   const duration=operandReason(interval.printed_duration,'hours');if(duration)return {path:q+'.printed_duration',reason:duration};
   if(interval.clock_source.reading!=='identified_document_reading')return {path:q+'.clock_source',reason:'identified_source_required'};
   const reading=sourceInterval(input,day,interval,null)!;times.push(reading);
   const classification=factReason(interval.classification);if(classification||interval.classification.value==='unknown')return {path:q+'.classification',reason:classification??'unknown'};
  }
  times.sort((a,b)=>a.start-b.start);if(times.some((t,j)=>j>0&&t.start<times[j-1].end))return {path:p+'.intervals',reason:'conflict'};
  return day.intervals.every(x=>x.classification.value==='free_break')?{path:p+'.intervals',reason:'no_work_not_paid_time'}:null;
 };
 if(dynamicDay){const {day,i}=selected[0],r=classified(day,i);if(!r)return finish(null);
  if(r.path.endsWith('.classification'))return block(r.path,r.reason,'מה היה אופי המקטע: עבודה, הפסקה שבה היית חופשי/ה לצאת, או זמן שבו נדרשת להישאר לרשות המעסיק?','fact',true,['worked','free_break','required_presence','unknown']);
  if(r.path.endsWith('.inventory'))return block(r.path,r.reason,'האם הרישום כולל את כל מקטעי הנוכחות וההפסקות ביום הזה, או שלא הייתה נוכחות כלל?','fact',true,['complete_work','no_work','incomplete']);
  return block(r.path,r.reason,'יש להשלים או ליישב את רישום מקטעי היום; היעדר זמן עבודה אינו תשלום אפס.');
 }

 if(decisionId==='wt.workday_assignment'){
  const allTimes:{start:number;end:number}[]=[],intervalIds=new Set<string>(),intervalSources=new Set<string>();
  if(facts?.assignment_witnesses?.some(w=>!input.workdays.some(d=>d.id===w.day_id))){consume('product_facts.assignment_witnesses');return block('product_facts.assignment_witnesses','conflict','עדות שיוך מתייחסת ליום שאינו נמצא ברישום המקור.');}
  // A per-day predicate cannot hold up an independent day because another day
  // is incomplete. The ordinary resolver separately rejects cross-day overlap.
  // Distinct shifts are never merged solely because their break is short.
  for(const {i,day}of selected){
   const p=dayPath(i);consume(p+'.id',p+'.date',p+'.inventory');for(const [j]of day.intervals.entries())consume(p+`.intervals.${j}.id`,p+`.intervals.${j}.start_at`,p+`.intervals.${j}.end_at`,p+`.intervals.${j}.printed_duration`,p+`.intervals.${j}.clock_source`);
   const inv=factReason(day.inventory);if(inv||day.inventory.value==='incomplete')return block(p+'.inventory',inv??'incomplete','האם רישום הנוכחות כולל את כל המקטעים באותו יום?', 'fact',true,['complete_work','no_work','incomplete']);
   if(day.inventory.value==='no_work'){if(day.intervals.length)return block(p+'.inventory','conflict','הצהרת אי־עבודה סותרת את מקטעי הנוכחות שנשמרו.');continue;}
   if(!day.intervals.length)return block(p+'.intervals','missing','יש לצרף את רישומי תחילת המשמרת וסיומה.');
   for(const [j,interval]of day.intervals.entries()){
    const sourceKey=canonicalSha256({observation_id:interval.printed_duration.observation_id,source:interval.printed_duration.source});
    if(intervalIds.has(interval.id)||intervalSources.has(sourceKey))return block(p+'.intervals','conflict','אותו מקטע מקור אינו משויך פעמיים.');intervalIds.add(interval.id);intervalSources.add(sourceKey);
    const reason=operandReason(interval.printed_duration,'hours');if(reason)return block(p+`.intervals.${j}.printed_duration`,reason,'יש לזהות את משך המקטע ואת תאריכי הכניסה והיציאה.');
    if(interval.clock_source.reading!=='identified_document_reading')return block(p+`.intervals.${j}.clock_source`,'identified_source_required','יש לזהות את מועדי הכניסה והיציאה במקור.');
    allTimes.push(sourceInterval(input,day,interval,null)!);
   }
   const witnesses=(facts?.assignment_witnesses??[]).filter(w=>w.day_id===day.id);
   for(const [index,w]of (facts?.assignment_witnesses??[]).entries())if(w.day_id===day.id)consume(`product_facts.assignment_witnesses.${index}`);
   if(witnesses.length>1)return block('product_facts.assignment_witnesses','conflict','יש ליישב עדויות כפולות לשיוך המקטעים לאותו יום עבודה.');
   const witness=witnesses[0];
   if(!witness&&day.intervals.length===1&&day.intervals[0].start_at.slice(0,10)===day.date)continue;
   const reason=factReason(witness?.fact,true);if(reason){if(!witness)consume('product_facts.assignment_witnesses');return block('product_facts.assignment_witnesses',reason,'יש לזהות ברישום המשמרות אם המקטעים שייכים ליום עבודה אחד או למשמרות נפרדות; הפסקה קצרה כשלעצמה אינה מכריעה.', 'source',false,undefined,'identified_workday_assignment_association');}
   const v=witness!.fact.value!;if(v.assignment!=='same_workday'||v.assigned_date!==day.date||!same(v.intervals,day.intervals.map(interval=>({interval_id:interval.id,source_interval_sha256:workingTimeAssignmentIntervalSha256(interval)}))))return block('product_facts.assignment_witnesses',v.assignment==='unknown'?'unknown':'conflict','יש להתאים את שיוך יום העבודה לכל המקטעים המקוריים ולתאריך, או לפצל משמרות לפי מקור מזוהה.');
  }
  allTimes.sort((a,b)=>a.start-b.start);return allTimes.some((t,i)=>i>0&&t.start<allTimes[i-1].end)?block('workdays','conflict','מקטעי נוכחות חופפים אינם נספרים פעמיים.'):finish(null);
 }
 if(decisionId==='wt.arrangement'){
  consume('arrangement','scheduled_weekdays');const arrangement=factReason(input.arrangement,true),schedule=factReason(input.scheduled_weekdays);
  if(arrangement||input.arrangement.value==='unsupported')return block('arrangement',arrangement??'unsupported','יש לזהות את מתכונת שבוע העבודה בהסכם או בלוח העבודה, לרבות הסדר מיוחד או מיטיב.');
  if(schedule)return block('scheduled_weekdays',schedule,'באילו ימים מתקיים שבוע העבודה הנהוג במקום העבודה? אין הכוונה רק לימי העבודה האישיים בחודש.', 'fact',false);
  const weekdays=input.scheduled_weekdays.value!,count=input.arrangement.value==='adult_hourly_five_day_42'?5:6;
  if(weekdays.length!==count||new Set(weekdays).size!==count)return block('scheduled_weekdays','conflict','ימי העבודה שנמסרו אינם תואמים את המתכונת המזוהה.');
  for(const {day,i}of selected){const p=dayPath(i);consume(p+'.inventory',p+'.kind',p+'.ordinary_limit');
   const inventory=factReason(day.inventory);if(inventory||day.inventory.value==='incomplete')return block(p+'.inventory',inventory??'incomplete','יש להשלים את רישום היום לצורך קביעת סף העבודה.');
   if(day.inventory.value==='no_work'){if(day.intervals.length)return block(p+'.inventory','conflict','רישום אי־עבודה סותר מקטעי עבודה.');continue;}
   const kind=factReason(day.kind);if(kind||['holiday','unsupported'].includes(day.kind.value!))return block(p+'.kind',kind??'unsupported','יש לזהות את סוג היום ביחס ללוח העבודה ולמנוחה השבועית.');
   if(['conflict','stale','expired','unreadable'].includes(day.ordinary_limit.state))return block(p+'.ordinary_limit',day.ordinary_limit.state,'יש ליישב את מקור הסף היומי; סף לילה אינו מוחק מקור סותר.');
   const limit=operandReason(day.ordinary_limit,'hours');
   if(limit){let seven=day.kind.value==='pre_rest';if(!seven){const classifiedReason=classified(day,i);if(!classifiedReason)seven=day.intervals.filter(x=>x.classification.value!=='free_break').reduce((n,x)=>n+sourceInterval(input,day,x,null)!.night_minutes,0)>=120;}
    if(!seven||!['missing','unknown'].includes(day.ordinary_limit.state))return block(p+'.ordinary_limit',limit,'יש לזהות את שעות התקן ואת היום המקוצר במקור; אין לחלק 42 במספר ימי השבוע.');
   }else {const minutes=sourceNumber(day.ordinary_limit,'hours')!;if(minutes<=0||minutes>(count===5?540:480))return block(p+'.ordinary_limit','unsupported','הסף היומי שנקרא אינו מתאים לענף המצומצם ומצריך בחינת הסדר נפרד.');}
  }
  return finish(null);
 }
 for(const {day,i}of selected){const p=dayPath(i);consume(p+'.payment_allocation',p+'.recorded_pay',p+'.payroll_allocations');
  // full_pay_for_workday identifies the complete inventory of recorded payment
  // assigned to this day. It does not assert that every worked hour was paid.
  const allocation=factReason(day.payment_allocation,true);if(allocation||day.payment_allocation.value!=='full_pay_for_workday')return block(p+'.payment_allocation',allocation??'partial','יש לזהות את מלוא רכיבי התשלום המתועדים המשויכים ליום העבודה, בסכום מפורש או בכמויות ותעריפים; ברוטו חודשי אינו שיוך יומי.');
  const bands=day.payroll_allocations??[];if(day.recorded_pay&&bands.length)return block(p+'.payroll_allocations','conflict','יש ליישב שיוך כפול באמצעות סכום וגם רכיבי תשלום.');
  const match=(s:DocumentReviewSource)=>same(identity(s),identity(day.payment_allocation.source!));
  if(day.recorded_pay){const amount=operandReason(day.recorded_pay,'money');if(amount)return block(p+'.recorded_pay',amount,'יש לזהות את הסכום ששויך ליום העבודה.');if(!match(day.recorded_pay.source))return block(p+'.payment_allocation','conflict','הסכום והשיוך היומי אינם קשורים לאותה קריאת מקור.');continue;}
  if(!bands.length)return block(p+'.recorded_pay','missing','יש לצרף את פירוט התשלום ליום העבודה; היעדר סכום אינו תשלום אפס.');
  const worked=classified(day,i);if(worked)return block(worked.path,worked.reason,'יש להשלים את מקטעי העבודה לפני אימות שלמות הקצאת התשלום.');
  const bandIds=new Set<string>(),observations=new Set<string>();let paidMinutes=0;
  for(const [j,band]of bands.entries()){
   if(bandIds.has(band.id))return block(p+'.payroll_allocations','conflict','רכיב תשלום כפול אינו נספר פעמיים.');bandIds.add(band.id);
   for(const [cell,operand,unit]of [['hours',band.hours,'hours'],['hourly_rate',band.hourly_rate,'money'],['percentage',band.percentage,'percent']] as const){
    if(cell==='percentage'&&!operand)continue;const reason=operandReason(operand,unit);if(reason)return block(p+`.payroll_allocations.${j}.${cell}`,reason,'יש לזהות את כמות השעות, התעריף ואחוז התשלום ברכיב המשויך.');
    if(!match(operand!.source))return block(p+'.payroll_allocations','conflict','רכיבי התשלום אינם קשורים לאותו שיוך מקור.');
   }
   const key=canonicalSha256({observation_id:band.hours.observation_id,source:band.hours.source});if(observations.has(key))return block(p+'.payroll_allocations','conflict','אותה כמות שעות מופיעה פעמיים בהקצאה.');observations.add(key);
   if(sourceNumber(band.hourly_rate,'money')!<=0||band.percentage&&sourceNumber(band.percentage,'percent')!<100)return block(p+'.payroll_allocations','premium_only_or_zero_rate','תוספת בלבד אינה מלוא תשלום השעות. יש לזהות את רכיב שכר הבסיס.');paidMinutes+=sourceNumber(band.hours,'hours')!;
  }
  const workedMinutes=day.intervals.filter(x=>x.classification.value!=='free_break').reduce((n,x)=>n+sourceInterval(input,day,x,null)!.minutes,0);
  if(paidMinutes>workedMinutes)return block(p+'.payroll_allocations','conflict','כמות השעות ברכיבי התשלום גדולה מזמן העבודה המזוהה. יש ליישב את השיוך לפני השוואה.');
 }
 // A shared numeric observation cannot constitute full payment of two days.
 const paidKeys=new Set<string>();for(const {day,i}of selected){const operands=day.recorded_pay?[day.recorded_pay]:(day.payroll_allocations??[]).map(b=>b.hours);for(const o of operands){const key=canonicalSha256({observation_id:o.observation_id,source:o.source});if(paidKeys.has(key))return block(dayPath(i)+'.payment_allocation','conflict','אותו רכיב תשלום משויך ליותר מיום אחד.');paidKeys.add(key);}}
 return finish(null);
}
