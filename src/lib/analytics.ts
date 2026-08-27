"use client";

import { currentFirstTouch, recordFunnelEvent } from "./attribution";

export type AnalyticsEvent =
  | "landing_view"
  | "start_check"
  | "questionnaire_started"
  | "questionnaire_step_viewed"
  | "questionnaire_step_completed"
  | "questionnaire_completed"
  | "payslip_uploaded"
  | "payment_started"
  | "payment_completed"
  | "hero_inspector_interaction"
  | "mini_demo_completed"
  | "faq_opened"
  | "upload_error"
  | "payment_returned";

declare global {
  interface Window {
    gtag?: (command: "event", eventName: string, params?: Record<string, unknown>) => void;
    tivdocAnalyticsQueue?: Array<{
      eventName: AnalyticsEvent;
      params?: Record<string, unknown>;
    }>;
  }
}

export function trackEvent(eventName: AnalyticsEvent, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const attribution = currentFirstTouch();
  const safeParams = {
    ...(typeof params?.value === "number" ? { value: params.value } : {}),
    ...(typeof params?.currency === "string" ? { currency: params.currency.slice(0, 3) } : {}),
    ...(typeof params?.step_number === "number" ? { step_number: params.step_number } : {}),
    ...(attribution
      ? {
          funnel_session_id: attribution.funnelId,
          ...(attribution.utmContent ? { utm_content: attribution.utmContent } : {}),
        }
      : {}),
  };
  if (
    [
      "landing_view",
      "start_check",
      "questionnaire_started",
      "questionnaire_step_viewed",
      "questionnaire_step_completed",
      "questionnaire_completed",
    ].includes(eventName)
  ) {
    recordFunnelEvent(eventName, {
      stepNumber:
        typeof safeParams.step_number === "number" ? safeParams.step_number : undefined,
      publicCaseId:
        typeof sessionStorage === "undefined"
          ? undefined
          : sessionStorage.getItem("tivdoc-public-id") || undefined,
    });
  }
  if (window.gtag) {
    window.gtag("event", eventName, safeParams);
    return;
  }

  window.tivdocAnalyticsQueue = window.tivdocAnalyticsQueue || [];
  window.tivdocAnalyticsQueue.push({ eventName, params: safeParams });
}
