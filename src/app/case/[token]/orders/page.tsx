import Link from 'next/link';
import {OrderRefundStatus} from '@/components/case/order-refund-status';
import {OrderCancellation} from '@/components/case/order-cancellation';
import {notFound,redirect} from 'next/navigation';
import {CaseShell} from '@/components/case/case-shell';
import {OrderPurchase,RefundRequest} from '@/components/case/order-purchase';
import {customerOrders} from '@/server/product/orders/service';
import {customerServiceClocks} from '@/server/product/orders/service-clock';
import {OrderServiceClock} from '@/components/case/order-service-clock';
import {listIdentityCases,resolveIdentitySession} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {guardStableAppEntrypoint} from '@/server/platform/capabilities/stable-next-entrypoint';
export const metadata={title:'הזמנות ותשלומים | תבדוק',robots:{index:false,follow:false}};
export default async function OrdersPage({params}:{params:Promise<{token:string}>}){
 await guardStableAppEntrypoint("CEP-111");const {token}=await params;const session=await resolveIdentitySession(await readCaseSessionCookie());if(!session)redirect('/login');const item=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===token);if(!item)notFound();
 const [ordersResult,clocksResult]=await Promise.allSettled([customerOrders(item.case_id,session.identity_id),customerServiceClocks(item.case_id,session.identity_id)]);
 const orders=ordersResult.status==='fulfilled'?ordersResult.value:null;
 const {clocks,observedAt}=clocksResult.status==='fulfilled'?clocksResult.value:{clocks:[],observedAt:0};
 return <CaseShell publicId={token} eyebrow={`תיק ${token}`}><h1>הזמנות ותשלומים</h1>{orders===null?<p role="alert">ההזמנות אינן זמינות כרגע. אפשר לרענן; זו אינה היסטוריה ריקה.</p>:<>{orders.length===0?<p>לא נמצאו הזמנות במסלול החדש. תשלום היסטורי שמופיע בתיק נשמר ואינו מחויב מחדש.</p>:orders.map(o=><article key={o.id} data-order-id={o.id}><h2>{o.kind==='full'?'דוח מלא':'בדיקה ראשונית'}</h2><p><bdi>{o.period_from.slice(0,7)} – {o.period_to.slice(0,7)}</bdi> · <bdi>{(o.amount_minor/100).toFixed(2)} ₪</bdi></p><p>{o.state==='paid'?'התשלום אומת':o.state==='cancelled'?'ההזמנה בוטלה':'התשלום טרם אומת'}</p><OrderRefundStatus order={o}/>{o.receipt_url?<a href={o.receipt_url} rel="noreferrer">הקבלה מהספק</a>:<p>קבלה מהספק טרם קושרה להזמנה.</p>}{o.state==='paid'?<OrderServiceClock publicId={token} clock={clocks.find(c=>c.order_id===o.id)} observedAt={observedAt}/>:null}<OrderCancellation publicId={token} order={o}/><RefundRequest publicId={token} order={o}/></article>)}<OrderPurchase publicId={token}/></>}<Link href={`/case/${token}`}>חזרה לתיק</Link></CaseShell>;
}
