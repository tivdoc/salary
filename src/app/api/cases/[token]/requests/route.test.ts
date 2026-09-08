import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({session:true,source:vi.fn(),answer:vi.fn(),list:vi.fn(),edit:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'owner'}:null,listIdentityCases:async()=>[{case_id:'case-a',public_id:'TV-OWN00001'}]}));
vi.mock('@/server/product/reports/request-document-source',()=>({loadRequestDocumentSource:state.source}));
vi.mock('@/server/product/reports/case-requests',()=>({answerCaseRequest:state.answer,listCaseRequests:state.list,editCaseRequest:state.edit}));
import {GET,POST} from './route';
const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const context=(token='TV-OWN00001')=>({params:Promise.resolve({token})});
const get=()=>new Request(`https://test/api?source=${requestId}`);
const post=(origin='https://test')=>new Request('https://test/api',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({requestId,answer:'כן, בדקתי במסמך והערך נכון',identityId:'forged',caseId:'other'})});
beforeEach(()=>{vi.clearAllMocks();state.session=true;state.source.mockResolvedValue({bytes:Buffer.from('%PDF-synthetic'),mime:'application/pdf',version:requestId,extension:'pdf'});state.answer.mockResolvedValue({id:requestId});state.list.mockResolvedValue([]);});
it('requires an authenticated owned case before resolving a source',async()=>{
 expect((await GET(get(),context('TV-FOREIGN1'))).status).toBe(404);state.session=false;expect((await GET(get(),context())).status).toBe(404);expect(state.source).not.toHaveBeenCalled();
});
it('refuses malformed source IDs before data or Storage reads',async()=>{
 expect((await GET(new Request('https://test/api?source=invalid'),context())).status).toBe(404);expect(state.source).not.toHaveBeenCalled();
});
it('returns the already verified source with no-store and exact server-owned scope',async()=>{
 const response=await GET(get(),context());expect(response.status).toBe(200);expect(await response.text()).toBe('%PDF-synthetic');expect(response.headers.get('cache-control')).toContain('no-store');
 expect(state.source).toHaveBeenCalledExactlyOnceWith({caseId:'case-a',identityId:'owner',requestId});
});
it('does not substitute another document after the source was replaced',async()=>{
 state.source.mockResolvedValue(null);expect((await GET(get(),context())).status).toBe(404);
 state.source.mockRejectedValue(Error('PRIVATE_STORAGE_DETAIL'));const response=await GET(get(),context());expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE_STORAGE_DETAIL');
});
it('rejects foreign Origin and foreign case before accepting a reading',async()=>{
 expect((await POST(post('https://foreign'),context())).status).toBe(403);expect((await POST(post(),context('TV-FOREIGN1'))).status).toBe(404);expect(state.answer).not.toHaveBeenCalled();
});
it('uses session identity and scoped case, ignoring forged body identity fields',async()=>{
 expect((await POST(post(),context())).status).toBe(200);expect(state.answer).toHaveBeenCalledExactlyOnceWith({caseId:'case-a',identityId:'owner',requestId,answer:'כן, בדקתי במסמך והערך נכון'});
});
it('reports a stale source as a recoverable conflict instead of accepting the old reading',async()=>{
 state.answer.mockRejectedValue(Error('CASE_ACCESS_DB_RPC_FAILED:case_request_answer_identified:REQUEST_FIELD_SOURCE_CHANGED'));
 const response=await POST(post(),context());expect(response.status).toBe(409);expect((await response.json()).code).toBe('request_edit_conflict');
});
