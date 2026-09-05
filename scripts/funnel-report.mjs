import "./production-refusal.mjs";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildFunnelReport,
  DEFAULT_NEW_FUNNEL_SINCE,
} from "./funnel-report-core.mjs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey || serviceRoleKey === "[SENSITIVE]") {
  console.error("Missing usable NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const since = sinceArgument?.slice("--since=".length) || DEFAULT_NEW_FUNNEL_SINCE;
if (Number.isNaN(new Date(since).getTime())) {
  console.error("Invalid --since date");
  process.exit(1);
}
const jsonOutput = process.argv.includes("--json");

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const [casesResult, eventsResult] = await Promise.all([
  supabase
    .from("cases")
    .select(
      "id,funnel_session_id,is_qa,attribution_status,utm_source,utm_medium,utm_campaign,utm_content,utm_term,fbclid,fbp,fbc,ga_client_id,landing_url,first_touch_at,created_at",
    )
    .gte("created_at", new Date(since).toISOString()),
  supabase
    .from("funnel_events")
    .select("session_id,case_id,event_name,step_number,created_at")
    .gte("created_at", new Date(since).toISOString()),
]);

for (const result of [casesResult, eventsResult]) {
  if (result.error) {
    console.error("Funnel report query failed", result.error.code);
    process.exit(1);
  }
}

const caseIds = (casesResult.data ?? []).map((salaryCase) => salaryCase.id);
const paymentsResult = caseIds.length
  ? await supabase
      .from("payments")
      .select("case_id,status,amount,currency,ga4_purchase_sent_at,created_at")
      .in("case_id", caseIds)
  : { data: [], error: null };
if (paymentsResult.error) {
  console.error("Funnel payment query failed", paymentsResult.error.code);
  process.exit(1);
}

const report = buildFunnelReport({
  cases: casesResult.data ?? [],
  events: eventsResult.data ?? [],
  payments: paymentsResult.data ?? [],
  since: new Date(since).toISOString(),
});

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const percent = (value) => (value === null ? "n/a" : `${value}%`);
console.log(`Tivdoc funnel comparison since ${report.newFunnel.since}`);
console.table([
  {
    funnel: "Old baseline",
    landing: report.baseline.landing,
    start: report.baseline.start,
    completed: report.baseline.questionnaireCompleted,
    purchases: report.baseline.purchases,
    revenueIls: report.baseline.purchases * 9.99,
  },
  {
    funnel: "New funnel",
    landing: report.newFunnel.landingSessions,
    start: report.newFunnel.startCheck,
    completed: report.newFunnel.questionnaireCompleted,
    purchases: report.newFunnel.purchases,
    revenueIls: report.newFunnel.revenueIls,
  },
]);
console.table(
  Object.entries(report.conversions).map(([metric, value]) => ({
    metric,
    conversion: percent(value),
  })),
);
console.table(
  report.steps.map((step) => ({
    Step: step.step,
    Viewed: step.viewed,
    Completed: step.completed,
    "Completion rate": percent(step.completionRate),
    "Drop-off": step.dropOff,
  })),
);
console.table(
  report.stepToStep.map((step) => ({
    Transition: step.transition,
    "From completed": step.fromCompleted,
    "Next viewed": step.nextViewed,
    Conversion: percent(step.conversionRate),
  })),
);
console.log({
  questionnaireStarted: report.newFunnel.questionnaireStarted,
  documentUploaded: report.newFunnel.documentUploaded,
  checkoutCreated: report.newFunnel.checkoutCreated,
  paymentVerifiedEvents: report.newFunnel.paymentVerifiedEvents,
  verifiedPayments: report.newFunnel.verifiedPayments,
  ga4PurchasesSent: report.newFunnel.ga4PurchasesSent,
  excludedQa: report.excludedQa,
  attribution: report.attribution,
});
