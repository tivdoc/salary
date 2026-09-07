"use client";
import {useId,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import type {SupportThread} from '@/server/product/reports/support';
const states={open:'ממתינה למענה',waiting_customer:'ממתינה לתשובתך',resolved:'טופלה'};
function SupportForm({publicId,threadId}:{publicId:string;threadId?:string}){
 const fieldId=useId(),router=useRouter(),retry=useRef<{id:string;message:string}|null>(null);
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 async function send(){if(busy)return;setBusy(true);if(retry.current?.message!==message)retry.current={id:crypto.randomUUID(),message};try{const r=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...retry.current,action:threadId?'support_reply':'support_open',...(threadId?{threadId}:{})})});if(!r.ok)throw new Error();retry.current=null;setMessage('');setNotice('ההודעה נשמרה בשרשור התמיכה.');router.refresh();}catch{setNotice('לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.');}finally{setBusy(false);}}
 return <div><label htmlFor={fieldId}>{threadId?'הוספת תשובה לפנייה':'פרטי הפנייה לתמיכה'}</label><textarea id={fieldId} value={message} onChange={e=>setMessage(e.target.value)} maxLength={2000} rows={4} disabled={busy}/><button type="button" disabled={busy||message.trim().length<4} onClick={send}>{busy?'שומרים…':'שליחת הודעה'}</button><p role="status">{notice}</p></div>;
}
export function SupportThreadView({publicId,threads}:{publicId:string;threads:readonly SupportThread[]}){
 return <section className="support-threads" id="support" aria-labelledby="support-title"><h2 id="support-title">פנייה לתמיכה</h2><p>אפשר לשאול או לבקש תיקון. תשובת תמיכה אינה אישור מקצועי לממצא. ההודעות והתשובות נשמרות כאן בתיק.</p><SupportForm publicId={publicId}/>{threads.length===0?<p>עדיין אין פניות תמיכה בתיק.</p>:threads.map(t=><article key={t.id}><h3>{t.origin==='finding'?'שאלה או תיקון מתוך ממצא':'פנייה מהתיק'} · {states[t.state]}</h3>{t.report_id?<Link href={`/case/${publicId}/reports#correction-${t.finding_id}`}>לממצא שממנו נפתחה הפנייה</Link>:null}<ol>{t.messages.map(m=><li key={m.id}><strong>{m.author_kind==='owner'?'תמיכת תבדוק':'ההודעה שלך'}</strong><time dateTime={m.created_at}>{new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short'}).format(new Date(m.created_at))}</time><p>{m.message}</p></li>)}</ol><SupportForm publicId={publicId} threadId={t.id}/></article>)}</section>;
}
