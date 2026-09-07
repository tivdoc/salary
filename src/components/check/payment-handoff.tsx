"use client";

import { initialPrice, productOffer } from "@/config/product-offer";

import { useState } from "react";
import { ArrowSquareOut, CheckCircle, LockKey } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import {
  metaEventDescriptor,
  trackMetaBrowserEventOnce,
} from "@/lib/meta-browser";

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
      const metaEvent = metaEventDescriptor(result.metaEvent);
      if (metaEvent) trackMetaBrowserEventOnce(metaEvent);
      trackEvent("payment_started", {
        value: productOffer.initial.price,
        currency: productOffer.currency,
      });
      window.location.assign(result.url);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "לא הצלחנו לפתוח את עמוד התשלום",
      );
      setLoading(false);
    }
  }

  return (
    <div className="payment-card">
      <div className="check-page-heading">
        <span className="mono">תשלום</span>
        <h1>הבדיקה מוכנה להתחיל.</h1>
        <p>עוד רגע עוברים לעמוד התשלום המאובטח של Invoice4u.</p>
      </div>
      <div className="payment-summary">
        <div>
          <span>בדיקה ראשונית של תלוש ושכר</span>
          <b className="mono">{initialPrice}</b>
        </div>
        <ul>
          <li>
            <CheckCircle weight="fill" aria-hidden="true" /> חודש אחד ועד{" "}
            {productOffer.initial.maxTopics} נושאים שנבדקו
          </li>
          <li>
            <CheckCircle weight="fill" aria-hidden="true" /> בחינה מול המסמכים
            והפרטים שמסרת
          </li>
          <li>
            <CheckCircle weight="fill" aria-hidden="true" /> מידע חסר יסומן
            לבירור; אין סכום ללא בסיס מספיק
          </li>
        </ul>
        <div className="payment-summary__total">
          <span>סה״כ לתשלום</span>
          <strong className="mono">{initialPrice}</strong>
        </div>
      </div>
      <div className="payment-security">
        <LockKey weight="duotone" aria-hidden="true" />
        <span>פרטי התשלום מוזנים ב־Invoice4u ואינם נשמרים ב־Tivdoc.</span>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button button--primary button--wide"
        type="button"
        disabled={loading}
        onClick={startPayment}
      >
        {loading ? "פותחים את עמוד התשלום..." : "מעבר לתשלום מאובטח"}
        <ArrowSquareOut aria-hidden="true" />
      </button>
      <p className="payment-note">
        חזרה לעמוד האישור אינה מספיקה כדי לסמן תשלום כהושלם. הסטטוס מתעדכן רק
        לאחר אימות.
      </p>
      <p className="payment-note">
        הבדיקה אינה כוללת דוח מלא. אין התחייבות לתוצאה מיידית; ייתכן שיידרשו
        השלמות לפני סיום הטיפול.
      </p>
    </div>
  );
}
