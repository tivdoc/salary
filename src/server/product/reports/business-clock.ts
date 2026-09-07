/** Product service calendar, not an employee entitlement calculator.
 * Holiday dates: CSC calendar_2026.pdf pp.2–3; civil-service shortened days
 * and additional agreement leave do not define Tivdoc's service hours. */
export const SERVICE_CALENDAR_2026=Object.freeze({
 version:'tivdoc-service-calendar-2026-v1',from:'2026-01-01',to:'2026-12-31',
 source:'https://www.gov.il/BlobFolder/policy/calendar_2026/he/calendar_2026.pdf',
 closed:['2026-04-02','2026-04-08','2026-04-22','2026-05-22','2026-09-12','2026-09-13','2026-09-21','2026-09-26','2026-10-03'],
});
export type ServiceCalendar=Readonly<{version:string;from:string;to:string;source:string;closed:readonly string[]}>;
export type PauseInterval=Readonly<{start:number;end:number}>;
export function unionIntervals(intervals:readonly PauseInterval[]):PauseInterval[]{
 const sorted=intervals.map(i=>{if(!Number.isFinite(i.start)||!Number.isFinite(i.end)||i.end<i.start)throw new Error('SLA_INTERVAL_INVALID');return {...i};}).sort((a,b)=>a.start-b.start);
 const merged:PauseInterval[]=[];
 for(const value of sorted){const last=merged.at(-1);if(last&&value.start<=last.end)merged[merged.length-1]={start:last.start,end:Math.max(last.end,value.end)};else merged.push(value);}
 return merged;
}
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'});
const offsetFormatter=new Intl.DateTimeFormat('en',{timeZone:'Asia/Jerusalem',timeZoneName:'longOffset'});
function atHour(date:string,hour:number){
 // The offset at noon is also the offset during the 09–17 service window.
 const offset=offsetFormatter.formatToParts(new Date(`${date}T12:00:00Z`)).find(p=>p.type==='timeZoneName')!.value.replace('GMT','');
 return Date.parse(`${date}T${String(hour).padStart(2,'0')}:00:00${offset||'Z'}`);
}
function dateKey(at:number){const p=dayFormatter.formatToParts(at);return ['year','month','day'].map(k=>p.find(i=>i.type===k)!.value).join('-');}
/** Exact elapsed milliseconds. Overlapping blockers are subtracted once;
 * automatic checks use elapsed time, human reviews Sun–Thu 09:00–17:00. */
export function elapsedServiceMs(start:number,end:number,pauses:readonly PauseInterval[],kind:'automatic'|'human',calendar:ServiceCalendar=SERVICE_CALENDAR_2026):number{
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>366*86400000)throw new Error('SLA_INTERVAL_INVALID');
 const merged=unionIntervals(pauses);
 function active(a:number,b:number){a=Math.max(a,start);b=Math.min(b,end);if(b<=a)return 0;let total=b-a;for(const p of merged)total-=Math.max(0,Math.min(b,p.end)-Math.max(a,p.start));return total;}
 if(kind==='automatic')return active(start,end);
 if(dateKey(start)<calendar.from||dateKey(end)>calendar.to)throw new Error('SLA_CALENDAR_UNAVAILABLE');
 let total=0;
 for(let day=Math.floor(start/86400000)*86400000-86400000;day<=end+86400000;day+=86400000){
  const date=new Date(day).toISOString().slice(0,10);const weekday=new Date(day).getUTCDay();
  if(weekday===5||weekday===6||calendar.closed.includes(date))continue;
  total+=active(atHour(date,9),atHour(date,17));
 }
 return total;
}
export const SLA_BUDGET_MS=Object.freeze({initial_automatic:15*60000,initial_human:8*3600000,full_human:24*3600000});
