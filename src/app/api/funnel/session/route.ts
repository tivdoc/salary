import { NextResponse } from "next/server";
import { funnelEventSchema } from "@/lib/funnel-validation";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await guardStableHttpEntrypoint("CEP-018", request);
  let parsed;
  try {
    parsed = funnelEventSchema.safeParse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid funnel event" }, { status: 422 });
  }

  const { attribution, eventName, stepNumber, publicCaseId } = parsed.data;
  try {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const existing = await supabase
      .from("funnel_sessions")
      .select("id,fbp,fbc,ga_client_id")
      .eq("id", attribution.funnelId)
      .maybeSingle();
    if (existing.error) throw existing.error;

    if (!existing.data) {
      const inserted = await supabase.from("funnel_sessions").insert({
        id: attribution.funnelId,
        utm_source: attribution.utmSource,
        utm_medium: attribution.utmMedium,
        utm_campaign: attribution.utmCampaign,
        utm_content: attribution.utmContent,
        utm_term: attribution.utmTerm,
        fbclid: attribution.fbclid,
        fbp: attribution.fbp,
        fbc: attribution.fbc,
        ga_client_id: attribution.gaClientId,
        landing_url: attribution.landingUrl,
        referrer: attribution.referrer,
        first_touch_at: attribution.firstTouchAt,
        last_seen_at: now,
        current_questionnaire_step: stepNumber,
        questionnaire_started_at:
          eventName === "questionnaire_started" ? now : null,
        questionnaire_completed_at:
          eventName === "questionnaire_completed" ? now : null,
      });
      if (inserted.error && inserted.error.code !== "23505") throw inserted.error;
    } else {
      const update: Record<string, unknown> = {
        last_seen_at: now,
        updated_at: now,
        ...(stepNumber ? { current_questionnaire_step: stepNumber } : {}),
        ...(eventName === "questionnaire_started" ? { questionnaire_started_at: now } : {}),
        ...(eventName === "questionnaire_completed" ? { questionnaire_completed_at: now } : {}),
        ...(!existing.data.fbp && attribution.fbp ? { fbp: attribution.fbp } : {}),
        ...(!existing.data.fbc && attribution.fbc ? { fbc: attribution.fbc } : {}),
        ...(!existing.data.ga_client_id && attribution.gaClientId
          ? { ga_client_id: attribution.gaClientId }
          : {}),
      };
      const updated = await supabase
        .from("funnel_sessions")
        .update(update)
        .eq("id", attribution.funnelId);
      if (updated.error) throw updated.error;
    }

    let caseId: string | null = null;
    if (publicCaseId) {
      const salaryCase = await supabase
        .from("cases")
        .select("id")
        .eq("public_id", publicCaseId)
        .maybeSingle();
      if (salaryCase.error) throw salaryCase.error;
      caseId = salaryCase.data?.id ?? null;
    }

    const event = await supabase.from("funnel_events").upsert(
      {
        session_id: attribution.funnelId,
        case_id: caseId,
        event_name: eventName,
        step_number: stepNumber ?? null,
        idempotency_key: [
          attribution.funnelId,
          eventName,
          stepNumber ?? "none",
          publicCaseId ?? "none",
        ].join(":"),
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (event.error) throw event.error;

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code =
      error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "funnel_write_error";
    console.warn("Funnel event write deferred", code);
    return NextResponse.json(
      { accepted: false },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  }
}
