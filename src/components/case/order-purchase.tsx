"use client";
import {useState} from 'react';
import Link from 'next/link';
import type {ProductOrder} from '@/server/product/orders/contracts';
import type {CustomerReleaseQuote} from '@/server/product/orders/service';
const names:Record<string,string>={minimum_wage:'שכר מינימום',working_time:'שעות עבודה',pension:'פנסיה',travel:'נסיעות',convalescence:'הבראה',vacation:'חופשה',sick_leave:'מחלה',rest_day:'יום מנוחה',bonuses:'בונוסים',contract:'חוזה'};
export function orderPurchaseTopicLabels(topics:readonly string[]){return topics.map(topic=>names[topic]??topic).join(', ');}
export function SavedQuoteSummary({quote,orderReady,publicId}:{quote:CustomerReleaseQuote;orderReady:boolean;publicId?:string}){
 return <div aria-label="הצעת מחיר שמורה"><p>תקופת ההצעה: <bdi>{quote.from} – {quote.to}</bdi>. הנושאים: {orderPurchaseTopicLabels(quote.topics)}.</p>
  <p>מחיר כולל: <bdi>{(quote.total_minor/100).toFixed(2)} ₪</bdi>; זיכוי התשלום הראשוני: <bdi>{(quote.credit_minor/100).toFixed(2)} ₪</bdi>; יתרה לתשלום: <bdi>{(quote.balance_minor/100).toFixed(2)} ₪</bdi>.</p>
  <p>ההצעה בתוקף עד <bdi>{new Date(quote.expires_at).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem'})}</bdi>, שעון ישראל.</p>
  {!orderReady?<p>ההצעה נשמרה, אך טרם נפתחה עבורה הזמנה לתשלום. {publicId?<Link href={`/case/${publicId}/thread`}>בירור בתיק</Link>:null}</p>:null}</div>;
}
function servicePromise(offer:ProductOrder['offer']){
 const sla=offer.sla;
 if('budget_ms' in sla)return sla.track==='business'?`עד ${sla.budget_ms/3600000} שעות עסקים. `:`עד ${sla.budget_ms/60000} דקות. `;
 return `${sla.automatic_ms!==null?`עד ${sla.automatic_ms/60000} דקות במסלול אוטומטי; `:''}עד ${sla.human_ms/3600000} שעות עסקים במסלול טיפול. `;
}
export function OrderPurchase({publicId,initial=false}:{publicId?:string;initial?:boolean}){
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[order,setOrder]=useState<ProductOrder|null>(null),[quote,setQuote]=useState<CustomerReleaseQuote|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function send(action:'quote'|'checkout'){
  setBusy(true);setError('');if(action==='quote')setQuote(null);try{const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='quote'?{action,publicId,...(!initial?{request:{kind:'full',from,to}}:{})}:{action,publicId,orderId:order?.id,termsAccepted:accepted})});const result=await response.json();if(!response.ok)throw new Error(result.error??'הבקשה לא הושלמה');if(result.url)window.location.assign(result.url);else{setOrder(result.order??null);setQuote(result.quote??null);setAccepted(false);}}catch(e){setError(e instanceof Error?e.message:'הבקשה לא הושלמה');}finally{setBusy(false);}
 }
 return <section className="payment-card"><h1>{initial?'בדיקה ראשונית':'הזמנת דוח מלא'}</h1><p>{initial?'חודש תלוש אחד ועד שלושה נושאים שניתן לבדוק.':'בחרו תקופה. נציג את הכיסוי הזמין ואת המחיר לפני אישור תשלום.'}</p>
 {quote?<SavedQuoteSummary quote={quote} orderReady={order!==null} publicId={publicId}/>:null}
 {!order?<><div>{!initial?<><label>מחודש <input type="month" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>עד חודש <input type="month" value={to} onChange={e=>setTo(e.target.value)}/></label></>:null}</div><button className="button button--primary" disabled={busy||!initial&&(!from||!to||from>to)} onClick={()=>send('quote')}>{busy?'בודקים זמינות…':'הצגת מחיר וכיסוי'}</button></>:<>
 <p>תקופה: <bdi>{order.period_from.slice(0,7)} – {order.period_to.slice(0,7)}</bdi></p><p>מחיר ההזמנה: <strong><bdi>{(order.amount_minor/100).toFixed(2)} ₪</bdi></strong></p><p>הנושאים הכלולים: {orderPurchaseTopicLabels(order.topics)}. נושאים אחרים אינם כלולים בהזמנה.</p><p>{order.offer.human_review_required?'הזמנה זו כוללת בדיקה אנושית לפי תנאיה השמורים.': 'בדיקת AI לפי הכיסוי שנרכש.'} זמן השירות שנשמר בהזמנה: {servicePromise(order.offer)}שעות עסקים: א׳–ה׳ 09:00–17:00, שעון ישראל, ללא חגים. זמן המתנה להשלמה שחוסמת את ההזמנה אינו נספר.</p>
 <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> קראתי את <Link href="/terms" target="_blank">תנאי השימוש</Link> ו<Link href="/privacy" target="_blank">הפרטיות</Link>, ואני מאשר את התקופה, הכיסוי והמחיר המוצגים.</label><button className="button button--primary" disabled={busy||!accepted} onClick={()=>send('checkout')}>{busy?'פותחים תשלום…':'מעבר לתשלום מאובטח'}</button></>}
 {error?<p role="alert">{error} {!initial&&publicId?<Link href={`/case/${publicId}/thread`}>בירור בתיק</Link>:null}</p>:null}<p>חזרה מסליקה אינה אישור תשלום. ההזמנה מתעדכנת לאחר אימות הספק.</p></section>;
}
export function RefundRequest({publicId,order}:{publicId:string;order:ProductOrder}){
 const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function send(){setBusy(true);try{const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refund',publicId,orderId:order.id,id:crypto.randomUUID(),reason})});if(!response.ok)throw new Error();setMessage('בקשת הביטול או ההחזר נקלטה לבדיקה. הכסף טרם הוחזר.');}catch{setMessage('לא ניתן לאשר שהבקשה נקלטה. אפשר לנסות שוב.');}finally{setBusy(false);}}
 if(order.state!=='paid')return null;
 return <details><summary>בקשת ביטול או החזר</summary><label>פרטי הבקשה <textarea maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={busy||reason.trim().length<4} onClick={send}>שליחת בקשה לבדיקה</button><p role="status">{message}</p></details>;
}
