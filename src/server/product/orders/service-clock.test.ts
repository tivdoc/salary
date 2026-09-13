import {it,expect} from 'vitest';
import {customerServiceClocks,orderClockView,type ServiceClock} from './service-clock';
import {SERVICE_CALENDAR_2026} from '../reports/business-clock';
import type {CaseAccessDb} from '../case-access/db';
const start=Date.parse('2026-09-06T06:00:00Z'),request='11111111-1111-4111-8111-111111111111';
const base:ServiceClock={order_id:request,started_at:new Date(start).toISOString(),completed_at:null,track:'automatic',budget_ms:3600000,calendar:SERVICE_CALENDAR_2026 as unknown as ServiceClock['calendar'],pauses:[]};
it('counts overlapping pauses once and distinguishes active, paused, overdue and completed',()=>{
 expect(orderClockView(base,start+1800000)).toMatchObject({state:'running',remainingMs:1800000});
 const paused={...base,pauses:[{request_id:request,started_at:new Date(start+600000).toISOString(),ended_at:null},{request_id:request,started_at:new Date(start+1200000).toISOString(),ended_at:null}]};
 expect(orderClockView(paused,start+7200000)).toMatchObject({state:'paused',elapsedMs:600000,remainingMs:3000000});
 expect(orderClockView(base,start+7200000).state).toBe('overdue');
 expect(orderClockView({...base,completed_at:new Date(start+1800000).toISOString()},start+7200000)).toMatchObject({state:'completed',elapsedMs:1800000});
});
it('does not invent time outside the stored calendar',()=>{
 expect(orderClockView({...base,track:'human'},Date.parse('2027-01-02T12:00:00Z')).state).toBe('unavailable');
});
it('calls the identity-scoped saved clock RPC and refuses unavailable data',async()=>{
 const calls:unknown[]=[];
 const db={async rpc(name:string,args:unknown){calls.push({name,args});return [{value:[base]}];}} as unknown as CaseAccessDb;
 expect((await customerServiceClocks('case','identity',db)).clocks).toHaveLength(1);
 expect(calls).toEqual([{name:'case_order_sla_snapshot',args:{target_case:'case',target_identity:'identity'}}]);
 await expect(customerServiceClocks('case','identity',{rpc:async()=>[]} as unknown as CaseAccessDb)).rejects.toThrow();
});

it('accepts a saved business schedule and counts business time independently of human review',async()=>{
 const clock={...base,track:'business' as const,budget_ms:86400000};
 const db={rpc:async()=>[{value:[clock]}]} as unknown as CaseAccessDb;
 expect((await customerServiceClocks('case','identity',db)).clocks[0].track).toBe('business');
 expect(orderClockView(clock,Date.parse('2026-09-07T06:00:00Z'))).toMatchObject({elapsedMs:8*3600000,remainingMs:16*3600000});
});
