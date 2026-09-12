import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import type {DocumentReviewOperand,DocumentReviewSource} from '../document-review/calculations.ts';
import {nonPayslipEffectiveReadingSha} from '../document-review/non-payslip.ts';
import {savedNonPayslipEvidenceSchema} from '../extraction/document-evidence/snapshot.ts';
import type {NormalizedDocumentEvidence,DocumentEvidenceValue} from '../extraction/document-evidence/contracts.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput,type WorkingTimeWorkday} from './working-time/index.ts';
import {obligationsEntitlementInputSchema,obligationTextSha256,type ExplicitObligation} from './obligations/index.ts';
import {normalizeMoney} from '../extraction/normalization.ts';
import {workingTimePayrollRate} from './working-time/payroll-rate.ts';

export const AUTOMATIC_NONPAY_EVIDENCE_POLICY='automatic-nonpay-source-evidence-v1' as const;
type Observation=NormalizedDocumentEvidence['observations'][number];
type Topic=DocumentReviewInput['purchased_scope']['topics'][number];
export type NonPayslipReadingDependency=Readonly<{
 version_id:string;product_document_id:string;checkpoint_sha256:string;normalized_sha256:string;
 observation_ids:readonly string[];dependent_check_ids:readonly string[];
}>;
export type AutomaticNonPayslipResult=Readonly<{input:DocumentReviewInput;reading_dependencies:readonly NonPayslipReadingDependency[]}>;
const missing={state:'missing' as const,value:null,source:null};
const dateAt=(date:string,days:number)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const sunday=(date:string)=>dateAt(date,-new Date(date+'T00:00:00Z').getUTCDay());
const rowKey=(o:Observation)=>canonicalSha256({page:o.original.page,block:o.original.block_id,row:o.original.row_id});
// Whole-clause grammar, not a search for whichever amount makes arithmetic fit.
// Qualifications, ranges, discretion and multiple monetary terms do not match.
function literalPromise(text:string){
 const match=/^המעסיק ישלם לעובד(?:ת)? (בונוס בסך )?([0-9]+(?:\.[0-9]{1,2})?) (?:ש״ח|ש"ח|ILS) (בכל חודש|לחודש|לכל (שעה|יום|משמרת) בחודש)[.]?$/u.exec(text.trim());
 if(!match)return null;
 const amount=normalizeMoney(match[2],'ILS');if(!amount)return null;
 return {bonus:!!match[1],minor:amount.minor_units,kind:match[4]?'linear' as const:'fixed' as const,
  unit:match[4]==='שעה'?'hours' as const:match[4]==='יום'?'days' as const:'count' as const};
}

/** A normalized candidate is never accepted by its confidence. The caller's
 * saved snapshot must contain exactly the same authenticated reading journal. */
export function attachAutomaticNonPayslipEvidence(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):AutomaticNonPayslipResult{
 const unchanged={input:candidate,reading_dependencies:[]};
 const time=(candidate.purchased_scope.topics.includes('working_time')||candidate.purchased_scope.topics.includes('rest_day'))&&candidate.entitlement_evidence?.working_time===undefined;
 const contracts=candidate.purchased_scope.topics.filter((t):t is 'contract'|'bonuses'=>t==='contract'||t==='bonuses');
 if(candidate.entitlement_composition||!candidate.non_payslip_evidence?.length||!time&&(!contracts.length||candidate.entitlement_evidence?.obligations!==undefined)
  ||candidate.period.from<'2026-05-01'||candidate.period.to>'2026-07-31')return unchanged;
 const input=documentReviewInputSchema.parse(candidate),gaps=[...input.coverage_gaps],dependencies:NonPayslipReadingDependency[]=[];
 const records=input.non_payslip_evidence!;
 if(new Set(records.map(r=>r.document.document_id)).size!==records.length)throw Error('AUTOMATIC_NONPAY_DUPLICATE_DOCUMENT');
 const days=new Map<string,WorkingTimeWorkday>(),manifest:WorkingTimeEntitlementInput['source_manifest']=[],timestamps:string[]=[],obligations:ExplicitObligation[]=[];
 const obligationManifest:WorkingTimeEntitlementInput['source_manifest']=[];
 const timeTopic:Topic=input.purchased_scope.topics.includes('working_time')?'working_time':'rest_day';
 for(const recordInput of records){
  const record=savedNonPayslipEvidenceSchema.parse(recordInput),d=record.document;
  const saved=snapshot.non_payslip_evidence?.filter(e=>e.document.document_id===d.document_id);
  if(saved?.length!==1||canonicalSha256(saved[0])!==canonicalSha256(record))throw Error('AUTOMATIC_NONPAY_SNAPSHOT_BINDING');
  const document=input.documents.find(x=>x.version_id===d.document_id);
  if(!document||document.document_id!==d.document_id||document.file_sha256!==d.content_sha256)throw Error('AUTOMATIC_NONPAY_DOCUMENT_BINDING');
  const e=record.extraction,token=canonicalSha256(d.document_id).slice(0,16),prefix=`entitlement.nonpay.${token}`;
  const pin={case_id:input.case_id,document_id:d.document_id,version_id:d.document_id,source_sha256:d.content_sha256};
  const gap=(suffix:string,topic:Topic,kind:DocumentReviewInput['coverage_gaps'][number]['kind'],detail:string,next_step:string)=>{
   const value={check_id:`${prefix}.${suffix}`,topic,kind,detail,next_step,source_pins:[pin]};
   if(!gaps.some(g=>g.check_id===value.check_id))gaps.push(value);
  };
  if(!e){
   for(const topic of d.document_type==='attendance'?(time?[timeTopic]:[]):contracts)gap('source',topic,'missing_source','טרם קיימת קריאה שמורה של המסמך.','יש להשלים את קריאת המסמך שכבר הועלה; לא נקבעו ערכים חסרים כאפס.');
   continue;
  }
  if(document.reading_sha256!==nonPayslipEffectiveReadingSha(record)||document.page_count!==e.physical_page_count)throw Error('AUTOMATIC_NONPAY_READING_BINDING');
  if(e.detected_document_type!==d.document_type){
   for(const topic of d.document_type==='attendance'?(time?[timeTopic]:[]):contracts)gap('document_kind',topic,'missing_source','סוג המסמך שחולץ אינו תואם לסוג המקור שהועלה.','נדרשת בדיקת סוג המסמך והקריאה לפני שימוש בנתוניו.');
   continue;
  }
  const readings=new Map(record.readings.filter(r=>r.target.month===input.period.from.slice(0,7)).map(r=>[r.target.observation.observation_id,r]));
  const read=(o:Observation|undefined):DocumentEvidenceValue|null=>{
   if(!o||o.issues.some(i=>i==='duplicate_source_cell'))return null;
   const r=readings.get(o.observation_id);return r?.state==='identified_reading'?r.value:null;
  };
  const pending=new Set<string>(),dependent=new Set<string>();
  const request=(observations:Observation[],id:string)=>{
   dependent.add(id);
   for(const o of observations)if(!readings.has(o.observation_id)&&!o.issues.includes('duplicate_source_cell')&&o.original.raw_value!==null)pending.add(o.observation_id);
  };
  const source=(observations:Observation[],label:string):DocumentReviewSource=>{
   const used=observations.map(o=>({observation_id:o.observation_id,original_sha256:o.original_sha256,reading_sha256:readings.get(o.observation_id)?.verification_sha256??null}));
   const locator={schema_version:AUTOMATIC_NONPAY_EVIDENCE_POLICY,observations_sha256:canonicalSha256(used),observation_ids:observations.map(o=>o.observation_id)};
   const full=JSON.stringify(locator);
   return {document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page:observations[0]?.original.page??1,
    locator:full.length<=500?full:JSON.stringify({schema_version:AUTOMATIC_NONPAY_EVIDENCE_POLICY,observations_sha256:canonicalSha256(used)}),label,
    reading:observations.length>0&&observations.every(o=>read(o)!==null)?'identified_document_reading':'provider_extraction',reading_receipt_sha256:nonPayslipEffectiveReadingSha(record)};
  };
  const emptyOperand=(id:string,s:DocumentReviewSource,money=false):DocumentReviewOperand=>({id,observation_id:id,state:'missing',printed_value:null,
   representation:money?'money_ils':'decimal_quantity',quantity_unit:money?null:'hours',precision:'source_exact',source:s});
  if(d.document_type==='attendance'&&time){
   manifest.push({document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:e.physical_page_count,kind:'case_document',case_id:input.case_id});
   timestamps.push(d.created_at,...record.readings.map(r=>r.answered_at));
   const rows=new Map<string,Observation[]>();
   for(const o of e.observations)if(o.original.row_id!==null){const key=rowKey(o);rows.set(key,[...(rows.get(key)??[]),o]);}
   const periodObservations=e.observations.filter(o=>['period_start','period_end'].includes(o.original.semantic));
   request(periodObservations,`${prefix}.period`);
   const starts=periodObservations.filter(o=>o.original.semantic==='period_start'),ends=periodObservations.filter(o=>o.original.semantic==='period_end');
   const from=starts.length===1?read(starts[0]):null,to=ends.length===1?read(ends[0]):null;
   if(from?.kind!=='iso_date'||to?.kind!=='iso_date'||from.value>to.value)gap('period',timeTopic,'missing_source','תקופת דוח הנוכחות טרם נקראה במלואה. תאריכים מזוהים של שורות נשמרים בנפרד.','יש לקרוא את גבולות תקופת המקור; תקופת הרכישה אינה מושלמת מתאריכי נוכחות.');
   let relevant=0;
   for(const [key,row]of rows){
    if(!row.some(o=>['entry_time','exit_time','reported_duration'].includes(o.original.semantic)))continue;
    const short=key.slice(0,16),id=`${prefix}.row.${short}`;
    const select=(semantic:Observation['original']['semantic'])=>row.filter(o=>o.original.semantic===semantic);
    const dates=select('row_date'),date=dates.length===1?read(dates[0]):null;
    // An already identified date outside scope is retained, never prorated or
    // used as grounds to request unrelated clock/amount cells.
    if(date?.kind==='iso_date'&&(date.value<input.period.from||date.value>input.period.to)){
     gap(`outside.${short}`,timeTopic,'missing_applicability','שורת נוכחות מזוהה נמצאת מחוץ לתקופת הבדיקה שנבחרה; היא נשמרה במקור.','לבדיקת התקופה הנוספת יש לבחור תקופת שירות מתאימה; לא בוצעה פרורציה.');continue;
    }
    relevant++;
    const clocks=[...select('entry_time'),...select('exit_time'),...select('reported_duration')];
    request([...dates,...clocks],id);
    if(dates.length!==1||date?.kind!=='iso_date'){
     gap(`date.${short}`,timeTopic,'missing_source','אין לשורת הנוכחות תאריך מלא יחיד שאושר בקריאה מזוהה.','יש לקרוא את תאריך השורה במקור; אין להשלים שנה או חודש מתקופת הבדיקה.');continue;
    }
    const dayId='day.'+date.value.replaceAll('-',''),s=source(dates,'תאריך שורת נוכחות שנקרא במקור');
    const day:WorkingTimeWorkday=days.get(date.value)??{id:dayId,date:date.value,kind:missing,inventory:{...missing,source:s},intervals:[],ordinary_limit:emptyOperand(`${dayId}.ordinary_limit`,s),recorded_pay:null,payment_allocation:{...missing,source:s}};
    days.set(date.value,day);
    const entries=select('entry_time'),exits=select('exit_time'),durations=select('reported_duration');
    const a=entries.length===1?read(entries[0]):null,b=exits.length===1?read(exits[0]):null,v=durations.length===1?read(durations[0]):null;
    let minutes:number|null=null;
    if(v?.kind==='duration_hhmm'){const [h,m]=v.value.split(':').map(Number);minutes=h*60+m;}
    if(v?.kind==='decimal'&&v.unit==='hours')minutes=Number(v.value)*60;
    if(a?.kind!=='clock_time'||b?.kind!=='clock_time'||minutes===null||!Number.isInteger(minutes)||minutes<=0||minutes>1440||new Set(clocks.map(o=>o.original.page)).size!==1){
     gap(`clock.${short}`,timeTopic,'missing_source','כניסה, יציאה ומשך נוכחות של אותה שורה עדיין אינם קריאה מזוהה מלאה ביחידות מתאימות.','יש לקרוא את שלושת הנתונים באותה שורה; משך חסר לא מוחלף בהפרש שעות מחושב.');continue;
    }
    const start=Date.parse(`${date.value}T${a.value}:00+03:00`),end=start+minutes*60000;
    const localEnd=new Date(end+10800000).toISOString(),endDate=localEnd.slice(0,10);
    if(localEnd.slice(11,16)!==b.value||endDate>input.period.to){
     gap(`clock_relation.${short}`,timeTopic,'missing_source','המשך המזוהה אינו תואם לכניסה וליציאה, או שהמקטע חוצה את גבול תקופת הבדיקה.','יש ליישב את תאריך היציאה ואת המשך במקור; לא פוצלה משמרת ולא שונו שעות.');continue;
    }
    if(day.intervals.length>=8){gap(`row_bound.${short}`,timeTopic,'missing_rule','מספר מקטעי היום חורג מגבול הבדיקה הנוכחית.','נדרשת סקירת מבנה המקטעים לפני חישוב יומי; כל השורות נשמרו.');continue;}
    const intervalSource=source([...dates,...clocks],'תאריך, כניסה, יציאה ומשך נוכחות — קריאות מזוהות באותה שורה');
    if(v?.kind!=='duration_hhmm'&&v?.kind!=='decimal')throw Error('AUTOMATIC_NONPAY_DURATION_TYPE');
    const duration:DocumentReviewOperand={id:'duration.'+short,observation_id:durations[0].observation_id,state:'observed',printed_value:v.value,
     representation:v.kind==='duration_hhmm'?'hours_minutes':'decimal_quantity',quantity_unit:'hours',precision:'source_exact',source:intervalSource};
    day.intervals.push({id:'interval.'+token+'.'+short,start_at:`${date.value}T${a.value}:00+03:00`,end_at:`${endDate}T${b.value}:00+03:00`,printed_duration:duration,clock_source:intervalSource,classification:{...missing,source:intervalSource}});
    const breaks=select('break_duration');
    if(breaks.length)gap(`break.${short}`,timeTopic,'missing_fact','רשום משך הפסקה, אך משך לבדו אינו מזהה את מועד ההפסקה ואת חובת הזמינות.','יש לזהות את מקטע ההפסקה והאם ניתן היה לצאת; לא נוכו דקות אוטומטית.');
   }
   if(!relevant)gap('attendance',timeTopic,'missing_source','לא זוהו שורות נוכחות מתוארכות שניתן לשייך לתקופה הנבדקת.','יש לזהות רישום מתוארך לתקופה; סך שעות חודשי אינו מזהה שעות נוספות יומיות או מנוחה שבועית.');
  }
  if(d.document_type==='contract'&&contracts.length&&input.entitlement_evidence?.obligations===undefined){
   const clauses=e.observations.filter(o=>o.original.semantic==='clause_text');
   const defaultTopic=contracts.includes('contract')?'contract':'bonuses';
   if(!clauses.length)gap('clause',defaultTopic,'missing_source','לא חולץ סעיף מפורש שממנו ניתן לזהות התחייבות כספית ותנאיה.','יש לבדוק סעיף שכר, מענק או נספח רלוונטי במסמך הקיים; לא הונח סכום אפס.');
   for(const clause of clauses){
    const short=clause.observation_id.slice(0,16),id=`${prefix}.clause.${short}`,text=read(clause);
    request([clause],id);
    if(text?.kind!=='text'){gap(`clause.${short}`,defaultTopic,'missing_source','טקסט הסעיף טרם נקרא בקריאה מזוהה.','יש לקרוא את הסעיף במקור; קריאה אינה הכרעת תחולה או תוקף ההסכם.');continue;}
    const literal=literalPromise(text.value);
    if(!literal){gap(`literal.${short}`,defaultTopic,'missing_rule','הסעיף המזוהה אינו אחת משתי התבניות המילוליות המפורשות הנתמכות: סכום חודשי קבוע, או תעריף לכל שעה, יום או משמרת בחודש.','נדרשת סקירת הסעיף והחריגים לפני המרתו לנוסחה; לא נבחר סכום מתוך הטקסט ולא הוסקה חובת תשלום.');continue;}
    const topic=literal.bonus?'bonuses':'contract';
    if(!contracts.includes(topic))continue;
    const row=e.observations.filter(o=>clause.original.row_id!==null&&rowKey(o)===rowKey(clause));
    const field=(semantic:Observation['original']['semantic'])=>row.filter(o=>o.original.semantic===semantic);
    const starts=field('effective_from'),ends=field('effective_to'),amounts=field(literal.kind==='fixed'?'amount':'rate');
    request([...starts,...ends,...amounts],id);
    const start=starts.length===1?read(starts[0]):null,end=ends.length===1?read(ends[0]):null,amount=amounts.length===1?read(amounts[0]):null;
    if(field('clause_text').length!==1||start?.kind!=='iso_date'||end?.kind!=='iso_date'||start.value>end.value||amount?.kind!=='money'||amount.minor_units!==literal.minor){
     gap(`association.${short}`,topic,'missing_source','טרם נקרא קשר יחיד בין נוסח ההתחייבות, סכומה או תעריפה וגבולות תוקפה באותה שורת סעיף.','יש לאמת את הסכום ואת תקופת התוקף במקור; סמיכות בלבד, סכום אחר או חודש התלוש אינם תחליף לקשר מפורש.');continue;
    }
    const fullMonth=input.period.from.slice(0,7)===input.period.to.slice(0,7)&&input.period.from.endsWith('-01')&&dateAt(input.period.to,1).endsWith('-01');
    if(!fullMonth||start.value>input.period.from||end.value<input.period.to){gap(`scope.${short}`,topic,'missing_applicability','התקופה שנבחרה אינה חודש שלם הכלול כולו בתוקף ההתחייבות החודשית המזוהה.','יש לזהות את תקופת החיוב הרלוונטית; לא בוצעה פרורציה ולא הונחה זכאות לחלק מחודש.');continue;}
    let quantity:DocumentReviewOperand|null=null;
    if(literal.kind==='linear'){
     const quantities=field('quantity'),froms=field('period_start'),tos=field('period_end');
     request([...quantities,...froms,...tos],id);
     const q=quantities.length===1?read(quantities[0]):null,from=froms.length===1?read(froms[0]):null,to=tos.length===1?read(tos[0]):null;
     const quantityLabel=literal.unit==='count'?'משמרות שבוצעו':literal.unit==='hours'?'שעות שבוצעו':'ימי עבודה שבוצעו';
     if(q?.kind==='decimal'&&q.unit===literal.unit&&quantities[0].original.source_label.trim()===quantityLabel&&/^\d+(?:\.\d+)?$/u.test(q.value)&&from?.kind==='iso_date'&&to?.kind==='iso_date'&&from.value===input.period.from&&to.value===input.period.to){
      quantity={id:'quantity.'+short,observation_id:quantities[0].observation_id,state:'observed',printed_value:q.value,representation:'decimal_quantity',quantity_unit:literal.unit,precision:'source_exact',source:source([...quantities,...froms,...tos],'כמות שנקראה עם יחידה ותקופת מקור מפורשות')};
     }
    }
    const clauseSource=source([clause,...starts,...ends,...amounts],'סעיף מילולי וסכום או תעריף באותה שורה — ללא הכרעת תוקף משפטי');
    const amountOperand:DocumentReviewOperand={id:'promise.'+short,observation_id:amounts[0].observation_id,state:'observed',printed_value:(amount.minor_units/100).toFixed(2),representation:'money_ils',quantity_unit:null,precision:'source_exact',source:clauseSource};
    const conditions=e.observations.filter(o=>o.original.page===clause.original.page&&o.original.block_id===clause.original.block_id&&['condition_text','annex_reference'].includes(o.original.semantic));
    // An extracted condition's existence is not proof it was fulfilled, and an
    // unparsed annex cannot disappear from the list of unresolved conditions.
    request(conditions,id);
    if(conditions.length>8){gap(`conditions.${short}`,topic,'missing_rule','רשימת התנאים או ההפניות חורגת מהגבול הנתמך לסעיף.','נדרשת סקירת כל התנאים והנספחים לפני חישוב; אף תנאי לא הושמט.');continue;}
    obligations.push({obligation_id:'literal.'+token+'.'+short,topic,title:literal.kind==='fixed'?'התחייבות לסכום חודשי מפורש':'התחייבות לתעריף ולכמות מפורשים',
     clause:{source:clauseSource,text:text.value,text_sha256:obligationTextSha256(text.value),effective_period:{from:start.value,to:end.value}},payment_period:input.period,
     promise:literal.kind==='fixed'?{kind:'fixed',amount:amountOperand}:{kind:'linear',rate:amountOperand,quantity,quantity_unit:literal.unit},
     conditions_mode:'all',conditions:conditions.map(o=>({condition_id:'condition.'+o.observation_id.slice(0,24),description:'נדרש לברר את קיום התנאי או ההפניה שבסעיף המקורי',fact:{state:'unknown',value:null,source:source([o],'תנאי או הפניה במקור; קיומם לא הוכרע'),basis:read(o)?'identified_document_reading':'ai_source_assessment'}})),
     assessments:[],scenario:'established_only',recorded:null});
   }
   obligationManifest.push({document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:e.physical_page_count,kind:'case_document',case_id:input.case_id});
   timestamps.push(d.created_at,...record.readings.map(r=>r.answered_at));
  }
  if(pending.size)dependencies.push({version_id:d.document_id,product_document_id:record.product_document_id,checkpoint_sha256:record.checkpoint_result_sha256!,normalized_sha256:canonicalSha256(e),observation_ids:[...pending],dependent_check_ids:[...dependent]});
 }
 const weeks=new Map<string,WorkingTimeWorkday[]>();
 for(const day of [...days.values()].sort((a,b)=>a.date.localeCompare(b.date))){const key=sunday(day.date);weeks.set(key,[...(weeks.get(key)??[]),day]);}
 const payloads:WorkingTimeEntitlementInput[]=[];
 const payrollRate=weeks.size?workingTimePayrollRate(input,snapshot):null;
 if(payrollRate&&!manifest.some(m=>m.document_id===payrollRate.source.document_id&&m.version_id===payrollRate.source.version_id)){
  const document=input.documents.find(d=>d.document_id===payrollRate.source.document_id&&d.version_id===payrollRate.source.version_id)!;
  if(document.page_count===null)throw Error('WORKING_RATE_PAGE_COUNT');
  manifest.push({document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page_count:document.page_count,kind:'case_document',case_id:input.case_id});
 }
 for(const [week,workdays]of weeks){
  if(workdays.reduce((n,d)=>n+d.intervals.length,0)>14)throw Error('AUTOMATIC_NONPAY_WEEK_INTERVAL_BOUND');
  const anchor=workdays[0].inventory.source!;
  payloads.push(workingTimeEntitlementInputSchema.parse({schema_version:'working-time-entitlement-input-v1',catalog_version:'1.0.0',calculation_policy:'working-time-separated-expected-v2',case_id:input.case_id,run_id:'automatic.source.selection',check_id_prefix:'entitlement.working.'+week.replaceAll('-',''),period:input.period,
   evaluated_at:new Date([...timestamps].sort().at(-1)!).toISOString(),source_manifest:manifest,week_start:week,week_inventory:missing,workdays,arrangement:missing,scheduled_weekdays:missing,rest_window:missing,
   regular_hourly_wage:payrollRate??{id:'regular.wage',observation_id:'unassigned.regular.wage',state:'missing',printed_value:null,representation:'money_ils',quantity_unit:null,precision:'source_exact',source:anchor},applicability:[],mode:'source_classified'}));
 }
 if(payloads.length>6)throw Error('AUTOMATIC_NONPAY_WEEK_BOUND');
 const packet=input.entitlement_evidence??{schema_version:'entitlement-source-evidence-v1' as const,case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period};
 const obligationPacket=obligations.length?obligationsEntitlementInputSchema.parse({schema_version:'obligations-entitlement-input-v1',catalog_id:'il.review.explicit_obligations.2026',catalog_version:'1.0.0',case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.literal',period:input.period,
  evaluated_at:new Date([...timestamps].sort().at(-1)!).toISOString(),purchased_topics:contracts,source_manifest:obligationManifest,obligations}):null;
 return {input:documentReviewInputSchema.parse({...input,coverage_gaps:gaps,...(payloads.length||obligationPacket?{entitlement_evidence:{...packet,...(payloads.length?{working_time:payloads}:{}),...(obligationPacket?{obligations:obligationPacket}:{})}}:{})}),reading_dependencies:dependencies};
}
