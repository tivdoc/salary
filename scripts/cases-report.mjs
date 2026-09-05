import "./production-refusal.mjs";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const since = sinceArgument
  ? new Date(sinceArgument.slice("--since=".length))
  : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
if (Number.isNaN(since.getTime())) {
  console.error("Invalid --since date");
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const [casesResult, sessionsResult, eventsResult] = await Promise.all([
  supabase
    .from("cases")
    .select(
      "id,public_id,status,payment_status,is_qa,attribution_status,utm_source,utm_medium,utm_campaign,utm_content,first_touch_at,created_at",
    )
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: true }),
  supabase
    .from("funnel_sessions")
    .select("id,current_questionnaire_step,questionnaire_completed_at,first_touch_at")
    .gte("first_touch_at", since.toISOString()),
  supabase
    .from("funnel_events")
    .select("event_name,step_number,created_at")
    .gte("created_at", since.toISOString()),
]);

for (const result of [casesResult, sessionsResult, eventsResult]) {
  if (result.error) {
    console.error("Report query failed", result.error.code);
    process.exit(1);
  }
}

const cases = casesResult.data ?? [];
const realCases = cases.filter((salaryCase) => !salaryCase.is_qa);
const verified = realCases.filter((salaryCase) => salaryCase.payment_status === "verified");
const eventCounts = new Map();
for (const event of eventsResult.data ?? []) {
  const key = event.step_number
    ? `${event.event_name}:step_${event.step_number}`
    : event.event_name;
  eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
}

console.log(`Tivdoc Salary report since ${since.toISOString()}`);
console.log({
  cases: cases.length,
  realCases: realCases.length,
  qaCases: cases.length - realCases.length,
  verifiedCustomers: verified.length,
  revenueIls: verified.length * 9.99,
  funnelSessions: sessionsResult.data?.length ?? 0,
});

console.table(
  realCases.map((salaryCase) => ({
    case: salaryCase.public_id,
    status: salaryCase.status,
    payment: salaryCase.payment_status,
    attribution: salaryCase.attribution_status,
    source: salaryCase.utm_source || "unknown",
    medium: salaryCase.utm_medium || "unknown",
    campaign: salaryCase.utm_campaign || "unknown",
    creative: salaryCase.utm_content || "unknown",
    createdAt: salaryCase.created_at,
  })),
);
console.table(
  [...eventCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([event, count]) => ({ event, count })),
);
