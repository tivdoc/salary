"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';
import {initialTravelTariffDraft,buildTravelTariffAnswer,travelTariffLabels,type TravelTariffContext,type TravelTariffAction,type TravelTariffDraft} from '@/lib/travel-tariff-display';

type Props={request:StoredRequest;context:TravelTariffContext;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean};
export function TravelTariffAnswer({request,context,publicId,onAnswered,correction=false,sourceShared=false}:Props){
 const [initial]=useState(()=>initialTravelTariffDraft(context,request.draft_text??(correction?request.answer_text:null)));
 const [action,setAction]=useState<TravelTariffAction|null>(initial.action),[draft,setDraft]=useState(initial.draft);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const disabled=busy||request.source_current!==true,answer=buildTravelTariffAnswer(context,action,draft);
 function change<K extends keyof TravelTariffDraft>(key:K,value:TravelTariffDraft[K]){setDraft(prior=>({...prior,[key]:value}));}
 async function submit(saveDraft=false,selected=action){
  if(disabled)return;
  const value=buildTravelTariffAnswer(context,selected,draft);if(!value)return;
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    requestId:request.id,answer:JSON.stringify(value),action:saveDraft?'draft':correction?'correction':'answer',expectedRevision:saveDraft?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}
   onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}finally{setBusy(false);}
 }
 return <div className="thread-answer">
  <p>{travelTariffLabels[context.subject]} — העתקת פרט מעמוד {context.page}. ההעתקה אינה מאשרת זכאות, תשלום או תחולה משפטית.</p>
  <p>מקטע המקור שנבחר: {context.locator}</p>
  {!sourceShared?<p><a href={`/api/cases/${publicId}/requests?source=${request.id}&view=marked#page=${context.page}`} target="_blank" rel="noopener noreferrer">פתיחת מקור התעריף</a></p>:null}
  <p>אין ערך מוצע לאישור. יש להעתיק רק את מה שמופיע במקור. אם הפרט אינו מופיע, יש לבחור לא יודע; אין להשלים אותו לפי התלוש, לפי התקרה או לפי חישוב.</p>
  {request.reading_display?.dependent_checks?.length?<p>הפרט משמש לבדיקה: {request.reading_display.dependent_checks.join(' · ')}. יתר הנתונים ייבדקו בנפרד.</p>:null}
  <div role="group" aria-label="תוצאת קריאת התעריף" className="option-row">{(['correct','unreadable','unknown'] as const).map(value=><button key={value} type="button" disabled={disabled}
   aria-pressed={action===value} className={action===value?'option-button is-selected':'option-button'} onClick={()=>{setAction(value);if(value!=='correct')void submit(false,value);}}>
   {value==='correct'?'העתקת הפרט מהמקור':value==='unreadable'?'לא קריא':'לא יודע'}</button>)}</div>
  {action==='correct'?<fieldset disabled={disabled} style={{border:0,padding:0}}><legend>הפרט שמופיע במקור</legend>
   {context.subject==='context'?<>
    <label className="field"><span>המסלול כפי שמופיע במקור</span><input value={draft.route_reference} maxLength={200} onChange={e=>change('route_reference',e.target.value)}/></label>
    <label className="field"><span>פרופיל ההנחה שמופיע במקור</span><select value={draft.discount_profile} onChange={e=>change('discount_profile',e.target.value)}><option value="">בחירה לפי המקור</option>
     <option value="standard_adult">תעריף רגיל למבוגר</option><option value="special_discount">פרופיל הנחה מיוחד</option></select></label>
    <label className="field"><span>הכיוונים הכלולים בתעריף</span><select value={draft.directions} onChange={e=>change('directions',e.target.value)}><option value="">בחירה לפי המקור</option>
     <option value="both">הלוך וחזור</option><option value="outbound">הלוך בלבד</option><option value="return">חזור בלבד</option></select></label>
    <label className="field"><span>תחילת תקופת התעריף המודפסת</span><input type="date" value={draft.from} onChange={e=>change('from',e.target.value)}/></label>
    <label className="field"><span>סוף תקופת התעריף המודפסת</span><input type="date" value={draft.to} onChange={e=>change('to',e.target.value)}/></label>
    <p>יש להעתיק את התקופה ואת פרופיל ההנחה מהמקור. אין לבחור אותם לפי חודש התלוש או להכריע כאן אם הנחה חלה על העובד.</p>
   </>:context.subject==='ticket_inventory'?<>
    <label className="field"><span>שלמות אפשרויות הכרטיסים במקטע המקור</span><select value={draft.ticket_inventory} onChange={e=>change('ticket_inventory',e.target.value)}><option value="">בחירה לפי המקור</option>
     <option value="complete">המקור מראה את כל האפשרויות המתאימות</option><option value="partial">רשימה חלקית או שלא ניתן לוודא שהיא מלאה</option></select></label>
    <label className="field"><span>זמינות מנוי חודשי לפי המקור</span><select value={draft.monthly_pass_availability} onChange={e=>change('monthly_pass_availability',e.target.value)}><option value="">בחירה לפי המקור</option>
     <option value="available">מנוי חודשי מתאים זמין</option><option value="unavailable">המקור מציין שאין מנוי חודשי מתאים</option></select></label>
    <p>היעדר מחיר או רשימת כרטיסים חלקית אינם מוכיחים שאין מנוי. כשאי אפשר לקבוע את הזמינות מהמקור, יש לבחור לא יודע.</p>
   </>:<label className="field"><span>{context.subject==='daily_fare'?'התעריף היומי המוזל שמופיע במקור, בשקלים':'מחיר המנוי החודשי שמופיע במקור, בשקלים'}</span>
    <input inputMode="decimal" value={draft.amount} maxLength={12} onChange={e=>change('amount',e.target.value)}/></label>}
   <p>עמוד המקור הקשור לבקשה: {context.page}</p>
   <label className="field"><span>מיקום הפרט בעמוד</span><input value={draft.locator} maxLength={120} onChange={e=>change('locator',e.target.value)}/></label>
   <label className="field"><span>הכיתוב במקור שמבסס את ההעתקה</span><textarea value={draft.text} maxLength={160} onChange={e=>change('text',e.target.value)}/></label>
   <button className="button button--primary" type="button" disabled={disabled||!answer} onClick={()=>void submit()}>{busy?'שומרים…':correction?'שמירת תיקון קריאת התעריף':'שמירת קריאת התעריף'}</button>
   <button className="button button--secondary" type="button" disabled={disabled||!answer} onClick={()=>void submit(true)}>שמירת טיוטה</button>
  </fieldset>:null}
  {action==='unknown'||action==='unreadable'?<p>התשובה נשמרת ביחס למקור הזה. לא יושלם ממנה מחיר, והבדיקות שתלויות בפרט יישארו חסרות.</p>:null}
  {request.source_current!==true?<p>יש לרענן את מצב המקור לפני שמירת קריאה.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  {busy?<p role="status">שומרים את קריאת התעריף…</p>:null}
 </div>;
}
