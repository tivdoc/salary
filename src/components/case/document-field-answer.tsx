"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';
import {SourceStructureAnswer} from './source-structure-answer';
import {TravelTariffAnswer} from './travel-tariff-answer';
import {SourcePeriodIntakeAnswer} from './source-period-intake-answer';
import {ObligationPaymentLinkAnswer} from './obligation-payment-link-answer';

type Action='confirm'|'correct'|'unreadable'|'unknown';
const labels:Record<Action,string>={confirm:'זה הערך בתא',correct:'הערך בתא שונה',unreadable:'לא קריא',unknown:'לא יודע'};
function previous(value:string|null|undefined):{action:Action|null;raw:string}{
 try{const parsed=JSON.parse(value??'');if(parsed.schema_version==='document-field-answer-v2'&&Object.hasOwn(labels,parsed.action))return {action:parsed.action,raw:typeof parsed.corrected_raw_value==='string'?parsed.corrected_raw_value:''};}catch{}
 return {action:null,raw:''};
}
type Props={request:StoredRequest;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean};
export function DocumentFieldAnswer(props:Props){
 const obligation=props.request.reading_display?.obligation_context;
 if(obligation)return <ObligationPaymentLinkAnswer {...props} context={obligation}/>;
 const intake=props.request.reading_display?.period_intake_context;
 if(intake)return <SourcePeriodIntakeAnswer {...props} context={intake}/>;
 const tariff=props.request.reading_display?.tariff_context;
 if(tariff)return <TravelTariffAnswer {...props} context={tariff}/>;
 const context=props.request.reading_display?.structure_context;
 return context?<SourceStructureAnswer {...props} context={context}/>:<ScalarDocumentFieldAnswer {...props}/>;
}
function ScalarDocumentFieldAnswer({request,publicId,onAnswered,correction=false,sourceShared=false}:Props){
 const initial=previous(request.draft_text??(correction?request.answer_text:null));
 const [action,setAction]=useState<Action|null>(initial.action),[raw,setRaw]=useState(initial.raw),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const display=request.reading_display;
 const transcription=display?.transcription_context,unitOnly=transcription?.kind==='balance_unit';
 const evidence=display?.evidence_context;
 const direct=!!display?.row_context||!!transcription||!!evidence;
 const allowedActions:Action[]=transcription||evidence&&!evidence.can_confirm?['correct','unreadable','unknown']:['confirm','correct','unreadable','unknown'];
 const validAction=action!==null&&allowedActions.includes(action);
 async function submit(draft=false,selected=action){
  if(request.source_current===false||!selected||!allowedActions.includes(selected)||selected==='correct'&&(!raw.trim()||unitOnly&&!['days','hours','ימים','שעות'].includes(raw.trim())))return;
  setBusy(true);setError('');setConflict(false);
  const answer={schema_version:'document-field-answer-v2',action:selected,...(selected==='correct'?{corrected_raw_value:raw.trim()}:{})};
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
   {!sourceShared?<p>{transcription?`השלמת מידע מעמוד ${display.page}. ההעתקה מתייחסת לפרט המבוקש בלבד ואינה אישור של שאר המסמך או של הזכאות.`:`אימות תא אחד בעמוד ${display.page}. האישור אינו חל על שאר המסמך או על הזכאות.`}</p>:null}
   {display.raw_value!==null?<p>{unitOnly?'המספר שנקרא ונשמר ללא שינוי: ':'הקריאה המקורית: '}<bdi>{display.raw_value}</bdi></p>:null}
   {!sourceShared&&display.text_fragment?<blockquote>{display.text_fragment}</blockquote>:null}
   {!sourceShared?<p><a href={`/api/cases/${publicId}/requests?source=${request.id}&view=marked#page=${display.page}`} target="_blank" rel="noopener noreferrer">פתיחת המקור לסימון ולאימות</a></p>:null}
   {!sourceShared&&!display.bounding_box?<p>{transcription?'לא התקבל מיקום מדויק. יש לפתוח את עמוד המקור ולהעתיק רק מידע שמופיע בו.':'לא התקבל מיקום מדויק של התא. יש לבדוק את הערך בעמוד המקור לפני אישור.'}</p>:null}
   {display.dependent_checks?.length?<p>הקריאה משמשת לבדיקה: {display.dependent_checks.join(' · ')}. הבדיקה תוכל להתעדכן לאחר אימות יתר הנתונים הנדרשים.</p>:null}
  </div>:null}
  {direct?<p>{transcription?'אם המידע אינו מופיע במסמך, בחרו לא יודע. אין להשלים אותו לפי חישוב או הערכה.':'כל פעולה נשמרת לתא הזה בלבד. לתיקון ערך יש להעתיק את התא ולשמור.'}</p>:null}
  {evidence?<p>{evidence.reading_state==='conflict'?'נשמרו קריאות סותרות; יש להעתיק את הערך מהמקור או להשאיר את הקריאה לא ידועה. ':''}תיקון יישמר כקריאת מקור מזוהה, עם סימון מערכת של פעולת ההעתקה. זה אינו נימוק שהקלדתם ואינו אישור לתנאי הסכם או לזכאות.</p>:null}
  <div role="group" aria-label="תוצאת בדיקת התא" className="option-row">{allowedActions.map(value=><button key={value} type="button" className={action===value?'option-button is-selected':'option-button'} aria-pressed={action===value} disabled={busy||request.source_current===false} onClick={()=>{setAction(value);if(direct&&value!=='correct')void submit(false,value);}}>{transcription&&value==='correct'?(unitOnly?'השלמת היחידה מהמסמך':'העתקת סך השעות מהמסמך'):direct&&value==='confirm'?'אישור הערך בתא ושמירה':labels[value]}</button>)}</div>
  {action==='correct'?<label className="field"><span>{unitOnly?'היחידה שמופיעה לצד היתרה':transcription?'סך השעות המדווחות שמופיע במסמך':'הערך שמופיע בתא המקור'}</span>{unitOnly?<select value={raw==='ימים'?'days':raw==='שעות'?'hours':raw} disabled={busy||request.source_current===false} onChange={event=>setRaw(event.target.value)} aria-invalid={!!error}><option value="">בחירת היחידה המודפסת</option><option value="days">ימים</option><option value="hours">שעות</option></select>:evidence?.value_kind==='text'?<textarea value={raw} maxLength={500} rows={5} disabled={busy||request.source_current===false} onChange={event=>setRaw(event.target.value)} aria-invalid={!!error}/>:<input value={raw} maxLength={500} disabled={busy||request.source_current===false} inputMode={transcription?'decimal':undefined} onChange={event=>setRaw(event.target.value)} aria-invalid={!!error}/>}<span>{unitOnly?'משלימים את היחידה בלבד. המספר המקורי אינו משתנה.':transcription?'יש להעתיק את הסך המודפס. שעות מדווחות אינן בהכרח שעות רגילות או שעות בתשלום.':'יש להעתיק את התא עצמו. סכום שחושב בנפרד או הערכה אינם תיקון קריאה.'}</span></label>:null}
  {action==='unknown'||action==='unreadable'?<p>המקור והסתירות יישמרו. בדיקות שתלויות בתא הזה יישארו פתוחות; בדיקות עצמאיות יוכלו להמשיך.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  {direct&&busy?<p role="status">שומרים את בדיקת התא…</p>:null}
  {!direct||action==='correct'?<><button className="button button--primary" type="button" disabled={busy||!validAction||action==='correct'&&!raw.trim()||request.source_current===false} onClick={()=>void submit()}>{busy?'שומרים…':transcription?'שמירת ההשלמה מהמסמך':correction?'שמירת תיקון הקריאה':'שמירת בדיקת התא'}</button>
  <button className="button button--secondary" type="button" disabled={busy||!validAction||action==='correct'&&!raw.trim()||request.source_current===false} onClick={()=>void submit(true)}>שמירת טיוטה</button></>:null}
 </div>;
}
