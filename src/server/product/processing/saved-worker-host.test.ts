import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PostgresConnectionFactory} from '@/server/platform/persistence/postgres/runtime/transaction-manager';
import {statement,type PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import {createSavedWorkerHost,type SavedWorkerHostInput} from './saved-worker-host';
vi.mock('server-only',()=>({}));
function setup(){
 const caseId=randomUUID();
 const input:SavedWorkerHostInput={caseId,buildSha:'a'.repeat(40),target:{target_id:'test-host',host:'127.0.0.1',database:'tivdoc_release_replay_20260907',disposable:true,validation:'LOOPBACK_DISPOSABLE_VALIDATED'},identity:{session_id:'machine:one',token_id:'token:one',tenant_id:`saved-case:${caseId}`,actor_id:'worker:one',reviewer_organization_id:null,rotation_counter:0}};
 const installed={tenant_id:input.identity.tenant_id,actor_id:input.identity.actor_id,runtime_role:'worker',reviewer_organization_id:null,session_rotation_counter:'0'};
 const queries:PostgresStatement[]=[];let acquisitions=0,releases=0;
 const controls={fail:'',principal:'tivdoc_worker_runtime',tenant:input.identity.tenant_id};
 const driver:PostgresConnectionFactory={async acquire(){acquisitions++;return {async query(s){
  queries.push(s);if(s.name===controls.fail)throw new Error('PRIVATE_CONNECTION_DETAIL');
  const rows=s.name==='schema_compatibility_read'?[{schema_version:'tivdoc-canonical-postgresql-v0.9.0'}]:s.name==='runtime_verified_context_install'?[{...installed}]:s.name==='saved_host_principal'?[{principal:controls.principal,tenant_id:controls.tenant}]:[];
  return {rows,row_count:rows.length};
 },release(){releases++;}};}};
 return {input,installed,queries,driver,controls,counts:()=>({acquisitions,releases})};
}
describe('canonical saved worker host',()=>{
 it('checks schema and reinstalls its pinned machine identity/build for every transaction',async()=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver);const originalToken=s.input.identity.token_id;
  s.input.identity={...s.input.identity,token_id:'changed:token'};s.input.buildSha='b'.repeat(40);
  for(let i=0;i<2;i++)expect(await host(async context=>{await context.client.query(statement('host_test_work','select $1',[i]));return i;})).toBe(i);
  const installs=s.queries.filter(q=>q.name==='runtime_verified_context_install');expect(installs).toHaveLength(2);expect(installs.every(q=>q.values[1]===originalToken)).toBe(true);expect(installs[0].values[2]).not.toBe(installs[1].values[2]);
  expect(s.queries.filter(q=>q.name==='runtime_build_context_set').every(q=>q.values[0]==='a'.repeat(40))).toBe(true);expect(s.queries.filter(q=>q.name==='saved_host_timeouts')).toHaveLength(2);expect(s.counts()).toEqual({acquisitions:3,releases:3});
 });
 it.each(['tenant_id','actor_id','runtime_role','reviewer_organization_id','session_rotation_counter'] as const)('refuses mismatched installed %s before work',async field=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver),work=vi.fn();Object.assign(s.installed,{[field]:'foreign'});
  await expect(host(work)).rejects.toThrow('POSTGRES_RUNTIME_IDENTITY_MISMATCH');expect(work).not.toHaveBeenCalled();expect(s.queries.at(-1)?.name).toBe('transaction_rollback');expect(s.counts()).toEqual({acquisitions:2,releases:2});
 });
 it.each(['principal','tenant'] as const)('refuses an incorrect actual %s even with a matching installation response',async field=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver),work=vi.fn();s.controls[field]='foreign';await expect(host(work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();expect(s.queries.at(-1)?.name).toBe('transaction_rollback');
 });
 it('preserves an application hold after rollback instead of converting it into a generic retry',async()=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver),failure=new Error('SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED');await expect(host(async()=>{throw failure;})).rejects.toBe(failure);expect(s.queries.at(-1)?.name).toBe('transaction_rollback');expect(s.counts()).toEqual({acquisitions:2,releases:2});
 });
 it('does not classify a failed commit as successful application work',async()=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver);s.controls.fail='transaction_commit';await expect(host(async()=>42)).rejects.toThrow('POSTGRES_TRANSACTION_FAILED');expect(s.queries.at(-1)?.name).toBe('transaction_rollback');
 });
 it('refuses a foreign case and production database before acquiring a connection',async()=>{
  const s=setup();await expect(createSavedWorkerHost({...s.input,caseId:randomUUID()},s.driver)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');await expect(createSavedWorkerHost({...s.input,target:{...s.input.target,database:'postgres'}},s.driver)).rejects.toThrow('POSTGRES_TARGET_NOT_DISPOSABLE');expect(s.counts().acquisitions).toBe(0);
 });
 it('rolls back failed session installation without running work',async()=>{
  const s=setup(),host=await createSavedWorkerHost(s.input,s.driver),work=vi.fn();s.controls.fail='runtime_verified_context_install';await expect(host(work)).rejects.toThrow('POSTGRES_TRANSACTION_FAILED');expect(work).not.toHaveBeenCalled();expect(s.counts()).toEqual({acquisitions:2,releases:2});
 });
});
