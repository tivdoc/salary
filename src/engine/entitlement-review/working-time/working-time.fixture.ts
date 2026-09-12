import type {DocumentReviewOperand,DocumentReviewSource} from '../../document-review/calculations.ts';
import {WORKING_TIME_APPLICABILITY} from './resolve.ts';
import type {WorkingTimeEntitlementInput,WorkingTimeSourceFact,WorkingTimeWorkday} from './contracts.ts';

export function source(label='Synthetic source'):DocumentReviewSource{return {document_id:'synthetic.attendance',version_id:'synthetic.v1',file_sha256:'a'.repeat(64),page:1,
 locator:label,label,reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};}
export function fact<T>(value:T):WorkingTimeSourceFact<T>{return {state:'observed',value,source:source('Synthetic factual reading')};}
export function operand(id:string,value:string|null,kind:'money'|'hours'|'percent'='hours'):DocumentReviewOperand{return {id,observation_id:'observation.'+id,state:value===null?'missing':'observed',printed_value:value,
 representation:kind==='money'?'money_ils':kind==='percent'?'percent':'hours_minutes',quantity_unit:kind==='money'?null:kind==='percent'?'ratio':'hours',precision:'source_exact',source:source('Cell '+id)};}
export function workday(index:number,hours:number):WorkingTimeWorkday{
 const date=`2026-06-${String(7+index).padStart(2,'0')}`,id=`day.${index}`;
 return {id,date,kind:fact(index===5?'pre_rest':'ordinary'),inventory:fact(hours?'complete_work':'no_work'),no_work_credit:fact('no_credit'),
  intervals:hours?[{id:`interval.${index}`,start_at:date+'T08:00:00+03:00',end_at:date+`T${String(8+hours).padStart(2,'0')}:00:00+03:00`,
   printed_duration:operand('duration.'+index,`${hours}:00`),clock_source:source('Cell duration.'+index),classification:fact('worked')}]:[],
  ordinary_limit:operand('limit.'+index,index===5?'7:00':'8:00'),recorded_pay:hours?operand('pay.'+index,String(hours*40),'money'):null,
  payment_allocation:fact('full_pay_for_workday')};
}
export function weekInput(hours=[10,10,10,10,10,8,0]):WorkingTimeEntitlementInput{
 const workdays=hours.map((h,i)=>workday(i,h));
 return {schema_version:'working-time-entitlement-input-v1',catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_id_prefix:'working.synthetic',
  period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',source_manifest:[{document_id:'synthetic.attendance',version_id:'synthetic.v1',file_sha256:'a'.repeat(64),page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  arrangement:fact('adult_hourly_six_day_42'),scheduled_weekdays:fact([0,1,2,3,4,5]),week_start:'2026-06-07',week_inventory:fact('complete'),workdays,
  rest_window:fact({start_at:'2026-06-13T00:00:00+03:00',end_at:'2026-06-14T12:00:00+03:00'}),regular_hourly_wage:operand('wage','40.00','money'),
  applicability:[...Object.keys(WORKING_TIME_APPLICABILITY).filter(id=>id!=='wt.non_rest_scope'),...workdays.map(d=>'wt.worked_time.'+d.id)].map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic explicit policy decision; no human signature or real activation.',sources:[source()],valid_until:null})),mode:'source_classified'};
}
export function singleDay(night=false):WorkingTimeEntitlementInput{
 const input=weekInput(),day=input.workdays[0];
 if(night)day.intervals=[{...day.intervals[0],start_at:'2026-06-07T22:00:00+03:00',end_at:'2026-06-08T08:00:00+03:00'}];
 input.workdays=[day];input.week_inventory=fact('partial');input.applicability=input.applicability.filter(d=>!d.decision_id.startsWith('wt.worked_time.')||d.decision_id==='wt.worked_time.day.0');return input;
}
