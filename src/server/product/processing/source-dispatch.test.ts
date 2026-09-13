import {beforeEach,describe,it,expect,vi} from 'vitest';
import {canonicalSha256,canonicalStringify} from '@/engine/rule-runtime/canonical';
import {dispatchCaseInput,lockCurrentSource,sourceJobSchema} from './source-dispatch';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
const caseId='11111111-1111-4111-8111-111111111111';
const queue=vi.hoisted(()=>({enqueue:vi.fn()}));
vi.mock('@/server/platform/persistence/postgres/runtime/jobs-outbox-audit',()=>({PostgresJobsOutboxAuditRepository:class{enqueue=queue.enqueue;}}));
beforeEach(()=>{vi.resetAllMocks();queue.enqueue.mockImplementation(async input=>input);});
const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:2,input_sha256:'a'.repeat(64),mode:'draft'});
function context(rows:Record<string,unknown>[],acknowledged=1){const calls:PostgresStatement[]=[];const ctx:PostgresTransactionContext={transaction_id:'test',client:{async query(s){calls.push(s);return {rows:s.name==='source_case_lock'?[]:rows,row_count:s.name==='source_dispatch_ack'?acknowledged:rows.length};}}};return {ctx,calls};}
const dispatchInput={caseId,tenantId:'synthetic',mode:'draft' as const,liveEnabled:false,nowMs:1};
describe('source dispatch fencing',()=>{
 it('rejects live work before SQL when not enabled',async()=>{const {ctx,calls}=context([]);await expect(dispatchCaseInput(ctx,{caseId,tenantId:'synthetic',mode:'live',liveEnabled:false,nowMs:1})).rejects.toThrow('LIVE_PROCESSING_DISABLED');expect(calls).toEqual([]);});
 it('has no memory fallback or synthetic work when no committed outbox exists',async()=>{const {ctx}=context([]);expect(await dispatchCaseInput(ctx,{caseId,tenantId:'synthetic',mode:'draft',liveEnabled:false,nowMs:1})).toBeNull();});
 it('rejects old revision, absent case and same revision with wrong digest',async()=>{for(const rows of [[],[{revision:3,input_sha256:job.input_sha256}],[{revision:2,input_sha256:'b'.repeat(64)}]])await expect(lockCurrentSource(context(rows).ctx,job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');});
 it('locks the exact case before checking its current revision and mode dependency',async()=>{const {ctx,calls}=context([{revision:2,input_sha256:job.input_sha256}]);await lockCurrentSource(ctx,job);expect(calls.map(c=>c.values)).toEqual([[caseId],[caseId,'draft']]);expect(calls[0].text).toContain('for update');expect(calls[1].text).toContain('d.mode=$2');});
 it('does not accept arbitrary payload, invalid hash or test execution mode',()=>{expect(()=>sourceJobSchema.parse({...job,mode:'synthetic_test'})).toThrow();expect(()=>sourceJobSchema.parse({...job,input_sha256:'fake'})).toThrow();expect(()=>sourceJobSchema.parse({...job,path:'other-case.pdf'})).toThrow();});
 it.each([null,'bad','A'.repeat(64),'b'.repeat(63)])('refuses an explicit invalid dependency %s',token=>{expect(()=>sourceJobSchema.parse({...job,authority_dependency_sha256:token})).toThrow();});
 it.each([undefined,null])('preserves historical source payload bytes and queue identity for DB dependency %s',async token=>{
  const legacy='{"case_id":"11111111-1111-4111-8111-111111111111","input_sha256":"'+ 'a'.repeat(64)+'","mode":"draft","revision":2,"schema_version":"saved-case-work-v1"}';
  const s=context([{revision:2,input_sha256:job.input_sha256,authority_dependency_sha256:token}]);
  await dispatchCaseInput(s.ctx,dispatchInput);const enqueued=queue.enqueue.mock.calls[0][0];
  expect(canonicalStringify(enqueued.payload)).toBe(legacy);expect(enqueued.payload).not.toHaveProperty('authority_dependency_sha256');
  expect(enqueued.job_id).toBe(`saved_${canonicalSha256(job)}`);expect(enqueued.pinned_version_sha256s).toEqual([job.input_sha256]);
  expect(s.calls.at(-1)?.values.at(-1)).toBeNull();
 });
 it('creates distinct idempotent queue identities for new authority without changing prior payloads',async()=>{
  const dependencies=['b'.repeat(64),'c'.repeat(64),'c'.repeat(64)];
  for(const token of dependencies)await dispatchCaseInput(context([{revision:2,input_sha256:job.input_sha256,authority_dependency_sha256:token}]).ctx,dispatchInput);
  const [first,second,retry]=queue.enqueue.mock.calls.map(c=>c[0]);
  expect(first.job_id).not.toBe(second.job_id);expect(second.job_id).toBe(retry.job_id);
  expect(first.payload).toEqual({...job,authority_dependency_sha256:dependencies[0]});
  expect(second.payload).toEqual({...job,authority_dependency_sha256:dependencies[1]});
  expect(first.pinned_version_sha256s).toEqual([job.input_sha256,dependencies[0]]);
 });
 it('requires exactly one dependency-matched dispatch acknowledgement in the enqueue transaction',async()=>{
  const token='b'.repeat(64),s=context([{revision:2,input_sha256:job.input_sha256,authority_dependency_sha256:token}],0);
  await expect(dispatchCaseInput(s.ctx,dispatchInput)).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');
  expect(queue.enqueue).toHaveBeenCalledTimes(1);expect(s.calls.at(-1)?.text).toContain('authority_dependency_sha256 is not distinct from $6');
  expect(s.calls.at(-1)?.values).toEqual([caseId,2,`saved_${canonicalSha256({...job,authority_dependency_sha256:token})}`,1,'draft',token]);
 });
 it.each([[undefined,'b'.repeat(64)],['b'.repeat(64),'c'.repeat(64)],['b'.repeat(64),null]])('refuses old authority %s when current dependency is %s',async(saved,current)=>{
  const candidate={...job,...(saved?{authority_dependency_sha256:saved}:{})};
  await expect(lockCurrentSource(context([{revision:2,input_sha256:job.input_sha256,authority_dependency_sha256:current}]).ctx,candidate)).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');
 });
 it('admits the exact current authority dependency without treating it as approval',async()=>{
  const token='b'.repeat(64);await expect(lockCurrentSource(context([{revision:2,input_sha256:job.input_sha256,authority_dependency_sha256:token}]).ctx,{...job,authority_dependency_sha256:token})).resolves.toBeUndefined();
 });
});
