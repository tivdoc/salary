"use client";

export type AnalyticsEvent =
  | "landing_view"
  | "start_check"
  | "questionnaire_started"
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
  }
}

export function trackEvent(eventName: AnalyticsEvent, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  window.gtag?.("event", eventName, params);
}
