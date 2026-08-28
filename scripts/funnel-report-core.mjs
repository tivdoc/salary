export const OLD_FUNNEL_BASELINE = Object.freeze({
  period: "2026-08-22 through 2026-08-27",
  landing: 168,
  start: 30,
  questionnaireCompleted: 6,
  purchases: 3,
  spendIls: 525.81,
});

export const DEFAULT_NEW_FUNNEL_SINCE = "2026-08-27T23:16:22.000Z";

export function conversion(numerator, denominator) {
  return denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : null;
}

function uniqueSessions(events, eventName, stepNumber, excludedSessionIds) {
  return new Set(
    events
      .filter(
        (event) =>
          event.event_name === eventName
          && (stepNumber === undefined || event.step_number === stepNumber)
          && !excludedSessionIds.has(event.session_id),
      )
      .map((event) => event.session_id),
  );
}

export function buildFunnelReport({ cases, events, payments, since }) {
  const qaCases = cases.filter((salaryCase) => salaryCase.is_qa);
  const qaSessionIds = new Set(
    qaCases.map((salaryCase) => salaryCase.funnel_session_id).filter(Boolean),
  );
  const realCases = cases.filter((salaryCase) => !salaryCase.is_qa);
  const realCaseIds = new Set(realCases.map((salaryCase) => salaryCase.id));
  const realPayments = payments.filter((payment) => realCaseIds.has(payment.case_id));
  const verifiedPayments = realPayments.filter(
    (payment) =>
      payment.status === "verified"
      && Number(payment.amount) === 9.99
      && payment.currency?.toUpperCase() === "ILS",
  );

  const count = (eventName, stepNumber) =>
    uniqueSessions(events, eventName, stepNumber, qaSessionIds).size;
  const landing = count("landing_view");
  const start = count("start_check");
  const questionnaireStarted = count("questionnaire_started");
  const questionnaireCompleted = count("questionnaire_completed");
  const documentUploaded = count("document_uploaded");
  const checkoutCreated = count("checkout_started");
  const paymentVerified = count("payment_verified");

  const steps = Array.from({ length: 7 }, (_, index) => {
    const step = index + 1;
    const viewed = count("questionnaire_step_viewed", step);
    const completed = count("questionnaire_step_completed", step);
    return {
      step,
      viewed,
      completed,
      completionRate: conversion(completed, viewed),
      dropOff: Math.max(viewed - completed, 0),
    };
  });

  const stepToStep = steps.slice(0, -1).map((current, index) => ({
    transition: `${current.step} → ${current.step + 1}`,
    fromCompleted: current.completed,
    nextViewed: steps[index + 1].viewed,
    conversionRate: conversion(steps[index + 1].viewed, current.completed),
  }));

  const revenueIls = Number(
    verifiedPayments
      .reduce((total, payment) => total + Number(payment.amount), 0)
      .toFixed(2),
  );

  const attributionFields = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "fbp",
    "fbc",
    "ga_client_id",
    "landing_url",
    "first_touch_at",
  ];

  return {
    baseline: {
      ...OLD_FUNNEL_BASELINE,
      landingToStart: conversion(OLD_FUNNEL_BASELINE.start, OLD_FUNNEL_BASELINE.landing),
      startToComplete: conversion(
        OLD_FUNNEL_BASELINE.questionnaireCompleted,
        OLD_FUNNEL_BASELINE.start,
      ),
      landingToPurchase: conversion(
        OLD_FUNNEL_BASELINE.purchases,
        OLD_FUNNEL_BASELINE.landing,
      ),
      cacIls: Number((OLD_FUNNEL_BASELINE.spendIls / OLD_FUNNEL_BASELINE.purchases).toFixed(2)),
    },
    newFunnel: {
      since,
      landingSessions: landing,
      startCheck: start,
      questionnaireStarted,
      questionnaireCompleted,
      documentUploaded,
      checkoutCreated,
      paymentVerifiedEvents: paymentVerified,
      verifiedPayments: verifiedPayments.length,
      purchases: verifiedPayments.length,
      ga4PurchasesSent: verifiedPayments.filter((payment) => payment.ga4_purchase_sent_at).length,
      revenueIls,
    },
    conversions: {
      landingToStart: conversion(start, landing),
      startToQuestionnaireComplete: conversion(questionnaireCompleted, start),
      questionnaireCompleteToUpload: conversion(documentUploaded, questionnaireCompleted),
      uploadToCheckout: conversion(checkoutCreated, documentUploaded),
      checkoutToVerifiedPurchase: conversion(verifiedPayments.length, checkoutCreated),
      landingToPurchase: conversion(verifiedPayments.length, landing),
    },
    steps,
    stepToStep,
    attribution: {
      capturedCases: realCases.filter((salaryCase) => salaryCase.attribution_status === "captured")
        .length,
      fieldCoverage: Object.fromEntries(
        attributionFields.map((field) => [
          field,
          realCases.filter((salaryCase) => Boolean(salaryCase[field])).length,
        ]),
      ),
    },
    excludedQa: {
      cases: qaCases.length,
      sessions: qaSessionIds.size,
    },
  };
}
