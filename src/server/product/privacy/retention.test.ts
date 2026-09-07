import {describe,it,expect,vi} from 'vitest';
import {retentionDecision} from './retention';
import {collectOrphans} from './storage-gc';
import type {CaseAccessDb} from '../case-access/db';
const base={kind:'document' as const,createdAt:'2025-01-01',lastActivityAt:'2025-01-01',now:'2026-09-07',references:[],holds:[]};
describe('retention and crash-safe GC',()=>{
 it('preserves referenced report evidence beyond the normal document age',()=>{expect(retentionDecision({...base,references:['published_report']})).toMatchObject({decision:'retain',reasons:['reference:published_report']});});
 it('retains legal holds and accounting records without filing evidence',()=>{expect(retentionDecision({...base,holds:['dispute']}).decision).toBe('retain');expect(retentionDecision({...base,kind:'accounting',taxYear:2020}).reasons).toContain('accounting_filing_evidence_required');});
 it('uses the later accounting horizon, not seven years from purchase',()=>{expect(retentionDecision({...base,kind:'accounting',taxYear:2020,taxReturnFiledAt:'2024-05-01'}).eligibleAt).toBe('2030-05-01T00:00:00.000Z');});
 it('marks eligible objects for a separate grace stage',()=>{expect(retentionDecision(base).decision).toBe('eligible_after_grace');expect(retentionDecision({...base,createdAt:'2026-09-01'}).decision).toBe('retain');});
 it('dry run never removes storage or claims a deletion',async()=>{const calls:string[]=[];const db:CaseAccessDb={provider:'fake',rpc:async<T>(fn:string)=>{calls.push(fn);return [{value:'marked'} as T];}};const remove=vi.fn();await collectOrphans({db,storage:{remove},objects:[{path:'synthetic',createdAt:base.createdAt}],execute:false});expect(calls).toEqual(['case_documents_gc_mark']);expect(remove).not.toHaveBeenCalled();});
 it('storage failure is not acknowledged as deleted',async()=>{const calls:string[]=[];const db:CaseAccessDb={provider:'fake',rpc:async<T>(fn:string)=>{calls.push(fn);return [{value:fn.endsWith('mark')?'marked':'deleting'} as T];}};expect(await collectOrphans({db,storage:{remove:async()=>{throw new Error('timeout');}},objects:[{path:'synthetic',createdAt:base.createdAt}],execute:true})).toMatchObject({failed:1,deleted:0});expect(calls).not.toContain('case_documents_gc_finish');});
});
