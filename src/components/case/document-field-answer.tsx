"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';

type Action='confirm'|'correct'|'unreadable'|'unknown';
const labels:Record<Action,string>={confirm:'זה הערך בתא',correct:'הערך בתא שונה',unreadable:'לא קריא',unknown:'לא יודע'};
function previous(value:string|null|undefined):{action:Action|null;raw:string}{
 try{const parsed=JSON.parse(value??'');if(parsed.schema_version==='document-field-answer-v2'&&Object.hasOwn(labels,parsed.action))return {action:parsed.action,raw:typeof parsed.corrected_raw_value==='string'?parsed.corrected_raw_value:''};}catch{}
 return {action:null,raw:''};
}
export function DocumentFieldAnswer({request,publicId,onAnswered,correction=false}:{request:StoredRequest;publicId:string;onAnswered:()=>void;correction?:boolean}){
 const initial=previous(request.draft_text??(correction?request.answer_text:null));
 const [action,setAction]=useState<Action|null>(initial.action),[raw,setRaw]=useState(initial.raw),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const display=request.reading_display;
 async function submit(draft=false){
  if(!action||action==='correct'&&!raw.trim())return;
  setBusy(true);setError('');setConflict(false);
  const answer={schema_version:'document-field-answer-v2',action,...(action==='correct'?{corrected_raw_value:raw.trim()}:{})};
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    requestId:request.id,answer:JSON.stringify(answer),action:draft?'draft':correction?'correction':'answer',expectedRevision:draft?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}
  finally{setBusy(false);}
 }
 return <div className="thread-answer">
  {display?<div>
   <p>אימות תא אחד בעמוד {display.page}. האישור אינו חל על שאר המסמך או על הזכאות.</p>
   {display.raw_value!==null?<p>הקריאה המקורית: <bdi>{display.raw_value}</bdi></p>:null}
   {display.text_fragment?<blockquote>{display.text_fragment}</blockquote>:null}
   <p><a href={`/api/cases/${publicId}/requests?source=${request.id}&view=marked#page=${display.page}`} target="_blank" rel="noopener noreferrer">פתיחת המקור לסימון ולאימות</a></p>
   {!display.bounding_box?<p>לא התקבל מיקום מדויק של התא. יש לבדוק את הערך בעמוד המקור לפני אישור.</p>:null}
  </div>:null}
  <div role="group" aria-label="תוצאת בדיקת התא" className="option-row">{(Object.keys(labels) as Action[]).map(value=><button key={value} type="button" className={action===value?'option-button is-selected':'option-button'} aria-pressed={action===value} disabled={busy||request.source_current===false} onClick={()=>setAction(value)}>{labels[value]}</button>)}</div>
  {action==='correct'?<label className="field"><span>הערך שמופיע בתא המקור</span><input value={raw} maxLength={500} disabled={busy} onChange={event=>setRaw(event.target.value)} aria-invalid={!!error}/><span>יש להעתיק את התא עצמו. סכום שחושב בנפרד או הערכה אינם תיקון קריאה.</span></label>:null}
  {action==='unknown'||action==='unreadable'?<p>המקור והסתירות יישמרו. בדיקות שתלויות בתא הזה יישארו פתוחות; בדיקות עצמאיות יוכלו להמשיך.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  <button className="button button--primary" type="button" disabled={busy||!action||action==='correct'&&!raw.trim()||request.source_current===false} onClick={()=>void submit()}>{busy?'שומרים…':correction?'שמירת תיקון הקריאה':'שמירת בדיקת התא'}</button>
  <button className="button button--secondary" type="button" disabled={busy||!action||action==='correct'&&!raw.trim()||request.source_current===false} onClick={()=>void submit(true)}>שמירת טיוטה</button>
 </div>;
}
