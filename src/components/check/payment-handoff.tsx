"use client";

import { useState } from "react";
import { ArrowSquareOut, CheckCircle, LockKey } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";

export function PaymentHandoff() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startPayment() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/payments/start", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "פתיחת התשלום נכשלה");
      trackEvent("payment_started", { value: 9.9, currency: "ILS" });
      window.location.assign(result.url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "לא הצלחנו לפתוח את עמוד התשלום");
      setLoading(false);
    }
  }

  return (
    <div className="payment-card">
      <div className="check-page-heading"><span className="mono">תשלום</span><h1>הבדיקה מוכנה להתחיל.</h1><p>עוד רגע עוברים לעמוד התשלום המאובטח של Invoice4u.</p></div>
      <div className="payment-summary">
        <div><span>בדיקה ראשונית של תלוש ושכר</span><b className="mono">9.90 ₪</b></div>
        <ul>
          <li><CheckCircle weight="fill" aria-hidden="true" /> זיהוי חריגות אפשריות</li>
          <li><CheckCircle weight="fill" aria-hidden="true" /> בחינה מול הפרטים שמסרת</li>
          <li><CheckCircle weight="fill" aria-hidden="true" /> הערכת פערים אפשריים</li>
        </ul>
        <div className="payment-summary__total"><span>סה״כ לתשלום</span><strong className="mono">9.90 ₪</strong></div>
      </div>
      <div className="payment-security"><LockKey weight="duotone" aria-hidden="true" /><span>פרטי התשלום מוזנים ב־Invoice4u ואינם נשמרים ב־Tivdoc.</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button--primary button--wide" type="button" disabled={loading} onClick={startPayment}>{loading ? "פותחים את עמוד התשלום..." : "מעבר לתשלום מאובטח"}<ArrowSquareOut aria-hidden="true" /></button>
      <p className="payment-note">חזרה לעמוד האישור אינה מספיקה כדי לסמן תשלום כהושלם. הסטטוס מתעדכן רק לאחר אימות.</p>
    </div>
  );
}
