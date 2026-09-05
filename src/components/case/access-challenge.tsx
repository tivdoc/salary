"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";

// UX Run 1 / U3 (D-1.2), corrected by the external review #1. The code
// screen, in two modes: `challenge` — the link was exchanged for a cookie and
// the code already went out; `funnel` — the case cookie's own contact is
// being verified before any document binds (finding 1). No token is ever in
// this component's props or requests.
export function AccessChallenge({ mode, publicId, maskedTo, channel, codeTtlMinutes, onVerified, onChangeContact }: {
  mode: "challenge" | "funnel";
  publicId: string | null;
  maskedTo: string | null;
  channel: "email" | "phone" | null;
  codeTtlMinutes: number;
  /** Funnel only: what to do after the verification instead of following `next`. */
  onVerified?: (next: string) => void;
  /** Funnel only: go back to the contact fields. */
  onChangeContact?: () => void;
}) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<"code" | "sending" | "verifying" | "done">("code");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(maskedTo ? `שלחנו קוד ל־${maskedTo}` : "שלחנו קוד לערוץ שמסרת");

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

  async function resend() {
    setPhase("sending");
    setError("");
    try {
      const response = await fetch("/api/cases/access/request", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "funnel" ? { funnel: true } : { challenge: true }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_send_failed"));
      const result = (await response.json()) as { to?: string | null };
      setNotice(result.to ? `שלחנו קוד חדש ל־${result.to}` : "שלחנו קוד חדש");
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_send_failed"));
    } finally {
      setPhase("code");
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!/^[0-9]{6}$/u.test(code)) {
      setError("הקוד הוא שש ספרות.");
      return;
    }
    setPhase("verifying");
    setError("");
    try {
      const response = await fetch("/api/cases/access/verify", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "funnel" ? { funnel: true, code } : { challenge: true, code }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_code_invalid"));
      const result = (await response.json()) as { next?: string };
      const next = typeof result.next === "string" ? result.next : publicId ? `/case/${publicId}` : "/cases";
      setPhase("done");
      if (onVerified) onVerified(next);
      else router.replace(next);
    } catch (caught) {
      setPhase("code");
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_code_invalid"));
    }
  }

  return (
    <div className="received-card">
      {publicId ? <span className="mono">תיק {publicId}</span> : <span className="mono">אימות</span>}
      <h1 ref={heading} tabIndex={-1}>{mode === "funnel" ? "אימות הטלפון או האימייל שמסרת" : "הזינו את הקוד שקיבלתם"}</h1>
      <p>{notice} {channel === "phone" ? "(SMS)" : channel === "email" ? "(אימייל)" : ""}. הקוד תקף {codeTtlMinutes} דקות.</p>
      {mode === "funnel" && <p>מאמתים לפני שמעלים תלוש: כך המסמכים שלך נקשרים רק לערוץ שבאמת שלך.</p>}
      <form onSubmit={verify} aria-busy={phase === "verifying"}>
        <label className="access-code-label">
          <span>קוד בן 6 ספרות</span>
          <input
            className="access-code-input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))}
            disabled={phase !== "code"}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button--primary button--wide" type="submit" disabled={phase !== "code"}>
          {phase === "verifying" ? "מאמתים…" : mode === "funnel" ? "אימות והמשך להעלאת תלוש" : "כניסה לתיק"}
        </button>
      </form>
      <div className="received-card__next">
        <b>לא קיבלתם קוד?</b>
        <span>
          <button type="button" className="link-button" onClick={resend} disabled={phase !== "code"}>{phase === "sending" ? "שולחים…" : "שלחו קוד חדש"}</button>
          {" · "}
          {mode === "funnel" && onChangeContact
            ? <button type="button" className="link-button" onClick={onChangeContact}>תיקון הטלפון או האימייל</button>
            : <a href="/login">כניסה עם טלפון או אימייל</a>}
        </span>
      </div>
    </div>
  );
}
