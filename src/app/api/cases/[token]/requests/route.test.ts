import {beforeEach,it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({session:true,source:vi.fn(),answer:vi.fn(),list:vi.fn(),edit:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'owner'}:null,listIdentityCases:async()=>[{case_id:'case-a',public_id:'TV-OWN00001'}]}));
vi.mock('@/server/product/reports/request-document-source',()=>({loadRequestDocumentSource:state.source}));
vi.mock('@/server/product/reports/case-requests',()=>({answerCaseRequest:state.answer,listCaseRequests:state.list,editCaseRequest:state.edit}));
import {GET,POST} from './route';
import {postgresCaseAccessDb,supabaseCaseAccessDb} from '@/server/product/case-access/db';
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
it.each(['REQUEST_FIELD_SOURCE_CHANGED','JUNE_COLLECTION_SOURCE_OR_SCOPE_CHANGED'])('reports a stale source as a recoverable conflict: %s',async code=>{
 state.answer.mockRejectedValue(Error('CASE_ACCESS_DB_RPC_FAILED:case_request_answer_identified:'+code));
 const response=await POST(post(),context());expect(response.status).toBe(409);expect((await response.json()).code).toBe('request_edit_conflict');
});
it('reports an invalid typed June answer without leaking database detail',async()=>{
 state.answer.mockRejectedValue(Error('CASE_ACCESS_DB_RPC_FAILED:case_request_answer_identified:JUNE_COLLECTION_ANSWER_INVALID'));
 const response=await POST(post(),context());expect(response.status).toBe(400);expect((await response.json()).code).toBe('request_answer_invalid');
});
it.each(['postgres','supabase'] as const)('maps locked review SQL refusals to the existing HTTP contract through %s',async provider=>{
 for(const [message,status,code] of [
  ['REVIEW_REQUEST_SOURCE_CHANGED',409,'request_edit_conflict'],['REVIEW_REQUEST_ANSWER_INVALID',400,'request_answer_invalid'],
  ['REVIEW_REQUEST_CLOSED',409,'request_edit_conflict'],['REVIEW_REQUEST_FORBIDDEN',404,null],
 ] as const){
  const error=Object.assign(Error(message),{code:'P0001',detail:'private customer database detail'});
  const store=provider==='postgres'?postgresCaseAccessDb({async query(){throw error;}}):supabaseCaseAccessDb({async rpc(){return {data:null,error};}});
  state.answer.mockImplementation(()=>store.rpc('case_request_answer_identified',{}));
  const response=await POST(post(),context()),body=await response.text();
  expect(response.status).toBe(status);expect(body).not.toContain('REVIEW_REQUEST');expect(body).not.toContain('private customer');
  if(code)expect(JSON.parse(body).code).toBe(code);else expect(body).toBe('');
 }
});
