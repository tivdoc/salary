import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const state=vi.hoisted(()=>({bytes:'original',session:true,rpc:vi.fn(),engineering:false,regular:false,financialRead:vi.fn(),canonicalRead:vi.fn(),regularRead:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'owner'}:null,listIdentityCases:async()=>[{case_id:'case-a',public_id:'TV-OWN00001'}]}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:state.rpc})}));
vi.mock('@/server/product/reports/customer-reports',()=>({customerReports:async()=>({reports:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',...(state.regular?{document:{schema_version:'tivdoc-report-document-v3',execution_authority:{namespace:'isolated_test'}}}:{})}]})}));
// This HTTP unit owns port/auth/byte behavior. The actual server-only reader
// and its canonical reconstruction are exercised by the DEV integration proof.
vi.mock('@/server/product/reports/june2026-canonical-test',()=>({readJune2026CanonicalTest:state.canonicalRead}));
vi.mock('@/server/product/reports/june2026-regular-artifact',()=>({readJune2026RegularArtifact:state.regularRead}));
vi.mock('@/server/product/reports/dev-financial-customer',()=>({devFinancialPreviewEnabled:()=>state.engineering,devFinancialCustomerReports:state.financialRead}));
vi.mock('@/server/product/reports/report-artifacts',()=>({savedReportPdf:()=>Buffer.from('%PDF-synthetic')}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:async()=>({data:new Blob([state.bytes]),error:null})})}})}));
import {GET,POST} from './route';
const report='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',version='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context=(token='TV-OWN00001')=>({params:Promise.resolve({token})});
beforeEach(()=>{state.session=true;state.bytes='original';state.engineering=false;state.regular=false;state.regularRead.mockReset();state.financialRead.mockReset();state.canonicalRead.mockReset();state.rpc.mockReset();state.rpc.mockResolvedValue([{value:{path:`cases/case-a/versions/${version}.pdf`,mime:'application/pdf',size:8,sha256:createHash('sha256').update('original').digest('hex')}}]);});

describe('ordinary signed canonical report transport',()=>{
 it('serves the saved same-run bytes on the ordinary route and refuses stale or missing artifacts',async()=>{
  state.regular=true;state.regularRead.mockResolvedValue({current:true,report:{html:Buffer.from('<p>same-run 240.58</p>'),pdf:Buffer.from('%PDF-same-run 240.58')}});
  const url=`https://test/api?report=${report}`;
  expect(await (await GET(new Request(url+'&format=html'),context())).text()).toBe('<p>same-run 240.58</p>');
  expect(await (await GET(new Request(url),context())).text()).toBe('%PDF-same-run 240.58');
  expect(state.regularRead).toHaveBeenCalledWith('case-a','owner',report);
  state.regularRead.mockResolvedValue({current:false});expect((await GET(new Request(url),context())).status).toBe(410);
  state.regularRead.mockResolvedValue(null);expect((await GET(new Request(url),context())).status).toBe(503);
 });
 it('refuses foreign access before invoking the ordinary canonical store',async()=>{
  state.regular=true;expect((await GET(new Request(`https://test/api?report=${report}`),context('TV-FOREIGN1'))).status).toBe(404);
  expect(state.regularRead).not.toHaveBeenCalled();
 });
});
describe('saved report artifact HTTP ownership and bytes',()=>{
 it('does not return a report or touch source RPC for a foreign case or no session',async()=>{
  expect((await GET(new Request(`https://test/api?report=${report}`),context('TV-FOREIGN1'))).status).toBe(404);
  state.session=false;expect((await GET(new Request(`https://test/api?report=${report}`),context())).status).toBe(404);expect(state.rpc).not.toHaveBeenCalled();
 });
 it('downloads only a source pinned to the owned report and rejects changed bytes',async()=>{
  const url=`https://test/api?report=${report}&version=${version}`;const response=await GET(new Request(url),context());expect(response.status).toBe(200);expect(await response.text()).toBe('original');expect(response.headers.get('cache-control')).toContain('no-store');expect(state.rpc).toHaveBeenCalledWith('case_report_source',{target_case:'case-a',target_identity:'owner',target_report:report,target_version:version});
  state.bytes='tampered';expect((await GET(new Request(url),context())).status).toBe(503);
 });
 it('requires same-origin and an owned case before storing a correction',async()=>{
  const body=JSON.stringify({id:report,reportId:report,findingId:version,message:'Synthetic correction'});
  expect((await POST(new Request('https://test/api',{method:'POST',body,headers:{origin:'https://foreign'}}),context())).status).toBe(403);
  expect((await POST(new Request('https://test/api',{method:'POST',body,headers:{origin:'https://test'}}),context('TV-FOREIGN1'))).status).toBe(404);expect(state.rpc).not.toHaveBeenCalled();
 });
});

describe('engineering report HTTP remains separately gated and identity scoped',()=>{
 const url=`https://test/api?engineering=1&report=${report}`;
 const saved=()=>({pdf:Buffer.from('%PDF-computed'),run:{source:{version_id:version,path:`cases/case-a/versions/${version}.pdf`,mime:'application/pdf',size:8,source_sha256:createHash('sha256').update('original').digest('hex')}}});
 it('does not read the engineering store when disabled or for another case/session',async()=>{
  expect((await GET(new Request(url),context())).status).toBe(404);
  state.engineering=true;expect((await GET(new Request(url),context('TV-FOREIGN1'))).status).toBe(404);
  state.session=false;expect((await GET(new Request(url),context())).status).toBe(404);expect(state.financialRead).not.toHaveBeenCalled();
 });
 it('uses the owned run and stored PDF without accepting an arbitrary report identifier',async()=>{
  state.engineering=true;state.financialRead.mockResolvedValue([saved()]);
  const response=await GET(new Request(url),context());expect(response.status).toBe(200);expect(await response.text()).toBe('%PDF-computed');
  expect(state.financialRead).toHaveBeenCalledWith('case-a','owner',report);expect(response.headers.get('cache-control')).toContain('no-store');
  state.financialRead.mockResolvedValue([]);expect((await GET(new Request(url),context())).status).toBe(404);
 });
 it('downloads only the exact source version and rejects a changed stored source',async()=>{
  state.engineering=true;state.financialRead.mockResolvedValue([saved()]);
  const response=await GET(new Request(url+`&version=${version}`),context());expect(response.status).toBe(200);expect(await response.text()).toBe('original');
  expect((await GET(new Request(url+`&version=${report}`),context())).status).toBe(404);
  state.bytes='tampered';expect((await GET(new Request(url+`&version=${version}`),context())).status).toBe(503);
 });
 it('surfaces failed reconstruction as unavailable instead of returning a report',async()=>{
  state.engineering=true;state.financialRead.mockRejectedValue(Error('DEV_FINANCIAL_CALCULATION_MISMATCH'));
  expect((await GET(new Request(url),context())).status).toBe(503);
 });
});

describe('canonical isolated DEV report transport',()=>{
 const url=`https://test/api?canonical=1&report=${report}`;
 it('denies foreign and missing sessions before reading canonical data',async()=>{
  expect((await GET(new Request(url),context('TV-FOREIGN1'))).status).toBe(404);
  state.session=false;expect((await GET(new Request(url),context())).status).toBe(404);
  expect(state.canonicalRead).not.toHaveBeenCalled();
 });
 it('serves the stored same-run HTML/PDF and refuses a superseded run',async()=>{
  state.canonicalRead.mockResolvedValue({current:true,report:{html:Buffer.from('<p>240.58</p>'),pdf:Buffer.from('%PDF-240.58')}});
  const html=await GET(new Request(url+'&format=html'),context());expect(await html.text()).toBe('<p>240.58</p>');
  expect(html.headers.get('cache-control')).toContain('no-store');
  expect(await (await GET(new Request(url),context())).text()).toBe('%PDF-240.58');
  expect(state.canonicalRead).toHaveBeenCalledWith('case-a','owner',report);
  state.canonicalRead.mockResolvedValue({current:false});expect((await GET(new Request(url),context())).status).toBe(410);
 });
});
