import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
import {LEGACY_PAID_TOPICS} from '@/server/product/orders/legacy-paid-receipt';
type Receipt=Awaited<ReturnType<typeof import('@/server/product/orders/legacy-customer').legacyCustomerReceipts>>[number];
const state=vi.hoisted(()=>({session:true,member:true,receipts:[] as Receipt[],unavailable:false,events:[] as string[],legacyRead:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');},redirect:()=>{throw Error('REDIRECT');}}));
vi.mock('next/link',()=>({default:({children,href}:{children:ReactNode;href:string})=>createElement('a',{href},children)}));
vi.mock('@/server/platform/capabilities/stable-next-entrypoint',()=>({guardStableAppEntrypoint:vi.fn()}));
vi.mock('@/server/product/case-access/session-cookie',()=>({readCaseSessionCookie:async()=> 'session'}));
vi.mock('@/server/product/case-access/service',()=>({resolveIdentitySession:async()=>state.session?{identity_id:'11111111-1111-4111-8111-111111111111'}:null,
 listIdentityCases:async()=>{state.events.push('membership');return state.member?[{case_id:'22222222-2222-4222-8222-222222222222',public_id:'TV-1234ABCD'}]:[];}}));
vi.mock('@/server/product/orders/legacy-customer',()=>({legacyCustomerReceipts:async(caseId:string,identityId:string)=>{state.events.push('legacy');state.legacyRead(caseId,identityId);if(state.unavailable)throw Error('UNAVAILABLE');return state.receipts;}}));
vi.mock('@/server/product/reports/dev-financial-customer',()=>({devFinancialPreviewEnabled:()=>false}));
vi.mock('@/server/product/orders/service',()=>({customerOrders:async()=>[]}));
vi.mock('@/server/product/orders/service-clock',()=>({customerServiceClocks:async()=>({clocks:[],observedAt:0})}));
vi.mock('@/components/case/case-shell',()=>({CaseShell:({children}:{children:ReactNode})=>createElement('main',null,children)}));
vi.mock('@/components/case/order-purchase',()=>({OrderPurchase:()=>createElement('form',{'data-new-purchase':true}),RefundRequest:()=>null}));
import Page from './page';
const html=async()=>renderToStaticMarkup(await Page({params:Promise.resolve({token:'TV-1234ABCD'})}));
beforeEach(()=>{state.session=true;state.member=true;state.unavailable=false;state.events=[];state.legacyRead.mockClear();state.receipts=[{id:'33333333-3333-4333-8333-333333333333',kind:'legacy_initial',origin:'legacy_paid_receipt',
 topics:[...LEGACY_PAID_TOPICS],periods:[],period_state:'missing',amount_minor:9900,currency:'ILS',receipt_sha256:'a'.repeat(64),scope_basis:'legacy_initial_scope_not_versioned',new_payment_required:false}];});
it('shows all nine paid topics and a period intake CTA outside Preview, keeping additional purchase separate',async()=>{
 const body=await html();expect(state.events).toEqual(['membership','legacy']);expect(state.legacyRead).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111');
 expect(body).toContain('תקבול מאומת');expect(body).toContain('99.00');expect(body).toContain('זיהוי המסמך והתקופה בבקשות התיק');expect(body).toContain('/case/TV-1234ABCD/thread');
 expect(body).toContain('<details><summary>רכישה נוספת ונפרדת</summary>');expect(body).not.toContain('לא נמצאו הזמנות');expect(body).not.toContain('חודש הבדיקה');
});
it('retains ordinary new purchases when no historical receipt exists',async()=>{state.receipts=[];const body=await html();expect(body).toContain('data-new-purchase');expect(body).not.toContain('<details>');expect(body).not.toContain('תקבול מאומת');});
it('does not present an empty purchase history or payment form when the receipt read failed',async()=>{state.unavailable=true;const body=await html();expect(body).toContain('אין בכך קביעה שהתשלום חסר');expect(body).not.toContain('לא נמצאו הזמנות');expect(body).not.toContain('data-new-purchase');});
it.each(['session','member'] as const)('does not query receipt without %s',async key=>{state[key]=false;await expect(html()).rejects.toThrow();expect(state.legacyRead).not.toHaveBeenCalled();});
