import {beforeEach,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {CaseAccessDb} from '../case-access/db';
import {loadRequestDocumentSource} from './request-document-source';
const ports=vi.hoisted(()=>({download:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:ports.download})}})}));
beforeEach(()=>vi.resetAllMocks());
function setup(){
 const input={caseId:randomUUID(),identityId:randomUUID(),requestId:randomUUID()},version=randomUUID(),bytes=Buffer.from('%PDF synthetic');
 const source={path:`cases/${input.caseId}/versions/${version}.pdf`,mime:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),version,page:1};
 const rpc=vi.fn(async()=>[{value:source}]),db={provider:'fake',rpc} as unknown as CaseAccessDb;
 ports.download.mockResolvedValue({data:new Blob([bytes]),error:null});return {input,bytes,source,rpc,db};
}
it('reads scoped metadata before Storage and returns only the exact verified bytes',async()=>{
 const s=setup(),result=await loadRequestDocumentSource(s.input,s.db);expect(result?.bytes).toEqual(s.bytes);
 expect(s.rpc).toHaveBeenCalledExactlyOnceWith('case_request_document_source',{target_case:s.input.caseId,target_identity:s.input.identityId,target_request:s.input.requestId});
 expect(ports.download).toHaveBeenCalledExactlyOnceWith(s.source.path);
});
it('does not read Storage when the scoped SQL lookup refuses the identity',async()=>{
 const s=setup();s.rpc.mockRejectedValueOnce(Error('REQUEST_FIELD_FORBIDDEN'));await expect(loadRequestDocumentSource(s.input,s.db)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');expect(ports.download).not.toHaveBeenCalled();
});
it.each(['foreign-path','version','mime','size'] as const)('refuses %s metadata before Storage',change=>{
 const s=setup();if(change==='foreign-path')s.source.path=`cases/${randomUUID()}/versions/${s.source.version}.pdf`;if(change==='version')s.source.version=randomUUID();if(change==='mime')s.source.mime='text/html';if(change==='size')s.source.size=10*1024*1024+1;
 return expect(loadRequestDocumentSource(s.input,s.db)).rejects.toThrow().then(()=>expect(ports.download).not.toHaveBeenCalled());
});
it.each(['hash','size','missing'] as const)('refuses %s Storage bytes',change=>{
 const s=setup();if(change==='hash')s.source.sha256='f'.repeat(64);if(change==='size')s.source.size++;if(change==='missing')ports.download.mockResolvedValue({data:null,error:Error('missing')});
 return expect(loadRequestDocumentSource(s.input,s.db)).rejects.toThrow();
});
