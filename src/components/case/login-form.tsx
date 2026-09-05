"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";

// UX Run 1 / U3 (D-1.4). One route for login and recovery: phone or email,
// then a code, then every case of that identity. The answer to a contact is
// the same whether or not it exists.
export function LoginForm({ codeTtlMinutes }: { codeTtlMinutes: number }) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"contact" | "sending" | "code" | "verifying" | "done">("contact");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

  async function requestCode(event?: React.FormEvent) {
    event?.preventDefault();
    const value = contact.trim();
    if (value.length < 3) {
      setError("הזינו טלפון או אימייל.");
      return;
    }
    setPhase("sending");
    setError("");
    try {
      const response = await fetch("/api/cases/access/request", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact: value }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_send_failed"));
      setPhase("code");
      setNotice(`אם יש תיק על ${value}, נשלח אליו קוד. הקוד תקף ${codeTtlMinutes} דקות.`);
    } catch (caught) {
      setPhase("contact");
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_send_failed"));
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
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact: contact.trim(), code }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_code_invalid"));
      const result = (await response.json()) as { next?: string };
      setPhase("done");
      router.replace(typeof result.next === "string" ? result.next : "/cases");
    } catch (caught) {
      setPhase("code");
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_code_invalid"));
    }
  }

  if (phase === "contact" || phase === "sending") {
    return (
      <form className="received-card" onSubmit={requestCode} aria-busy={phase === "sending"}>
        <span className="mono">כניסה לתיק</span>
        <h1 ref={heading} tabIndex={-1}>הטלפון או האימייל שמסרת בבדיקה</h1>
        <p>נשלח קוד בן 6 ספרות. אין סיסמה. הקישור שנשלח אחרי התשלום פג? זו הדרך חזרה.</p>
        <label className="access-code-label">
          <span>טלפון או אימייל</span>
          <input className="access-code-input" autoComplete="username" inputMode="email" value={contact} onChange={(event) => setContact(event.target.value)} disabled={phase === "sending"} aria-invalid={error ? true : undefined} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button--primary button--wide" type="submit" disabled={phase === "sending"}>{phase === "sending" ? "שולחים…" : "שלחו לי קוד"}</button>
      </form>
    );
  }

  return (
    <form className="received-card" onSubmit={verify} aria-busy={phase === "verifying"}>
      <span className="mono">כניסה לתיק</span>
      <h1 ref={heading} tabIndex={-1}>הזינו את הקוד שקיבלתם</h1>
      {notice && <p>{notice}</p>}
      <label className="access-code-label">
        <span>קוד בן 6 ספרות</span>
        <input className="access-code-input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} disabled={phase !== "code"} aria-invalid={error ? true : undefined} />
      </label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button--primary button--wide" type="submit" disabled={phase !== "code"}>{phase === "verifying" ? "מאמתים…" : "כניסה"}</button>
      <div className="received-card__next">
        <b>לא קיבלתם קוד?</b>
        <span>
          <button type="button" className="link-button" onClick={() => requestCode()} disabled={phase !== "code"}>שלחו קוד חדש</button>
          {" · "}
          <button type="button" className="link-button" onClick={() => { setPhase("contact"); setCode(""); setError(""); }}>החליפו טלפון או אימייל</button>
        </span>
      </div>
    </form>
  );
}
