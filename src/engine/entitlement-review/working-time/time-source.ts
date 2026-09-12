import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewOperand,DocumentReviewSource} from '../../document-review/calculations.ts';
import type {WorkingTimeEntitlementInput,WorkingTimeWorkday,WorkingTimeSourceFact} from './contracts.ts';

export function usable<T>(fact:WorkingTimeSourceFact<T>){return (fact.state==='observed'||fact.state==='declared')&&fact.value!==null&&fact.source!==null;}
export function sourceNumber(o:DocumentReviewOperand,kind:'money'|'hours'|'percent'){
 if(kind==='money'&&(o.representation!=='money_ils'||o.quantity_unit!==null)
  ||kind==='hours'&&(!['hours_minutes','decimal_quantity'].includes(o.representation)||o.quantity_unit!=='hours')
  ||kind==='percent'&&(o.representation!=='percent'||o.quantity_unit!=='ratio'))throw Error('WORKING_TIME_SOURCE_UNIT');
 if(!['observed','declared'].includes(o.state)||o.printed_value===null)return null;
 if(o.representation==='hours_minutes'){
  const m=/^(\d{1,3}):([0-5]\d)$/u.exec(o.printed_value);if(!m)throw Error('WORKING_TIME_DURATION_FORMAT');
  return Number(m[1])*60+Number(m[2]);
 }
 if(!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,8})?$/u.test(o.printed_value))throw Error('WORKING_TIME_SOURCE_NUMBER');
 return Number(o.printed_value)*(kind==='hours'?60:1);
}
export function sourcePin(input:WorkingTimeEntitlementInput,s:DocumentReviewSource){return {case_id:input.case_id,document_id:s.document_id,version_id:s.version_id,source_sha256:s.file_sha256};}
export function assertSource(input:WorkingTimeEntitlementInput,s:DocumentReviewSource){
 const d=input.source_manifest.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
 if(!d||d.file_sha256!==s.file_sha256||s.page<1||s.page>d.page_count||d.kind!=='legal_source'&&d.case_id!==input.case_id
  ||s.reading==='customer_declaration'&&d.kind!=='customer_answer')throw Error('WORKING_TIME_SOURCE_BINDING');
}
export function validateAllSources(input:WorkingTimeEntitlementInput){
 function visit(v:unknown):void{if(!v||typeof v!=='object')return;if(Array.isArray(v)){v.forEach(visit);return;}
  const x=v as Record<string,unknown>;
  if(typeof x.reading_receipt_sha256==='string'&&typeof x.locator==='string'){assertSource(input,v as DocumentReviewSource);return;}
  Object.values(x).forEach(visit);
 }
 visit(input);
}
export function atTime(raw:string){
 if(!/^2026-(?:05|06|07|08)-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\+03:00$/u.test(raw))throw Error('WORKING_TIME_CLOCK_FORMAT');
 const value=Date.parse(raw);
 if(!Number.isFinite(value)||new Date(value+10800000).toISOString().slice(0,19)!==raw.slice(0,19))throw Error('WORKING_TIME_CLOCK_DATE');
 return value;
}
export function sourceInterval(input:WorkingTimeEntitlementInput,day:WorkingTimeWorkday,interval:WorkingTimeWorkday['intervals'][number],rest:{start:number;end:number}|null){
 const duration=sourceNumber(interval.printed_duration,'hours');if(duration===null)return null;
 if(duration<=0||duration>1440||!Number.isInteger(duration))throw Error('WORKING_TIME_DURATION_BOUND');
 const start=atTime(interval.start_at),end=atTime(interval.end_at);
 if(end-start!==duration*60000)throw Error('WORKING_TIME_CLOCK_DURATION_MISMATCH');
 const dayStart=atTime(day.date+'T00:00:00+03:00');
 if(start<dayStart||end>dayStart+36*3600000||interval.end_at.slice(0,10)>input.period.to)throw Error('WORKING_TIME_INTERVAL_PERIOD');
 const a=interval.clock_source,b=interval.printed_duration.source;
 if(a.document_id!==b.document_id||a.version_id!==b.version_id||a.file_sha256!==b.file_sha256||a.page!==b.page||a.reading_receipt_sha256!==b.reading_receipt_sha256)throw Error('WORKING_TIME_CLOCK_SOURCE');
 let night=0,restMinutes=0;
 for(let at=start;at<end;at+=60000){const hour=new Date(at+10800000).getUTCHours();if(hour>=22||hour<6)night++;if(rest&&at>=rest.start&&at<rest.end)restMinutes++;}
 const trace={schema_version:'working-time-source-clock-v1',day_id:day.id,interval,minutes:duration,night_minutes:night,rest_minutes:rest?restMinutes:null,
  rest_window:rest?input.rest_window:null,timezone:'Asia/Jerusalem',utc_offset:'+03:00',rollover_basis:'explicit_source_dates_and_printed_duration'};
 return {...trace,start,end,sha256:canonicalSha256(trace)};
}
export type TimeReading=NonNullable<ReturnType<typeof sourceInterval>>;
export function transformedHours(reading:TimeReading,kind:'minutes'|'night_minutes'|'rest_minutes',id:string):DocumentReviewOperand{
 const value=reading[kind];if(value===null)throw Error('WORKING_TIME_UNKNOWN_REST');
 const original=reading.interval.printed_duration;
 return {...original,id,observation_id:`working-time.${kind}.${reading.sha256}`,printed_value:`${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`,
  representation:'hours_minutes',quantity_unit:'hours',precision:'source_exact',
  source:{...original.source,locator:`${original.source.locator.slice(0,280)}; ${kind}; source-clock-v1 ${reading.sha256}`}};
}
