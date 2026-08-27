import { NextResponse } from "next/server";
import { setCaseCookie } from "@/lib/case-cookie";
import { hashPaymentReturnToken, isPaymentReturnToken } from "@/lib/payment";
import { paymentReturnDestination } from "@/lib/payment-return";
import { deliverVerifiedMetaPurchase } from "@/lib/meta-purchase";
import { deliverVerifiedGa4Purchase } from "@/lib/ga4-server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { verifyPendingInvoice4uPayment } from "@/lib/verify-payment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const destination = paymentReturnDestination(request.url);
  const paymentReturnToken = new URL(request.url).searchParams.get("payment_return");
  if (!isPaymentReturnToken(paymentReturnToken)) {
    return NextResponse.redirect(destination);
  }

  try {
    const supabase = getSupabaseAdmin();
    const tokenHash = hashPaymentReturnToken(paymentReturnToken);
    const { data: payment, error } = await supabase
      .from("payments")
      .select("id,case_id")
      .eq("payment_return_token_hash", tokenHash)
      .gt("payment_return_token_expires_at", new Date().toISOString())
      .is("payment_return_token_consumed_at", null)
      .maybeSingle();
    if (error || !payment) {
      return NextResponse.redirect(destination);
    }

    await verifyPendingInvoice4uPayment(payment.case_id);
    await Promise.all([
      deliverVerifiedMetaPurchase(payment.case_id, request),
      deliverVerifiedGa4Purchase(payment.case_id),
    ]);
    await setCaseCookie(payment.case_id);
    await supabase
      .from("payments")
      .update({ payment_return_token_consumed_at: new Date().toISOString() })
      .eq("id", payment.id)
      .is("payment_return_token_consumed_at", null);
  } catch (error) {
    console.error("Payment return recovery failed", error instanceof Error ? error.name : "error");
  }

  return NextResponse.redirect(destination);
}
