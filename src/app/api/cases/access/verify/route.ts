import { NextResponse } from "next/server";
import { verifyAccessCode } from "@/server/product/case-access/service";
import { setCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_STATUS: Readonly<Record<string, Readonly<{ status: number; code: string; error: string }>>> = Object.freeze({
  invalid: { status: 401, code: "access_code_invalid", error: "הקוד שהוזן אינו נכון" },
  expired: { status: 410, code: "access_code_expired", error: "תוקף הקוד פג" },
  locked: { status: 429, code: "access_code_locked", error: "יותר מדי ניסיונות" },
  none: { status: 404, code: "access_code_missing", error: "לא נמצא קוד פעיל" },
  link_invalid: { status: 410, code: "access_link_invalid", error: "הקישור אינו תקף" },
  request_invalid: { status: 400, code: "access_request_invalid", error: "לא הצלחנו לקרוא את הבקשה" },
});

// UX Run 1 / U2 (D-1.2, D-1.3): a valid code opens the rolling identity
// session; the cookie is the whole "account". The sixth attempt is refused
// before the digits are looked at.
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-100", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const body = await strictJsonObject(request, 4_096);
  if (!body || typeof body.code !== "string" || (typeof body.token !== "string" && typeof body.contact !== "string")) {
    return NextResponse.json({ error: "לא הצלחנו לקרוא את הבקשה", code: "access_request_invalid" }, { status: 400 });
  }
  try {
    const result = await verifyAccessCode({ token: body.token, contact: body.contact, code: body.code });
    if (result.outcome !== "ok") {
      const answer = CODE_STATUS[result.outcome] ?? CODE_STATUS.none!;
      return NextResponse.json({ error: answer.error, code: answer.code }, { status: answer.status, headers: { "Cache-Control": "no-store" } });
    }
    await setCaseSessionCookie(result.session, result.session_ttl_seconds);
    return NextResponse.json({ ok: true, next: result.next }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Case access code verification failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לאמת את הקוד עכשיו", code: "case_status_unavailable" }, { status: 503 });
  }
}
