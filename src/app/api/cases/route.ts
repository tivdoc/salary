import { NextResponse } from "next/server";
import { setCaseCookie } from "@/lib/case-cookie";
import { metaRequestContext, sendMetaCapiEvent } from "@/lib/meta-capi";
import { metaEventId } from "@/lib/meta-events";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { questionnaireSchema } from "@/lib/validation";
// S3.1 raised the questionnaire from seven steps to nine: the engine needs the
// start month, birth year and sex, the pension-at-hire answer, the two travel
// answers and the §30(א) role question, and without them the report refuses
// instead of answering. The two client events already in place —
// questionnaire_step_viewed and questionnaire_step_completed, both carrying
// step_number — are what measures the cost: if start→case falls more than ten
// points against the pre-S3.1 baseline, the split the brief specifies is to keep
// steps 0-3 and 8 before payment and reopen steps 4-5 as thread requests after
// it. Nothing here assumes the drop; the instrument is what decides.
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-013", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "לא הצלחנו לקרוא את הטופס" }, { status: 400 });
  }

  const parsed = questionnaireSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "יש פרטים שדורשים תיקון", fields: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const attribution = parsed.data.attribution;
    const { data: created, error: caseError } = await supabase
      .from("cases")
      .insert({
        first_name: parsed.data.firstName,
        email: parsed.data.email.toLowerCase(),
        phone: parsed.data.phone,
        status: "questionnaire_completed",
        funnel_session_id: attribution?.funnelId ?? null,
        utm_source: attribution?.utmSource ?? null,
        utm_medium: attribution?.utmMedium ?? null,
        utm_campaign: attribution?.utmCampaign ?? null,
        utm_content: attribution?.utmContent ?? null,
        utm_term: attribution?.utmTerm ?? null,
        fbclid: attribution?.fbclid ?? null,
        fbp: attribution?.fbp ?? null,
        fbc: attribution?.fbc ?? null,
        ga_client_id: attribution?.gaClientId ?? null,
        landing_url: attribution?.landingUrl ?? null,
        referrer: attribution?.referrer ?? null,
        first_touch_at: attribution?.firstTouchAt ?? null,
        current_questionnaire_step: 9,
        attribution_status: attribution ? "captured" : "legacy_unresolved",
      })
      .select("id,public_id")
      .single();

    if (caseError || !created) throw caseError ?? new Error("Case creation returned no identifier");

    const { suspectedIssue, attribution: _attribution, ...payload } = parsed.data;
    void _attribution;
    const { error: responseError } = await supabase.from("questionnaire_responses").insert({
      case_id: created.id,
      payload,
      suspected_issue: suspectedIssue,
    });

    if (responseError) {
      await supabase.from("cases").delete().eq("id", created.id);
      throw responseError;
    }

    if (attribution) {
      const now = new Date().toISOString();
      const sessionResult = await supabase
        .from("funnel_sessions")
        .upsert(
          {
            id: attribution.funnelId,
            case_id: created.id,
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
            current_questionnaire_step: 9,
            questionnaire_started_at: now,
            questionnaire_completed_at: now,
            updated_at: now,
          },
          { onConflict: "id" },
        );
      if (sessionResult.error) {
        console.warn("Case attribution link deferred", sessionResult.error.code);
      } else {
        await supabase.from("funnel_events").upsert(
          {
            session_id: attribution.funnelId,
            case_id: created.id,
            event_name: "case_created",
            step_number: null,
            idempotency_key: `${attribution.funnelId}:case_created:${created.public_id}`,
          },
          { onConflict: "idempotency_key", ignoreDuplicates: true },
        );
      }
    }

    await setCaseCookie(created.id);

    const eventId = metaEventId("Lead", created.public_id);
    const context = metaRequestContext(request, "/check");
    const metaDelivery = await sendMetaCapiEvent({
      eventName: "Lead",
      eventId,
      eventSourceUrl: context.eventSourceUrl,
      customer: {
        firstName: parsed.data.firstName,
        email: parsed.data.email,
        phone: parsed.data.phone,
        clientIpAddress: context.clientIpAddress,
        clientUserAgent: context.clientUserAgent,
        fbp: context.fbp,
        fbc: context.fbc,
      },
    });
    if (metaDelivery.status === "failed") {
      console.warn("Meta Lead delivery deferred", metaDelivery.code);
    }

    return NextResponse.json(
      {
        publicId: created.public_id,
        metaEvent: { eventName: "Lead", eventId },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to create salary case", error);
    return NextResponse.json(
      { error: "לא הצלחנו לפתוח את הבדיקה כרגע. אפשר לנסות שוב בעוד רגע." },
      { status: 503 },
    );
  }
}
