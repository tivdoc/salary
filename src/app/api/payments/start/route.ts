import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import {
  INITIAL_CHECK_CURRENCY,
  INITIAL_CHECK_PRICE,
  Invoice4uHostedPaymentAdapter,
} from "@/lib/payment";
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
        .select("id,public_id,status,payment_status")
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

    const handoff = new Invoice4uHostedPaymentAdapter().createHandoff();
    const { error: paymentError } = await supabase.from("payments").upsert(
      {
        case_id: caseId,
        provider: handoff.provider,
        amount: INITIAL_CHECK_PRICE,
        currency: INITIAL_CHECK_CURRENCY,
        status: "pending",
        idempotency_key: `${caseId}:initial-check`,
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (paymentError) throw paymentError;

    const { error: updateError } = await supabase
      .from("cases")
      .update({
        status: "payment_pending",
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", caseId);
    if (updateError) throw updateError;

    return NextResponse.json({ url: handoff.url, publicId: salaryCase.public_id });
  } catch (error) {
    console.error("Payment handoff failed", error);
    return NextResponse.json(
      { error: "לא הצלחנו לפתוח את עמוד התשלום כרגע. אפשר לנסות שוב." },
      { status: 503 },
    );
  }
}
