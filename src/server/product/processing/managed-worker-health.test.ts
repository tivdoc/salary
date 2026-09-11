import {describe,expect,it} from 'vitest';
import {managedWorkerHealthSchema,summarizeManagedWorkerHealth} from './managed-worker-health';

const fixture=()=>({checked_at:new Date('2026-09-11T00:40:00Z'),last_activity_at:new Date('2026-09-11T00:39:30Z'),capability_expires_at:new Date('2026-09-11T04:00:00Z'),
 daily_claims:'2',total_claims:'4',daily_limit:12,total_limit:20,
 cases:[{case_id:'11111111-1111-4111-8111-111111111111',pending_requests:3,authority_state:'record_present',authority_expires_at:'2026-09-11T01:00:00Z'}]});
describe('managed worker operational metadata',()=>{
 it('normalizes actual pg timestamps/bigints and computes remaining work without claiming authority readiness',()=>{
  const row=managedWorkerHealthSchema.parse(fixture());
  expect(row.checked_at).toBe('2026-09-11T00:40:00.000Z');expect(row.daily_claims).toBe(2);
  expect(row.cases[0].authority_state).toBe('record_present');expect(row).not.toHaveProperty('ready');
  expect(summarizeManagedWorkerHealth(row)).toEqual({daily_remaining:10,total_remaining:16,budget_exhausted:false,pending_requests:3,authority_expired:0,work_activity:'recent_work'});
 });
 it('reports exhausted budget and actual expired authority independently of an old activity timestamp',()=>{
  const row=managedWorkerHealthSchema.parse({...fixture(),daily_claims:'13',last_activity_at:'2026-09-11T00:00:00Z',cases:[{...fixture().cases[0],authority_state:'expired',authority_expires_at:'2026-09-11T00:01:00Z'}]});
  expect(summarizeManagedWorkerHealth(row)).toMatchObject({daily_remaining:0,budget_exhausted:true,authority_expired:1,work_activity:'no_recent_work'});
 });
 it('represents an idle never-processed enrollment without pretending the scheduler was observed',()=>{
  const row=managedWorkerHealthSchema.parse({...fixture(),last_activity_at:null,cases:[]});
  expect(summarizeManagedWorkerHealth(row)).toMatchObject({pending_requests:0,authority_expired:0,work_activity:'never_observed'});
 });
 it.each(['unsafe-bigint','duplicate-case','private-field','ready-state','invalid-time'])('refuses %s instead of returning untrusted metadata to operations',mutation=>{
  const value=fixture();
  if(mutation==='unsafe-bigint')value.total_claims='9007199254740992';
  if(mutation==='duplicate-case')value.cases.push({...value.cases[0]});
  if(mutation==='private-field')Object.assign(value,{capability:'private'});
  if(mutation==='ready-state')value.cases[0].authority_state='ready';
  if(mutation==='invalid-time')value.cases[0].authority_expires_at='not a date';
  expect(()=>managedWorkerHealthSchema.parse(value)).toThrow();
 });
});
