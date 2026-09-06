"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import type { StoredRequest } from "@/server/product/reports/case-requests";

// Site S3.4 / D-2. The thread renders questions the engine asked and the
// answers already given. It never invents a question: every card here came from
// a refusal, and the customer can see which of them is holding the case.

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString("he-IL", { day: "numeric", month: "long" });
}

function AnswerForm({ request, publicId, onAnswered }: { request: StoredRequest; publicId: string; onAnswered: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!value.trim()) {
      setError("צריך לענות כדי לשלוח.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/cases/${publicId}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request.id, answer: value.trim() }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "request_answer_failed"));
      onAnswered();
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "request_answer_failed"));
      setBusy(false);
    }
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
        <button className="button button--primary" type="button" onClick={() => void submit()} disabled={busy || !value}>
          {busy ? "שולחים…" : "שליחת תשובה"}
        </button>
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
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        />
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button button--primary" type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? "שולחים…" : "שליחת תשובה"}
      </button>
    </div>
  );
}

export function ThreadView({ publicId, requests }: { publicId: string; requests: readonly StoredRequest[] }) {
  const router = useRouter();
  const open = requests.filter((request) => request.answered_at === null);
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
        <div className={`received-card thread-card${request.blocking ? " thread-card--blocking" : ""}`} key={request.id}>
          <p className="thread-card__meta">
            {request.blocking ? "ממתינים לתשובה כדי להמשיך" : "לא מעכב את הבדיקה"} · נשאל ב־{formatWhen(request.opened_at)} · פתוח עד {formatWhen(request.expires_at)}
          </p>
          <h2>{request.question}</h2>
          {request.field_crop ? <p className="thread-card__crop">השדה בתלוש: {request.field_crop}</p> : null}
          <AnswerForm request={request} publicId={publicId} onAnswered={() => router.refresh()} />
        </div>
      ))}

      {answered.length > 0 ? (
        <div className="received-card">
          <h2>מה כבר עניתם</h2>
          <ul className="thread-answered">
            {answered.map((request) => (
              <li key={request.id}>
                <p className="thread-answered__question">{request.question}</p>
                <p className="thread-answered__answer">{request.answer_text}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
