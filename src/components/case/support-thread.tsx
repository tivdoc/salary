"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import type {SupportThread} from '@/server/product/reports/support';
import {readSupportDraft,writeSupportDraft,supportDraftKey,type SupportDraft} from './support-recovery';
const states={open:'ממתינה למענה',waiting_customer:'ממתינה לתשובתך',resolved:'טופלה'};
function SupportForm({publicId,threadId}:{publicId:string;threadId?:string}){
 const fieldId=useId(),router=useRouter(),working=useRef(false),key=supportDraftKey(publicId,threadId);
 const [draft,setDraft]=useState<SupportDraft>({message:'',pendingId:null,updatedAt:0});
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{
  let restored:SupportDraft|null=null;try{restored=readSupportDraft(sessionStorage,key);}catch{/* blocked browser storage */}
  // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate tab storage after identical server/client initial HTML.
  setDraft(restored??{message:'',pendingId:null,updatedAt:0});setReady(true);
  setNotice(restored?.pendingId?'לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.':restored?'הטיוטה שוחזרה בלשונית זו. היא טרם נשלחה.':'');
 },[key]);
 function remember(value:SupportDraft|null){try{return writeSupportDraft(sessionStorage,key,value);}catch{return false;}}
 function edit(message:string){const value={message,pendingId:null,updatedAt:Date.now()};setDraft(value);setNotice(remember(value)?'הטיוטה נשמרת בלשונית זו עד 24 שעות, וטרם נשלחה.':'השמירה בלשונית אינה זמינה. הטקסט יישאר כאן עד רענון או יציאה.');}
 async function send(){
  if(working.current||!ready||draft.message.trim().length<4)return;
  working.current=true;setBusy(true);
  const pending={...draft,pendingId:draft.pendingId??crypto.randomUUID(),updatedAt:Date.now()};
  setDraft(pending);const recoverable=remember(pending);
  try{
   const r=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:pending.pendingId,message:pending.message,action:threadId?'support_reply':'support_open',...(threadId?{threadId}:{})})});
   if(!r.ok||(await r.json()).ok!==true)throw new Error();
   remember(null);setDraft({message:'',pendingId:null,updatedAt:0});setNotice('ההודעה נשמרה בשרשור התמיכה.');router.refresh();
  }catch{setNotice(recoverable?'לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.':'לא התקבל אישור שמירה. אפשר לנסות שוב כאן; רענון ימחק את פרטי הניסיון כי השמירה בלשונית אינה זמינה.');}
  finally{working.current=false;setBusy(false);}
 }
 return <div className="thread-answer">
  <label className="field" htmlFor={fieldId}>
   <span>{threadId?'הוספת תשובה לפנייה':'פרטי הפנייה לתמיכה'}</span>
   <textarea id={fieldId} dir="auto" aria-describedby={notice?`${fieldId}-status`:undefined} value={draft.message} onChange={e=>edit(e.target.value)} maxLength={2000} rows={4} disabled={!ready||busy||draft.pendingId!==null}/>
  </label>
  <button className="button button--primary" type="button" disabled={!ready||busy||draft.message.trim().length<4} onClick={send}>{busy?'שומרים…':'שליחת הודעה'}</button>
  <p id={`${fieldId}-status`} role="status">{notice}</p>
 </div>;
}
export function SupportThreadView({publicId,threads}:{publicId:string;threads:readonly SupportThread[]}){
 return <section className="support-threads" id="support" aria-labelledby="support-title"><h2 id="support-title">פנייה לתמיכה</h2><p>אפשר לשאול או לבקש תיקון. תשובת תמיכה אינה אישור מקצועי לממצא. ההודעות והתשובות נשמרות כאן בתיק.</p><SupportForm key={publicId} publicId={publicId}/>{threads.length===0?<p>עדיין אין פניות תמיכה בתיק.</p>:threads.map(t=><article key={t.id}><h3>{t.origin==='finding'?'שאלה או תיקון מתוך ממצא':'פנייה מהתיק'} · {states[t.state]}</h3>{t.report_id?<Link href={`/case/${publicId}/reports#correction-${t.finding_id}`}>לממצא שממנו נפתחה הפנייה</Link>:null}<ol>{t.messages.map(m=><li key={m.id}><strong>{m.author_kind==='owner'?'תמיכת תבדוק':'ההודעה שלך'}</strong><time dateTime={m.created_at}>{new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short'}).format(new Date(m.created_at))}</time><p>{m.message}</p></li>)}</ol><SupportForm key={`${publicId}:${t.id}`} publicId={publicId} threadId={t.id}/></article>)}</section>;
}
