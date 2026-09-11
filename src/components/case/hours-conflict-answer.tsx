"use client";

import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {HOURS_CONFLICT_ANSWER_VERSION,parseHoursConflictAnswer} from '@/server/product/reports/document-hours-conflict-answer';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';

function initial(value:string|null|undefined){
 try{const parsed=JSON.parse(value??'null');return {unknown:parsed?.state==='unknown',hours:typeof parsed?.hours==='string'?parsed.hours:'',basis:typeof parsed?.basis==='string'?parsed.basis:''};}
 catch{return {unknown:false,hours:'',basis:''};}
}

export function HoursConflictAnswer({request,publicId,onAnswered,correction=false}:{request:StoredRequest;publicId:string;onAnswered:()=>void;correction?:boolean}){
 const [form,setForm]=useState(()=>initial(request.draft_text??(correction?request.answer_text:null)));
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 async function submit(action:'answer'|'draft'|'correction'=correction?'correction':'answer'){
  const wire=JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:form.unknown?'unknown':'declared',
   ...(!form.unknown?{hours:form.hours}:{}),basis:form.basis});
  if(action!=='draft')try{parseHoursConflictAnswer(wire);}catch{setError('יש לציין שעות רגילות בין 0 ל־182 ובסיס לתשובה באורך 10 תווים לפחות, או לבחור שלא ניתן לקבוע.');return;}
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:request.id,
    answer:wire,action,expectedRevision:action==='draft'?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){if(response.status===409)setConflict(true);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));setBusy(false);}
 }
 return <div className="thread-answer">
  {request.hours_conflict_source?.source_observations.length?<div><p>הקריאות שנשמרו מהמסמך:</p><ul>{request.hours_conflict_source.source_observations.map(row=><li key={row.candidate_id}>עמוד {row.page} · {row.source_label??'שעות רגילות'}: {row.raw_value??'לא ניתן לקרוא'}</li>)}</ul></div>:<p>לא נשמרו קריאות שעות מספיקות לבירור הסתירה. אין כאן מספר שעות שנבחר עבורך.</p>}
  <label className="field"><span>שעות רגילות בחודש</span><input inputMode="decimal" value={form.hours} maxLength={8} disabled={busy||form.unknown} onChange={e=>setForm({...form,hours:e.target.value})}/></label>
  <label className="field"><span>הבסיס לתשובה, למשל רישום נוכחות או הסבר לסתירה</span><textarea value={form.basis} maxLength={1000} disabled={busy} onChange={e=>setForm({...form,basis:e.target.value})}/></label>
  <label><input type="checkbox" checked={form.unknown} disabled={busy} onChange={e=>setForm({...form,unknown:e.target.checked})}/> לא ניתן לקבוע את מספר השעות</label>
  <p>זו הצהרתך על שעות העבודה. היא אינה משנה את הקריאות המקוריות ואינה אישור משפטי של החישוב. אם לא ניתן לקבוע, החישוב ימשיך להמתין לבירור.</p>
  {error?<p className="form-error" role="alert">{error}</p>:null}
  {conflict?<button className="button button--secondary" type="button" onClick={onAnswered}>טעינת התשובה שנשמרה</button>:null}
  <button className="button button--primary" type="button" disabled={busy} onClick={()=>void submit()}>{busy?'שומרים…':correction?'שליחת תיקון':'שליחת תשובה'}</button>
  <button className="button button--secondary" type="button" disabled={busy} onClick={()=>void submit('draft')}>שמירת טיוטה</button>
 </div>;
}
