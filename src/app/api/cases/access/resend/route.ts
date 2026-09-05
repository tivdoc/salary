import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { resendCaseLink } from "@/server/product/case-access/service";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UX Run 1 / U5: "שלחו לי את הקישור שוב" from the received screen, for the
// funnel cookie's own case only, a few times per case. A failed send is an
// answer, not an exception, and never touches payment verification.
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-101", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "לא נמצא תיק בדיקה בדפדפן הזה", code: "case_not_found" }, { status: 401 });
  }
  try {
    const result = await resendCaseLink(caseId);
    if (result.outcome === "resend_limited") {
      return NextResponse.json({ error: "שלחנו את הקישור כמה פעמים", code: "access_resend_limited" }, { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    if (result.outcome === "not_verified") {
      return NextResponse.json({ error: "התשלום עדיין לא אומת", code: "case_status_unavailable" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    if (result.outcome !== "sent") {
      return NextResponse.json({ error: "לא הצלחנו לשלוח את ההודעה עכשיו", code: "access_send_failed", outcome: result.outcome }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true, outcome: "sent" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Case link resend failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לשלוח את ההודעה עכשיו", code: "access_send_failed" }, { status: 503 });
  }
}
