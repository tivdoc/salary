import Link from 'next/link';
import {orderClockView,type ServiceClock} from '@/server/product/orders/service-clock';
function duration(ms:number){const minutes=Math.ceil(ms/60000),hours=Math.floor(minutes/60);return hours?`${hours} שעות${minutes%60?` ו־${minutes%60} דקות`:''}`:`${minutes} דקות`;}
export function OrderServiceClock({clock,publicId,observedAt}:{clock:ServiceClock|undefined;publicId:string;observedAt:number}){
 if(!clock)return <p>זמן הטיפול בהזמנה אינו זמין כרגע.</p>;
 const view=orderClockView(clock,observedAt);
 if(view.state==='unavailable')return <p>אין כרגע נתון מאומת על יתרת זמן השירות להזמנה.</p>;
 return <div aria-label="זמן טיפול בהזמנה">
  <p>{view.state==='completed'?'הדוח פורסם וזמן הטיפול נסגר.':view.state==='paused'?'זמן הטיפול מושהה עד להשלמת הפרטים המבוקשים.':view.state==='overdue'?'זמן השירות שהוקצה להזמנה חלף. ההזמנה עדיין בטיפול.':`נותרו ${duration(view.remainingMs!)} מזמן השירות שהוקצה להזמנה.`}</p>
  {view.blockingRequests.map(id=><p key={id}><Link href={`/case/${publicId}/thread#request-${id}`}>לפרטים שצריך להשלים</Link></p>)}
  <p className="muted">{clock.track==='human'?'זמן השירות נספר בימים א׳–ה׳, 09:00–17:00, לפי לוח השירות שנשמר בהזמנה ובהפחתת זמני השלמה.':'זמן השירות נספר בדקות שחלפו, בהפחתת זמני השלמה.'} נכון ל־<bdi>{new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short'}).format(observedAt)}</bdi>.</p>
 </div>;
}
