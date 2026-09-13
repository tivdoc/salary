'use client';
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import type {EvidenceSourceTranscriptionContext} from '@/engine/extraction/document-evidence/source-transcription';
import {buildEvidenceSourceAnswer,initialEvidenceSourceDraft,type EvidenceSourceAction as Action} from '@/lib/document-evidence-source-display';
export {buildEvidenceSourceAnswer,initialEvidenceSourceDraft,displayEvidenceSourceAnswer} from '@/lib/document-evidence-source-display';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';

type Props={request:StoredRequest;context:EvidenceSourceTranscriptionContext;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean};
export function DocumentEvidenceSourceTranscriptionAnswer({request,context,publicId,onAnswered,correction=false,sourceShared=false}:Props){
 const [initial]=useState(()=>initialEvidenceSourceDraft(request.draft_text??(correction?request.answer_text:null)));
 const [action,setAction]=useState<Action|null>(initial.action),[draft,setDraft]=useState(initial.draft);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const disabled=busy||request.source_current!==true,answer=buildEvidenceSourceAnswer(action,draft,context);
 const sourcePage=context.page??(/^[1-9][0-9]*$/u.test(draft.page??'')&&Number(draft.page)<=context.page_count?Number(draft.page):1);
 async function submit(saveDraft=false,selected=action){
  if(disabled)return;
  const value=buildEvidenceSourceAnswer(selected,draft,context);if(!value)return;
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    requestId:request.id,answer:JSON.stringify(value),action:saveDraft?'draft':correction?'correction':'answer',expectedRevision:saveDraft?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}finally{setBusy(false);}
 }
 return <div className="thread-answer">
  <p>העתקת סעיף כספי {context.page===null?'ממסמך תנאי ההעסקה':`מעמוד ${context.page} במסמך תנאי ההעסקה`}. שמירת הקריאה אינה מאשרת זכאות, תחולה משפטית או תשלום.</p>
  {!sourceShared?<p><a href={`/api/cases/${publicId}/requests?source=${request.id}#page=${sourcePage}`} target="_blank" rel="noopener noreferrer">פתיחת עמוד המקור לקריאת הסעיף</a></p>:null}
  <p>יש להעתיק את הסעיף במלואו, כולל תנאים, חריגים והפניות שבו. אין להשלים נוסח לפי התלוש, סכום שחושב או מידע שאינו בעמוד הזה. אם לא מופיע סעיף מתאים, בחרו לא יודע.</p>
  {request.reading_display?.dependent_checks?.length?<p>הקריאה משמשת לבדיקה: {request.reading_display.dependent_checks.join(' · ')}.</p>:null}
  <div role="group" aria-label="תוצאת קריאת הסעיף" className="option-row">{(['correct','unreadable','unknown'] as const).map(value=><button type="button" key={value} disabled={disabled}
   aria-pressed={action===value} className={action===value?'option-button is-selected':'option-button'} onClick={()=>{setAction(value);if(value!=='correct')void submit(false,value);}}>
   {value==='correct'?'העתקת הסעיף מהמקור':value==='unreadable'?'לא קריא':'לא יודע'}</button>)}</div>
  {action==='correct'?<fieldset disabled={disabled} style={{border:0,padding:0}}><legend>הסעיף שמופיע במקור</legend>
   {context.page===null?<label className="field"><span>עמוד הסעיף במקור, מתוך {context.page_count} עמודים</span><input type="number" inputMode="numeric" min={1} max={context.page_count} step={1} value={draft.page??''} onChange={e=>setDraft(prior=>({...prior,page:e.target.value}))}/></label>
    :<p>עמוד המקור הקשור לבקשה: {context.page}</p>}
   <label className="field"><span>מיקום הסעיף בעמוד, למשל מספר סעיף או כותרת</span><input value={draft.locator} maxLength={120} onChange={e=>setDraft(prior=>({...prior,locator:e.target.value}))}/></label>
   <label className="field"><span>נוסח הסעיף המלא כפי שמופיע במקור</span><textarea value={draft.raw_value} maxLength={context.max_characters} rows={9} onChange={e=>setDraft(prior=>({...prior,raw_value:e.target.value}))}/></label>
   <p>אין לקצר סעיף כדי להתאים לשדה. אם אי אפשר להעתיק אותו במלואו, הקריאה צריכה להישאר פתוחה.</p>
   <button className="button button--primary" type="button" disabled={disabled||!answer} onClick={()=>void submit()}>{busy?'שומרים…':correction?'שמירת תיקון קריאת הסעיף':'שמירת קריאת הסעיף'}</button>
   <button className="button button--secondary" type="button" disabled={disabled||!answer} onClick={()=>void submit(true)}>שמירת טיוטה</button>
  </fieldset>:null}
  {action==='unknown'||action==='unreadable'?<p>המקור והיסטוריית הקריאות נשמרים. לא יושלם נוסח או סכום, והבדיקות שתלויות בסעיף יישארו פתוחות.</p>:null}
  {request.source_current!==true?<p>יש לרענן את מצב המקור לפני שמירת קריאה.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  {busy?<p role="status">שומרים את קריאת הסעיף…</p>:null}
 </div>;
}
