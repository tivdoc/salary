"use client";

import { useId, useState } from "react";
import Link from "next/link";
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
  // S4 (2.6). Not pre-checked, and no default that makes it look checked: the
  // person ticks it or nobody pays. The version they are agreeing to is decided
  // by the server when it records the consent, never sent from here.
  const [accepted, setAccepted] = useState(false);
  const consentId = useId();

  async function startPayment() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/payments/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termsAccepted: accepted }),
      });
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
      <div className="payment-consent">
        <input
          id={consentId}
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
          disabled={loading}
        />
        <label htmlFor={consentId}>
          קראתי ואני מאשר את <Link href="/terms" target="_blank" rel="noreferrer">תנאי השימוש</Link> ואת <Link href="/privacy" target="_blank" rel="noreferrer">מדיניות הפרטיות</Link>.
        </label>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="button button--primary button--wide" type="button" disabled={loading || !accepted} onClick={startPayment}>{loading ? "פותחים את עמוד התשלום..." : "מעבר לתשלום מאובטח"}<ArrowSquareOut aria-hidden="true" /></button>
      <p className="payment-note">{offer.second_product_sentence}</p>
      <p className="payment-note">חזרה לעמוד האישור אינה מספיקה כדי לסמן תשלום כהושלם. הסטטוס מתעדכן רק לאחר אימות.</p>
    </div>
  );
}
