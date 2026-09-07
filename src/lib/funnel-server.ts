import "server-only";
import { getSupabaseAdmin } from "./supabase-admin";

export async function recordCaseFunnelEvent(
  caseId: string,
  eventName: "document_uploaded" | "checkout_started" | "payment_verified",
) {
  const supabase = getSupabaseAdmin();
  const salaryCase = await supabase
    .from("cases")
    .select("funnel_session_id")
    .eq("id", caseId)
    .maybeSingle();
  if (salaryCase.error || !salaryCase.data?.funnel_session_id) return;

  const sessionId = salaryCase.data.funnel_session_id;
  const event = await supabase.from("funnel_events").upsert(
    {
      session_id: sessionId,
      case_id: caseId,
      event_name: eventName,
      step_number: null,
      idempotency_key: `${sessionId}:${eventName}:${caseId}`,
    },
    { onConflict: "idempotency_key", ignoreDuplicates: true },
  );
  if (event.error) throw event.error;
}
