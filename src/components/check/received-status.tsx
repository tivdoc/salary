"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle, ClockCountdown, WarningCircle } from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";

type CaseStatus = {
  publicId: string;
  status: string;
  paymentStatus: string;
  paymentVerified: boolean;
};

export function ReceivedStatus() {
  const paymentTracked = useRef(false);
  const [data, setData] = useState<CaseStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    trackEvent("payment_returned");
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      attempts += 1;
      try {
        const response = await fetch("/api/cases/status", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "טעינת הסטטוס נכשלה");
        if (!active) return;
        setData(result);
        setError("");
        if (result.paymentVerified && !paymentTracked.current) {
          paymentTracked.current = true;
          trackEvent("payment_completed", { value: 9.9, currency: "ILS" });
        }
        if (!result.paymentVerified && attempts < 8) {
          timer = setTimeout(load, 4_000);
        }
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "לא הצלחנו לטעון את סטטוס הבדיקה");
      }
    }

    load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (error) {
    return <div className="received-card received-card--error"><WarningCircle weight="duotone" aria-hidden="true" /><h1>לא הצלחנו לזהות את הבדיקה.</h1><p>{error}</p><Link className="button button--secondary" href="/">חזרה לעמוד הבית</Link></div>;
  }

  if (!data) {
    return <div className="received-card" aria-busy="true"><div className="status-skeleton" /><div className="status-skeleton status-skeleton--short" /><p>בודקים את סטטוס התשלום...</p></div>;
  }

  if (data.paymentVerified) {
    return (
      <div className="received-card received-card--verified">
        <CheckCircle weight="duotone" aria-hidden="true" />
        <span className="mono">תיק {data.publicId}</span>
        <h1>התשלום אומת. הבדיקה התקבלה.</h1>
        <p>המסמכים והפרטים שלך נשמרו, והתיק מוכן לעבור לבדיקה.</p>
        <div className="received-card__next"><b>מה עכשיו?</b><span>אם נצטרך מסמך או פרט נוסף, ניצור קשר לפי הפרטים שמסרת.</span></div>
        <Link className="button button--secondary" href="/">חזרה לעמוד הבית</Link>
      </div>
    );
  }

  return (
    <div className="received-card received-card--pending">
      <ClockCountdown weight="duotone" aria-hidden="true" />
      <span className="mono">תיק {data.publicId}</span>
      <h1>חזרת מעמוד התשלום. ממתינים לאימות.</h1>
      <p>לא סימנו את התשלום כהושלם רק בגלל החזרה לעמוד הזה. הסטטוס יתעדכן לאחר שנקבל אימות.</p>
      <div className="received-card__next"><b>אפשר לסגור את החלון.</b><span>התיק נשמר. אם התשלום הושלם, האימות יכול לקחת כמה רגעים.</span></div>
      <Link className="button button--secondary" href="/">חזרה לעמוד הבית</Link>
    </div>
  );
}
