import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
type PrivateReviewSummary=Awaited<ReturnType<typeof import('@/server/product/reports/private-document-review').privateDocumentReviewReports>>[number];
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({view:vi.fn(()=>null),opened:vi.fn(()=>null),actions:vi.fn(()=>null),inquiry:vi.fn(()=>'נוסח פנייה למעסיק'),
 reportState:'authority_unavailable',namespace:'isolated_test',gap:24058,privateEnabled:false,reviews:[] as PrivateReviewSummary[]}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:async()=>{}}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>({identity_id:'synthetic-owner'}),
 listIdentityCases:async()=>[{case_id:'synthetic-case',public_id:'TV-1234ABCD'}]}));
vi.mock('@/server/product/reports/dev-financial-customer',()=>({devFinancialPreviewEnabled:()=>false,devFinancialCustomerReports:async()=>[]}));
vi.mock('@/server/product/reports/private-review-environment',()=>({privateReviewEnvironmentEnabled:()=>state.privateEnabled}));
vi.mock('@/server/product/reports/private-document-review',()=>({privateDocumentReviewReports:async()=>state.reviews}));
vi.mock('@/server/product/reports/customer-reports',()=>({customerReports:async()=>({reports:[{id:'historical-report',publishedAt:'2026-09-10T12:00:00Z',
 state:state.reportState,projection:{check_period_month:'2026-06',report_kind:'full',legal_basis:'opinion_3ddad7e8 + errata_1_owner_closed',
 topics:[{topic:'minimum_wage',gate:'checked',status:state.gap>0?'finding':'no_gap',amount:null,
 range:state.gap>0?{low:{currency:'ILS',minor_units:state.gap},high:{currency:'ILS',minor_units:state.gap}}:null}]},
 document:{schema_version:'tivdoc-report-document-v3',revision:7,execution_authority:{namespace:state.namespace,analysis_run_id:'synthetic-analysis-run'},
 evidence:[{id:'source-evidence',version_id:'source-version',page:1,field:'compensation.base_monthly_salary'}],
 findings:[{id:'synthetic-finding',topic:'minimum_wage',evidence_ids:['source-evidence'],rule_versions:['candidate-v1'],parameter_versions:['parameter-v1']}]}}]})}));
vi.mock('@/components/case/case-shell',()=>({CaseShell:({children}:{children:ReactNode})=>createElement('div',null,children)}));
vi.mock('@/components/case/report-view',()=>({ReportView:state.view}));
vi.mock('@/components/case/report-open',()=>({ReportOpen:state.opened}));
vi.mock('@/components/case/dev-financial-report',()=>({DevFinancialReport:()=>null}));
vi.mock('@/components/case/report-finding-actions',()=>({ReportFindingActions:state.actions}));
vi.mock('@/server/product/reports/report-inquiry',()=>({inquiryText:state.inquiry}));
import Page from './page';

beforeEach(()=>{state.reportState='authority_unavailable';state.namespace='isolated_test';state.gap=24058;
 state.privateEnabled=false;state.reviews=[];
 state.view.mockClear();state.opened.mockClear();state.actions.mockClear();state.inquiry.mockClear();});

it('shows a historical unavailable notice without current amounts, report downloads, source links or open receipt',async()=>{
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain('הדוח אינו זמין כרגע');expect(html).toContain('האישור שעליו התבסס הניתוח אינו בתוקף');
 expect(html).not.toContain('240.58');expect(html).not.toContain('/api/cases/');
 expect(state.view).not.toHaveBeenCalled();expect(state.opened).not.toHaveBeenCalled();
});

it.each([
 ['expired','תוקף ההרשאה להצגת הטיוטה פג.'],
 ['revoked','ההרשאה להצגת הטיוטה בוטלה.'],
 ['authority_unavailable','לא ניתן לאמת כעת את ההרשאה'],
 ['source_or_analysis_changed','המקור או מצב הניתוח אינם עדכניים'],
 [undefined,'לא נמסרה סיבה מפורטת'],
] as const)('shows the explicit private %s reason without restoring any blocked link',async(reason,message)=>{
 state.privateEnabled=true;state.reviews=[{report_id:'private-report',analysis_run_id:'private-run',period:{from:'2026-06-01',to:'2026-06-30'},
  report_revision:1,current:false,created_at:'2026-09-12T22:05:00Z',purchased_topics:['minimum_wage'],...(reason?{unavailable_reason:reason}:{})}];
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain(message);expect(html).not.toContain('הקלט השתנה');expect(html).not.toContain('/api/cases/');
 expect(html).toContain('13.9.2026');expect(html).toContain('1:05');expect(html).toContain('שעון ישראל');
 expect(html).toContain('dateTime="2026-09-12T22:05:00Z"');expect(html).toContain('אינה דוח שאושר לפרסום או קביעת חוב');
});

it('shows distinct creation times for same-revision private drafts and keeps only the current links',async()=>{
 state.privateEnabled=true;
 const base={analysis_run_id:'private-run',period:{from:'2026-06-01',to:'2026-06-30'},report_revision:1,purchased_topics:['minimum_wage']};
 state.reviews=[{...base,report_id:'old',current:false,created_at:'2026-09-12T10:00:00Z',unavailable_reason:'expired'},
  {...base,report_id:'new',current:true,created_at:'2026-09-12T11:20:00Z'}];
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain('13:00');expect(html).toContain('14:20');expect(html).toContain('report=new');expect(html).not.toContain('report=old');
 expect(html).toContain('פתיחת הטיוטה העדכנית');
});

it('shows the stored DEV run and 240.58 only as a synthetic test result without generic legal presentation or employer actions',async()=>{
 state.reportState='published';
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain('סיכום בדיקת DEV סינתטית');expect(html).toContain('אין כאן אישור אדם אמיתי');
 expect(html).toContain('synthetic-analysis-run');expect(html).toContain('240.58');expect(html).toContain('2026-06');
 expect(html).toContain('format=html');expect(html).toContain('תוצר הבדיקה השמור — PDF');expect(html).toContain('version=source-version');
 for(const text of ['opinion_3ddad7e8','errata_1_owner_closed','מתחת לרצפת החוק','לטובתך','אפשר לפנות למעסיק','נוסח פנייה למעסיק'])expect(html).not.toContain(text);
 expect(state.view).not.toHaveBeenCalled();expect(state.actions).not.toHaveBeenCalled();expect(state.inquiry).not.toHaveBeenCalled();
});

it('does not invent a zero or a debt when the stored DEV projection has no positive amount',async()=>{
 state.reportState='published';state.gap=0;
 const html=renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(html).toContain('לא נשמר פער כספי חיובי להצגה');expect(html).not.toContain('0.00 ILS');
 expect(state.view).not.toHaveBeenCalled();expect(state.actions).not.toHaveBeenCalled();expect(state.inquiry).not.toHaveBeenCalled();
});

it('retains the ordinary view and actions for a current real-authority report',async()=>{
 state.reportState='published';state.namespace='real';
 renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
 expect(state.view).toHaveBeenCalledOnce();expect(state.actions).toHaveBeenCalledOnce();expect(state.inquiry).toHaveBeenCalledOnce();
});
