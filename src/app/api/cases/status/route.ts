import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isPaymentVerified } from "@/lib/case-status";
import { deliverVerifiedMetaPurchase } from "@/lib/meta-purchase";
import { verifyPendingInvoice4uPayment } from "@/lib/verify-payment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "לא נמצא תיק בדיקה בדפדפן הזה" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    try {
      await verifyPendingInvoice4uPayment(caseId);
    } catch {
      // Provider outages must not make the saved case unavailable to the user.
    }
    await deliverVerifiedMetaPurchase(caseId, request);
    const [caseResult, paymentResult] = await Promise.all([
      supabase
        .from("cases")
        .select("public_id,status,payment_status,created_at")
        .eq("id", caseId)
        .single(),
      supabase
        .from("payments")
        .select("status,provider_reference,analytics_reported_at,meta_purchase_event_id,created_at")
        .eq("case_id", caseId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (caseResult.error) throw caseResult.error;
    if (paymentResult.error) throw paymentResult.error;
    const salaryCase = caseResult.data;
    const payment = paymentResult.data;

    const paymentStatus = payment?.status ?? salaryCase.payment_status;
    const paymentVerified = isPaymentVerified(paymentStatus);
    let trackPaymentCompleted = false;
    if (paymentVerified && !payment?.analytics_reported_at) {
      const claim = await supabase.rpc("claim_salary_payment_completed", {
        target_case_id: caseId,
      });
      trackPaymentCompleted = !claim.error && claim.data === true;
    }
    const metaEvent =
      paymentVerified && payment?.meta_purchase_event_id
        ? {
            eventName: "Purchase",
            eventId: payment.meta_purchase_event_id,
            customData: { value: 9.99, currency: "ILS" },
          }
        : null;
    return NextResponse.json(
      {
        publicId: salaryCase.public_id,
        status: salaryCase.status,
        paymentStatus,
        paymentVerified,
        trackPaymentCompleted,
        metaEvent,
        createdAt: salaryCase.created_at,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to read case status", error);
    return NextResponse.json({ error: "לא הצלחנו לטעון את סטטוס הבדיקה" }, { status: 503 });
  }
}
