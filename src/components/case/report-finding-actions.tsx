"use client";
import {useEffect,useId,useState,useRef} from 'react';
import {useRouter} from 'next/navigation';
import {readSupportDraft,writeSupportDraft,supportDraftKey,type SupportDraft} from './support-recovery';
export function ReportFindingActions({publicId,reportId,findingId,text}:{publicId:string;reportId:string;findingId:string;text:string}){
 const fieldId=useId(),router=useRouter(),working=useRef(false);
 const key=supportDraftKey(publicId,`finding:${reportId}:${findingId}`);
 const [draft,setDraft]=useState<SupportDraft>({message:'',pendingId:null,updatedAt:0});
 const [readyKey,setReadyKey]=useState(''),[notice,setNotice]=useState(''),[copyNotice,setCopyNotice]=useState(''),[busy,setBusy]=useState(false);
 const ready=readyKey===key;
 useEffect(()=>{
  let restored:SupportDraft|null=null;try{restored=readSupportDraft(sessionStorage,key);}catch{/* optional browser storage */}
  // eslint-disable-next-line react-hooks/set-state-in-effect -- recover tab state only after matching server/client initial HTML.
  setDraft(restored??{message:'',pendingId:null,updatedAt:0});setReadyKey(key);
  setNotice(restored?.pendingId?'לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.':restored?'הטיוטה שוחזרה בלשונית זו. היא טרם נשלחה.':'');
 },[key]);
 function remember(value:SupportDraft|null){try{return writeSupportDraft(sessionStorage,key,value);}catch{return false;}}
 function edit(message:string){
  if(!ready||working.current||draft.pendingId!==null)return;
  const next={message,pendingId:null,updatedAt:Date.now()};setDraft(next);
  setNotice(remember(next)?'הטיוטה נשמרת בלשונית זו עד 24 שעות, וטרם נשלחה.':'השמירה בלשונית אינה זמינה. הטקסט יישאר כאן עד רענון או יציאה.');
 }
 async function submit(){
  if(!ready||working.current||draft.message.trim().length<4)return;
  working.current=true;setBusy(true);
  const pending={...draft,pendingId:draft.pendingId??crypto.randomUUID(),updatedAt:Date.now()};setDraft(pending);
  const recoverable=remember(pending);
  try{
   const response=await fetch(`/api/cases/${publicId}/reports`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({id:pending.pendingId,reportId,findingId,message:pending.message})});
   if(!response.ok||(await response.json()).state!=='pending')throw new Error('CORRECTION_ACK_MISSING');
   remember(null);setDraft({message:'',pendingId:null,updatedAt:0});setNotice('הבקשה נשמרה בשרשור התמיכה בתיק. הדוח הקיים נשמר עד לסיום הבדיקה.');router.refresh();
  }catch{setNotice(recoverable?'לא התקבל אישור שמירה. הטקסט נשאר כאן ואפשר לנסות שוב.':'לא התקבל אישור שמירה. אפשר לנסות שוב כאן; רענון ימחק את פרטי הניסיון כי השמירה בלשונית אינה זמינה.');}
  finally{working.current=false;setBusy(false);}
 }
 return <div className="thread-answer">
  {text?<><div className="field"><label htmlFor={`${fieldId}-inquiry`}>נוסח לבקשת בירור</label><textarea id={`${fieldId}-inquiry`} dir="auto" readOnly value={text} rows={4}/></div><button className="button button--secondary" type="button" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopyNotice('הנוסח הועתק.');}catch{setCopyNotice('אפשר לבחור את הטקסט ולהעתיק ידנית.');}}}>העתקת הנוסח</button><p role="status">{copyNotice}</p></>:null}
  <details id={`correction-${findingId}`}><summary>שאלה או תיקון לממצא הזה</summary>
   <div className="field"><label htmlFor={fieldId}>מה דורש בדיקה נוספת?</label><textarea id={fieldId} dir="auto" aria-describedby={`${fieldId}-status`} maxLength={2000} value={draft.message} onChange={e=>edit(e.target.value)} rows={3} disabled={!ready||busy||draft.pendingId!==null}/></div>
   <button className="button button--primary" type="button" disabled={!ready||busy||draft.message.trim().length<4} onClick={submit}>{busy?'שומרים…':'שמירת בקשת בירור'}</button>
  </details><p id={`${fieldId}-status`} role="status">{notice}</p>
 </div>;
}
