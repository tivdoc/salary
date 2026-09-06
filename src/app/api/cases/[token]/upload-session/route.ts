import { NextResponse } from "next/server";
import { setCaseCookie } from "@/lib/case-cookie";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Site S2.3 — attaching a document to a case after payment.
 *
 * The upload path itself is not duplicated here, and that is the whole point of
 * the route. `/api/documents/sign` and `/api/documents/complete` decide which
 * case a file belongs to by reading the funnel's case cookie, and the review
 * screen that judges readability before the money moves is the one screen this
 * product has for looking at a document. A second upload endpoint reachable
 * from the case screen would be a second place a file is accepted and a second
 * place readability is judged — the failure S2 exists to prevent.
 *
 * So this route does one thing: it proves the verified identity owns the case,
 * and points the funnel's cookie at it. The customer then walks the same
 * screens they walked the first time.
 *
 * The cookie is the funnel's, not an escalation: it is set only for a case the
 * session already grants access to, and everything it unlocks is behind
 * `requireVerifiedFunnelCase`, which asks the same question again.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await guardStableHttpEntrypoint("CEP-106", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }

  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) {
    return NextResponse.json({ error: "צריך להיכנס לתיק כדי לצרף מסמך", code: "session_required" }, { status: 401 });
  }
  const { token } = await context.params;
  if (!/^TV-[A-Z0-9]{8}$/u.test(token)) {
    return NextResponse.json({ error: "לא נמצא תיק", code: "case_not_found" }, { status: 404 });
  }
  const cases = await listIdentityCases(session.identity_id);
  const found = cases.find((candidate) => candidate.public_id === token);
  if (!found) {
    return NextResponse.json({ error: "לא נמצא תיק", code: "case_not_found" }, { status: 404 });
  }

  try {
    await setCaseCookie(found.case_id);
  } catch (error) {
    // The cookie is signed with CASE_TOKEN_SECRET; without it there is no way to
    // hand the funnel a case, and pretending otherwise would send the customer
    // to a screen that immediately redirects them back.
    console.error("Opening an upload session failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לפתוח מסך צירוף מסמך", code: "upload_session_failed" }, { status: 503 });
  }

  return NextResponse.json(
    { ok: true, next: "/check/upload" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
