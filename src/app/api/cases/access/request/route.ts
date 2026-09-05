import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { exchangeLinkToken, requestAccessCode, requestFunnelCode, resendChallengeCode } from "@/server/product/case-access/service";
import { readCaseChallengeCookie, setCaseChallengeCookie } from "@/server/product/case-access/session-cookie";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UX Run 1 / U2 (D-1.2, D-1.4), corrected by the external review #1: a code
// to the channel on file, in three modes — `funnel` (the case cookie's own
// contact, verified before any document binds; finding 1), `challenge` (a
// fresh code for the challenge the link exchange opened; finding 8) and a
// typed `contact` (login and recovery). The answer never says whether a
// contact exists; no token is accepted here any more, and none is echoed.
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-099", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const body = await strictJsonObject(request, 4_096);
  if (!body || (body.funnel !== true && body.challenge !== true && body.exchange !== true && typeof body.contact !== "string")) {
    return NextResponse.json({ error: "לא הצלחנו לקרוא את הבקשה", code: "access_request_invalid" }, { status: 400 });
  }
  try {
    if (body.exchange === true) {
      // Finding 8: the link's one-time exchange — token spent, code sent, challenge cookie set, the case path answered. A cookie can
      // only be set here, in a route handler; the page that received the link renders nothing but the component that calls this.
      const exchanged = await exchangeLinkToken({ token: body.token, request });
      if (exchanged.outcome !== "challenge") return NextResponse.json({ error: "הקישור אינו תקף", code: "access_link_invalid" }, { status: 410, headers: { "Cache-Control": "no-store" } });
      await setCaseChallengeCookie(exchanged.challenge, exchanged.challenge_ttl_seconds);
      return NextResponse.json({ accepted: true, next: `/case/${exchanged.public_id}` }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (body.funnel === true) {
      const caseId = await readCaseIdFromCookie();
      if (!caseId) return NextResponse.json({ error: "לא נמצא תיק בדיקה בדפדפן הזה", code: "case_not_found" }, { status: 401 });
      const result = await requestFunnelCode({ caseId, contact: body.contact, channel: body.channel, request });
      if (!result.case_found) return NextResponse.json({ error: "לא נמצא תיק בדיקה בדפדפן הזה", code: "case_not_found" }, { status: 404 });
      if (result.refused === "ip_rate_limited") return rateLimited();
      return NextResponse.json({ accepted: true, channel: result.masked_channel, to: result.masked_to, already_verified: result.already_verified }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const result = body.challenge === true
      ? await resendChallengeCode({ challenge: await readCaseChallengeCookie(), request })
      : await requestAccessCode({ contact: body.contact, request });
    if (result.refused === "ip_rate_limited") return rateLimited();
    return NextResponse.json({ accepted: true, channel: result.masked_channel, to: result.masked_to }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Case access code request failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לשלוח קוד עכשיו", code: "access_send_failed" }, { status: 503 });
  }
}

function rateLimited(): Response {
  return NextResponse.json({ error: "יותר מדי בקשות מהמכשיר הזה", code: "access_rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "900" } });
}
