import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {hashSession} from '../case-access/crypto';
import type {CaseAccessDb} from '../case-access/db';
import {realAiServiceCustomerReports,realAiServiceCustomerArtifact,realAiServiceCustomerRefusal,realAiServiceCustomerRequestReview} from './real-ai-service-customer';
const ports=vi.hoisted(()=>({transaction:vi.fn(),read:vi.fn(),review:vi.fn(),rpc:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../case-access/db',()=>({withCaseAccessPostgresTransaction:ports.transaction}));
vi.mock('./real-ai-service-delivery',()=>({readRealAiServiceReport:ports.read,readRealAiServiceRequestReview:ports.review}));
const caseId='00000000-0000-4000-8000-000000000001',identityId='00000000-0000-4000-8000-000000000002',reportId='00000000-0000-4000-8000-000000000003';
const input={caseId,identityId,sessionToken:'synthetic-private-session-token-only'},db:CaseAccessDb={provider:'fake',rpc:ports.rpc};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','1');
 ports.transaction.mockImplementation(async callback=>callback(db));
 ports.rpc.mockImplementation(async name=>[{value:name==='case_access_real_service_context_install'?identityId:[]}]);
 ports.read.mockResolvedValue({bytes:new Uint8Array([1,2]),analysis_run_id:'synthetic-run'});
});
afterEach(()=>vi.unstubAllEnvs());
it('pins session installation and protected report read to the same transaction client',async()=>{
 await realAiServiceCustomerArtifact(input,reportId,'pdf');
 expect(ports.transaction).toHaveBeenCalledOnce();
 expect(ports.rpc).toHaveBeenCalledExactlyOnceWith('case_access_real_service_context_install',{target_case:caseId,target_session_hash:hashSession(input.sessionToken)});
 expect(ports.read).toHaveBeenCalledExactlyOnceWith(db,{case_id:caseId,identity_id:identityId,report_id:reportId},'pdf');
 expect(ports.rpc.mock.invocationCallOrder[0]).toBeLessThan(ports.read.mock.invocationCallOrder[0]);
 expect(JSON.stringify(ports.rpc.mock.calls)).not.toContain(input.sessionToken);
});
it('returns only bounded metadata from the authenticated list',async()=>{
 expect(await realAiServiceCustomerReports(input)).toEqual([]);
 expect(ports.rpc.mock.calls.map(([name])=>name)).toEqual(['case_access_real_service_context_install','case_report_real_ai_list']);
 expect(ports.read).not.toHaveBeenCalled();
});
it('refuses a mismatched session identity before list or artifact reads',async()=>{
 ports.rpc.mockResolvedValue([{value:caseId}]);
 await expect(realAiServiceCustomerArtifact(input,reportId,'html')).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');
 expect(ports.read).not.toHaveBeenCalled();expect(ports.rpc).toHaveBeenCalledTimes(1);
});
it('default disabled never obtains a database connection',async()=>{
 vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');await expect(realAiServiceCustomerReports(input)).rejects.toThrow('REAL_SERVICE_DISABLED');
 expect(ports.transaction).not.toHaveBeenCalled();
});
it.each(['REAL_SERVICE_SESSION_FORBIDDEN','REAL_SERVICE_UNAVAILABLE_FORBIDDEN','REAL_SERVICE_UNAVAILABLE_UNPUBLISHED'])('uses one nonexistence refusal for %s',code=>{
 expect(realAiServiceCustomerRefusal(Error(code))).toBe(404);
});
it.each(['REAL_SERVICE_UNAVAILABLE_SUPERSEDED','REAL_SERVICE_ENROLLMENT_EXPIRED','REAL_SERVICE_CASE_DECISION_EXPIRED','REAL_SERVICE_REVOKED'])('preserves precise stale status for %s',code=>{
 expect(realAiServiceCustomerRefusal(Error(code))).toBe(410);
});
it('does not disguise data corruption or a database outage as missing/stale data',()=>{
 expect(realAiServiceCustomerRefusal(Error('REAL_SERVICE_RENDERED_BYTES_CHANGED'))).toBeNull();
 expect(realAiServiceCustomerRefusal(Error('connection timeout'))).toBeNull();
});
const metadata={report_id:reportId,analysis_run_id:'synthetic-run',published_at:'2026-09-12T10:00:00Z',from:'2026-06-01',to:'2026-06-30',current:true,reason:null};
function reviewLookup(entries:unknown[]=[metadata]){
 ports.rpc.mockImplementation(async name=>[{value:name==='case_access_real_service_context_install'?identityId:entries}]);
 const review={case_id:caseId,analysis_run_id:metadata.analysis_run_id,period:{from:metadata.from,to:metadata.to}};
 ports.review.mockResolvedValue(review);return review;
}
it('authenticates list and request review through one transaction and revalidates the selected current artifact',async()=>{
 const review=reviewLookup();expect(await realAiServiceCustomerRequestReview(input)).toBe(review);
 expect(ports.transaction).toHaveBeenCalledOnce();
 expect(ports.rpc.mock.calls.map(([name])=>name)).toEqual(['case_access_real_service_context_install','case_report_real_ai_list']);
 expect(ports.review).toHaveBeenCalledExactlyOnceWith(db,{case_id:caseId,identity_id:identityId,report_id:reportId});
 expect(ports.rpc.mock.invocationCallOrder[1]).toBeLessThan(ports.review.mock.invocationCallOrder[0]);
});
it.each(['absent','stale','ambiguous','duplicate'] as const)('preserves requests without fetching ambiguous or unavailable review evidence: %s',async state=>{
 reviewLookup(state==='absent'?[]:state==='stale'?[{...metadata,current:false,reason:'expired'}]:[metadata,{...metadata,report_id:state==='duplicate'?reportId:identityId}]);
 expect(await realAiServiceCustomerRequestReview(input)).toBeNull();expect(ports.review).not.toHaveBeenCalled();
});
it.each(['case','run','period'] as const)('rejects current-list versus artifact %s mismatch',async state=>{
 const review=reviewLookup();ports.review.mockResolvedValue({...review,...(state==='case'?{case_id:identityId}:state==='run'?{analysis_run_id:'other-run'}:{period:{from:'2026-05-01',to:'2026-05-31'}})});
 await expect(realAiServiceCustomerRequestReview(input)).rejects.toThrow('REAL_SERVICE_REQUEST_REVIEW_BINDING');
});
it('does not read request review after foreign session denial, or while disabled',async()=>{
 reviewLookup();ports.rpc.mockResolvedValue([{value:caseId}]);
 await expect(realAiServiceCustomerRequestReview(input)).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');expect(ports.review).not.toHaveBeenCalled();
 vi.clearAllMocks();vi.stubEnv('TIVDOC_REAL_AI_SERVICE_ENABLED','0');
 expect(await realAiServiceCustomerRequestReview(input)).toBeNull();expect(ports.transaction).not.toHaveBeenCalled();
});
