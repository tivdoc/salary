"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';
import {buildSourcePeriodIntakeAnswer,initialSourcePeriodIntakeDraft,sourcePeriodIntakeKinds,type SourcePeriodIntakeContext,type SourcePeriodIntakeAction,type SourcePeriodIntakeDraft} from '@/lib/source-period-intake-display';

type Props={request:StoredRequest;context:SourcePeriodIntakeContext;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean};
export function SourcePeriodIntakeAnswer({request,context,publicId,onAnswered,correction=false,sourceShared=false}:Props){
 const [initial]=useState(()=>initialSourcePeriodIntakeDraft(context,request.draft_text??(correction?request.answer_text:null)));
 const [action,setAction]=useState<SourcePeriodIntakeAction|null>(initial.action),[draft,setDraft]=useState(initial.draft);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const disabled=busy||request.source_current!==true,answer=buildSourcePeriodIntakeAnswer(context,action,draft);
 function change(key:keyof SourcePeriodIntakeDraft,value:string){setDraft(prior=>({...prior,[key]:value}));}
 async function submit(saveDraft=false,selected=action){
  if(disabled)return;const value=buildSourcePeriodIntakeAnswer(context,selected,draft);if(!value)return;
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    requestId:request.id,answer:JSON.stringify(value),action:saveDraft?'draft':correction?'correction':'answer',expectedRevision:saveDraft?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}finally{setBusy(false);}
 }
 return <div className="thread-answer">
  <p>יש לזהות את סוג המסמך ולהעתיק את התקופה המופיעה בו. חודש הרכישה אינו ידוע, ולכן לא מוצעים תאריכים לאישור.</p>
  {!sourceShared?<p><a href={`/api/cases/${publicId}/requests?source=${request.id}#page=1`} target="_blank" rel="noopener noreferrer">פתיחת המסמך המקורי ({context.page_count} עמודים)</a></p>:null}
  <p>זו קריאה של המקור בלבד. היא אינה מאשרת זכאות, תשלום או נכונות של חישוב.</p>
  <div role="group" aria-label="תוצאת קריאת סוג המסמך והתקופה" className="option-row">{(['correct','unreadable','unknown'] as const).map(value=><button key={value} type="button" disabled={disabled}
   aria-pressed={action===value} className={action===value?'option-button is-selected':'option-button'} onClick={()=>{setAction(value);if(value!=='correct')void submit(false,value);}}>
   {value==='correct'?'העתקת הפרט מהמקור':value==='unreadable'?'לא קריא':'לא יודע'}</button>)}</div>
  {action==='correct'?<fieldset disabled={disabled} style={{border:0,padding:0}}><legend>הפרטים שמופיעים במסמך</legend>
   <label className="field"><span>סוג המסמך לפי תוכנו</span><select value={draft.document_kind} onChange={e=>change('document_kind',e.target.value)}><option value="">בחירה לפי המקור</option>
    {Object.entries(sourcePeriodIntakeKinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label className="field"><span>האם מופיעה תקופה במסמך?</span><select value={draft.period_shown} onChange={e=>change('period_shown',e.target.value)}><option value="">בחירה לפי המקור</option>
    <option value="yes">מופיעים תאריכי התקופה</option><option value="no">לא מופיעה תקופה במסמך</option></select></label>
   {draft.period_shown==='yes'?<>
    <label className="field"><span>תחילת התקופה המופיעה במקור</span><input type="date" value={draft.from} onChange={e=>change('from',e.target.value)}/></label>
    <label className="field"><span>סוף התקופה המופיעה במקור</span><input type="date" value={draft.to} onChange={e=>change('to',e.target.value)}/></label>
    <p>אין לבחור את תקופת העבודה או הרכישה אם היא אינה מופיעה במסמך.</p>
   </>:null}
   <label className="field"><span>מספר העמוד בקובץ שבו מופיעים הפרטים (1–{context.page_count})</span><input type="number" min={1} max={context.page_count} step={1} value={draft.page} onChange={e=>change('page',e.target.value)}/></label>
   <label className="field"><span>כותרת התקופה או תיאור המיקום המדויק במקור</span><input value={draft.source_label} maxLength={400} onChange={e=>change('source_label',e.target.value)}/></label>
  </fieldset>:null}
  {request.source_current!==true?<p role="alert">לא ניתן לאמת שהמסמך עדיין נוכחי. יש לרענן את הבקשות לפני שליחת קריאה.</p>:null}
  {error?<p role="alert">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>רענון הבקשות</button>:null}
  {action==='correct'?<div className="option-row"><button type="button" className="button button--primary" disabled={disabled||!answer} onClick={()=>void submit()}>{busy?'שומר…':correction?'שמירת תיקון הקריאה':'שמירת הקריאה מהמקור'}</button>
   <button type="button" disabled={disabled||!answer} onClick={()=>void submit(true)}>שמירת טיוטה</button></div>:null}
 </div>;
}
