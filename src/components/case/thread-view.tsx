"use client";

import { useEffect, useState } from "react";
import { AddDocumentButton } from "./add-document-button";
import { useRouter } from "next/navigation";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { formatRequestDate, formatRequestMonth } from "@/lib/request-display";
import type { StoredRequest } from "@/server/product/reports/case-requests";
import {HoursConflictAnswer} from './hours-conflict-answer';
import {HOURS_CONFLICT_NAMESPACE,formatHoursConflictAnswer} from '@/server/product/reports/document-hours-conflict-answer';
import {DocumentFieldAnswer} from './document-field-answer';
import {displayDocumentReadingAnswer,documentRowCellLabels,groupDocumentReadingRequests,type DocumentReadingRequestGroup} from '@/lib/document-reading-display';
import {balanceMovementLabels} from '@/lib/source-structure-display';

function displayAnswer(request:StoredRequest){
 if(request.code.startsWith('document_field:'))return displayDocumentReadingAnswer(request.answer_text,request.reading_display);
 if(!request.code.startsWith(HOURS_CONFLICT_NAMESPACE))return request.answer_text;
 try{return formatHoursConflictAnswer(request.answer_text??'');}catch{return 'התשובה השמורה אינה זמינה להצגה.';}
}

const documentSatisfied=(request:StoredRequest)=>request.source_current===true&&request.source_intake_upload_state?.state==='satisfied'&&request.source_intake_upload_state.information_satisfied
 ||request.source_current!==false&&request.document_upload_state?.state==='satisfied'&&request.document_upload_state.information_satisfied;
function DocumentUploadStatus({request}:{request:StoredRequest}){
 const intake=request.source_intake_upload_state;
 if(intake&&intake.state!=='requested')return <div role="status">
  <p>{intake.state==='satisfied'?'סוג המקור ותקופתו זוהו. קליטת המקור הושלמה; הבדיקות בתשעת הנושאים נמשכות בנפרד.'
   :intake.state==='stale'?'המקור שהתקבל הוחלף. הקבלה והקריאה הקודמות נשמרות בהיסטוריה.'
    :intake.state==='received_pending_reading'?'הקובץ התקבל. זיהוי סוג המסמך והתקופה טרם הושלם; אין צורך להעלות שוב את אותו קובץ.'
     :intake.reason==='duplicate_content'?'הקובץ הוא העתק של מקור שכבר קיים בתיק. המידע החסר עדיין לא זוהה.'
      :intake.reason==='source_reading_unresolved'?'קריאת המקור נשארה לא ידועה או לא קריאה. אפשר לתקן את הקריאה או לצרף מקור ברור יותר.'
       :'עדיין לא זוהתה במקור תקופה מלאה שניתן לבדוק. הקריאה והקובץ נשמרו.'}</p>
  {intake.reading_request_ids.map((id,index)=><p key={id}><a href={`#request-${id}`}>זיהוי סוג המסמך והתקופה במקור {index+1}</a></p>)}
 </div>;
 const upload=request.document_upload_state;if(!upload||upload.state==='requested')return null;
 if(upload.state==='satisfied')return <p role="status">המידע הנדרש נמצא במסמך שהעלית. ההשלמה נשמרת בהיסטוריה.</p>;
 if(upload.state==='received_pending_review')return <p role="status">הקובץ התקבל וממתין לבדיקה. עדיין לא נקבע שהמידע הנדרש נמצא בו. אין צורך להעלות שוב את אותו קובץ.</p>;
 if(upload.state==='stale')return <p role="status">המסמך שנבדק הוחלף. הגרסה החדשה תיבדק בנפרד; ההשלמה הקודמת נשמרת בהיסטוריה.</p>;
 const detail=upload.reason==='duplicate_content'?'זהו תוכן שכבר קיים בתיק. כדי להשלים את המידע, יש לצרף מסמך אחר או גרסה מלאה וברורה יותר.'
  :upload.reason==='dependent_check_not_evaluated'||upload.reason==='unsupported_document_kind'?'המידע הדרוש עדיין לא אומת בבדיקה. הקובץ נשמר בתיק.'
   :'המידע הדרוש עדיין לא נמצא באופן ברור ומלא. יש לצרף מסמך שמציג אותו עבור התקופה המבוקשת.';
 return <p role="status">הקובץ התקבל, אך ההשלמה עדיין חסרה. {detail}</p>;
}

// Site S3.4 / D-2. The thread renders questions the engine asked and the
// answers already given. It never invents a question: every card here came from
// a refusal, and the customer can see which of them is holding the case.

function AnswerForm({ request, publicId, onAnswered, correction = false }: { request: StoredRequest; publicId: string; onAnswered: () => void; correction?: boolean }) {
  const [value, setValue] = useState(request.draft_text ?? (correction ? request.answer_text ?? "" : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);

  async function submit(action: "answer" | "draft" | "correction" = correction ? "correction" : "answer") {
    if (!value.trim()) {
      setError("צריך לענות כדי לשלוח.");
      return;
    }
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      const response = await fetch(`/api/cases/${publicId}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.id, answer: value.trim(), action, expectedRevision: action === "draft" ? request.draft_revision ?? 0 : request.answer_revision ?? 0 }),
      });
      if (!response.ok) {
        if(response.status===409)setConflict(true);
        throw new Error(await customerErrorFromResponse(response, "request_answer_failed"));
      }
      onAnswered();
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "request_answer_failed"));
      setBusy(false);
    }
  }

  if(request.code.startsWith(HOURS_CONFLICT_NAMESPACE))return <HoursConflictAnswer request={request} publicId={publicId} onAnswered={onAnswered} correction={correction}/>;
  if(request.code.startsWith('document_field:')&&request.reading_display)return <DocumentFieldAnswer request={request} publicId={publicId} onAnswered={onAnswered} correction={correction}/>;

  if (request.answer_kind === "document") {
    if(request.source_intake_upload_state?.state==='received_pending_reading')return null;
    return <AddDocumentButton publicId={publicId} label={request.document_upload_state?.state==='received_pending_review'?"צירוף מסמך נוסף לבקשה":"צירוף המסמך לתיק"} requestId={request.id} />;
  }

  if (request.answer_kind === "choice" && request.options) {
    return (
      <div className="thread-answer">
        <div className="option-row">
          {request.options.map((option) => (
            <button
              className={value === option ? "option-button is-selected" : "option-button"}
              type="button"
              key={option}
              aria-pressed={value === option}
              onClick={() => setValue(option)}
              disabled={busy}
            >
              {option}
            </button>
          ))}
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {conflict ? <button className="button button--secondary" type="button" onClick={onAnswered}>טעינת התשובה שנשמרה</button> : null}
        <button className="button button--primary" type="button" onClick={() => void submit()} disabled={busy || !value}>
          {busy ? "שומרים…" : correction ? "שליחת תיקון" : "שליחת תשובה"}
        </button>
        <button className="button button--secondary" type="button" onClick={() => void submit("draft")} disabled={busy || !value.trim()}>שמירת טיוטה</button>
      </div>
    );
  }

  return (
    <div className="thread-answer">
      <label className="field">
        <span className="v5-visually-hidden">תשובה</span>
        <input
          type={request.answer_kind === "number" ? "number" : "text"}
          inputMode={request.answer_kind === "number" ? "decimal" : "text"}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `thread-answer-error-${request.id}` : undefined}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        />
      </label>
      {error ? <p className="form-error" id={`thread-answer-error-${request.id}`} role="alert">{error}</p> : null}
      {conflict ? <button className="button button--secondary" type="button" onClick={onAnswered}>טעינת התשובה שנשמרה</button> : null}
      <button className="button button--primary" type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? "שומרים…" : correction ? "שליחת תיקון" : "שליחת תשובה"}
      </button>
      <button className="button button--secondary" type="button" onClick={() => void submit("draft")} disabled={busy || !value.trim()}>שמירת טיוטה</button>
    </div>
  );
}

function RowReadingGroup({group,publicId,onAnswered}:{group:Extract<DocumentReadingRequestGroup<StoredRequest>,{kind:'row'|'balance'}>;publicId:string;onAnswered:()=>void}){
 const first=group.requests[0],display=first.reading_display!;
 const cellLabel=(request:StoredRequest)=>{const context=request.reading_display!.structure_context;return group.kind==='balance'&&context?.kind==='balance_movement'
  ?balanceMovementLabels[context.cell]:documentRowCellLabels[request.reading_display!.row_context!.cell];};
 return <div className="received-card thread-card">
  <h2>{group.kind==='balance'?'בדיקת תאים בטבלת יתרות':'בדיקת תאים בשורה'}: {group.label}</h2>
  <p>עמוד {group.page}. פותחים את המקור פעם אחת ובודקים כל תא בנפרד. אישור של תא אינו מאשר את השורה כולה, את החישוב או את הזכאות.</p>
  <p><a href={`/api/cases/${publicId}/requests?source=${first.id}&view=marked#page=${group.page}`} target="_blank" rel="noopener noreferrer">פתיחת שורת המקור לבדיקה</a></p>
  {display.text_fragment?<blockquote>{display.text_fragment}</blockquote>:null}
  {!display.bounding_box?<p>לא התקבל מיקום מדויק של השורה. יש לאתר אותה בעמוד המקור לפי הכיתוב והערכים.</p>:null}
  {group.kind==='balance'?<p>כל תא יתרה, יחידתו ותקופתו נשמרים בהחלטה נפרדת. תאים שכבר נענו נשארים בהיסטוריה.</p>:null}
  {group.requests.map(request=><section key={request.id} id={`request-${request.id}`} aria-label={`בדיקת ${cellLabel(request)} בשורה`}>
   <h3>{cellLabel(request)}</h3>
   <p>{request.question}</p>
   <p className="thread-card__meta">פתוח עד {formatRequestDate(request.expires_at)}{request.statement_month?` · תקופת השאלה: ${formatRequestMonth(request.statement_month)}`:''}</p>
   <DocumentFieldAnswer key={`${request.id}:${request.draft_revision}:${request.answer_revision}`} request={request} publicId={publicId} onAnswered={onAnswered} sourceShared/>
  </section>)}
 </div>;
}

export function ThreadView({ publicId, requests, renderedAt }: { publicId: string; requests: readonly StoredRequest[]; renderedAt: number }) {
  const router = useRouter();
  const open = requests.filter((request) => request.answered_at === null && !request.not_required_for_current_review && !request.covered_by_field_request_id && !documentSatisfied(request) && request.source_current !== false && Date.parse(request.expires_at) > renderedAt);
  const deferred=requests.filter(request=>request.answered_at===null&&request.not_required_for_current_review&&request.source_current===true&&Date.parse(request.expires_at)>renderedAt);
  const expired = requests.filter((request) => request.answered_at === null && !documentSatisfied(request) && request.source_current !== false && Date.parse(request.expires_at) <= renderedAt);
  const superseded = requests.filter((request) => request.answered_at === null && request.source_current === false);
  // The initial render uses the same server instant through hydration. The DB
  // remains the expiry authority; refresh at the next deadline while open.
  useEffect(() => {
    const deadlines = requests.filter(request => request.answered_at === null && !request.not_required_for_current_review && !documentSatisfied(request) && request.source_current !== false && Date.parse(request.expires_at) > renderedAt).map(request => Date.parse(request.expires_at));
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => router.refresh(), Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now()) + 100));
    return () => window.clearTimeout(timer);
  }, [requests, renderedAt, router]);
  const answered = requests.filter((request) => request.answered_at !== null);
  const fulfilled = requests.filter((request) => request.answered_at === null && documentSatisfied(request));
  const covered = requests.filter(request=>request.answered_at===null&&request.source_current!==false&&!!request.covered_by_field_request_id&&Date.parse(request.expires_at)>renderedAt);
  const blocking = open.filter((request) => request.blocking);

  return (
    <div className="thread-view">
      <div className="received-card">
        <h1>שאלות בתיק</h1>
        <p>{open.length} פעולות נדרשות כעת{deferred.length?` · ${deferred.length} שאלות נשמרו ואינן נדרשות לבדיקה הנוכחית.`:''}</p>
        {answered.length>0&&open.length>0&&deferred.length===0?<p>הספירה מתייחסת לפעולות שמוצגות כעת. לאחר עיבוד תשובות חדשות, הרשימה עשויה להתעדכן; שמירת תשובה אינה קובעת שהבדיקה הושלמה.</p>:null}
        {open.length === 0 ? (
          <p>אין כרגע שאלות פתוחות. אם נצטרך משהו כדי להמשיך, זה יופיע כאן.</p>
        ) : (
          <p>
            {blocking.length > 0
              ? "יש שאלה שאנחנו ממתינים לתשובה עליה כדי להמשיך. שעון הזמנים עצור עד שתענה."
              : open.every(request=>request.document_upload_state?.state==='received_pending_review'||request.source_intake_upload_state?.state==='received_pending_reading')
                ? "הקבצים התקבלו וממתינים לבדיקת המידע. מצב כל השלמה מופיע כאן."
              : open.some(request=>request.code.startsWith('minimum_wage_june2026:')||request.code.startsWith(HOURS_CONFLICT_NAMESPACE))
                ? "השאלות נועדו להשלמת מידע על תקופת העבודה ורכיבי השכר. התשובות נשמרות בתיק."
                : "יש שאלה שתשפר את הדיוק. אפשר לענות בכל רגע — היא לא מעכבת את הבדיקה."}
          </p>
        )}
      </div>

      {groupDocumentReadingRequests(open).map(group => {
       if(group.kind==='row'||group.kind==='balance')return <RowReadingGroup key={`${group.kind}:${group.group_id}`} group={group} publicId={publicId} onAnswered={()=>router.refresh()}/>;
       const request=group.requests[0];return (
        <div className={`received-card thread-card${request.blocking ? " thread-card--blocking" : ""}`} key={request.id} id={`request-${request.id}`}>
          <p className="thread-card__meta">
            {request.blocking ? "ממתינים לתשובה כדי להמשיך" : request.code.startsWith('minimum_wage_june2026:')||request.code.startsWith(HOURS_CONFLICT_NAMESPACE)?"נדרש מידע להמשך הבירור":"לא מעכב את הבדיקה"} · נשאל ב־{formatRequestDate(request.opened_at)} · פתוח עד {formatRequestDate(request.expires_at)}
          </p>
          {request.statement_month ? <p className="thread-card__meta">תקופת השאלה: {formatRequestMonth(request.statement_month)}</p> : null}
          <h2>{request.question}</h2>
          <DocumentUploadStatus request={request}/>
          {request.field_crop && !request.code.startsWith('document_field:') && !request.code.startsWith('minimum_wage_june2026:') && !request.code.startsWith('document_transcription:') && !request.code.startsWith(HOURS_CONFLICT_NAMESPACE) ? <p className="thread-card__crop">השדה בתלוש: {request.field_crop}</p> : null}
          {request.code.startsWith(HOURS_CONFLICT_NAMESPACE)?<p><a href={`/api/cases/${publicId}/requests?source=${request.id}`} target="_blank" rel="noopener noreferrer">פתיחת התלוש לבירור הסתירה</a></p>:null}
          {(request.code.startsWith('document_field:')&&!request.reading_display?.row_context&&!request.reading_display?.transcription_context&&!request.reading_display?.field.startsWith('source_scope.')||request.code.startsWith('document_transcription:')) ? <p><a href={`/api/cases/${publicId}/requests?source=${request.id}`} target="_blank" rel="noopener noreferrer">פתיחת המסמך לאימות השדה</a><br />האישור מתייחס לקריאת הנתון במסמך ואינו אישור של החישוב או של הזכאות.</p> : null}
          {request.code.startsWith('minimum_wage_june2026:') ? <p><a href={`/api/cases/${publicId}/requests?source=${request.id}`} target="_blank" rel="noopener noreferrer">פתיחת התלוש שאליו מתייחסת השאלה</a><br />התשובה נשמרת כהצהרתך לצורך הבירור ואינה אישור משפטי של החישוב או הזכאות.</p> : null}
          <AnswerForm key={`${request.id}:${request.draft_revision}:${request.answer_revision}`} request={request} publicId={publicId} onAnswered={() => router.refresh()} />
        </div>
      );})}

      {covered.length>0?<div className="received-card"><h2>שאלות שמטופלות באימות השדה</h2><p>אין צורך להשיב על אותו תא פעמיים. אימות הקריאה אינו אישור לחישוב או לזכאות.</p>{covered.map(request=><p key={request.id} id={`request-${request.id}`}>{request.question} — {request.covered_by_confirmed_reading?'הקריאה כבר נבדקה ונכללה בדוח העדכני. ':request.covered_by_unresolved_reading?'נשמרה תשובה שלא ניתן לאמת את התא. הבדיקה נשארת חסרה; אפשר לתקן את התשובה או לצרף מקור ברור. ':''}<a href={`#request-${request.covered_by_field_request_id}`}>{request.covered_by_confirmed_reading||request.covered_by_unresolved_reading?'מעבר לקריאה שנשמרה':'מעבר לשאלת אימות הקריאה'}</a></p>)}</div>:null}
      {expired.length > 0 ? <div className="received-card"><h2>שאלות שנסגרו ללא תשובה</h2>{expired.map(request => <p key={request.id}>{request.question} — הסתיים המועד להשלמה.</p>)}</div> : null}
      {superseded.length > 0 ? <div className="received-card"><h2>שאלות ממסמך קודם</h2><p>המסמך או תקופתו השתנו. השאלות נשמרות בהיסטוריה ואינן ממתינות לאישור. אם יהיה צורך בהשלמה מהמסמך העדכני, תופיע שאלה חדשה.</p>{superseded.map(request => <p key={request.id}>{request.question}</p>)}</div> : null}

      {fulfilled.length>0?<div className="received-card"><h2>השלמות שהמידע בהן נמצא</h2><ul className="thread-answered">{fulfilled.map(request=><li key={request.id} id={`request-${request.id}`}><p className="thread-answered__question">{request.question}</p><DocumentUploadStatus request={request}/>{request.statement_month?<p>תקופת ההשלמה: {formatRequestMonth(request.statement_month)}</p>:null}</li>)}</ul></div>:null}

      {deferred.length?<div className="received-card"><h2>לא נדרש לבדיקה הנוכחית</h2><p>שאלות אלה נשמרו ללא תשובה. מענה עליהן אינו דרוש לקידום הבדיקות האפשריות בדוח הנוכחי. פערי שיוך המקור עדיין מופיעים בדוח. זו אינה קביעה שהנתונים אינם נדרשים לבדיקות אחרות או לזכאות; שינוי במסמך או בבדיקה עשוי להחזיר שאלה לרשימה הפעילה.</p><ul>{deferred.map(request=><li key={request.id} id={`request-${request.id}`}>{request.question}{request.replacement_review_request_id?<p>תאי המקור ריקים. <a href={`#request-${request.replacement_review_request_id}`}>מעבר לשאלה על מקור נוסף לשורה</a></p>:null}</li>)}</ul></div>:null}
      {answered.length > 0 ? (
        <div className="received-card">
          <h2>מה כבר עניתם</h2>
          <ul className="thread-answered">
            {answered.map((request) => (
              <li key={request.id} id={`request-${request.id}`}>
                <p className="thread-answered__question">{request.question}</p>
                {request.statement_month ? <p>תקופת התשובה: {formatRequestMonth(request.statement_month)}</p> : null}
                <p className="thread-answered__answer">{displayAnswer(request)}</p>
                {request.covered_by_field_request_id?<p>התשובה המספרית נשמרה כהצהרה. כדי להשתמש בה כקריאת מסמך נדרש אימות התא במקור. <a href={`#request-${request.covered_by_field_request_id}`}>מעבר לאימות השדה</a></p>:null}
                {request.source_current === true && request.code.startsWith('document_field:') && ['הערך שונה במסמך','לא ניתן לקרוא את השדה'].includes(request.answer_text ?? '') ? <div><p>אפשר לצרף גרסה ברורה או מתוקנת של אותו מסמך. המסמך הקודם נשמר עד להשלמת ההחלפה. התשובה נשארת בהיסטוריה; המסמך החדש ייבדק בנפרד.</p><AddDocumentButton publicId={publicId} sourceRequestId={request.id} label="החלפת המסמך של השאלה" /></div> : null}
                {(request.answer_revision ?? 1) > 1 ? <p>תשובה מתוקנת · גרסה {request.answer_revision}. התשובה המקורית נשמרה.</p> : null}
                {request.source_current === false ? <p>התשובה נשמרה ביחס למסמך הקודם. היא אינה מאשרת נתונים מהמסמך העדכני.</p> : request.answer_kind !== "document" ? <details><summary>תיקון התשובה</summary><AnswerForm key={`${request.id}:${request.draft_revision}:${request.answer_revision}`} request={request} publicId={publicId} correction onAnswered={() => router.refresh()} /></details> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
