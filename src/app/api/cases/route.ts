import { NextResponse } from "next/server";
import { setCaseCookie } from "@/lib/case-cookie";
import { metaRequestContext, sendMetaCapiEvent } from "@/lib/meta-capi";
import { metaEventId } from "@/lib/meta-events";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { questionnaireSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
    const { data: created, error: caseError } = await supabase
      .from("cases")
      .insert({
        first_name: parsed.data.firstName,
        email: parsed.data.email.toLowerCase(),
        phone: parsed.data.phone,
        status: "questionnaire_completed",
      })
      .select("id,public_id")
      .single();

    if (caseError || !created) throw caseError ?? new Error("Case creation returned no identifier");

    const { suspectedIssue, ...payload } = parsed.data;
    const { error: responseError } = await supabase.from("questionnaire_responses").insert({
      case_id: created.id,
      payload,
      suspected_issue: suspectedIssue,
    });

    if (responseError) {
      await supabase.from("cases").delete().eq("id", created.id);
      throw responseError;
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
