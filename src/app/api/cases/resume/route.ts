import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await guardStableHttpEntrypoint("CEP-014", request);
  const caseId = await readCaseIdFromCookie();
  if (!caseId) return NextResponse.json({ resumePath: null });

  try {
    const supabase = getSupabaseAdmin();
    const [salaryCase, documents] = await Promise.all([
      supabase
        .from("cases")
        .select("status,payment_status")
        .eq("id", caseId)
        .maybeSingle(),
      supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId)
        .eq("document_type", "payslip"),
    ]);
    if (salaryCase.error || !salaryCase.data) {
      return NextResponse.json({ resumePath: null });
    }

    let resumePath = "/check/upload";
    if (["verified", "paid"].includes(salaryCase.data.payment_status)) {
      resumePath = "/check/received";
    } else if ((documents.count ?? 0) > 0) {
      resumePath = "/check/payment";
    }
    return NextResponse.json({ resumePath }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ resumePath: null });
  }
}
