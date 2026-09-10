import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({view:vi.fn(()=>null),opened:vi.fn(()=>null)}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:async()=>{}}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>({identity_id:'synthetic-owner'}),
 listIdentityCases:async()=>[{case_id:'synthetic-case',public_id:'TV-1234ABCD'}]}));
vi.mock('@/server/product/reports/dev-financial-customer',()=>({devFinancialPreviewEnabled:()=>false,devFinancialCustomerReports:async()=>[]}));
vi.mock('@/server/product/reports/customer-reports',()=>({customerReports:async()=>({reports:[{id:'historical-report',publishedAt:'2026-09-10T12:00:00Z',
 state:'authority_unavailable',projection:{sensitive:'240.58 ILS'},document:{schema_version:'tivdoc-report-document-v3',execution_authority:{namespace:'isolated_test'},findings:[]}}]})}));
vi.mock('@/components/case/case-shell',()=>({CaseShell:({children}:{children:ReactNode})=>createElement('div',null,children)}));
vi.mock('@/components/case/report-view',()=>({ReportView:state.view}));
vi.mock('@/components/case/report-open',()=>({ReportOpen:state.opened}));
vi.mock('@/components/case/dev-financial-report',()=>({DevFinancialReport:()=>null}));
vi.mock('@/components/case/report-finding-actions',()=>({ReportFindingActions:()=>null}));
import Page from './page';

it('shows a historical unavailable notice without current amounts, report downloads, source links or open receipt',async()=>{
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain('הדוח אינו זמין כרגע');expect(html).toContain('האישור שעליו התבסס הניתוח אינו בתוקף');
 expect(html).not.toContain('240.58');expect(html).not.toContain('/api/cases/');
 expect(state.view).not.toHaveBeenCalled();expect(state.opened).not.toHaveBeenCalled();
});
