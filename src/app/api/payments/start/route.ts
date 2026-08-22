import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import {
  INITIAL_CHECK_CURRENCY,
  INITIAL_CHECK_PRICE,
  getPaymentReturnUrl,
  invoice4uOrderIdForCase,
} from "@/lib/payment";
import { Invoice4uApiError, Invoice4uClient } from "@/lib/invoice4u";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";

export async function POST() {
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "תיק הבדיקה לא נמצא. יש להתחיל מחדש." }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const [caseResult, documentResult] = await Promise.all([
      supabase
        .from("cases")
        .select("id,public_id,first_name,email,phone,status,payment_status")
        .eq("id", caseId)
        .single(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .eq("document_type", "payslip"),
    ]);
    const { data: salaryCase, error: caseError } = caseResult;
    if (caseError || !salaryCase) {
      return NextResponse.json({ error: "תיק הבדיקה לא נמצא" }, { status: 404 });
    }

    if (["paid", "verified"].includes(salaryCase.payment_status)) {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }

    const { count, error: documentError } = documentResult;
    if (documentError) throw documentError;
    if (!count) {
      return NextResponse.json({ error: "צריך להעלות תלוש לפני המעבר לתשלום" }, { status: 409 });
    }

    const idempotencyKey = `${caseId}:initial-check`;
    const orderId = invoice4uOrderIdForCase(salaryCase.public_id);
    const { data: existingPayment, error: existingPaymentError } = await supabase
      .from("payments")
      .select("id,status,provider_redirect_url")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingPaymentError) throw existingPaymentError;
    if (existingPayment?.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }
    if (existingPayment?.status === "pending" && existingPayment.provider_redirect_url) {
      return NextResponse.json({
        url: existingPayment.provider_redirect_url,
        publicId: salaryCase.public_id,
      });
    }

    const pendingPaymentValues = {
      case_id: caseId,
      provider: "invoice4u",
      amount: INITIAL_CHECK_PRICE,
      currency: INITIAL_CHECK_CURRENCY,
      status: "pending",
      provider_payment_id: null,
      provider_order_id: orderId,
      provider_redirect_url: null,
      provider_reference: null,
      provider_clearing_log_id: null,
      provider_confirmation_number: null,
      verified_at: null,
      analytics_reported_at: null,
      idempotency_key: idempotencyKey,
    };
    const pendingPayment = existingPayment
      ? await supabase
          .from("payments")
          .update(pendingPaymentValues)
          .eq("id", existingPayment.id)
          .neq("status", "verified")
          .select("id,status")
          .maybeSingle()
      : await supabase
          .from("payments")
          .insert(pendingPaymentValues)
          .select("id,status")
          .single();
    if (pendingPayment.error) throw pendingPayment.error;
    if (!pendingPayment.data || pendingPayment.data.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }

    const { error: updateError } = await supabase
      .from("cases")
      .update({
        status: "payment_pending",
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", caseId)
      .not("payment_status", "in", "(paid,verified)");
    if (updateError) throw updateError;

    const checkout = await new Invoice4uClient().createCheckout({
      caseId: salaryCase.public_id,
      orderId,
      fullName: salaryCase.first_name,
      phone: salaryCase.phone,
      email: salaryCase.email,
      returnUrl: getPaymentReturnUrl(),
      amount: INITIAL_CHECK_PRICE,
      currency: INITIAL_CHECK_CURRENCY,
    });
    const persistedPayment = await supabase
      .from("payments")
      .update({
        provider_payment_id: checkout.paymentId,
        provider_redirect_url: checkout.url,
      })
      .eq("id", pendingPayment.data.id)
      .neq("status", "verified")
      .select("status,provider_redirect_url")
      .maybeSingle();
    if (persistedPayment.error) throw persistedPayment.error;
    if (!persistedPayment.data || persistedPayment.data.status === "verified") {
      return NextResponse.json({ url: "/check/received", publicId: salaryCase.public_id });
    }
    if (!persistedPayment.data.provider_redirect_url) {
      throw new Error("Invoice4u checkout URL was not persisted");
    }

    return NextResponse.json({
      url: persistedPayment.data.provider_redirect_url,
      publicId: salaryCase.public_id,
    });
  } catch (error) {
    console.error(
      "Payment handoff failed",
      error instanceof Invoice4uApiError ? error.code : "internal_error",
    );
    return NextResponse.json(
      { error: "לא הצלחנו לפתוח את עמוד התשלום כרגע. אפשר לנסות שוב." },
      { status: 503 },
    );
  }
}
