import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
const state=vi.hoisted(()=>({bytes:'original',session:true,rpc:vi.fn()}));
vi.mock('@/server/platform/capabilities/stable-http-entrypoint',()=>({guardStableHttpEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'owner'}:null,listIdentityCases:async()=>[{case_id:'case-a',public_id:'TV-OWN00001'}]}));
vi.mock('@/server/product/case-access/db',()=>({resolveCaseAccessDb:async()=>({rpc:state.rpc})}));
vi.mock('@/server/product/reports/customer-reports',()=>({customerReports:async()=>({reports:[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]})}));
vi.mock('@/server/product/reports/report-artifacts',()=>({savedReportPdf:()=>Buffer.from('%PDF-synthetic')}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>({storage:{from:()=>({download:async()=>({data:new Blob([state.bytes]),error:null})})}})}));
import {GET,POST} from './route';
const report='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',version='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const context=(token='TV-OWN00001')=>({params:Promise.resolve({token})});
beforeEach(()=>{state.session=true;state.bytes='original';state.rpc.mockReset();state.rpc.mockResolvedValue([{value:{path:`cases/case-a/versions/${version}.pdf`,mime:'application/pdf',size:8,sha256:createHash('sha256').update('original').digest('hex')}}]);});
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
