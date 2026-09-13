import {beforeEach,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
vi.mock('server-only',()=>({}));
const ports=vi.hoisted(()=>({session:true,artifact:vi.fn(),ordinary:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=>'synthetic-authenticated-session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>ports.session?{identity_id:'owner'}:null,
 listIdentityCases:async()=>[{case_id:'case-a',public_id:'TV-OWN00001'}]}));
vi.mock('@/server/product/reports/customer-reports',()=>({customerReports:ports.ordinary}));
vi.mock('@/server/product/reports/real-ai-service-customer',async original=>({
 ...await original<typeof import('@/server/product/reports/real-ai-service-customer')>(),realAiServiceCustomerArtifact:ports.artifact}));
import {GET} from './route';
const report='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',url=`https://test/api?service=real&report=${report}`;
const context=(token='TV-OWN00001')=>({params:Promise.resolve({token})});
beforeEach(()=>{vi.clearAllMocks();ports.session=true;
 ports.artifact.mockImplementation(async(_scope,_report,format)=>{
  const bytes=Buffer.from(format==='html'?'<p>same-run 240.58</p>':'%PDF-same-run 240.58');
  return {bytes,content_type:format==='html'?'text/html; charset=utf-8':'application/pdf',analysis_run_id:'same-synthetic-run',sha256:createHash('sha256').update(bytes).digest('hex')};
 });
});
it('passes the owned session to the authenticated reader and preserves exact same-run HTML/PDF bytes',async()=>{
 for(const format of ['html','pdf']){
  const response=await GET(new Request(url+`&format=${format}`),context()),bytes=Buffer.from(await response.arrayBuffer());
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('x-tivdoc-analysis-run')).toBe('same-synthetic-run');
  expect(response.headers.get('x-tivdoc-artifact-sha256')).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(bytes.toString()).toBe(format==='html'?'<p>same-run 240.58</p>':'%PDF-same-run 240.58');
  expect(response.headers.get('content-disposition')).toBe(format==='pdf'?`attachment; filename="Tivdoc-${report}.pdf"`:null);
  expect(ports.artifact).toHaveBeenLastCalledWith({caseId:'case-a',identityId:'owner',sessionToken:'synthetic-authenticated-session'},report,format);
 }
 expect(ports.ordinary).not.toHaveBeenCalled();
});
it('refuses foreign cases, missing sessions and mixed source/DEV selectors before any REAL read',async()=>{
 expect((await GET(new Request(url),context('TV-FOREIGN1'))).status).toBe(404);
 ports.session=false;expect((await GET(new Request(url),context())).status).toBe(404);ports.session=true;
 for(const selector of ['version','review','engineering','canonical'])expect((await GET(new Request(url+`&${selector}=1`),context())).status).toBe(404);
 expect(ports.artifact).not.toHaveBeenCalled();expect(ports.ordinary).not.toHaveBeenCalled();
});
it.each(['REAL_SERVICE_UNAVAILABLE_FORBIDDEN','REAL_SERVICE_UNAVAILABLE_UNPUBLISHED','REAL_SERVICE_DISABLED'])('conceals %s without fallback',async code=>{
 ports.artifact.mockRejectedValue(Error(code));const response=await GET(new Request(url),context());
 expect(response.status).toBe(404);expect(await response.text()).toBe('');expect(ports.ordinary).not.toHaveBeenCalled();
});
it.each(['REAL_SERVICE_UNAVAILABLE_EXPIRED','REAL_SERVICE_UNAVAILABLE_REVOKED','REAL_SERVICE_UNAVAILABLE_SUPERSEDED'])('marks %s as stale and never returns historical bytes',async code=>{
 ports.artifact.mockRejectedValue(Error(code));const response=await GET(new Request(url),context());
 expect(response.status).toBe(410);expect(await response.json()).toEqual({code:'analysis_superseded'});expect(ports.ordinary).not.toHaveBeenCalled();
});
it('preserves service outages as 503, rather than concealing a data or verification failure',async()=>{
 ports.artifact.mockRejectedValue(Error('REAL_SERVICE_ARTIFACT_CHANGED'));const response=await GET(new Request(url),context());
 expect(response.status).toBe(503);expect(await response.json()).toEqual({code:'report_unavailable'});expect(ports.ordinary).not.toHaveBeenCalled();
});
