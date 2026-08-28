import { describe, expect, it } from "vitest";
import { buildFunnelReport, conversion } from "./funnel-report-core.mjs";

function event(sessionId, eventName, stepNumber = null) {
  return { session_id: sessionId, event_name: eventName, step_number: stepNumber };
}

describe("buildFunnelReport", () => {
  it("calculates the new funnel, step drop-off, revenue, and excludes QA", () => {
    const events = [
      event("real", "landing_view"),
      event("real", "start_check"),
      event("real", "questionnaire_started"),
      event("real", "questionnaire_step_viewed", 1),
      event("real", "questionnaire_step_completed", 1),
      event("real", "questionnaire_step_viewed", 2),
      event("real", "questionnaire_completed"),
      event("real", "document_uploaded"),
      event("real", "checkout_started"),
      event("real", "payment_verified"),
      event("qa", "landing_view"),
      event("qa", "start_check"),
      event("qa", "questionnaire_step_viewed", 1),
    ];
    const cases = [
      {
        id: "case-real",
        funnel_session_id: "real",
        is_qa: false,
        attribution_status: "captured",
        utm_source: "facebook",
        landing_url: "https://tivdoc.com/",
        first_touch_at: "2026-08-28T00:00:00Z",
      },
      {
        id: "case-qa",
        funnel_session_id: "qa",
        is_qa: true,
        attribution_status: "internal_qa",
      },
    ];
    const payments = [
      {
        case_id: "case-real",
        status: "verified",
        amount: 9.99,
        currency: "ILS",
        ga4_purchase_sent_at: "2026-08-28T00:10:00Z",
      },
      {
        case_id: "case-qa",
        status: "verified",
        amount: 9.99,
        currency: "ILS",
        ga4_purchase_sent_at: "2026-08-28T00:10:00Z",
      },
    ];

    const report = buildFunnelReport({
      cases,
      events,
      payments,
      since: "2026-08-28T00:00:00Z",
    });

    expect(report.newFunnel).toMatchObject({
      landingSessions: 1,
      startCheck: 1,
      questionnaireCompleted: 1,
      documentUploaded: 1,
      checkoutCreated: 1,
      verifiedPayments: 1,
      purchases: 1,
      ga4PurchasesSent: 1,
      revenueIls: 9.99,
    });
    expect(report.steps[0]).toMatchObject({
      step: 1,
      viewed: 1,
      completed: 1,
      completionRate: 100,
      dropOff: 0,
    });
    expect(report.steps[1]).toMatchObject({ viewed: 1, completed: 0, dropOff: 1 });
    expect(report.excludedQa).toEqual({ cases: 1, sessions: 1 });
  });

  it("does not divide by zero", () => {
    expect(conversion(0, 0)).toBeNull();
  });
});
