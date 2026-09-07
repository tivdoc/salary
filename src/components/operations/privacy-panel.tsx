"use client";
import {useState} from 'react';
type Row={id:string;public_id:string;kind:string;message:string;due_at:string};
export function PrivacyPanel({csrfToken}:{csrfToken:string}){
 const [rows,setRows]=useState<Row[]|null>(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);try{const r=await fetch('/api/operations/privacy/queue',{cache:'no-store'});if(!r.ok)throw new Error();const body=await r.json();if(!Array.isArray(body.data?.value))throw new Error();setRows(body.data.value);setError('');}catch{setError('תור הפרטיות אינו זמין');}finally{setBusy(false);}}
 async function decide(id:string,state:'in_review'|'restricted'){setBusy(true);try{const r=await fetch('/api/operations/privacy/decide',{method:'POST',headers:{'Content-Type':'application/json','x-tivdoc-csrf':csrfToken},body:JSON.stringify({id,state,resolution:reason})});if(!r.ok)throw new Error();await load();}catch{setError('העדכון לא נשמר');}finally{setBusy(false);}}
 return <section><h2>בקשות פרטיות</h2><button disabled={busy} onClick={load}>טעינת בקשות</button>{error?<p role="alert">{error}</p>:null}{rows?.length===0?<p>אין בקשות פתוחות.</p>:null}<label>נימוק ללקוח <textarea maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label>{rows?.map(r=><article key={r.id}><h3>{r.public_id} · {r.kind}</h3><p>{r.message}</p><p>יעד טיפול: {new Date(r.due_at).toLocaleDateString('he-IL')}</p><button disabled={busy||reason.trim().length<4} onClick={()=>decide(r.id,'in_review')}>בטיפול</button><button disabled={busy||reason.trim().length<4} onClick={()=>decide(r.id,'restricted')}>הגבלת טיפול עם נימוק</button></article>)}<p>השלמה תירשם רק לאחר ביצוע בפועל ואסמכתה. שינוי מצב כאן אינו מוחק מידע.</p></section>;
}
