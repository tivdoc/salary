"use client";

import { productOffer } from "@/config/product-offer";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle,
  ClockCountdown,
  WarningCircle,
} from "@phosphor-icons/react";
import { trackEvent } from "@/lib/analytics";
import {
  metaEventDescriptor,
  trackMetaBrowserEventOnce,
} from "@/lib/meta-browser";

type CaseStatus = {
  publicId: string;
  status: string;
  paymentStatus: string;
  paymentVerified: boolean;
  trackPaymentCompleted: boolean;
  metaEvent?: unknown;
};

export function ReceivedStatus() {
  const paymentTracked = useRef(false);
  const [data, setData] = useState<CaseStatus | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  function refreshStatus() {
    setError("");
    setData(null);
    setRetry((current) => current + 1);
  }

  useEffect(() => {
    trackEvent("payment_returned");
  }, []);

  useEffect(() => {
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      attempts += 1;
      try {
        const response = await fetch("/api/cases/status", {
          cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "טעינת הסטטוס נכשלה");
        if (!active) return;
        setData(result);
        setError("");
        const metaEvent = metaEventDescriptor(result.metaEvent);
        if (result.paymentVerified && metaEvent?.eventName === "Purchase") {
          trackMetaBrowserEventOnce(metaEvent);
        }
        if (result.trackPaymentCompleted && !paymentTracked.current) {
          paymentTracked.current = true;
          trackEvent("payment_completed", {
            value: productOffer.initial.price,
            currency: productOffer.currency,
          });
        }
        if (!result.paymentVerified && attempts < 8) {
          timer = setTimeout(load, 4_000);
        }
      } catch (caught) {
        if (!active) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "לא הצלחנו לטעון את סטטוס הבדיקה",
        );
      }
    }

    load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [retry]);

  if (error) {
    return (
      <div className="received-card received-card--error">
        <WarningCircle weight="duotone" aria-hidden="true" />
        <h1>לא הצלחנו לטעון את הבדיקה.</h1>
        <p role="alert">{error}</p>
        <p>
          כדאי לפתוח את הקישור בדפדפן שבו התחלת. אם עדיין אין גישה, אפשר לפנות
          לשירות.
        </p>
        <button
          className="button button--primary"
          type="button"
          onClick={refreshStatus}
        >
          בדיקת סטטוס מחדש
        </button>
        <a
          className="home-text-link"
          href={`mailto:${productOffer.supportEmail}`}
        >
          פנייה לשירות
        </a>
        <Link className="button button--secondary" href="/">
          חזרה לעמוד הבית
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="received-card" aria-busy="true">
        <div className="status-skeleton" />
        <div className="status-skeleton status-skeleton--short" />
        <p>בודקים את סטטוס התשלום...</p>
      </div>
    );
  }

  if (data.paymentVerified) {
    return (
      <div className="received-card received-card--verified">
        <CheckCircle weight="duotone" aria-hidden="true" />
        <span className="mono">תיק {data.publicId}</span>
        <h1>התשלום אומת. הבדיקה התקבלה.</h1>
        <p>המסמכים והפרטים שלך נשמרו, והתיק מוכן לעבור לבדיקה.</p>
        <div className="received-card__next">
          <b>מה עכשיו?</b>
          <span>אם נצטרך מסמך או פרט נוסף, ניצור קשר לפי הפרטים שמסרת.</span>
        </div>
        <Link className="button button--secondary" href="/">
          חזרה לעמוד הבית
        </Link>
      </div>
    );
  }

  return (
    <div className="received-card received-card--pending">
      <ClockCountdown weight="duotone" aria-hidden="true" />
      <span className="mono">תיק {data.publicId}</span>
      <h1>חזרת מעמוד התשלום. ממתינים לאימות.</h1>
      <p>
        לא סימנו את התשלום כהושלם רק בגלל החזרה לעמוד הזה. הסטטוס יתעדכן לאחר
        שנקבל אימות.
      </p>
      <div className="received-card__next">
        <b>אין צורך לשלם שוב.</b>
        <span>
          התיק נשמר. אם התשלום הושלם, האימות יכול לקחת כמה רגעים. אפשר לבדוק שוב
          כאן, באותו דפדפן.
        </span>
      </div>
      <button
        className="button button--primary"
        type="button"
        onClick={refreshStatus}
      >
        בדיקת סטטוס מחדש
      </button>
      <Link className="button button--secondary" href="/">
        חזרה לעמוד הבית
      </Link>
    </div>
  );
}
