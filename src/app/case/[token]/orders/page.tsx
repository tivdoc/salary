import Link from 'next/link';
import {notFound,redirect} from 'next/navigation';
import {CaseShell} from '@/components/case/case-shell';
import {OrderPurchase,RefundRequest} from '@/components/case/order-purchase';
import {customerOrders} from '@/server/product/orders/service';
import {listIdentityCases,resolveIdentitySession} from '@/server/product/case-access/service';
import {readCaseSessionCookie} from '@/server/product/case-access/session-cookie';
import {guardStableAppEntrypoint} from '@/server/platform/capabilities/stable-next-entrypoint';
export const metadata={title:'הזמנות ותשלומים | תבדוק',robots:{index:false,follow:false}};
export default async function OrdersPage({params}:{params:Promise<{token:string}>}){
 await guardStableAppEntrypoint("CEP-111");const {token}=await params;const session=await resolveIdentitySession(await readCaseSessionCookie());if(!session)redirect('/login');const item=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===token);if(!item)notFound();
 let orders=null;try{orders=await customerOrders(item.case_id,session.identity_id);}catch{}
 return <CaseShell publicId={token} eyebrow={`תיק ${token}`}><h1>הזמנות ותשלומים</h1>{orders===null?<p role="alert">ההזמנות אינן זמינות כרגע. אפשר לרענן; זו אינה היסטוריה ריקה.</p>:<>{orders.length===0?<p>לא נמצאו הזמנות במסלול החדש. תשלום היסטורי שמופיע בתיק נשמר ואינו מחויב מחדש.</p>:orders.map(o=><article key={o.id}><h2>{o.kind==='full'?'דוח מלא':'בדיקה ראשונית'}</h2><p><bdi>{o.period_from.slice(0,7)} – {o.period_to.slice(0,7)}</bdi> · <bdi>{(o.amount_minor/100).toFixed(2)} ₪</bdi></p><p>{o.state==='paid'?'התשלום אומת':o.state==='cancelled'?'ההזמנה בוטלה':'התשלום טרם אומת'} · {o.refund_state==='requested'?'בקשת ההחזר בבדיקה; הכסף טרם הוחזר':o.refund_state==='refunded'?'ההחזר אומת':o.refund_state==='none'?'אין בקשת החזר':'בקשת ההחזר בטיפול'}</p>{o.receipt_url?<a href={o.receipt_url} rel="noreferrer">הקבלה מהספק</a>:<p>קבלה מהספק טרם קושרה להזמנה.</p>}<RefundRequest publicId={token} order={o}/></article>)}<OrderPurchase publicId={token}/></>}<Link href={`/case/${token}`}>חזרה לתיק</Link></CaseShell>;
}
