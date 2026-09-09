"use client";

import { useEffect, useState } from "react";
import { AddDocumentButton } from "./add-document-button";
import { useRouter } from "next/navigation";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { formatRequestDate, formatRequestMonth } from "@/lib/request-display";
import type { StoredRequest } from "@/server/product/reports/case-requests";

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

  if (request.answer_kind === "document") {
    return <AddDocumentButton publicId={publicId} label="צירוף המסמך לתיק" requestId={request.id} />;
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

export function ThreadView({ publicId, requests, renderedAt }: { publicId: string; requests: readonly StoredRequest[]; renderedAt: number }) {
  const router = useRouter();
  const open = requests.filter((request) => request.answered_at === null && request.source_current !== false && Date.parse(request.expires_at) > renderedAt);
  const expired = requests.filter((request) => request.answered_at === null && request.source_current !== false && Date.parse(request.expires_at) <= renderedAt);
  const superseded = requests.filter((request) => request.answered_at === null && request.source_current === false);
  // The initial render uses the same server instant through hydration. The DB
  // remains the expiry authority; refresh at the next deadline while open.
  useEffect(() => {
    const deadlines = requests.filter(request => request.answered_at === null && request.source_current !== false && Date.parse(request.expires_at) > renderedAt).map(request => Date.parse(request.expires_at));
    if (deadlines.length === 0) return;
    const timer = window.setTimeout(() => router.refresh(), Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now()) + 100));
    return () => window.clearTimeout(timer);
  }, [requests, renderedAt, router]);
  const answered = requests.filter((request) => request.answered_at !== null);
  const blocking = open.filter((request) => request.blocking);

  return (
    <div className="thread-view">
      <div className="received-card">
        <h1>שאלות בתיק</h1>
        {open.length === 0 ? (
          <p>אין כרגע שאלות פתוחות. אם נצטרך משהו כדי להמשיך, זה יופיע כאן.</p>
        ) : (
          <p>
            {blocking.length > 0
              ? "יש שאלה שאנחנו ממתינים לתשובה עליה כדי להמשיך. שעון הזמנים עצור עד שתענה."
              : "יש שאלה שתשפר את הדיוק. אפשר לענות בכל רגע — היא לא מעכבת את הבדיקה."}
          </p>
        )}
      </div>

      {open.map((request) => (
        <div className={`received-card thread-card${request.blocking ? " thread-card--blocking" : ""}`} key={request.id} id={`request-${request.id}`}>
          <p className="thread-card__meta">
            {request.blocking ? "ממתינים לתשובה כדי להמשיך" : "לא מעכב את הבדיקה"} · נשאל ב־{formatRequestDate(request.opened_at)} · פתוח עד {formatRequestDate(request.expires_at)}
          </p>
          {request.statement_month ? <p className="thread-card__meta">תקופת השאלה: {formatRequestMonth(request.statement_month)}</p> : null}
          <h2>{request.question}</h2>
          {request.field_crop && !request.code.startsWith('document_field:') ? <p className="thread-card__crop">השדה בתלוש: {request.field_crop}</p> : null}
          {request.code.startsWith('document_field:') ? <p><a href={`/api/cases/${publicId}/requests?source=${request.id}`} target="_blank" rel="noopener noreferrer">פתיחת המסמך לאימות השדה</a><br />האישור מתייחס לקריאת הנתון במסמך ואינו אישור של החישוב או של הזכאות.</p> : null}
          <AnswerForm key={`${request.id}:${request.draft_revision}:${request.answer_revision}`} request={request} publicId={publicId} onAnswered={() => router.refresh()} />
        </div>
      ))}

      {expired.length > 0 ? <div className="received-card"><h2>שאלות שנסגרו ללא תשובה</h2>{expired.map(request => <p key={request.id}>{request.question} — הסתיים המועד להשלמה.</p>)}</div> : null}
      {superseded.length > 0 ? <div className="received-card"><h2>שאלות ממסמך קודם</h2><p>המסמך או תקופתו השתנו. השאלות נשמרות בהיסטוריה ואינן ממתינות לאישור. אם יהיה צורך בהשלמה מהמסמך העדכני, תופיע שאלה חדשה.</p>{superseded.map(request => <p key={request.id}>{request.question}</p>)}</div> : null}

      {answered.length > 0 ? (
        <div className="received-card">
          <h2>מה כבר עניתם</h2>
          <ul className="thread-answered">
            {answered.map((request) => (
              <li key={request.id}>
                <p className="thread-answered__question">{request.question}</p>
                {request.statement_month ? <p>תקופת התשובה: {formatRequestMonth(request.statement_month)}</p> : null}
                <p className="thread-answered__answer">{request.answer_text}</p>
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
