"use client";
import {useState} from 'react';
import type {StoredRequest} from '@/server/product/reports/case-requests';
import {customerErrorFromResponse,customerErrorMessage} from '@/lib/customer-copy';
import {balanceMovementLabels,deductionGroupLabels,sourcePeriodKindLabels,buildSourceStructureAnswer,initialSourceStructureDraft,
 type SourceStructureContext,type SourceStructureAction,type SourceStructureDraft} from '@/lib/source-structure-display';

const unitLabel=(unit:string)=>unit==='days'?'ימים':unit==='hours'?'שעות':'היחידה אינה מודפסת במקור';
function SourceDetails({context,rawValue}:{context:SourceStructureContext;rawValue:string|null}){
 if(context.kind==='period_association')return <div><p>יש לזהות לאיזו תקופה מתייחסים הנתונים המסומנים. המספרים מוצגים לזיהוי בלבד ואין צורך לאשר אותם שוב.</p>
  <ul>{context.refs.map((ref,index)=><li key={`${ref.label}:${index}`}>{ref.label} · עמוד {ref.page}: <bdi>{ref.raw_value??'לא נקרא מספר'}</bdi></li>)}</ul>
  <p>החודש הנבדק: <bdi>{context.month}</bdi>. יש להעתיק את התקופה שהמקור מציין; תאריך התלוש לבדו אינו קובע את תקופת כל רכיב.</p></div>;
 if(context.kind==='source_relationship')return <div><p>הסכומים מוצגים לצורך זיהוי השדות בלבד. השאלה היא על הקשר שמופיע במקור, ולא על אישור המספרים מחדש.</p>
  <dl><dt>{context.contribution.label}{context.contribution.page?` · עמוד ${context.contribution.page}`:''}</dt><dd><bdi>{context.contribution.raw_value??'לא נקרא סכום'}</bdi></dd><dt>{context.base.label}{context.base.page?` · עמוד ${context.base.page}`:''}</dt><dd><bdi>{context.base.raw_value??'לא נקרא סכום'}</bdi></dd></dl>
  {context.proposed_value?<p>השיוך המוצג: {context.proposed_value.relationship==='same_base'?'הרכיב משויך לאותו בסיס':'הרכיב אינו משויך לאותו בסיס'}.</p>:null}</div>;
 if(context.kind==='deduction_group')return <div><p>יש לבדוק את שיוך כל שורה ואת גבולות הקבוצה במקור. התאמה בסכום אינה ראיה לשיוך. המספרים כאן מוצגים לזיהוי בלבד.</p>
  <ul>{context.rows.map(row=><li key={row.component_id}>{row.label}{row.page?` · עמוד ${row.page}`:''}: <bdi>{row.raw_value??'סכום לא נקרא'}</bdi>{context.proposed_value?.members.find(m=>m.component_id===row.component_id)?` — ${deductionGroupLabels[context.proposed_value.members.find(m=>m.component_id===row.component_id)!.group]}`:''}</li>)}</ul>
  {context.proposed_value?<p>מלאי השורות המוצג: {context.proposed_value.inventory==='complete'?'כל השורות בקבוצה מופיעות':'חלקי — ייתכנו שורות נוספות'}.</p>:null}</div>;
 const value=context.proposed_value;
 return <div><p>{balanceMovementLabels[context.cell]} בטבלת {context.label}. כל תא נבדק בנפרד; האישור אינו חל על שאר היתרות או על זכאות.</p>
  {value?<p>{value.state==='not_present'?'לא מופיעה שורת התאמות':<><bdi>{value.amount}</bdi> — {unitLabel(value.unit)}</>} · תקופה: <bdi>{value.period}</bdi></p>:<>
   {rawValue!==null?<p>המספר שנקרא במקור: <bdi>{rawValue}</bdi>. נדרשת בדיקת התא, יחידתו ותקופתו.</p>:null}<p>אין קריאה מלאה קיימת של התא שאפשר לאשר. יש להעתיק את הפרט מהמקור בלבד.</p></>}</div>;
}
export function SourceStructureAnswer({request,context,publicId,onAnswered,correction=false,sourceShared=false}:{request:StoredRequest;context:SourceStructureContext;publicId:string;onAnswered:()=>void;correction?:boolean;sourceShared?:boolean}){
 const [initial]=useState(()=>initialSourceStructureDraft(context,request.draft_text??(correction?request.answer_text:null)));
 const [action,setAction]=useState<SourceStructureAction|null>(initial.action),[draft,setDraft]=useState(initial.draft),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false);
 const display=request.reading_display!,disabled=busy||(context.kind==='period_association'?request.source_current!==true:request.source_current===false);
 const allowed:SourceStructureAction[]=context.kind==='source_relationship'&&context.allows_explicit_confirmation===true?['confirm','correct','unreadable','unknown']:['correct','unreadable','unknown'];
 const hasForm=action==='correct'||action==='confirm'&&context.kind==='source_relationship';
 const answer=buildSourceStructureAnswer(context,action,draft);
 function change<K extends keyof SourceStructureDraft>(key:K,value:SourceStructureDraft[K]){setDraft(previous=>({...previous,[key]:value}));}
 async function submit(saveDraft=false,selected=action){
  if(disabled||!selected||!allowed.includes(selected))return;
  const value=buildSourceStructureAnswer(context,selected,draft);if(!value)return;
  setBusy(true);setError('');setConflict(false);
  try{
   const response=await fetch(`/api/cases/${publicId}/requests`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:request.id,answer:JSON.stringify(value),
    action:saveDraft?'draft':correction?'correction':'answer',expectedRevision:saveDraft?request.draft_revision??0:request.answer_revision??0})});
   if(!response.ok){setConflict(response.status===409);throw Error(await customerErrorFromResponse(response,'request_answer_failed'));}onAnswered();
  }catch(caught){setError(customerErrorMessage({error:caught instanceof Error?caught.message:null},'request_answer_failed'));}finally{setBusy(false);}
 }
 return <div className="thread-answer">
  <SourceDetails context={context} rawValue={display.raw_value}/>
  {!sourceShared?<><p><a href={`/api/cases/${publicId}/requests?source=${request.id}&view=marked#page=${display.page}`} target="_blank" rel="noopener noreferrer">פתיחת המקור לבדיקת השיוך או התא</a></p>
   {display.text_fragment?<blockquote>{display.text_fragment}</blockquote>:null}
   {!display.bounding_box?<p>לא התקבל סימון מדויק. יש לאתר את השדות בעמוד {display.page} לפי כותרות המקור.</p>:null}</>:null}
  {context.proposed_value?<blockquote>{context.proposed_value.basis.text}</blockquote>:null}
  {display.dependent_checks?.length?<p>ההשלמה משמשת לבדיקה: {display.dependent_checks.join(' · ')}. נתונים וחסמים אחרים ייבדקו בנפרד.</p>:null}
  <div role="group" aria-label="תוצאת בדיקת המקור" className="option-row">{allowed.map(value=><button key={value} type="button" disabled={disabled} aria-pressed={action===value}
   className={action===value?'option-button is-selected':'option-button'} onClick={()=>{setAction(value);if(value==='unknown'||value==='unreadable')void submit(false,value);}}>{value==='confirm'?'אישור קשר בין הרכיב לבסיס'
    :value==='correct'?(context.kind==='source_relationship'?'תיקון או פירוט הקשר':context.proposed_value?'הפרט במקור שונה':'העתקת הפרט מהמקור'):value==='unknown'?'לא יודע':'לא קריא'}</button>)}</div>
  {hasForm?<fieldset disabled={disabled} style={{border:0,padding:0}}><legend>הפרט שנמצא במקור</legend>
   {context.kind==='source_relationship'?<>
    {action==='confirm'?<p>האישור מתייחס לקשר בין הרכיב לבסיס שמוצגים כאן. יש לזהות את סוג הקרן ואת הראיה במקור לפני השמירה.</p>:<label className="field"><span>האם הרכיב משויך לבסיס הזה במסמך?</span><select value={draft.relationship} onChange={event=>change('relationship',event.target.value as SourceStructureDraft['relationship'])}>
     <option value="">בחירת הקשר שמופיע במקור</option><option value="same_base">כן, משויך לאותו בסיס</option><option value="different_base">לא, אינו משויך לאותו בסיס</option></select></label>}
    <label className="field"><span>סוג הקרן או הרכיב לפי המקור</span><select value={draft.fund_kind} onChange={event=>change('fund_kind',event.target.value as SourceStructureDraft['fund_kind'])}>
     <option value="">בחירת הסוג שמופיע במקור</option><option value="pension">פנסיה</option><option value="study">קרן השתלמות</option><option value="severance">פיצויים</option><option value="combined">כמה סוגים יחד</option><option value="unknown">הסוג אינו ברור</option></select></label>
    <label className="field"><span>שם הקרן או הרכיב כפי שהוא מופיע במקור</span><input value={draft.fund_label} maxLength={160} onChange={event=>change('fund_label',event.target.value)}/></label>
    <label className="field"><span>מה במקור קושר בין הרכיב לבסיס?</span><select value={draft.source_kind} onChange={event=>change('source_kind',event.target.value as SourceStructureDraft['source_kind'])}>
     <option value="">בחירת הראיה במקור</option><option value="same_row">הרכיב והבסיס נמצאים באותה שורה</option><option value="labelled_section">כותרת הקבוצה קושרת ביניהם</option><option value="explicit_reference">הפניה מפורשת קושרת ביניהם</option></select></label>
   </>:null}
   {context.kind==='deduction_group'?<><p>יש לבחור שיוך לכל שורה. כאשר השיוך אינו ברור, בוחרים שלא ניתן לקבוע.</p>{context.rows.map(row=><label className="field" key={row.component_id}><span>{row.label} — <bdi>{row.raw_value??'סכום לא נקרא'}</bdi></span>
    <select value={draft.members[row.component_id]??''} onChange={event=>change('members',{...draft.members,[row.component_id]:event.target.value as SourceStructureDraft['members'][string]})}><option value="">בחירת קבוצה לפי המקור</option>
     <option value="mandatory">ניכויי חובה</option>{context.allows_voluntary===true?<option value="voluntary">ניכויי רשות</option>:null}<option value="unknown">לא ניתן לקבוע</option></select></label>)}
    <label className="field"><span>האם כל שורות הקבוצה מופיעות במקור שנבדק?</span><select value={draft.inventory} onChange={event=>change('inventory',event.target.value as SourceStructureDraft['inventory'])}>
     <option value="">בחירת מצב מלאי השורות</option><option value="complete">כל השורות מופיעות</option><option value="partial">המלאי חלקי או שלא ניתן לוודא שהוא מלא</option></select></label></>:null}
   {context.kind==='deduction_group'&&draft.inventory==='complete'&&context.rows.some(row=>draft.members[row.component_id]==='unknown')?<p>כאשר שיוך של שורה אינו ברור, יש לבחור מלאי חלקי. אין לאשר את שלמות הקבוצה על סמך הסכום.</p>:null}
   {context.kind==='balance_movement'?<>
    {context.cell==='adjustments'?<label><input type="checkbox" checked={draft.not_present} onChange={event=>change('not_present',event.target.checked)}/>לא מופיעה שורת התאמות בטבלה</label>:null}
    {!draft.not_present?<><label className="field"><span>המספר שמופיע בתא {balanceMovementLabels[context.cell]}</span><input value={draft.amount} inputMode="decimal" maxLength={40} onChange={event=>change('amount',event.target.value)}/></label>
     <label className="field"><span>היחידה שמופיעה במקור</span><select value={draft.unit} onChange={event=>change('unit',event.target.value as SourceStructureDraft['unit'])}><option value="">בחירת היחידה לפי המקור</option>
      <option value="days">ימים</option><option value="hours">שעות</option><option value="source_native_unknown">היחידה אינה מודפסת במקור</option></select></label></>:null}
    <label className="field"><span>החודש שאליו מתייחס התא</span><input type="month" value={draft.period} onChange={event=>change('period',event.target.value)}/></label>
    <p>אין להעביר מספר מתא סמוך, להשלים יתרה בחישוב או להזין אפס במקום תא ריק. היחידה והתקופה מתייחסות לתא הזה בלבד.</p></>:null}
   {context.kind==='period_association'?<>
    <label className="field"><span>סוג התקופה שמצוין במקור</span><select value={draft.period_kind} onChange={event=>change('period_kind',event.target.value as SourceStructureDraft['period_kind'])}>
     <option value="">בחירת סוג התקופה לפי המקור</option>{(['current','retroactive','cumulative'] as const).map(kind=><option key={kind} value={kind}>{sourcePeriodKindLabels[kind]}</option>)}</select></label>
    <label className="field"><span>מתאריך</span><input type="date" value={draft.period_from} onChange={event=>change('period_from',event.target.value)}/></label>
    <label className="field"><span>עד תאריך</span><input type="date" value={draft.period_to} onChange={event=>change('period_to',event.target.value)}/></label>
    <p>עמוד המקור: {display.page}. אם גבולות התקופה אינם מצוינים או אינם ברורים, יש לבחור לא יודע או לא קריא.</p>
   </>:<label className="field"><span>עמוד המקור</span><input inputMode="numeric" value={draft.page} maxLength={4} onChange={event=>change('page',event.target.value)}/></label>}
   <label className="field"><span>מיקום השדה או הקבוצה בעמוד</span><input value={draft.locator} maxLength={120} onChange={event=>change('locator',event.target.value)} placeholder="למשל: כותרת הטבלה ושם השורה"/></label>
   <label className="field"><span>הכיתוב במקור שמבסס את ההעתקה או השיוך</span><textarea value={draft.text} maxLength={160} onChange={event=>change('text',event.target.value)}/></label>
   <p>יש להעתיק את הכיתוב הרלוונטי. אם המקור אינו מאפשר לקבוע את הפרט, בוחרים לא יודע או לא קריא.</p>
   <button className="button button--primary" type="button" disabled={disabled||!answer} onClick={()=>void submit()}>{busy?'שומרים…':action==='confirm'?'שמירת אישור הקשר':correction?'שמירת תיקון בדיקת המקור':'שמירת בדיקת המקור'}</button>
   <button className="button button--secondary" type="button" disabled={disabled||!answer} onClick={()=>void submit(true)}>שמירת טיוטה</button>
  </fieldset>:null}
  {action==='unknown'||action==='unreadable'?<p>התשובה נשמרת ביחס למקור. הבדיקות התלויות בפרט הזה יישארו חסרות; בדיקות עצמאיות יוכלו להמשיך.</p>:null}
  {error?<p role="alert" className="form-error">{error}</p>:null}
  {conflict?<button type="button" onClick={onAnswered}>טעינת המצב שנשמר</button>:null}
  {busy?<p role="status">שומרים את בדיקת המקור…</p>:null}
 </div>;
}
