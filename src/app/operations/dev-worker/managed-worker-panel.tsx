'use client';
import {useRef,useState} from 'react';
import type {ManagedWorkerStatus} from '@/server/product/processing/managed-worker-contract';

const labels={waiting:'ממתין',processing:'בעיבוד',awaiting_input:'ממתין להשלמה',failed:'נכשל',complete:'ריצת DEV הושלמה'};
export function ManagedWorkerPanel({initial,unavailable,csrfToken}:{initial:ManagedWorkerStatus[];unavailable:boolean;csrfToken:string}){
 const [rows,setRows]=useState(initial),[message,setMessage]=useState(unavailable?'מצב העובד אינו זמין כרגע.':''),[busy,setBusy]=useState(false);
 const inFlight=useRef(false);
 async function refresh(){
  const response=await fetch('/api/operations/dev-worker',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error();const value=await response.json();if(!Array.isArray(value.data))throw Error();setRows(value.data);
 }
 async function perform(row?:ManagedWorkerStatus){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setMessage('');
  try{
   if(row){
    const response=await fetch('/api/operations/dev-worker',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-tivdoc-csrf':csrfToken},
     body:JSON.stringify({action:'retry',caseId:row.case_id,jobId:row.job_id,expectedRevision:row.job_revision})});
    if(!response.ok){setMessage('הניסיון לא אושר. ייתכן שהמצב השתנה, המכסה מוצתה או שתוצאת ספק דורשת בירור.');await refresh();return;}
    setMessage('אושר ניסיון נוסף. הוא יבוצע במחזור התזמון הבא.');
   }
   await refresh();
  }catch{setMessage('לא התקבל אישור עדכני. רענון המצב מאפשר לבדוק מה נשמר לפני ניסיון נוסף.');}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <section aria-busy={busy}><button type="button" disabled={busy} onClick={()=>void perform()}>רענון מצב</button><p role="status">{message}</p>
  {rows.length===0?<p>אין תיקי DEV רשומים להצגה.</p>:<div style={{overflowX:'auto'}}><table><caption>המצב נגזר מהתור ומהקלט השמור</caption>
   <thead><tr><th>תיק</th><th>מצב</th><th>גרסת קלט</th><th>ניסיונות</th><th>שגיאה אחרונה</th><th>פעולה</th></tr></thead>
   <tbody>{rows.map(row=><tr key={row.case_id}><td dir="ltr">{row.case_id}</td><td>{labels[row.state]}</td><td>{row.input_revision??'—'}</td>
    <td>{row.attempt_count}/{row.max_attempts}</td><td dir="ltr">{row.last_error??'—'}</td><td>{row.state==='failed'&&row.job_id&&row.job_revision&&row.max_attempts<5?
     <button type="button" disabled={busy} onClick={()=>void perform(row)}>אישור ניסיון נוסף לתיק זה</button>:'—'}</td></tr>)}</tbody>
  </table></div>}</section>;
}
