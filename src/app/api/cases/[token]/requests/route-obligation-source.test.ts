import {beforeEach,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {CaseAccessDb} from '@/server/product/case-access/db';

const state=vi.hoisted(()=>({db:null as CaseAccessDb|null,identityId:'',caseId:'',session:true,download:vi.fn(),marker:vi.fn(),guard:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:state.guard}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'synthetic-session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:state.identityId}:null,listIdentityCases:async()=>[{case_id:state.caseId,public_id:'TV-SYNTH001'}]}));
vi.mock('@/server/product/case-access/db',async original=>({...await original<typeof import('@/server/product/case-access/db')>(),resolveCaseAccessDb:async()=>state.db}));
vi.mock('@/server/product/reports/case-requests',()=>({answerCaseRequest:vi.fn(),editCaseRequest:vi.fn(),listCaseRequests:vi.fn()}));
vi.mock('@/server/product/reports/marked-reading-source',()=>({markReadingSource:state.marker}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:state.download})}})}));
import {GET} from './route';
import {PRODUCT_HTTP_HEADERS} from '@/server/product/routes/http-common';

function fixture(){
 state.caseId=randomUUID();state.identityId=randomUUID();state.session=true;
 const requestId=randomUUID(),candidate='a'.repeat(64),version=randomUUID(),bytes=Buffer.from('%PDF-1.7 synthetic selected source');
 const source={path:`cases/${state.caseId}/versions/${version}.pdf`,mime:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),version,page:2};
 const rpc=vi.fn<(name:string,args:Readonly<Record<string,unknown>>)=>Promise<unknown[]>>().mockResolvedValue([{value:source}]);
 state.db={provider:'fake',async rpc<T>(name:string,args:Readonly<Record<string,unknown>>){return await rpc(name,args) as T[];}};
 state.download.mockResolvedValue({data:new Blob([bytes]),error:null});state.marker.mockResolvedValue(null);
 const request=(query='',token='TV-SYNTH001')=>({request:new Request(`https://test/api/cases/${token}/requests?source=${requestId}${query}`),context:{params:Promise.resolve({token})}});
 const run=(query='',token='TV-SYNTH001')=>{const r=request(query,token);return GET(r.request,r.context);};
 return {requestId,candidate,source,bytes,rpc,request,run};
}
beforeEach(()=>{vi.resetAllMocks();});
function protectedHeaders(response:Response){for(const [key,value] of Object.entries(PRODUCT_HTTP_HEADERS))expect(response.headers.get(key)).toBe(value);}

it.each(['candidate','payroll','clause','candidate-clause'])('passes authenticated scope and the explicit %s selector to the protected source lookup',async kind=>{
 const f=fixture(),hasCandidate=kind.includes('candidate'),linked=kind.includes('clause')?'clause':'payroll';
 const query=`${hasCandidate?`&candidate=${f.candidate}`:''}${kind==='candidate'?'':`&linked=${linked}`}&caseId=foreign&identityId=foreign&version=foreign`;
 const response=await f.run(query);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);protectedHeaders(response);
 expect(f.rpc).toHaveBeenCalledExactlyOnceWith('case_request_obligation_source',{target_case:state.caseId,target_identity:state.identityId,target_request:f.requestId,target_candidate:hasCandidate?f.candidate:null,target_linked:linked});
 expect(state.download).toHaveBeenCalledExactlyOnceWith(f.source.path);expect(state.marker).not.toHaveBeenCalled();
});
it('preserves the original source lookup without obligation selectors and retains the capability guard',async()=>{
 const f=fixture(),r=f.request(),response=await GET(r.request,r.context);expect(response.status).toBe(200);protectedHeaders(response);
 expect(state.guard).toHaveBeenCalledExactlyOnceWith('CEP-105',r.request);
 expect(f.rpc).toHaveBeenCalledExactlyOnceWith('case_request_document_source',{target_case:state.caseId,target_identity:state.identityId,target_request:f.requestId});
 expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
});
it.each(['&candidate=','&candidate=bad','&candidate='+ 'A'.repeat(64),'&linked=','&linked=other','&linked=clause&candidate=bad'])('refuses malformed selectors before the source lookup: %s',async query=>{
 const f=fixture(),response=await f.run(query);expect(response.status).toBe(404);expect(await response.text()).toBe('');protectedHeaders(response);
 expect(f.rpc).not.toHaveBeenCalled();expect(state.download).not.toHaveBeenCalled();expect(state.marker).not.toHaveBeenCalled();
});
it.each(['foreign-case','missing-session','missing-source','null-source'])('does not expose or download a %s source',async kind=>{
 const f=fixture();if(kind==='missing-session')state.session=false;if(kind==='missing-source')f.rpc.mockResolvedValue([]);if(kind==='null-source')f.rpc.mockResolvedValue([{value:null}]);
 const response=await f.run(`&candidate=${f.candidate}`,kind==='foreign-case'?'TV-FOREIGN1':'TV-SYNTH001');
 expect(response.status).toBe(404);expect(await response.text()).toBe('');protectedHeaders(response);expect(state.download).not.toHaveBeenCalled();
 if(kind==='foreign-case'||kind==='missing-session')expect(f.rpc).not.toHaveBeenCalled();
});
it('retains the capability refusal before source lookup',async()=>{
 const f=fixture();state.guard.mockRejectedValueOnce(Error('CAPABILITY_ENTRYPOINT_BLOCKED:CEP-105'));
 const response=await f.run(`&candidate=${f.candidate}`);expect(response.status).toBe(404);expect(await response.text()).toBe('');protectedHeaders(response);
 expect(f.rpc).not.toHaveBeenCalled();expect(state.download).not.toHaveBeenCalled();
});
it.each(['rpc','storage','hash','foreign-path'])('returns a protected unavailable response for valid selection with %s failure',async kind=>{
 const f=fixture();if(kind==='rpc')f.rpc.mockRejectedValueOnce(Error('PRIVATE_SOURCE_FAILURE'));
 if(kind==='storage')state.download.mockResolvedValueOnce({data:null,error:Error('PRIVATE_STORAGE_FAILURE')});
 if(kind==='hash')f.source.sha256='f'.repeat(64);if(kind==='foreign-path')f.source.path=`cases/${randomUUID()}/versions/${f.source.version}.pdf`;
 const response=await f.run(`&candidate=${f.candidate}`);expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'request_source_unavailable'});protectedHeaders(response);
 expect(state.marker).not.toHaveBeenCalled();if(kind==='rpc'||kind==='foreign-path')expect(state.download).not.toHaveBeenCalled();
});
it.each(['payroll','clause'])('forwards only the selected %s bytes and selectors to the marker, retaining original fallback',async linked=>{
 const f=fixture(),response=await f.run(`&candidate=${f.candidate}&linked=${linked}&view=marked`);expect(response.status).toBe(200);
 expect(state.marker).toHaveBeenCalledExactlyOnceWith({caseId:state.caseId,identityId:state.identityId,requestId:f.requestId,bytes:f.bytes,mime:'application/pdf',version:f.source.version,extension:'pdf',candidateHash:f.candidate,linked},state.db);
 expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);expect(response.headers.get('X-Tivdoc-Source-View')).toBeNull();protectedHeaders(response);
});
it('returns an explicitly derived marker for the selected source with the existing private headers',async()=>{
 const f=fixture(),marked=Buffer.from('%PDF synthetic derived marker');state.marker.mockResolvedValueOnce(marked);
 const response=await f.run(`&candidate=${f.candidate}&view=marked`);expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(marked);
 expect(response.headers.get('X-Tivdoc-Source-View')).toBe('derived-marker');expect(response.headers.get('Content-Disposition')).toBe(`inline; filename="source-${f.source.version}-marked.pdf"`);protectedHeaders(response);
});
