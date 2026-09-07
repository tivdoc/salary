import {z} from 'zod';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {elapsedServiceMs,SERVICE_CALENDAR_2026} from '../reports/business-clock';
const instant=z.iso.datetime({offset:true});
const clockSchema=z.object({order_id:z.uuid(),started_at:instant,completed_at:instant.nullable(),track:z.enum(['automatic','human']),budget_ms:z.coerce.number().int().positive(),
 calendar:z.object({version:z.string(),from:z.string(),to:z.string(),source:z.string(),closed:z.array(z.string())}),
 pauses:z.array(z.object({request_id:z.uuid(),started_at:instant,ended_at:instant.nullable()})),
});
export type ServiceClock=z.infer<typeof clockSchema>;
export async function customerServiceClocks(caseId:string,identityId:string,db?:CaseAccessDb){
 const store=db??await resolveCaseAccessDb();if(!store)throw new Error('ORDER_CLOCK_UNAVAILABLE');
 const rows=await store.rpc<{value:unknown}>('case_order_sla_snapshot',{target_case:caseId,target_identity:identityId});
 return {clocks:z.array(clockSchema).parse(rows[0]?.value),observedAt:Date.now()};
}
export function orderClockView(clock:ServiceClock,observedAt:number){
 const end=clock.completed_at?Date.parse(clock.completed_at):observedAt;
 try{
  if(clock.calendar.version!==SERVICE_CALENDAR_2026.version)throw new Error('SLA_CALENDAR_UNAVAILABLE');
  const elapsed=elapsedServiceMs(Date.parse(clock.started_at),end,clock.pauses.map(p=>({start:Date.parse(p.started_at),end:p.ended_at?Date.parse(p.ended_at):end})),clock.track,clock.calendar);
  const paused=!clock.completed_at&&clock.pauses.some(p=>p.ended_at===null);
  return {state:clock.completed_at?'completed' as const:paused?'paused' as const:elapsed>clock.budget_ms?'overdue' as const:'running' as const,
   elapsedMs:elapsed,remainingMs:Math.max(0,clock.budget_ms-elapsed),
   blockingRequests:clock.completed_at?[]:clock.pauses.filter(p=>p.ended_at===null).map(p=>p.request_id)};
 }catch{return {state:'unavailable' as const,elapsedMs:null,remainingMs:null,blockingRequests:[]};}
}
