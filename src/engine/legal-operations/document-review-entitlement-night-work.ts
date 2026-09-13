import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {createRuleSpecPackage,type RuleSpecDraft} from './rulespec.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand,type DocumentReviewSource} from '../document-review/calculations.ts';
import {NIGHT_ENTITLEMENT_CATALOG,NIGHT_ENTITLEMENT_LEGAL_MANIFEST,NIGHT_ENTITLEMENT_SOURCE_REVIEW,nightEntitlementLegalSource} from './document-review-entitlement-source-policy.ts';

type Candidate=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>;
export type NightEntitlementDecision=Candidate['decisions'][number];
export type NightEntitlementInterval=Readonly<{
 id:string;date:string;start_time:string;end_time:string;clock_source:DocumentReviewSource;
 printed_presence:DocumentReviewOperand;classification:'work'|'excluded_break'|'unresolved_rest';
}>;
export type NightEntitlementInput=Readonly<{
 catalog_id:typeof NIGHT_ENTITLEMENT_CATALOG.catalog_id;catalog_version:'1.0.0';
 case_id:string;run_id:string;check_id:string;period:{from:string;to:string};evaluated_at:string;
 source_manifest:DocumentReviewCalculationInput['source_manifest'];
 intervals:readonly NightEntitlementInterval[];hourly_wage:DocumentReviewOperand;
 payroll_allocations:readonly Readonly<{id:string;hours:DocumentReviewOperand;hourly_rate:DocumentReviewOperand;percentage:DocumentReviewOperand|null}>[];
 applicability:readonly NightEntitlementDecision[];
 mode:'source_classified'|'all_presence_is_work_scenario';
 conditional_assumptions?:Candidate['conditional_assumptions'];
}>;
export const NIGHT_ENTITLEMENT_DEPENDENCIES=deepFreeze({
 'night.coverage':'האם חל חוק שעות עבודה ומנוחה על התפקיד, והאם יש הסדר מיוחד שמשנה את יום העבודה? יש לצרף את ההסדר אם הוא קיים.',
 'night.workday':'האם המקטעים שייכים ליום עבודה רצוף אחד? יש לציין את ההפסקה בין משמרות אם הייתה.',
 'night.breaks':'במקטעים שסומנו כמנוחה, האם היה אפשר לצאת ולהיות פנויים מחובות, או שהיה צורך להישאר זמינים לעבודה? יש לפרט את השעות.',
 'night.non_rest_day':'מהו יום המנוחה השבועית שנקבע, והאם המקטע חופף מנוחה שבועית או חג? החישוב הנוכחי הוא ליום רגיל בלבד.',
 'night.regular_wage':'האם התעריף שנבחר כולל את כל התוספות הנכללות בשכר הרגיל לצורך שעות נוספות?',
 'night.weekly_overlap':'האם אותן שעות כבר סווגו כשעות נוספות שבועיות או קיבלו גמול אחר? אין לסכום את הגמולים פעמיים.',
 'night.payroll_allocation':'יש לאמת שהכמויות והתעריפים שנבחרו משייכים את התשלום למקטע הזה, ללא כפל בסיס ותוספת וללא רכיבים חסרים.',
 'night.rounding':'יש לאמת את שיטת עיגול השכר. כאן מוצג מועמד בעיגול חצי כלפי מעלה בסך היומי ובכל קבוצת תעריף משויכת.',
});
export type NightEntitlementMissing=Readonly<{dependency_id:string;state:string;question:string}>;
const hhmm=/^(0?\d|[1-9]\d{1,2}):([0-5]\d)$/u;
const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/u;
function minutes(raw:string){const m=hhmm.exec(raw);if(!m)throw Error('NIGHT_ENTITLEMENT_DURATION_FORMAT');return Number(m[1])*60+Number(m[2]);}
function renderedMinutes(value:number){return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;}
function requireSameSource(a:DocumentReviewSource,b:DocumentReviewSource){
 if(a.document_id!==b.document_id||a.version_id!==b.version_id||a.file_sha256!==b.file_sha256||a.page!==b.page||a.reading_receipt_sha256!==b.reading_receipt_sha256)throw Error('NIGHT_ENTITLEMENT_INTERVAL_SOURCE');
}
function intervalReading(interval:NightEntitlementInterval){
 if(!/^\d{4}-\d{2}-\d{2}$/u.test(interval.date)||!clock.test(interval.start_time)||!clock.test(interval.end_time))throw Error('NIGHT_ENTITLEMENT_CLOCK_FORMAT');
 const p=interval.printed_presence;
 if(p.state!=='observed'||p.printed_value===null||p.representation!=='hours_minutes'||p.quantity_unit!=='hours')return null;
 requireSameSource(interval.clock_source,p.source);
 const duration=minutes(p.printed_value);
 if(duration<=0||duration>36*60)throw Error('NIGHT_ENTITLEMENT_DURATION_RANGE');
 // Date rollover is proved by the source duration plus both clock cells. An
 // asterisk, a bare end-before-start comparison, or a model guess is not used.
 const start=Date.parse(`${interval.date}T${interval.start_time}:00+03:00`);
 if(!Number.isFinite(start)||new Date(start+3*3600000).toISOString().slice(0,10)!==interval.date)throw Error('NIGHT_ENTITLEMENT_DATE');
 const end=start+duration*60000,localEnd=new Date(end+3*3600000).toISOString();
 if(localEnd.slice(11,16)!==interval.end_time)throw Error('NIGHT_ENTITLEMENT_CLOCK_DURATION_MISMATCH');
 let nightMinutes=0;
 // Bounded minute arithmetic is only a source-time representation transform;
 // rate selection, tier quantities, expected pay and subtraction run in RuleSpec.
 for(let at=start;at<end;at+=60000){const hour=new Date(at+3*3600000).getUTCHours();if(hour>=22||hour<6)nightMinutes++;}
 const seed={schema_version:'source-clock-interval-v1',interval_id:interval.id,date:interval.date,start_time:interval.start_time,end_time:interval.end_time,
  clock_source:interval.clock_source,printed_presence:p,end_date:localEnd.slice(0,10),minutes:duration,night_minutes:nightMinutes,
  classification:interval.classification,rollover_basis:'printed_duration_and_both_clocks',timezone:'Asia/Jerusalem',utc_offset:'+03:00'};
 return {...seed,start,end,reading_sha256:canonicalSha256(seed)};
}
function supportedNumber(operand:DocumentReviewOperand,kind:'money'|'hours'|'percent'){
 if(kind==='money'&&(operand.representation!=='money_ils'||operand.quantity_unit!==null))throw Error('NIGHT_ENTITLEMENT_MONEY_UNIT');
 if(kind==='hours'&&(!['hours_minutes','decimal_quantity'].includes(operand.representation)||operand.quantity_unit!=='hours'))throw Error('NIGHT_ENTITLEMENT_HOURS_UNIT');
 if(kind==='percent'&&(operand.representation!=='percent'||operand.quantity_unit!=='ratio'))throw Error('NIGHT_ENTITLEMENT_PERCENT_UNIT');
 if(operand.printed_value!==null&&operand.printed_value.startsWith('-'))throw Error('NIGHT_ENTITLEMENT_NEGATIVE_SOURCE');
}
function allocationHours(operand:DocumentReviewOperand){
 if(!['observed','declared'].includes(operand.state)||operand.printed_value===null)return null;
 if(operand.representation==='hours_minutes')return {n:BigInt(minutes(operand.printed_value)),d:BigInt(60)};
 const m=/^(0|[1-9]\d{0,5})(?:\.(\d{1,8}))?$/u.exec(operand.printed_value);
 if(!m)throw Error('NIGHT_ENTITLEMENT_ALLOCATION_QUANTITY');
 return {n:BigInt(m[1]+(m[2]??'')),d:BigInt(10)**BigInt(m[2]?.length??0)};
}

/** The ordinary review input path selects this versioned constructor. It emits
 * normal calculation inputs and exact missing dependencies, never findings or
 * a completed report. All final monetary arithmetic uses the existing engine. */
export function resolveDocumentReviewNightEntitlement(input:NightEntitlementInput){
 if(input.catalog_id!==NIGHT_ENTITLEMENT_CATALOG.catalog_id||input.catalog_version!==NIGHT_ENTITLEMENT_CATALOG.catalog_version)throw Error('NIGHT_ENTITLEMENT_CATALOG_VERSION');
 if(input.period.from<NIGHT_ENTITLEMENT_CATALOG.supported_work_period.from||input.period.to>NIGHT_ENTITLEMENT_CATALOG.supported_work_period.to||input.period.to<input.period.from)throw Error('NIGHT_ENTITLEMENT_RESEARCH_PERIOD');
 if(input.intervals.length>8||input.payroll_allocations.length>8)throw Error('NIGHT_ENTITLEMENT_SOURCE_BOUND');
 if(new Set(input.intervals.map(i=>i.id)).size!==input.intervals.length||new Set(input.payroll_allocations.map(i=>i.id)).size!==input.payroll_allocations.length)throw Error('NIGHT_ENTITLEMENT_DUPLICATE_ROW');
 const allocationIdentities=input.payroll_allocations.map(a=>canonicalSha256({observation_id:a.hours.observation_id,source:a.hours.source}));
 if(new Set(allocationIdentities).size!==allocationIdentities.length)throw Error('NIGHT_ENTITLEMENT_ALLOCATION_DUPLICATE_SOURCE');
 const missing:NightEntitlementMissing[]=[];
 if(!input.intervals.length)missing.push({dependency_id:'night.dated_attendance',state:'missing',question:'יש לצרף נוכחות מתוארכת ובה שעות כניסה, יציאה והפסקות. סך שעות בתלוש לבדו אינו מזהה יום עבודה לילי.'});
 const readings=input.intervals.map(intervalReading);
 if(readings.some(r=>r===null))missing.push({dependency_id:'night.interval_duration',state:'missing',question:'יש לאמת את תאריך המקטע, שעות הכניסה והיציאה ומשך הנוכחות המקורי. לא הושלם תאריך מעבר חצות מתוך ניחוש.'});
 const valid=readings.filter((r):r is NonNullable<typeof r>=>r!==null).sort((a,b)=>a.start-b.start);
 for(const [i,r]of valid.entries()){
  if(r.date<input.period.from||r.end_date>input.period.to)throw Error('NIGHT_ENTITLEMENT_INTERVAL_PERIOD');
  if(i>0&&r.start<valid[i-1].end)throw Error('NIGHT_ENTITLEMENT_INTERVAL_OVERLAP');
 }
 if(valid.length&&valid[valid.length-1].end-valid[0].start>36*3600000)throw Error('NIGHT_ENTITLEMENT_MULTIPLE_WORKDAYS');
 if(!input.payroll_allocations.length)missing.push({dependency_id:'night.payroll_amount',state:'missing',question:'יש לזהות את התשלום המשויך לאותן שעות ואת התעריפים; אין להשתמש בברוטו החודשי כתחליף.'});
 const decisions:NightEntitlementDecision[]=Object.keys(NIGHT_ENTITLEMENT_DEPENDENCIES).map(decision_id=>input.applicability.find(d=>d.decision_id===decision_id)??{
  decision_id,state:'missing',basis:'ai_source_assessment',explanation:NIGHT_ENTITLEMENT_DEPENDENCIES[decision_id as keyof typeof NIGHT_ENTITLEMENT_DEPENDENCIES],
  sources:[nightEntitlementLegalSource(decision_id==='night.coverage'||decision_id==='night.workday'?1:4,decision_id)],valid_until:null});
 if(new Set(input.applicability.map(d=>d.decision_id)).size!==input.applicability.length||input.applicability.some(d=>!(d.decision_id in NIGHT_ENTITLEMENT_DEPENDENCIES)))throw Error('NIGHT_ENTITLEMENT_DECISION_SET');
 const unresolved=input.intervals.some(i=>i.classification==='unresolved_rest');
 if(unresolved){
  const index=decisions.findIndex(d=>d.decision_id==='night.breaks'),d=decisions[index];
  if(d.state==='accepted')throw Error('NIGHT_ENTITLEMENT_REST_CLASSIFICATION_UNRESOLVED');
 }
 if(input.mode==='all_presence_is_work_scenario'&&(!unresolved||!input.conditional_assumptions?.some(a=>a.decision_id==='night.breaks')))throw Error('NIGHT_ENTITLEMENT_EXPLICIT_REST_HYPOTHESIS_REQUIRED');
 if(input.mode==='source_classified'&&unresolved)missing.push({dependency_id:'night.breaks',state:'unknown',question:NIGHT_ENTITLEMENT_DEPENDENCIES['night.breaks']});
 for(const decision of decisions)if(decision.state!=='accepted')missing.push({dependency_id:decision.decision_id,state:decision.state,question:NIGHT_ENTITLEMENT_DEPENDENCIES[decision.decision_id as keyof typeof NIGHT_ENTITLEMENT_DEPENDENCIES]});
 const eligible=valid.filter(r=>r.classification==='work'||(input.mode==='all_presence_is_work_scenario'&&r.classification==='unresolved_rest'));
 if(valid.length&&!eligible.length)missing.push({dependency_id:'night.actual_work',state:'missing',question:'לא זוהו שעות עבודה בתוך המקטע; נוכחות או מנוחה אינן מסווגות אוטומטית כעבודה.'});
 if(eligible.length&&eligible.reduce((n,r)=>n+r.night_minutes,0)<120)missing.push({dependency_id:'night.two_hours',state:'unknown',question:'לא הוכחו לפחות שעתיים של עבודה בין 22:00 ל־06:00; כלל יום העבודה הלילי אינו מתאים לנתונים האלה.'});
 const hardMissing=missing.some(m=>!Object.hasOwn(NIGHT_ENTITLEMENT_DEPENDENCIES,m.dependency_id))||(input.mode==='source_classified'&&unresolved);
 if(hardMissing){
  // Ask for the decisive source before asking case-specific legal questions
  // that cannot yet be grounded in an identified workday.
  const decisive=missing.filter(m=>!Object.hasOwn(NIGHT_ENTITLEMENT_DEPENDENCIES,m.dependency_id)||(input.mode==='source_classified'&&unresolved&&m.dependency_id==='night.breaks'));
  return deepFreeze({catalog:NIGHT_ENTITLEMENT_CATALOG,state:'missing_source' as const,check:null,missing:decisive,temporal_transformations:valid});
 }
 let allocatedHours={n:BigInt(0),d:BigInt(1)};
 for(const a of input.payroll_allocations){
  const h=allocationHours(a.hours);if(h)allocatedHours={n:allocatedHours.n*h.d+h.n*allocatedHours.d,d:allocatedHours.d*h.d};
  if(a.percentage?.printed_value!==null&&a.percentage?.printed_value!==undefined&&['observed','declared'].includes(a.percentage.state)){
   const percentage=Number(a.percentage.printed_value);
   if(!Number.isFinite(percentage)||percentage<100)throw Error('NIGHT_ENTITLEMENT_OVERLAPPING_PREMIUM_NOT_FULL_PAY');
  }
 }
 if(allocatedHours.n*BigInt(60)>BigInt(valid.reduce((n,r)=>n+r.minutes,0))*allocatedHours.d)throw Error('NIGHT_ENTITLEMENT_ALLOCATED_HOURS_OVERLAP');
 supportedNumber(input.hourly_wage,'money');
 const operands:DocumentReviewOperand[]=[],facts:RuleSpecDraft['facts'][number][]=[],bindings:Candidate['fact_bindings']=[],nodes:RuleSpecDraft['nodes'][number][]=[];
 const addFact=(operand:DocumentReviewOperand)=>{
  const prior=operands.find(o=>o.id===operand.id);
  if(prior){if(canonicalSha256(prior)!==canonicalSha256(operand))throw Error('NIGHT_ENTITLEMENT_OPERAND_ID_REUSED');return `fact.${operand.id}`;}
  operands.push(operand);const ref_id=`fact.${operand.id}`;
  facts.push({ref_id,value_kind:operand.representation==='money_ils'?'money':'rational',unit:operand.representation==='money_ils'?'currency.ils':operand.quantity_unit});bindings.push({ref_id,operand_id:operand.id});return ref_id;
 };
 const wageRef=addFact(input.hourly_wage);
 const presenceRefs:string[]=[],nightRefs:string[]=[];
 for(const [index,r]of eligible.entries()){
  const source={...r.clock_source,locator:`${r.clock_source.locator}; ${r.date} ${r.start_time}–${r.end_date} ${r.end_time}; duration ${r.printed_presence.printed_value}; transform ${r.reading_sha256}`};
  const base={...r.printed_presence,source,observation_id:`interval.${r.reading_sha256}`,precision:'source_exact' as const};
  presenceRefs.push(addFact({...base,id:`night.presence.${index}`,printed_value:renderedMinutes(r.minutes)}));
  nightRefs.push(addFact({...base,id:`night.overlap.${index}`,printed_value:renderedMinutes(r.night_minutes),observation_id:`night-overlap.${r.reading_sha256}`}));
 }
 nodes.push({node_id:'night.hours',operation:'aggregate.bounded',refs:presenceRefs},{node_id:'night.overlap',operation:'aggregate.bounded',refs:nightRefs},
  {node_id:'night.qualifies',operation:'compare.gte',left_ref:'night.overlap',right_ref:'parameter.night.minimum'},
  {node_id:'night.zero',operation:'constant.rational',value:'0',unit:'hours'},{node_id:'night.hour.unit',operation:'constant.rational',value:'1',unit:'hours'},
  {node_id:'night.regular.hours',operation:'min',refs:['night.hours','parameter.daily.threshold']},
  {node_id:'night.excess',operation:'subtract',left_ref:'night.hours',right_ref:'parameter.daily.threshold'},
  {node_id:'night.overtime',operation:'max',refs:['night.excess','night.zero']},
  {node_id:'night.first.hours',operation:'min',refs:['night.overtime','parameter.first.hours']},
  {node_id:'night.later.hours',operation:'subtract',left_ref:'night.overtime',right_ref:'night.first.hours'},
  {node_id:'night.first.weighted',operation:'multiply',left_ref:'night.first.hours',right_ref:'parameter.first.rate'},
  {node_id:'night.later.weighted',operation:'multiply',left_ref:'night.later.hours',right_ref:'parameter.later.rate'},
  {node_id:'night.weighted.hours',operation:'add',refs:['night.regular.hours','night.first.weighted','night.later.weighted']},
  {node_id:'night.wage.factor',operation:'divide',left_ref:'night.weighted.hours',right_ref:'night.hour.unit'},
  {node_id:'night.required',operation:'money.scale',money_ref:wageRef,rational_ref:'night.wage.factor',rounding:'half_up'});
 // Group the document's disjoint bands by the actual sourced rate before
 // rounding; otherwise splitting a band changes allocated pay by an agorah.
 const groups=new Map<string,string[]>();
 for(const [index,a]of input.payroll_allocations.entries()){
  supportedNumber(a.hours,'hours');supportedNumber(a.hourly_rate,'money');if(a.percentage)supportedNumber(a.percentage,'percent');
  const hoursRef=addFact(a.hours),rateRef=addFact(a.hourly_rate);let weighted=hoursRef;
  if(a.percentage){weighted=`night.allocation.${index}.weighted`;nodes.push({node_id:weighted,operation:'multiply',left_ref:hoursRef,right_ref:addFact(a.percentage)});}
  const prior=groups.get(rateRef)??[];prior.push(weighted);groups.set(rateRef,prior);
 }
 const allocatedRefs:string[]=[];
 for(const [index,[rate,refs]]of [...groups].entries()){
  const prefix=`night.allocated.${index}`;nodes.push({node_id:prefix+'.hours',operation:'aggregate.bounded',refs},
   {node_id:prefix+'.factor',operation:'divide',left_ref:prefix+'.hours',right_ref:'night.hour.unit'},
   {node_id:prefix+'.pay',operation:'money.scale',money_ref:rate,rational_ref:prefix+'.factor',rounding:'half_up'});allocatedRefs.push(prefix+'.pay');
 }
 nodes.push({node_id:'night.recorded.allocation',operation:'aggregate.bounded',refs:allocatedRefs},
  {node_id:'night.difference',operation:'subtract',left_ref:'night.required',right_ref:'night.recorded.allocation'});
 const parameterDefs=[['night.minimum','2','hours',1,'1: at least two working hours in night window'],['daily.threshold','7','hours',1,'2(b): seven-hour night workday'],
  ['first.hours','2','hours',4,'16(a): first two overtime hours'],['first.rate','125','ratio',4,'16(a): 1¼ regular wage'],['later.rate','150','ratio',4,'16(a): 1½ regular wage']] as const;
 const parameterBindings:Candidate['parameter_bindings']=[],parameters:RuleSpecDraft['parameters'][number][]=[];
 for(const [key,value,unit,page,locator]of parameterDefs){
  const id='legal.'+key;operands.push({id,observation_id:`law.${key}`,state:'observed',printed_value:value,representation:unit==='ratio'?'percent':'decimal_quantity',quantity_unit:unit,precision:'source_exact',source:nightEntitlementLegalSource(page,locator)});
  parameterBindings.push({ref_id:'parameter.'+key,operand_id:id});parameters.push({ref_id:'parameter.'+key,parameter_id:'il.review.night.'+key,parameter_version:'1.0.0',value_kind:'rational',unit});
 }
 const rule=createRuleSpecPackage({schema_version:'tivdoc-rulespec-v0.6.0',rule_spec_id:NIGHT_ENTITLEMENT_CATALOG.rule_spec_id,rule_spec_version:NIGHT_ENTITLEMENT_CATALOG.rule_spec_version,
  topic:'working_time',catalog_boundary:'real_inactive',source_version_ids:[NIGHT_ENTITLEMENT_SOURCE_REVIEW.source_version_id],effective_period:NIGHT_ENTITLEMENT_CATALOG.supported_work_period,
  sectors:['general_conditionally_assessed'],populations:['adult_hourly_conditionally_assessed'],facts,parameters,nodes,output_ref:'night.difference',
  golden_case_set_sha256:canonicalSha256({independent_synthetic_vectors:[{worked_hours:10,wage_minor:4000,required_minor:44000,allocated_minor:40000,gap_minor:4000},{worked_hours:10,wage_minor:4000,required_minor:44000,allocated_minor:44000,gap_minor:0}]}),
  resource_policy:{max_steps:128,max_depth:32,max_aggregate_items:32,max_integer_digits:64}});
 const source_manifest=[...input.source_manifest];
 const law=source_manifest.find(s=>s.document_id===NIGHT_ENTITLEMENT_LEGAL_MANIFEST.document_id);
 if(law&&canonicalSha256(law)!==canonicalSha256(NIGHT_ENTITLEMENT_LEGAL_MANIFEST))throw Error('NIGHT_ENTITLEMENT_LEGAL_SOURCE_PIN');
 if(!law)source_manifest.push(NIGHT_ENTITLEMENT_LEGAL_MANIFEST);
 const calculation=documentReviewCalculationInputSchema.parse({schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:input.run_id,check_id:input.check_id,
  period:input.period,evaluated_at:input.evaluated_at,source_manifest,operands,remittance_status:'not_assessed',operation:{kind:'candidate_rule',rule,fact_bindings:bindings,parameter_bindings:parameterBindings,
   required_decision_ids:Object.keys(NIGHT_ENTITLEMENT_DEPENDENCIES),decisions,expected_output_ref:'night.required',recorded_ref:null,
   comparison:{schema_version:'candidate-comparison-v1',expected_ref:'night.required',recorded_ref:'night.recorded.allocation',difference_ref:'night.difference',recorded_basis:'document_allocation'},
   execution_preconditions:['night.qualifies'],
   ...(input.conditional_assumptions?{conditional_assumptions:input.conditional_assumptions}:{})}});
 const scenario=input.mode==='all_presence_is_work_scenario';
 return deepFreeze({catalog:NIGHT_ENTITLEMENT_CATALOG,state:'candidate' as const,missing,temporal_transformations:valid,
  check:{check_id:input.check_id,topic:'working_time' as const,title:scenario?'אם כל המקטע הוא זמן עבודה: גמול יום עבודה לילי':'גמול יום עבודה לילי — חישוב מותנה',
   explanation:(scenario?'השעות הן משך הנוכחות בתרחיש בלבד; לא נקבע שמקטעי המנוחה היו עבודה. ':'')+'הדרישה מחושבת מחדש לפי 7 שעות רגילות, שעתיים נוספות ב־125% והיתרה ב־150%. ההשוואה היא להקצאת שכר מהכמויות והתעריפים במסמכים, ולא להוכחת תשלום בפועל. ההנחות ותנאי התחולה מפורטים בנפרד; אין לסכום עם גמול שבועי או מנוחה.',calculation}});
}
