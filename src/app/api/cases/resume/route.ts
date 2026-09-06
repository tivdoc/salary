import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-014", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const caseId = await readCaseIdFromCookie();
  if (!caseId) return NextResponse.json({ resumePath: null });

  try {
    const supabase = getSupabaseAdmin();
    const [salaryCase, documents] = await Promise.all([
      supabase
        .from("cases")
        // S4: the public id too, so a screen that just created a case can tell
        // whether the browser's funnel cookie still points at the same one.
        .select("public_id,status,payment_status")
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

    // External review #1, finding 1: an unverified contact resumes at the verification step, nowhere further.
    const verified = await supabase.from("cases").select("contact_verified_at").eq("id", caseId).maybeSingle();
    if (!verified.data?.contact_verified_at) return NextResponse.json({ resumePath: "/check?verify=1", contactVerified: false, publicId: salaryCase.data.public_id }, { headers: { "Cache-Control": "no-store" } });
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
