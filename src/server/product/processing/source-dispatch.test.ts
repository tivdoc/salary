import {describe,it,expect} from 'vitest';
import {dispatchCaseInput,lockCurrentSource,sourceJobSchema} from './source-dispatch';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
const caseId='11111111-1111-4111-8111-111111111111';
const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:2,input_sha256:'a'.repeat(64),mode:'draft'});
function context(rows:Record<string,unknown>[]){const calls:PostgresStatement[]=[];const ctx:PostgresTransactionContext={transaction_id:'test',client:{async query(s){calls.push(s);return {rows:s.name==='source_case_lock'?[]:rows,row_count:rows.length};}}};return {ctx,calls};}
describe('source dispatch fencing',()=>{
 it('rejects live work before SQL when not enabled',async()=>{const {ctx,calls}=context([]);await expect(dispatchCaseInput(ctx,{caseId,tenantId:'synthetic',mode:'live',liveEnabled:false,nowMs:1})).rejects.toThrow('LIVE_PROCESSING_DISABLED');expect(calls).toEqual([]);});
 it('has no memory fallback or synthetic work when no committed outbox exists',async()=>{const {ctx}=context([]);expect(await dispatchCaseInput(ctx,{caseId,tenantId:'synthetic',mode:'draft',liveEnabled:false,nowMs:1})).toBeNull();});
 it('rejects old revision, absent case and same revision with wrong digest',async()=>{for(const rows of [[],[{revision:3,input_sha256:job.input_sha256}],[{revision:2,input_sha256:'b'.repeat(64)}]])await expect(lockCurrentSource(context(rows).ctx,job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');});
 it('locks the exact case before checking a current revision',async()=>{const {ctx,calls}=context([{revision:2,input_sha256:job.input_sha256}]);await lockCurrentSource(ctx,job);expect(calls.map(c=>c.values)).toEqual([[caseId],[caseId]]);expect(calls[0].text).toContain('for update');});
 it('does not accept arbitrary payload, invalid hash or test execution mode',()=>{expect(()=>sourceJobSchema.parse({...job,mode:'synthetic_test'})).toThrow();expect(()=>sourceJobSchema.parse({...job,input_sha256:'fake'})).toThrow();expect(()=>sourceJobSchema.parse({...job,path:'other-case.pdf'})).toThrow();});
});
