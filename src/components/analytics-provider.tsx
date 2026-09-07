"use client";
import {EXTERNAL_MEASUREMENT_ENABLED} from "@/lib/measurement-policy";

import Script from "next/script";

export function AnalyticsProvider() {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (!EXTERNAL_MEASUREMENT_ENABLED || !measurementId) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="tivdoc-ga4" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${measurementId}', { send_page_view: true });
          (window.tivdocAnalyticsQueue || []).forEach(function(queued) {
            gtag('event', queued.eventName, queued.params);
          });
          window.tivdocAnalyticsQueue = [];
        `}
      </Script>
    </>
  );
}
