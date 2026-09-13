"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import type {DocumentReadingDisplay} from '@/lib/document-reading-display';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';

type Context=NonNullable<DocumentReadingDisplay['obligation_context']>;
type Action='correct'|'unknown'|'unreadable';
type Draft={relationship:''|'same_obligation'|'different_obligation';locator:string;text:string;selectedCandidate:string};
type Answer={action:'correct';candidate_target_sha256?:string;value:{relationship:'same_obligation'|'different_obligation';basis:{page:number;locator:string;text:string}}}|{action:'unknown'|'unreadable'};
const empty:Draft={relationship:'',locator:'',text:'',selectedCandidate:''};
function candidateFor(context:Context,selection:string){
 const candidates=context.candidates;if(!candidates?.length||candidates.length>16||new Set(candidates.map(c=>c.target_sha256)).size!==candidates.length)return null;
 return candidates.length===1?candidates[0]:candidates.find(c=>c.target_sha256===selection)??null;
}
export function buildObligationPaymentLinkAnswer(context:Context,action:Action|null,draft:Draft):Answer|null{
 if(action==='unknown'||action==='unreadable')return {action};
 const locator=draft.locator.trim(),text=draft.text.trim(),candidate=candidateFor(context,draft.selectedCandidate),page=candidate?.payroll_page??context.payroll_page;
 if(action!=='correct'||!['same_obligation','different_obligation'].includes(draft.relationship)||!locator||locator.length>120||!text||text.length>160
  ||context.candidates!==undefined&&(!candidate||!/^[a-f0-9]{64}$/u.test(candidate.target_sha256))||!Number.isInteger(page)||page<1||page>100)return null;
 return {action:'correct',...(candidate?{candidate_target_sha256:candidate.target_sha256}:{}),value:{relationship:draft.relationship as 'same_obligation'|'different_obligation',basis:{page,locator,text}}};
}
export function initialObligationPaymentLinkDraft(context:Context,value:string|null|undefined):{action:Action|null;draft:Draft}{
 try{
  const parsed:unknown=JSON.parse(value??'');
  if(!parsed||typeof parsed!=='object'||!('action'in parsed))return {action:null,draft:empty};
  if(parsed.action==='unknown'||parsed.action==='unreadable')return {action:parsed.action,draft:empty};
  if(parsed.action==='correct'&&'value'in parsed&&parsed.value&&typeof parsed.value==='object'){
   const value=parsed.value;
   if('relationship'in value&&['same_obligation','different_obligation'].includes(String(value.relationship))&&'basis'in value&&value.basis&&typeof value.basis==='object'){
    const b=value.basis;
    const selectedCandidate='candidate_target_sha256'in parsed&&typeof parsed.candidate_target_sha256==='string'?parsed.candidate_target_sha256:'';
    const candidate=candidateFor(context,selectedCandidate),page=candidate?.payroll_page??context.payroll_page;
    if('page'in b&&b.page===page&&'locator'in b&&typeof b.locator==='string'&&'text'in b&&typeof b.text==='string'
     &&(context.candidates===undefined||candidate?.target_sha256===selectedCandidate)){
     const draft={relationship:value.relationship as Draft['relationship'],locator:b.locator,text:b.text,selectedCandidate};
     if(buildObligationPaymentLinkAnswer(context,'correct',draft))return {action:'correct',draft};
    }
   }
  }
 }catch{/* A malformed or historical answer never becomes an affirmative link. */}
 return {action:null,draft:empty};
}
export function obligationPaymentLinkSubmission(request:StoredRequest,answer:Answer|null,saveDraft=false,correction=false){
 if(request.source_current!==true||!answer)return null;
 return {requestId:request.id,answer:JSON.stringify(answer),action:saveDraft?'draft':correction?'correction':'answer',expectedRevision:saveDraft?request.draft_revision??0:request.answer_revision??0};
}
export function ObligationPaymentLinkAnswer({request,context,publicId,onAnswered,correction=false}:{request:StoredRequest;context:Context;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean}){
 const [initial]=useState(()=>initialObligationPaymentLinkDraft(context,request.draft_text??(correction?request.answer_text:null)));
 const [action,setAction]=useState<Action|null>(initial.action),[draft,setDraft]=useState(initial.draft),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const disabled=busy||request.source_current!==true,answer=buildObligationPaymentLinkAnswer(context,action,draft),display=request.reading_display;
 const sourceUrl=`/api/cases/${encodeURIComponent(publicId)}/requests?source=${encodeURIComponent(request.id)}`;
 const candidate=candidateFor(context,draft.selectedCandidate),hasPayroll=context.candidates===undefined||candidate!==null;
 const payrollPage=candidate?.payroll_page??context.payroll_page,payrollLocator=candidate?.payroll_locator??context.payroll_locator,amount=candidate?.amount??display?.raw_value;
 const payrollUrl=hasPayroll?`${sourceUrl}${candidate?`&candidate=${encodeURIComponent(candidate.target_sha256)}`:''}&view=marked#page=${payrollPage}`:null;
 function change<K extends keyof Draft>(key:K,value:Draft[K]){setDraft(current=>({...current,[key]:value}));}
 async function submit(saveDraft=false,selected=action){
  if(disabled)return;
  const body=obligationPaymentLinkSubmission(request,buildObligationPaymentLinkAnswer(context,selected,draft),saveDraft,correction);if(!body)return;
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${encodeURIComponent(publicId)}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}
  finally{setBusy(false);}
 }
 return <div className="thread-answer">
  <p>יש לבדוק איזה קשר מופיע במקור בין שורת התשלום לסעיף ההתחייבות. הסכום שכבר נקרא מוצג לזיהוי; הפעולה אינה מאשרת את הסכום, את סיווג התשלום או את הזכאות.</p>
  {context.candidates&&context.candidates.length>1?<label className="field"><span>שורת התשלום לבדיקה</span><select value={draft.selectedCandidate} disabled={disabled} onChange={event=>setDraft({...empty,selectedCandidate:event.target.value})}>
   <option value="">בחירת שורה מהתלושים השמורים</option>{context.candidates.map(c=><option key={c.target_sha256} value={c.target_sha256}>{c.amount} · עמוד {c.payroll_page} · {c.payroll_locator}</option>)}</select>
   <span>בחירת שורה מציגה את המקור שלה. יש לבדוק בנפרד אם מופיעה בו הפניה לסעיף.</span></label>:null}
  <dl>
   <dt>שורת התשלום בתלוש{hasPayroll?` · עמוד ${payrollPage}`:''}</dt>
   <dd>{hasPayroll?<>{amount!==null&&amount!==undefined?<bdi>{amount}</bdi>:'לא נקרא סכום'}<p style={{overflowWrap:'anywhere'}}>מיקום במקור: <bdi>{payrollLocator}</bdi></p>
    <a href={payrollUrl!} target="_blank" rel="noopener noreferrer">פתיחת שורת התשלום בתלוש</a></>:<p>יש לבחור שורה כדי לפתוח את מקור התשלום שלה.</p>}</dd>
   <dt>סעיף ההתחייבות בחוזה · עמוד {context.clause_page}</dt>
   <dd><p style={{overflowWrap:'anywhere'}}>מיקום במקור: <bdi>{context.clause_locator}</bdi></p>
    <a href={`${sourceUrl}&linked=clause#page=${context.clause_page}`} target="_blank" rel="noopener noreferrer">פתיחת סעיף ההתחייבות בחוזה</a></dd>
  </dl>
  <p>התקופה הנבדקת: <bdi>{context.period.from}</bdi> עד <bdi>{context.period.to}</bdi>. יש להעתיק את ההפניה מהתלוש עצמו. דמיון בסכומים או בשמות אינו מספיק לקביעת קשר.</p>
  {display?.dependent_checks?.length?<p>הקריאה משמשת לבדיקה: {display.dependent_checks.join(' · ')}.</p>:null}
  {request.source_current!==true?<p role="status">לא ניתן לאמת ששני המקורות עדיין נוכחיים. יש לטעון את המצב שנשמר לפני הוספת קריאה.</p>:null}
  <div role="group" aria-label="תוצאת בדיקת הקשר במקור" className="option-row">{(['correct','unknown','unreadable'] as const).map(value=><button key={value} type="button" disabled={disabled}
   aria-pressed={action===value} className={action===value?'option-button is-selected':'option-button'} onClick={()=>{setAction(value);if(value!=='correct')void submit(false,value);}}>
   {value==='correct'?'פירוט הקשר במקור':value==='unknown'?'לא יודע':'לא קריא'}</button>)}</div>
  {action==='correct'?<fieldset disabled={disabled} style={{border:0,padding:0}}><legend>ההפניה שמופיעה בתלוש</legend>
   <label className="field"><span>מה הקשר שמצוין בשורת התשלום?</span><select value={draft.relationship} onChange={event=>change('relationship',event.target.value as Draft['relationship'])}>
    <option value="">בחירת הקשר שמופיע במקור</option><option value="same_obligation">השורה מפנה לסעיף הזה</option><option value="different_obligation">השורה מפנה להתחייבות אחרת</option></select></label>
   <p>{hasPayroll?`ההעתקה מתייחסת לתלוש, עמוד ${payrollPage}.`:'יש לבחור שורת תשלום לפני העתקת ההפניה.'} עמוד החוזה זמין בקישור הנפרד למעלה.</p>
   <label className="field"><span>מיקום ההפניה בעמוד התלוש</span><input value={draft.locator} maxLength={120} onChange={event=>change('locator',event.target.value)} placeholder="למשל: שם הטבלה ושורת התשלום"/></label>
   <label className="field"><span>הכיתוב בתלוש שמבסס את הקשר</span><textarea value={draft.text} maxLength={160} rows={3} onChange={event=>change('text',event.target.value)}/></label>
   <p>אם אין בתלוש הפניה ברורה, אפשר לבחור לא יודע. השמירה מתעדת את קריאת המקור; בדיקת שיוך התשלום להתחייבות נעשית בנפרד.</p>
   <button type="button" className="button button--primary" disabled={disabled||!answer} onClick={()=>void submit()}>{busy?'שומרים…':correction?'שמירת תיקון הקשר במקור':'שמירת הקשר במקור'}</button>
   <button type="button" className="button button--secondary" disabled={disabled||!answer} onClick={()=>void submit(true)}>שמירת טיוטה</button>
  </fieldset>:null}
  {action==='unknown'||action==='unreadable'?<p>הקריאה תישמר כלא ידועה או לא קריאה. השוואת התשלום תישאר חסרה; בדיקות עצמאיות של הסכום הצפוי יוכלו להמשיך.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  {busy?<p role="status">שומרים את קריאת הקשר…</p>:null}
 </div>;
}
