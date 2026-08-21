import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { isPaymentVerified } from "@/lib/case-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "לא נמצא תיק בדיקה בדפדפן הזה" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const [caseResult, paymentResult] = await Promise.all([
      supabase
        .from("cases")
        .select("public_id,status,payment_status,created_at")
        .eq("id", caseId)
        .single(),
      supabase
        .from("payments")
        .select("status,provider_reference,created_at")
        .eq("case_id", caseId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (caseResult.error) throw caseResult.error;
    const salaryCase = caseResult.data;
    const payment = paymentResult.data;

    const paymentStatus = payment?.status ?? salaryCase.payment_status;
    return NextResponse.json(
      {
        publicId: salaryCase.public_id,
        status: salaryCase.status,
        paymentStatus,
        paymentVerified: isPaymentVerified(paymentStatus),
        createdAt: salaryCase.created_at,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to read case status", error);
    return NextResponse.json({ error: "לא הצלחנו לטעון את סטטוס הבדיקה" }, { status: 503 });
  }
}
