import { NextResponse } from "next/server";
import { requestAccessCode } from "@/server/product/case-access/service";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// UX Run 1 / U2 (D-1.2, D-1.4): a code to the channel on file, for a link
// token or a contact. The answer never says whether the contact exists; the
// token arrives in the body, never in the query string, and is not echoed.
export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-099", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const body = await strictJsonObject(request, 4_096);
  if (!body || (typeof body.token !== "string" && typeof body.contact !== "string")) {
    return NextResponse.json({ error: "לא הצלחנו לקרוא את הבקשה", code: "access_request_invalid" }, { status: 400 });
  }
  try {
    const result = await requestAccessCode({ token: body.token, contact: body.contact, request });
    if (result.refused === "ip_rate_limited") {
      return NextResponse.json({ error: "יותר מדי בקשות מהמכשיר הזה", code: "access_rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "900" } });
    }
    return NextResponse.json(
      { accepted: true, channel: result.masked_channel, to: result.masked_to },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Case access code request failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לשלוח קוד עכשיו", code: "access_send_failed" }, { status: 503 });
  }
}
