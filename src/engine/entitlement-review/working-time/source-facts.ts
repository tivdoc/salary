import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import {nonPayslipEffectiveReadingSha} from '../../document-review/non-payslip.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';
import {normalizeMoney} from '../../extraction/normalization.ts';
import type {NonPayslipReadingDependency} from '../automatic-nonpay.ts';
import {workingTimeEntitlementInputSchema,type WorkingTimeEntitlementInput} from './contracts.ts';
import {WORKING_TIME_PRODUCT_FACTS_POLICY} from './product-fact-contracts.ts';
import {workingTimeAssignmentIntervalSha256} from './product-decisions.ts';

export const WORKING_TIME_SOURCE_FACTS_POLICY='working-time-identified-source-facts-v1' as const;
const weekdays=['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
type Literal={kind:'week';days:5|6}|{kind:'weekdays';days:number[]}|{kind:'limit';weekday:number;duration:string}|{kind:'wage';minor:number;composition:'total_rate_including_all_regular_supplements'|'single_rate_no_regular_supplements'}|{kind:'assignment';date:string;clocks:{start_at:string;end_at:string}[]};
/** Whole literal clauses only. A candidate match selects an existing reading
 * request; it never establishes a value before that reading is identified. */
export function workingTimeLiteralClause(text:string):Literal|null{
 const value=text.trim().replace(/^\d+(?:\.\d+)*[.)]?\s+/u,'').replace(/[.]$/u,'');
 const week=/^שבוע העבודה (?:הוא|הינו|יהיה) בן (5|חמישה|6|שישה) ימים$/u.exec(value);if(week)return {kind:'week',days:['5','חמישה'].includes(week[1])?5:6};
 const days=/^ימי העבודה הקבועים הם (.+)$/u.exec(value);if(days){const list=days[1].split(/,\s*/u).map(d=>weekdays.indexOf(d));if(list.length>=5&&list.length<=6&&list.every(n=>n>=0)&&new Set(list).size===list.length)return {kind:'weekdays',days:list};return null;}
 const limit=/^שעות התקן ביום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת) הן (\d{1,2}:[0-5]\d)$/u.exec(value);if(limit)return {kind:'limit',weekday:weekdays.indexOf(limit[1]),duration:limit[2]};
 const wage=/^השכר הרגיל לשעה הוא (\d+(?:\.\d{1,2})?) (?:ש״ח|ש"ח|ILS),? (וכולל את כל תוספות השכר הרגילות|ואין רכיבי שכר רגילים נוספים)$/u.exec(value);
 if(wage){const amount=normalizeMoney(wage[1],'ILS');if(amount&&amount.minor_units>0)return {kind:'wage',minor:amount.minor_units,composition:wage[2].startsWith('וכולל')?'total_rate_including_all_regular_supplements':'single_rate_no_regular_supplements'};return null;}
 const assignment=/^משמרת אחת בתאריך (\d{4}-\d{2}-\d{2}): (.+)$/u.exec(value);if(assignment){const clocks=[];for(const raw of assignment[2].split('; ')){const m=/^(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d) עד (\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d)$/u.exec(raw);if(!m)return null;clocks.push({start_at:m[1]+'T'+m[2]+':00+03:00',end_at:m[3]+'T'+m[4]+':00+03:00'});}return clocks.length>0&&clocks.length<=8?{kind:'assignment',date:assignment[1],clocks}:null;}
 return null;
}
function own(source:DocumentReviewSource|null|undefined){if(!source)return false;try{return JSON.parse(source.locator).schema_version===WORKING_TIME_SOURCE_FACTS_POLICY;}catch{return false;}}
/** Stable through answer materialization: relevant immutable contract pins are
 * present before their identified temporal association can be produced. */
export function workingTimeProductSourcePins(review:DocumentReviewInput,input:WorkingTimeEntitlementInput){
 const ids=new Set(input.source_manifest.filter(m=>m.kind==='case_document').map(m=>m.document_id));
 for(const record of review.non_payslip_evidence??[])if(record.document.case_id===input.case_id&&record.extraction?.observations.some(o=>workingTimeLiteralClause(o.original.raw_value??'')!==null))ids.add(record.document.document_id);
 return review.documents.filter(d=>ids.has(d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})).sort((a,b)=>canonicalSha256(a).localeCompare(canonicalSha256(b)));
}
/** Deterministic source association, not legal interpretation. The same source
 * policy is replayed during admission, and no absent clause means no supplement. */
export function attachWorkingTimeSourceFacts(candidate:WorkingTimeEntitlementInput,review:DocumentReviewInput){
 const input=workingTimeEntitlementInputSchema.parse(candidate),result=structuredClone(input),p=result.product_facts;
 const reading_dependencies:NonPayslipReadingDependency[]=[],missing={state:'missing' as const,value:null,source:null};
 if(p?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY)return {input:result,reading_dependencies};
 if(review.case_id!==input.case_id||canonicalSha256(review.period)!==canonicalSha256(input.period))throw Error('WT_SOURCE_FACT_SCOPE');
 if(own(result.arrangement.source))result.arrangement=structuredClone(missing);if(own(result.scheduled_weekdays.source))result.scheduled_weekdays=structuredClone(missing);
 if(own(p.regular_wage_basis?.source))p.regular_wage_basis=structuredClone(missing);
 p.assignment_witnesses=(p.assignment_witnesses??[]).filter(w=>!own(w.fact.source));
 for(const day of result.workdays)if(own(day.ordinary_limit.source))day.ordinary_limit={...day.ordinary_limit,state:'missing',printed_value:null};
 const found:{literal:Literal;source:DocumentReviewSource}[]=[];
 for(const raw of review.non_payslip_evidence??[]){
  const record=savedNonPayslipEvidenceSchema.parse(raw),e=record.extraction;if(!e||e.detected_document_type!==record.document.document_type)continue;
  const document=review.documents.find(d=>d.document_id===record.document.document_id&&d.version_id===record.document.document_id);
  if(record.document.case_id!==input.case_id||!document||document.file_sha256!==record.document.content_sha256||document.reading_sha256!==nonPayslipEffectiveReadingSha(record)||document.page_count!==e.physical_page_count)throw Error('WT_SOURCE_FACT_RECORD_BINDING');
  const reads=new Map(record.readings.filter(r=>r.target.month===input.period.from.slice(0,7)).map(r=>[r.target.observation.observation_id,r])),pending:string[]=[];
  const identifiedValue=(id:string)=>{const r=reads.get(id);return r?.state==='identified_reading'?r.value:null;};
  const starts=e.observations.filter(o=>o.original.semantic==='effective_from'||o.original.semantic==='period_start'),ends=e.observations.filter(o=>o.original.semantic==='effective_to'||o.original.semantic==='period_end');
  const from=starts.length===1?identifiedValue(starts[0].observation_id):null,to=ends.length===1?identifiedValue(ends[0].observation_id):null;
  const explicitPeriod=from?.kind==='iso_date'&&to?.kind==='iso_date'&&from.value<=input.period.from&&to.value>=input.period.to;
  const adversePeriod=starts.length>1||ends.length>1||from?.kind==='iso_date'&&from.value>input.period.from||to?.kind==='iso_date'&&to.value<input.period.to;
  const declaredCurrent=p.contract_terms_current.state==='declared'&&p.contract_terms_current.value===true&&p.contract_terms_current.source?.reading==='customer_declaration';
  for(const o of e.observations){
   if(!['clause_text','source_label'].includes(o.original.semantic)||o.issues.includes('duplicate_source_cell'))continue;
   const read=reads.get(o.observation_id),v=read?.state==='identified_reading'?read.value:null,literal=v?.kind==='text'?workingTimeLiteralClause(v.value):null;
   const candidateLiteral=workingTimeLiteralClause(o.original.raw_value??'');
   // Bind the factual current-terms question to this exact contract even while
   // the clause or its temporal context still awaits an identified reading.
   if((literal||candidateLiteral)&&!result.source_manifest.some(d=>d.document_id===document.document_id))result.source_manifest.push({document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page_count:e.physical_page_count,kind:'case_document',case_id:input.case_id});
   if(!read&&candidateLiteral)pending.push(o.observation_id);
   if(!literal)continue;
   const datedAssignment=literal.kind==='assignment'&&literal.date>=input.period.from&&literal.date<=input.period.to;
   if(!datedAssignment&&adversePeriod)continue;
   if(!datedAssignment&&!explicitPeriod&&!(record.document.document_type==='contract'&&declaredCurrent)){
    for(const d of [...starts,...ends])if(!reads.has(d.observation_id)&&d.original.raw_value!==null)pending.push(d.observation_id);continue;
   }
   const used=[o,...(explicitPeriod?[...starts,...ends]:[])];
   const locator={schema_version:WORKING_TIME_SOURCE_FACTS_POLICY,source_sha256:canonicalSha256(used.map(x=>({observation_id:x.observation_id,original_sha256:x.original_sha256,reading_sha256:reads.get(x.observation_id)?.verification_sha256}))),
    period:input.period,temporal_assertion_sha256:!explicitPeriod&&!datedAssignment?canonicalSha256(p.contract_terms_current):null};
   const source:DocumentReviewSource={document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:o.original.page,locator:JSON.stringify(locator),label:'קשר מפורש שנקרא בסעיף המקור',reading:'identified_document_reading',reading_receipt_sha256:document.reading_sha256};
   found.push({literal,source});
   if(!result.source_manifest.some(d=>d.document_id===source.document_id))result.source_manifest.push({document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:e.physical_page_count,kind:'case_document',case_id:input.case_id});
  }
  if(pending.length)reading_dependencies.push({version_id:document.version_id,product_document_id:record.product_document_id,checkpoint_sha256:record.checkpoint_result_sha256!,normalized_sha256:canonicalSha256(e),observation_ids:[...new Set(pending)],dependent_check_ids:result.workdays.flatMap(d=>[result.check_id_prefix+'.'+d.id,...(result.calculation_policy?[result.check_id_prefix+'.'+d.id+'.expected']:[])])});
 }
 const weeks=found.filter(v=>v.literal.kind==='week'),schedules=found.filter(v=>v.literal.kind==='weekdays'),wages=found.filter(v=>v.literal.kind==='wage');
 if(result.arrangement.state==='missing'&&weeks.length){const w=weeks[0];if(w.literal.kind==='week')result.arrangement={state:weeks.length===1?'observed':'conflict',value:weeks.length===1?(w.literal.days===5?'adult_hourly_five_day_42':'adult_hourly_six_day_42'):null,source:w.source};}
 if(result.scheduled_weekdays.state==='missing'&&schedules.length){const s=schedules[0];if(s.literal.kind==='weekdays')result.scheduled_weekdays={state:schedules.length===1?'observed':'conflict',value:schedules.length===1?s.literal.days:null,source:s.source};}
 if((!p.regular_wage_basis||p.regular_wage_basis.state==='missing')&&wages.length){const w=wages[0],rate=result.regular_hourly_wage;
  const amount=rate.state==='observed'&&rate.source.reading==='identified_document_reading'&&rate.representation==='money_ils'&&rate.quantity_unit===null&&rate.printed_value!==null?normalizeMoney(rate.printed_value,'ILS'):null;
  if(w.literal.kind==='wage'&&amount)p.regular_wage_basis={state:wages.length===1&&amount.minor_units===w.literal.minor?'observed':'conflict',value:wages.length===1&&amount.minor_units===w.literal.minor?{period:input.period,hourly_wage_operand_sha256:canonicalSha256(rate),composition:w.literal.composition}:null,source:w.source};
 }
 for(const day of result.workdays){
  const limits=found.filter(v=>v.literal.kind==='limit'&&v.literal.weekday===new Date(day.date+'T00:00:00Z').getUTCDay());
  if(day.ordinary_limit.state==='missing'&&limits.length){const l=limits[0];if(l.literal.kind==='limit')day.ordinary_limit={...day.ordinary_limit,observation_id:'wt.source.limit.'+canonicalSha256(l.source),state:limits.length===1?'observed':'conflict',printed_value:limits.length===1?l.literal.duration:null,representation:'hours_minutes',quantity_unit:'hours',source:l.source};}
  const assignments=found.filter(v=>v.literal.kind==='assignment'&&v.literal.date===day.date);
  if(assignments.length&&!p.assignment_witnesses.some(w=>w.day_id===day.id)){const a=assignments[0];if(a.literal.kind==='assignment'){
   const equal=assignments.length===1&&canonicalSha256(a.literal.clocks)===canonicalSha256(day.intervals.map(i=>({start_at:i.start_at,end_at:i.end_at})));
   p.assignment_witnesses.push({day_id:day.id,fact:{state:equal?'observed':'conflict',value:equal?{assigned_date:day.date,assignment:'same_workday',intervals:day.intervals.map(i=>({interval_id:i.id,source_interval_sha256:workingTimeAssignmentIntervalSha256(i)}))}:null,source:a.source}});
  }}
 }
 return {input:workingTimeEntitlementInputSchema.parse(result),reading_dependencies};
}
export function assertWorkingTimeSourceFacts(input:WorkingTimeEntitlementInput,review:DocumentReviewInput){
 if(input.product_facts?.schema_version!==WORKING_TIME_PRODUCT_FACTS_POLICY)return;
 const replay=attachWorkingTimeSourceFacts(input,review).input;
 const check=(before:unknown,after:unknown)=>{if(canonicalSha256(before??null)!==canonicalSha256(after??null))throw Error('WT_SOURCE_FACT_REPLAY');};
 if(own(input.arrangement.source))check(input.arrangement,replay.arrangement);
 if(own(input.scheduled_weekdays.source))check(input.scheduled_weekdays,replay.scheduled_weekdays);
 if(input.product_facts?.regular_wage_basis?.state==='observed'&&!own(input.product_facts.regular_wage_basis.source))throw Error('WT_REGULAR_BASIS_PRODUCER_REQUIRED');
 if(own(input.product_facts?.regular_wage_basis?.source))check(input.product_facts?.regular_wage_basis,replay.product_facts?.regular_wage_basis);
 for(const w of input.product_facts?.assignment_witnesses??[]){if(w.fact.state==='observed'&&!own(w.fact.source))throw Error('WT_ASSIGNMENT_PRODUCER_REQUIRED');if(own(w.fact.source))check(w,replay.product_facts?.assignment_witnesses?.find(x=>x.day_id===w.day_id));}
 for(const [i,d]of input.workdays.entries())if(own(d.ordinary_limit.source))check(d.ordinary_limit,replay.workdays[i].ordinary_limit);
}
export function isWorkingTimeProducedSource(source:DocumentReviewSource|null|undefined){return own(source);}
