import type {legacyCustomerReceipts} from '@/server/product/orders/legacy-customer';
const topics={working_time:'זמני עבודה',pension:'פנסיה',vacation:'חופשה',convalescence:'הבראה',travel:'נסיעות',rest_day:'מנוחה שבועית',minimum_wage:'שכר מינימום',bonuses:'רכיבים נוספים',contract:'תנאי חוזה'};
export function LegacyPaidOrders({receipts}:{receipts:Awaited<ReturnType<typeof legacyCustomerReceipts>>}){
 return <>{receipts.map(receipt=><article key={receipt.id} data-legacy-order-id={receipt.id}>
  <h2>הבדיקה שנרכשה במסלול הקודם</h2><p>תקבול מאומת במידע השמור: <bdi>{(receipt.amount_minor/100).toFixed(2)} ₪</bdi>. חיבור ההזמנה אינו יוצר חיוב חדש.</p>
  <p>ההיקף שנשמר: {receipt.topics.map(topic=>topics[topic]).join(' · ')}.</p>
  <p>תקופת הרכישה לא נשמרה בהזמנה המקורית.</p>
  {receipt.period_state==='missing'?<p>חסרה תקופה מזוהה במסמכים. נדרש תלוש או מסמך עם תאריכי התקופה לפני ניתוח כספי.</p>
   :<p>תקופות שזוהו במקורות ונשמרו בנפרד: {receipt.periods.map((period,index)=><span key={index}><bdi>{period.from} – {period.to}</bdi>{index<receipt.periods.length-1?' · ':''}</span>)}.</p>}
 </article>)}</>;
}
