"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, ClockCountdown, WarningCircle } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { metaEventDescriptor, trackMetaBrowserEventOnce } from "@/lib/meta-browser";
import { formatDuration, initialCheckPriceNumber, productOffer } from "@/lib/product-offer";

// UX Run 1 / U5. The received screen is an answer, not a waiting room: the
// delivery estimate comes from configuration (D-7.1); the link to the case
// was sent to the channel on file and can be sent again; verification is
// re-checked on demand with the time of the last check shown; after a named
// number of seconds without verification the screen names the state and a
// way to reach a person instead of going quiet. Nothing here stops silently.

type CaseStatus = {
  publicId: string;
  status: string;
  paymentStatus: string;
  paymentVerified: boolean;
  trackPaymentCompleted: boolean;
  metaEvent?: unknown;
};

function clock(date: Date): string {
  return date.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ReceivedStatus() {
  const offer = productOffer();
  const paymentTracked = useRef(false);
  const startedAt = useRef<number | null>(null);
  const [data, setData] = useState<CaseStatus | null>(null);
  const [error, setError] = useState("");
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  const [resend, setResend] = useState<{ state: "idle" | "sending" | "sent" | "failed"; message: string }>({ state: "idle", message: "" });

  const load = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch("/api/cases/status", { cache: "no-store" });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "case_status_unavailable"));
      const result = (await response.json()) as CaseStatus;
      setData(result);
      setError("");
      const metaEvent = metaEventDescriptor(result.metaEvent);
      if (result.paymentVerified && metaEvent?.eventName === "Purchase") trackMetaBrowserEventOnce(metaEvent);
      if (result.trackPaymentCompleted && !paymentTracked.current) {
        paymentTracked.current = true;
        trackEvent("payment_completed", { value: initialCheckPriceNumber(), currency: offer.currency });
      }
      return result;
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "case_status_unavailable"));
      return null;
    } finally {
      setChecking(false);
      setLastChecked(new Date());
    }
  }, [offer.currency]);

  useEffect(() => {
    trackEvent("payment_returned");
    startedAt.current = Date.now();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const result = await load();
      if (!active) return;
      if (result?.paymentVerified) return;
      if (Date.now() - (startedAt.current ?? Date.now()) >= offer.verification_wait.named_state_after_seconds * 1_000) {
        setWaitedTooLong(true);
        return;
      }
      timer = setTimeout(poll, offer.verification_wait.poll_interval_seconds * 1_000);
    }
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [load, offer.verification_wait.named_state_after_seconds, offer.verification_wait.poll_interval_seconds]);

  async function resendLink() {
    setResend({ state: "sending", message: "" });
    try {
      const response = await fetch("/api/cases/access/resend", { method: "POST" });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "access_send_failed"));
      setResend({ state: "sent", message: "שלחנו את הקישור שוב לערוץ שמסרת." });
    } catch (caught) {
      setResend({ state: "failed", message: customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "access_send_failed") });
    }
  }

  const contact = offer.contact.support_email
    ? <a href={`mailto:${offer.contact.support_email}`}>{offer.contact.support_email}</a>
    : <Link href="/login">כניסה לתיק עם הטלפון או האימייל שמסרת</Link>;

  const recheck = (
    <p className="received-card__recheck">
      <button type="button" className="link-button" onClick={() => void load()} disabled={checking}>{checking ? "בודקים…" : "בדיקה מחדש"}</button>
      {lastChecked ? <span className="mono"> · נבדק לאחרונה {clock(lastChecked)}</span> : null}
    </p>
  );

  if (error && !data) {
    return (
      <div className="received-card received-card--error">
        <WarningCircle weight="duotone" aria-hidden="true" />
        <h1>לא הצלחנו לזהות את הבדיקה.</h1>
        <p>{error}</p>
        {recheck}
        <p>אם שילמת, הקישור לתיק נשלח לערוץ שמסרת: {contact}.</p>
        <Link className="button button--secondary" href="/check">התחלת בדיקה חדשה</Link>
      </div>
    );
  }

  if (!data) {
    return <div className="received-card" aria-busy="true"><div className="status-skeleton" /><div className="status-skeleton status-skeleton--short" /><p>בודקים את מצב הבדיקה…</p></div>;
  }

  if (data.paymentVerified) {
    return (
      <div className="received-card received-card--verified">
        <CheckCircle weight="duotone" aria-hidden="true" />
        <span className="mono">תיק {data.publicId}</span>
        <h1>התשלום אומת. הבדיקה התקבלה.</h1>
        <p>המסמכים והפרטים שלך נשמרו, והתיק בעבודה.</p>
        <div className="received-card__next">
          <b>מתי מגיעה התוצאה?</b>
          <span>במסלול האוטומטי תוך {formatDuration(offer.initial_check.delivery.automatic)}; כשהתלוש עובר לבדיקה אנושית — {formatDuration(offer.initial_check.delivery.human)}.</span>
        </div>
        <div className="received-card__next">
          <b>איך חוזרים לתיק?</b>
          <span>שלחנו קישור לערוץ שמסרת. הוא פותח את התיק מכל מכשיר, עם קוד חד־פעמי. לא הגיע? <button type="button" className="link-button" onClick={resendLink} disabled={resend.state === "sending"}>{resend.state === "sending" ? "שולחים…" : "שלחו לי את הקישור שוב"}</button></span>
        </div>
        {resend.message && <div className={resend.state === "failed" ? "form-error" : "form-notice"} role="status">{resend.message}</div>}
        <p className="payment-note">{offer.second_product_sentence}</p>
        <Link className="button button--secondary" href={`/case/${data.publicId}`}>לתיק שלי</Link>
      </div>
    );
  }

  if (waitedTooLong) {
    return (
      <div className="received-card received-card--pending">
        <WarningCircle weight="duotone" aria-hidden="true" />
        <span className="mono">תיק {data.publicId}</span>
        <h1>האימות מתעכב.</h1>
        <p>עברו יותר מ־{offer.verification_wait.named_state_after_seconds} שניות בלי אישור מחברת הסליקה. זה קורה; התשלום לא אבד והתיק נשמר. האימות ממשיך ברקע ומתעדכן גם אחרי שסוגרים את החלון.</p>
        {recheck}
        <div className="received-card__next"><b>לא מסתדר?</b><span>{contact}</span></div>
        <Link className="button button--secondary" href="/">חזרה לעמוד הבית</Link>
      </div>
    );
  }

  return (
    <div className="received-card received-card--pending">
      <ClockCountdown weight="duotone" aria-hidden="true" />
      <span className="mono">תיק {data.publicId}</span>
      <h1>חזרת מעמוד התשלום. ממתינים לאימות.</h1>
      <p>לא סימנו את התשלום כהושלם רק בגלל החזרה לעמוד הזה. הסטטוס מתעדכן לאחר שנקבל אימות מחברת הסליקה.</p>
      {recheck}
      <div className="received-card__next"><b>אפשר לסגור את החלון.</b><span>התיק נשמר. כשהתשלום יאומת נשלח קישור לתיק לערוץ שמסרת.</span></div>
      <Link className="button button--secondary" href="/">חזרה לעמוד הבית</Link>
    </div>
  );
}
