import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
type Receipt=Awaited<ReturnType<typeof import('@/server/product/orders/legacy-customer').legacyCustomerReceipts>>[number];
const state=vi.hoisted(()=>({dev:true,session:true,member:true,receipts:[] as Receipt[],unavailable:false,events:[] as string[],
 legacyRead:vi.fn(),overviewRead:vi.fn(),guard:vi.fn(),blocking:false,reportsAvailable:true,requestsAvailable:true,publishedReports:0}));
vi.mock('server-only',()=>({}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');},redirect:()=>{throw Error('REDIRECT');}}));
vi.mock('next/link',()=>({default:({children,href,className}:{children:ReactNode;href:string;className?:string})=>createElement('a',{href,className},children)}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:state.guard}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session',readCaseChallengeCookie:async()=>null}));
vi.mock('@/server/product/case-access/crypto',()=>({isOpaqueToken:()=>false}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'11111111-1111-4111-8111-111111111111'}:null,
 listIdentityCases:async()=>{state.events.push('membership');return state.member?[{case_id:'22222222-2222-4222-8222-222222222222',public_id:'TV-1234ABCD',status:'completed',payment_verified:false,created_at:'2026-09-11T00:00:00Z'}]:[];},
 describeChallenge:async()=>({live:false}),peekLinkToken:async()=>({valid:false})}));
vi.mock('@/server/product/case-access/overview',()=>({loadCaseOverview:async(...args:unknown[])=>{
 state.overviewRead(...args);return {requestsAvailable:state.requestsAvailable,openRequests:state.blocking?1:0,
 blocking:state.blocking?{id:'synthetic-request',question:'מה הייתה תקופת העבודה?'}:null,reportsAvailable:state.reportsAvailable,publishedReports:state.publishedReports,period:'2026-06'};}}));
vi.mock('@/server/product/orders/legacy-customer',()=>({legacyCustomerReceipts:async(caseId:string,identityId:string)=>{
 state.events.push('legacy');state.legacyRead(caseId,identityId);if(state.unavailable)throw Error('STORE_UNAVAILABLE');return state.receipts;
}}));
vi.mock('@/server/product/reports/dev-financial-customer',()=>({devFinancialPreviewEnabled:()=>state.dev}));
vi.mock('@/components/case/case-shell',()=>({CaseShell:({children}:{children:ReactNode})=>createElement('main',null,children)}));
vi.mock('@/components/case/access-challenge',()=>({AccessChallenge:()=>null}));
vi.mock('@/components/case/link-exchange',()=>({LinkExchange:()=>null}));
vi.mock('@/lib/product-offer',()=>({productOffer:()=>({second_product_sentence:'הצעת ההמשך הקיימת.',access:{link_token_ttl_hours:24,code_ttl_minutes:10}})}));
import Page from './page';

function receipt():Receipt{return {id:'33333333-3333-4333-8333-333333333333',kind:'legacy_initial',origin:'legacy_paid_receipt',
 topics:['working_time','pension','vacation','convalescence','travel','rest_day','minimum_wage','bonuses','contract'],
 periods:[{from:'2026-05-20',to:'2026-06-30'}],amount_minor:9900,currency:'ILS',period_state:'source_observed',receipt_sha256:'a'.repeat(64),scope_basis:'legacy_initial_scope_not_versioned',new_payment_required:false};}
const html=async()=>renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
beforeEach(()=>{state.dev=true;state.session=true;state.member=true;state.receipts=[receipt()];state.unavailable=false;state.events=[];
 state.blocking=false;state.reportsAvailable=true;state.requestsAvailable=true;state.publishedReports=0;state.legacyRead.mockClear();state.overviewRead.mockClear();state.guard.mockClear();});

it('shows authenticated legacy nine-topic receipt without applying modern price/scope or the stale case payment flag',async()=>{
 const body=await html();expect(state.events).toEqual(['membership','legacy']);
 expect(state.legacyRead).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
 expect(body).toContain('תשעה נושאים');expect(body).toContain('תקבול מאומת במידע השמור');expect(body).toContain('99.00');expect(body).toContain('חיבור ההזמנה אינו יוצר חיוב חדש');
 expect(body).toContain('תקופת הרכישה לא נשמרה בהזמנה המקורית');expect(body).toContain('תקופות שזוהו במקורות ונשמרו בנפרד');expect(body).toContain('2026-05-20');
 for(const text of ['טרם התקבל אימות תשלום','חודש אחד ועד שלושה','הבדיקה הושלמה','הצעת ההמשך הקיימת.'])expect(body).not.toContain(text);
 expect(body).toContain('מצב התיק והתשלום לבדם אינם אישור שהדוח מוכן');expect(body).toContain('/case/TV-1234ABCD/reports');
 expect(state.guard).toHaveBeenCalledWith('CEP-096');
});
it('keeps missing original purchase period distinct from a source period still missing',async()=>{
 state.receipts=[{...receipt(),period_state:'missing',periods:[]}];const body=await html();
 expect(body).toContain('תקופת הרכישה לא נשמרה');expect(body).toContain('חסרה תקופה מזוהה במסמכים');expect(body).not.toContain('חודש הבדיקה:');
 expect(body).toContain('זיהוי המסמך והתקופה בבקשות התיק');expect(body).toContain('/case/TV-1234ABCD/thread');expect(body).toContain('אין צורך לשלם שוב');
});
it('routes to the real blocking request without marking the report ready from completed case status',async()=>{
 state.blocking=true;const body=await html();expect(body).toContain('מה הייתה תקופת העבודה?');expect(body).toContain('/thread#request-synthetic-request');
 expect(body).not.toContain('הבדיקה הושלמה');
});
it('does not treat failed receipt read as proof that payment is absent',async()=>{
 state.unavailable=true;const body=await html();expect(body).toContain('לא ניתן לטעון את פרטי הרכישה ההיסטורית');expect(body).toContain('אין בכך קביעה שהתשלום חסר');
 expect(body).not.toContain('טרם התקבל אימות תשלום');expect(body).not.toContain('תשעה נושאים');expect(body).not.toContain('תקבול מאומת');
});
it('retains the existing modern view when DEV has no admitted historical receipt',async()=>{
 state.receipts=[];const body=await html();expect(body).toContain('טרם התקבל אימות תשלום');expect(body).toContain('חודש אחד ועד שלושה');expect(body).toContain('הצעת ההמשך הקיימת.');
});
it('reads the authenticated payment registry on the honest local runtime without a financial Preview flag',async()=>{
 state.dev=false;const body=await html();expect(state.legacyRead).toHaveBeenCalledOnce();expect(state.events).toEqual(['membership','legacy']);
 expect(body).not.toContain('חודש אחד ועד שלושה');expect(body).not.toContain('טרם התקבל אימות תשלום');expect(body).toContain('תקבול מאומת');
});
it.each(['session','member'] as const)('refuses absent %s before the protected receipt query',async key=>{
 state[key]=false;await expect(html()).rejects.toThrow(key==='session'?'REDIRECT':'NOT_FOUND');expect(state.legacyRead).not.toHaveBeenCalled();expect(state.overviewRead).not.toHaveBeenCalled();
});
it('forwards the resolved private cookie after membership and directs a published REAL overview to reports',async()=>{
 state.receipts=[];state.publishedReports=1;const body=await html();
 expect(state.overviewRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({case_id:'22222222-2222-4222-8222-222222222222'}),'11111111-1111-4111-8111-111111111111','session');
 expect(body).toContain('לצפייה בדוחות שפורסמו');expect(body).toContain('1 דוחות שפורסמו זמינים לצפייה');
 expect(body).not.toContain('עדיין לא פורסם דוח');expect(body).not.toContain('session');
});
it('keeps unavailable report discovery distinct from no published report',async()=>{
 state.receipts=[];state.reportsAvailable=false;const body=await html();
 expect(body).toContain('לא ניתן לטעון את מצב הדוחות כרגע');expect(body).not.toContain('עדיין לא פורסם דוח');
});
