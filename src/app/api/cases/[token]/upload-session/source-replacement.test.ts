import {beforeEach,expect,it,vi} from 'vitest';
import {POST} from './route';
const p=vi.hoisted(()=>({session:vi.fn(),cases:vi.fn(),source:vi.fn(),cookie:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:async()=>({outcome:'ALLOW'})}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:p.session,listIdentityCases:p.cases}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=>'synthetic'}));
vi.mock('@/lib/case-cookie',()=>({setCaseCookie:p.cookie}));
vi.mock('@/server/product/reports/request-document-source',()=>({requestDocumentSourceMetadata:p.source}));
const caseId='11111111-1111-4111-8111-111111111111',identityId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333',version='44444444-4444-4444-8444-444444444444';
const context={params:Promise.resolve({token:'TV-SYNTH001'})};
const call=(id=requestId,origin='https://example.test')=>POST(new Request(`https://example.test/api/cases/TV-SYNTH001/upload-session?sourceRequestId=${id}`,{method:'POST',headers:{origin}}),context);
beforeEach(()=>{vi.resetAllMocks();p.session.mockResolvedValue({identity_id:identityId});p.cases.mockResolvedValue([{case_id:caseId,public_id:'TV-SYNTH001'}]);p.source.mockResolvedValue({version});});
it('resolves the exact version from authenticated case/request before opening the funnel',async()=>{
 const result=await call();expect(result.status).toBe(200);expect(await result.json()).toEqual({ok:true,next:`/check/upload?replaceVersionId=${version}`});
 expect(p.source).toHaveBeenCalledExactlyOnceWith({caseId,identityId,requestId});expect(p.cookie).toHaveBeenCalledExactlyOnceWith(caseId);expect(result.headers.get('cache-control')).toBe('no-store');
});
it('refuses foreign case before reading its source or setting a cookie',async()=>{
 p.cases.mockResolvedValue([]);expect((await call()).status).toBe(404);expect(p.source).not.toHaveBeenCalled();expect(p.cookie).not.toHaveBeenCalled();
});
it('refuses a request bound to another case instead of opening a generic upload screen',async()=>{
 p.source.mockRejectedValue(Error('REQUEST_FIELD_FORBIDDEN'));expect((await call()).status).toBe(404);expect(p.cookie).not.toHaveBeenCalled();
});
it('keeps the current funnel unchanged if the source was replaced in another tab',async()=>{
 p.source.mockResolvedValue(null);const r=await call();expect(r.status).toBe(409);expect(await r.json()).toMatchObject({code:'request_source_changed'});expect(p.cookie).not.toHaveBeenCalled();
});
it('does not turn an unavailable source into a different document selection',async()=>{
 p.source.mockRejectedValue(Error('DB_OFFLINE'));expect((await call()).status).toBe(503);expect(p.cookie).not.toHaveBeenCalled();
});
it('rejects malformed and cross-origin source navigation',async()=>{
 expect((await call('invalid')).status).toBe(404);expect((await call(requestId,'https://foreign.test')).status).toBe(403);expect(p.source).not.toHaveBeenCalled();expect(p.cookie).not.toHaveBeenCalled();
});
it('requires an actual identity session for replacement navigation',async()=>{
 p.session.mockResolvedValue(null);expect((await call()).status).toBe(401);expect(p.source).not.toHaveBeenCalled();expect(p.cookie).not.toHaveBeenCalled();
});
