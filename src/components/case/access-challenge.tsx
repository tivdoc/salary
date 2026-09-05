"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";

// UX Run 1 / U3 (D-1.2). The code challenge the sent link opens: the code
// goes to the channel on file the moment the page loads; six digits open the
// case. The token travels in the request body only.
export function AccessChallenge({ token, publicId, maskedTo, channel, codeTtlMinutes }: {
  token: string;
  publicId: string;
  maskedTo: string | null;
  channel: "email" | "phone" | null;
  codeTtlMinutes: number;
}) {
  const router = useRouter();
  const requested = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<"sending" | "code" | "verifying" | "done">("sending");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function requestCode() {
    setError("");
    try {
      const response = await fetch("/api/cases/access/request", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_send_failed"));
      setPhase("code");
      setNotice(maskedTo ? `שלחנו קוד ל־${maskedTo}` : "שלחנו קוד לערוץ שמסרת");
    } catch (caught) {
      setPhase("code");
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_send_failed"));
    }
  }

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void requestCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    heading.current?.focus();
  }, [phase]);

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
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, code }),
      });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_code_invalid"));
      const result = (await response.json()) as { next?: string };
      setPhase("done");
      router.replace(typeof result.next === "string" ? result.next : `/case/${publicId}`);
    } catch (caught) {
      setPhase("code");
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_code_invalid"));
    }
  }

  return (
    <div className="received-card">
      <span className="mono">תיק {publicId}</span>
      <h1 ref={heading} tabIndex={-1}>{phase === "sending" ? "שולחים קוד כניסה…" : "הזינו את הקוד שקיבלתם"}</h1>
      {notice && <p>{notice} {channel === "phone" ? "(SMS)" : channel === "email" ? "(אימייל)" : ""}. הקוד תקף {codeTtlMinutes} דקות.</p>}
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
            disabled={phase === "sending" || phase === "verifying" || phase === "done"}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button--primary button--wide" type="submit" disabled={phase !== "code"}>
          {phase === "verifying" ? "מאמתים…" : "כניסה לתיק"}
        </button>
      </form>
      <div className="received-card__next">
        <b>לא קיבלתם קוד?</b>
        <span>
          <button type="button" className="link-button" onClick={requestCode} disabled={phase === "sending" || phase === "verifying"}>שלחו קוד חדש</button>
          {" · "}
          <a href="/login">כניסה עם טלפון או אימייל</a>
        </span>
      </div>
    </div>
  );
}
