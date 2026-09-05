"use client";

import { useState } from "react";
import { ArrowSquareOut, CheckCircle, LockKey } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import { customerErrorFromResponse, customerErrorMessage } from "@/lib/customer-copy";
import { formatPrice, initialCheckPriceNumber, productOffer } from "@/lib/product-offer";
import { metaEventDescriptor, trackMetaBrowserEventOnce } from "@/lib/meta-browser";

export function PaymentHandoff() {
  const offer = productOffer();
  const price = formatPrice(offer.initial_check.price);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startPayment() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/payments/start", { method: "POST" });
      if (!response.ok) throw new Error(await customerErrorFromResponse(response, "payment_start_failed"));
      const result = await response.json();
      const metaEvent = metaEventDescriptor(result.metaEvent);
      if (metaEvent) trackMetaBrowserEventOnce(metaEvent);
      trackEvent("payment_started", { value: initialCheckPriceNumber(), currency: offer.currency });
      window.location.assign(result.url);
    } catch (caught) {
      setError(customerErrorMessage({ error: caught instanceof Error ? caught.message : null }, "payment_start_failed"));
      setLoading(false);
    }
  }

  return (
    <div className="payment-card">
      <div className="check-page-heading"><span className="mono">תשלום</span><h1>הבדיקה מוכנה להתחיל.</h1><p>עוד רגע עוברים לעמוד התשלום המאובטח של Invoice4u.</p></div>
      <div className="payment-summary">
        <div><span>בדיקה ראשונית של תלוש ושכר</span><b className="mono">{price}</b></div>
        <ul>
          <li><CheckCircle weight="fill" aria-hidden="true" /> זיהוי חריגות אפשריות</li>
          <li><CheckCircle weight="fill" aria-hidden="true" /> בחינה מול הפרטים שמסרת</li>
          <li><CheckCircle weight="fill" aria-hidden="true" /> הערכת פערים אפשריים</li>
        </ul>
        <div className="payment-summary__total"><span>סה״כ לתשלום</span><strong className="mono">{price}</strong></div>
      </div>
      <div className="payment-security"><LockKey weight="duotone" aria-hidden="true" /><span>פרטי התשלום מוזנים ב־Invoice4u ואינם נשמרים ב־Tivdoc.</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button--primary button--wide" type="button" disabled={loading} onClick={startPayment}>{loading ? "פותחים את עמוד התשלום..." : "מעבר לתשלום מאובטח"}<ArrowSquareOut aria-hidden="true" /></button>
      <p className="payment-note">{offer.second_product_sentence}</p>
      <p className="payment-note">חזרה לעמוד האישור אינה מספיקה כדי לסמן תשלום כהושלם. הסטטוס מתעדכן רק לאחר אימות.</p>
    </div>
  );
}
