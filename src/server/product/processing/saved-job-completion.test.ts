import {describe,it,expect,vi} from 'vitest';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {completeSavedDraftJob} from './saved-job-completion';
import {purchasedMonths,savedMonthIdempotencyKey,readSavedOrders,type SavedOrderScope} from './saved-order-scope';
import {SOURCE_JOB_KIND,type SourceJob} from './source-dispatch';

// Authority/case locking is independently exercised with the actual worker DB
// role. These tests isolate receipt completeness and terminal write behavior.
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:vi.fn(async()=>({revision:1}))}));
function setup(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'draft-finalizer',mode:'real'}),caseId=fixture.command.case_id;
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'11111111-1111-4111-8111-111111111111',kind:'full',from:'2025-01-01',to:'2025-02-01',topics:[...fixture.command.requested_topics],offer_sha256:'b'.repeat(64)};
 const row={job_id:'saved-test',tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,job_kind:SOURCE_JOB_KIND,payload:job,
  payload_sha256:canonicalSha256(job),state:'running',fencing_token:2,lease_owner:'worker',lease_valid:true,cancellation_requested:false,terminal_effect_sha256:null as string|null};
 const receipts=purchasedMonths(order).map(month=>{
  const key=savedMonthIdempotencyKey(job,order.id,month),end=month==='2025-01'?'31':'28';
  const command={...fixture.command,idempotency_key:key,period:{start_date:`${month}-01`,end_date:`${month}-${end}`}};
  return {idempotency_key:key,analysis_run_id:`run-${month}`,command,command_sha256:canonicalSha256(command),result_sha256:'c'.repeat(64),report_id:`report-${month}`,report_revision:1,report_sha256:'d'.repeat(64)};
 });
 const responses:Record<string,Record<string,unknown>[]>={saved_job_read:[row],saved_job_lock:[row],saved_order_entitlements:[{orders:[order],current_orders:[order]}],saved_job_month_receipts:receipts,saved_job_complete_atomic:[{outbox_id:'saved-draft:saved-test'}]};
 const calls:PostgresStatement[]=[];
 const context:PostgresTransactionContext={transaction_id:'unit-only',client:{async query(s){calls.push(s);const rows=responses[s.name];if(!rows)throw new Error(`UNEXPECTED_SQL:${s.name}`);return {rows,row_count:rows.length};}}};
 const input={context,jobId:row.job_id,workerId:'worker',fencingToken:2};
 return {input,job,order,row,receipts,responses,calls};
}
describe('saved draft job exact purchased completion',()=>{
 it('binds both months, distinct order scopes and their durable receipts to one draft manifest',async()=>{
  const s=setup(),result=await completeSavedDraftJob(s.input);
  expect(result.manifest.months.map(m=>m.month)).toEqual(['2025-01','2025-02']);
  expect(result.manifest.publication).toBe('draft');expect(result.sha256).toBe(canonicalSha256(result.manifest));
  const write=s.calls.filter(c=>c.name==='saved_job_complete_atomic');expect(write).toHaveLength(1);
  expect(write[0].text).toContain('clock_timestamp()');expect(write[0].text).toContain('not cancellation_requested');
 });
 it.each(['missing','duplicate','wrong month','wrong topics','wrong command hash'] as const)('refuses %s receipt before any terminal write',async(defect)=>{
  const s=setup();
  if(defect==='missing')s.receipts.pop();
  if(defect==='duplicate')s.receipts[1]=s.receipts[0];
  if(defect==='wrong month')s.receipts[1].command.period.start_date='2025-01-01';
  if(defect==='wrong topics')s.receipts[1].command.requested_topics=s.receipts[1].command.requested_topics.slice(0,3);
  if(defect==='wrong command hash')s.receipts[1].command_sha256='e'.repeat(64);
  if(defect==='wrong month'||defect==='wrong topics')s.receipts[1].command_sha256=canonicalSha256(s.receipts[1].command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow(/SAVED_JOB_(MONTHS_INCOMPLETE|RECEIPT_SCOPE)/);
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it.each(['stale fence','expired','cancelled','other worker'] as const)('rejects %s before receipt work',async(defect)=>{
  const s=setup();if(defect==='stale fence')s.row.fencing_token=3;if(defect==='expired')s.row.lease_valid=false;
  if(defect==='cancelled')s.row.cancellation_requested=true;if(defect==='other worker')s.row.lease_owner='another';
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.calls.some(c=>c.name==='saved_job_month_receipts')).toBe(false);
 });
 it('refuses a lease expiring at the atomic write without a separate outbox insertion',async()=>{
  const s=setup();s.responses.saved_job_complete_atomic=[];
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.calls.filter(c=>c.name==='saved_job_complete_atomic')).toHaveLength(1);
  expect(s.calls.some(c=>c.name==='outbox_enqueue')).toBe(false);
 });
 it('replays only the exact persisted manifest and detects a mismatched outbox',async()=>{
  const s=setup(),first=await completeSavedDraftJob(s.input);s.row.state='succeeded';s.row.terminal_effect_sha256=first.sha256;
  s.responses.saved_job_manifest_replay=[{payload:first.manifest,payload_sha256:first.sha256}];s.calls.length=0;
  expect((await completeSavedDraftJob(s.input)).replayed).toBe(true);
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
  s.responses.saved_job_manifest_replay[0].payload={...first.manifest,publication:'published'};
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MANIFEST_MISMATCH');
 });
 it('requires the chosen order entitlement even when another paid order remains',async()=>{
  const s=setup();s.responses.saved_order_entitlements[0].current_orders=[{...s.order,id:'22222222-2222-4222-8222-222222222222'}];
  await expect(readSavedOrders(s.input.context,s.job,s.order.id)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 });
 it.each(['tenant','case','hash'] as const)('refuses a job whose %s is not bound to its source',async(defect)=>{
  const s=setup();if(defect==='tenant')s.row.tenant_id='saved-case:foreign';
  if(defect==='case')s.row.canonical_case_id='22222222-2222-4222-8222-222222222222';
  if(defect==='hash')s.row.payload_sha256='e'.repeat(64);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_SCOPE');
  expect(s.calls.some(c=>c.name==='saved_job_lock')).toBe(false);
 });
 it('preserves overlapping purchases as distinct keys and refuses duplicate journal orders',async()=>{
  const s=setup(),other={...s.order,id:'22222222-2222-4222-8222-222222222222'};
  expect(savedMonthIdempotencyKey(s.job,s.order.id,'2025-01')).not.toBe(savedMonthIdempotencyKey(s.job,other.id,'2025-01'));
  s.responses.saved_order_entitlements[0].orders=[s.order,s.order];
  await expect(readSavedOrders(s.input.context,s.job)).rejects.toThrow('SAVED_ORDER_SCOPE');
 });
 it('expands December boundaries and 600 months exactly, rejecting an oversized paid scope',()=>{
  const s=setup();expect(purchasedMonths({...s.order,from:'2024-12-01',to:'2025-02-01'})).toEqual(['2024-12','2025-01','2025-02']);
  expect(purchasedMonths({...s.order,from:'1976-01-01',to:'2025-12-01'})).toHaveLength(600);
  expect(()=>purchasedMonths({...s.order,from:'1975-12-01',to:'2025-12-01'})).toThrow('ORDER_PERIOD_REQUIRES_OPERATIONS');
 });
});
