"use client";
import {useState} from 'react';
import Link from 'next/link';
import type {ProductOrder} from '@/server/product/orders/contracts';
const names:Record<string,string>={minimum_wage:'שכר מינימום',working_time:'שעות עבודה',pension:'פנסיה',travel:'נסיעות',convalescence:'הבראה',vacation:'חופשה',sick_leave:'מחלה'};
export function OrderPurchase({publicId,initial=false}:{publicId?:string;initial?:boolean}){
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[order,setOrder]=useState<ProductOrder|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function send(action:'quote'|'checkout'){
  setBusy(true);setError('');try{const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='quote'?{action,publicId,...(!initial?{request:{kind:'full',from,to}}:{})}:{action,publicId,orderId:order?.id,termsAccepted:accepted})});const result=await response.json();if(!response.ok)throw new Error(result.error??'הבקשה לא הושלמה');if(result.url)window.location.assign(result.url);else{setOrder(result.order);setAccepted(false);}}catch(e){setError(e instanceof Error?e.message:'הבקשה לא הושלמה');}finally{setBusy(false);}
 }
 return <section className="payment-card"><h1>{initial?'בדיקה ראשונית':'הזמנת דוח מלא'}</h1><p>{initial?'חודש תלוש אחד ועד שלושה נושאים שניתן לבדוק.':'בחרו תקופה. נציג את הכיסוי הזמין ואת המחיר לפני אישור תשלום.'}</p>
 {!order?<><div>{!initial?<><label>מחודש <input type="month" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>עד חודש <input type="month" value={to} onChange={e=>setTo(e.target.value)}/></label></>:null}</div><button className="button button--primary" disabled={busy||!initial&&(!from||!to||from>to)} onClick={()=>send('quote')}>{busy?'בודקים זמינות…':'הצגת מחיר וכיסוי'}</button></>:<>
 <p>תקופה: <bdi>{order.period_from.slice(0,7)} – {order.period_to.slice(0,7)}</bdi></p><p>מחיר ההזמנה: <strong><bdi>{(order.amount_minor/100).toFixed(2)} ₪</bdi></strong></p><p>הנושאים הכלולים: {order.topics.map(t=>names[t]??t).join(', ')}. נושאים אחרים אינם כלולים בהזמנה.</p><p>{order.offer.human_review_required?'הזמנה זו כוללת בדיקה אנושית לפי תנאיה השמורים.': 'בדיקת AI לפי הכיסוי שנרכש.'} זמן השירות שנשמר בהזמנה: {order.offer.sla.automatic_ms!==null?`עד ${order.offer.sla.automatic_ms/60000} דקות במסלול אוטומטי; `:''}{`עד ${order.offer.sla.human_ms/3600000} שעות עסקים במסלול טיפול`} שעות עסקים: א׳–ה׳ 09:00–17:00, שעון ישראל, ללא חגים. זמן המתנה להשלמה שחוסמת את ההזמנה אינו נספר.</p>
 <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> קראתי את <Link href="/terms" target="_blank">תנאי השימוש</Link> ו<Link href="/privacy" target="_blank">הפרטיות</Link>, ואני מאשר את התקופה, הכיסוי והמחיר המוצגים.</label><button className="button button--primary" disabled={busy||!accepted} onClick={()=>send('checkout')}>{busy?'פותחים תשלום…':'מעבר לתשלום מאובטח'}</button></>}
 {error?<p role="alert">{error}</p>:null}<p>חזרה מסליקה אינה אישור תשלום. ההזמנה מתעדכנת לאחר אימות הספק.</p></section>;
}
export function RefundRequest({publicId,order}:{publicId:string;order:ProductOrder}){
 const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function send(){setBusy(true);try{const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refund',publicId,orderId:order.id,id:crypto.randomUUID(),reason})});if(!response.ok)throw new Error();setMessage('בקשת הביטול או ההחזר נקלטה לבדיקה. הכסף טרם הוחזר.');}catch{setMessage('לא ניתן לאשר שהבקשה נקלטה. אפשר לנסות שוב.');}finally{setBusy(false);}}
 if(order.state!=='paid')return null;
 return <details><summary>בקשת ביטול או החזר</summary><label>פרטי הבקשה <textarea maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={busy||reason.trim().length<4} onClick={send}>שליחת בקשה לבדיקה</button><p role="status">{message}</p></details>;
}
