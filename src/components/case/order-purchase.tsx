"use client";
import {useState} from 'react';
import Link from 'next/link';
import {termsVersionHref,privacyVersionHref,hasReportNotificationTerms,REPORT_NOTIFICATION_NOTICE} from '@/lib/legal-terms';
import type {ProductOrder} from '@/server/product/orders/contracts';
import type {CustomerReleaseQuote,CustomerSavedReleaseQuoteResult} from '@/server/product/orders/service';
const names:Record<string,string>={minimum_wage:'שכר מינימום',working_time:'שעות עבודה',pension:'פנסיה',travel:'נסיעות',convalescence:'הבראה',vacation:'חופשה',sick_leave:'מחלה',rest_day:'יום מנוחה',bonuses:'בונוסים',contract:'חוזה'};
export function orderPurchaseTopicLabels(topics:readonly string[]){return topics.map(topic=>names[topic]??topic).join(', ');}
export function OrderTermsDisclosure({version}:{version:string}){
 return <><p>גרסת התנאים השמורה בהזמנה: <bdi>{version}</bdi>.</p>{hasReportNotificationTerms(version)?<p>{REPORT_NOTIFICATION_NOTICE}</p>:null}</>;
}
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
type SavedOfferAvailability=CustomerSavedReleaseQuoteResult['availability'];
const availabilityMessages:Record<SavedOfferAvailability['state'],string>={
 ready:'ההצעה השמורה זמינה לתקופה ולכיסוי המוצגים.',
 needs_information:'נדרשת השלמת מידע בתיק לפני שאפשר להציג הצעת המשך.',
 conditional_result:'התוצאה הקיימת תלויה בתנאים שטרם הושלמו. עדיין אין הצעת המשך לתשלום.',
 comparison_needs_review:'ההשוואה בתיק דורשת בירור לפני שאפשר להציג הצעת המשך.',
 coverage_unavailable:'עדיין אין כיסוי מאומת להצעת המשך עבור התקופה בתיק.',
 order_needs_review:'מצב ההזמנה דורש בירור לפני שאפשר להציע תשלום נוסף.',
 quote_expired:'תוקף ההצעה השמורה פג. צריך להכין הצעה מעודכנת לפני תשלום.',
 below_upgrade_threshold:'לפי התוצאה השמורה, לא מוצעת כרגע רכישת דוח המשך.',
 not_prepared:'עדיין לא נשמרה בתיק הצעת המשך זמינה לתשלום.',
};
export function SavedOfferAvailability({availability}:{availability:SavedOfferAvailability}){
 return <div role="status"><p>{availabilityMessages[availability.state]}</p>{availability.period?<p>התקופה שנבדקה: <bdi>{availability.period.from} – {availability.period.to}</bdi>.</p>:null}</div>;
}
export function OrderPurchase({publicId,initial=false}:{publicId?:string;initial?:boolean}){
 const [order,setOrder]=useState<ProductOrder|null>(null),[quote,setQuote]=useState<CustomerReleaseQuote|null>(null),[availability,setAvailability]=useState<SavedOfferAvailability|null>(null),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function send(action:'quote'|'checkout'){
  setBusy(true);setError('');if(action==='quote'){setQuote(null);setOrder(null);setAvailability(null);setAccepted(false);}
  try{
   const body=action==='quote'?{action:initial?'quote':'saved_quote',publicId}:{action,publicId,orderId:order?.id,termsAccepted:accepted};
   const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const result=await response.json();if(!response.ok)throw new Error(result.error??'הבקשה לא הושלמה');
   if(result.url)window.location.assign(result.url);else{setOrder(result.order??null);setQuote(result.quote??null);setAvailability(result.availability??null);setAccepted(false);}
  }catch(e){setError(e instanceof Error?e.message:'הבקשה לא הושלמה');}finally{setBusy(false);}
 }
 return <section className="payment-card"><h1>{initial?'בדיקה ראשונית':'הזמנת דוח מלא'}</h1><p>{initial?'חודש תלוש אחד ועד שלושה נושאים שניתן לבדוק.':'כאן אפשר לראות הצעה שנשמרה לתיק, לתקופה ולכיסוי המופיעים בה. רכישה לתקופה אחרת עדיין אינה זמינה במסך זה.'}</p>
 {availability&&availability.state!=='ready'?<><SavedOfferAvailability availability={availability}/>{publicId?<p><Link href={`/case/${publicId}/thread`}>להשלמת מידע או בירור בתיק</Link></p>:null}</>:null}
 {quote?<SavedQuoteSummary quote={quote} orderReady={order!==null} publicId={publicId}/>:null}
 {!order?<button className="button button--primary" disabled={busy||!initial&&!publicId} onClick={()=>send('quote')}>{busy?'בודקים זמינות…':initial?'הצגת מחיר וכיסוי':'הצגת ההצעה השמורה'}</button>:<>
 <p>תקופה: <bdi>{order.period_from.slice(0,7)} – {order.period_to.slice(0,7)}</bdi></p><p>מחיר ההזמנה: <strong><bdi>{(order.amount_minor/100).toFixed(2)} ₪</bdi></strong></p><p>הנושאים הכלולים: {orderPurchaseTopicLabels(order.topics)}. נושאים אחרים אינם כלולים בהזמנה.</p><p>{order.offer.human_review_required?'הזמנה זו כוללת בדיקה אנושית לפי תנאיה השמורים.': 'בדיקת AI לפי הכיסוי שנרכש.'} זמן השירות שנשמר בהזמנה: {servicePromise(order.offer)}שעות עסקים: א׳–ה׳ 09:00–17:00, שעון ישראל, ללא חגים. זמן המתנה להשלמה שחוסמת את ההזמנה אינו נספר.</p>
 <OrderTermsDisclosure version={order.terms_version}/>
 <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)}/> קראתי את <Link href={termsVersionHref(order.terms_version)} target="_blank" rel="noreferrer">תנאי השימוש</Link> ו<Link href={privacyVersionHref(order.terms_version)} target="_blank" rel="noreferrer">הפרטיות</Link> בגרסה שנשמרה בהזמנה, ואני מאשר את התקופה, הכיסוי והמחיר המוצגים.</label><button className="button button--primary" disabled={busy||!accepted} onClick={()=>send('checkout')}>{busy?'פותחים תשלום…':'מעבר לתשלום מאובטח'}</button></>}
 {error?<p role="alert">{error} {!initial&&publicId?<Link href={`/case/${publicId}/thread`}>בירור בתיק</Link>:null}</p>:null}<p>חזרה מסליקה אינה אישור תשלום. ההזמנה מתעדכנת לאחר אימות הספק.</p></section>;
}
export function RefundRequest({publicId,order}:{publicId:string;order:ProductOrder}){
 const [reason,setReason]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function send(){setBusy(true);try{const response=await fetch('/api/payments/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refund',publicId,orderId:order.id,id:crypto.randomUUID(),reason})});if(!response.ok)throw new Error();setMessage('בקשת הביטול או ההחזר נקלטה לבדיקה. הכסף טרם הוחזר.');}catch{setMessage('לא ניתן לאשר שהבקשה נקלטה. אפשר לנסות שוב.');}finally{setBusy(false);}}
 if(order.state!=='paid')return null;
 return <details><summary>בקשת ביטול או החזר</summary><label>פרטי הבקשה <textarea maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={busy||reason.trim().length<4} onClick={send}>שליחת בקשה לבדיקה</button><p role="status">{message}</p></details>;
}
