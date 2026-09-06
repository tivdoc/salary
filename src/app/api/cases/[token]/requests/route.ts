import { NextResponse } from "next/server";
import { answerCaseRequest, listCaseRequests } from "@/server/product/reports/case-requests";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Site S3.4 / D-2 — answering one request on the thread.
 *
 * The only write this route performs is an ANSWER. There is no path here that
 * opens a request: a request exists because a refusal opened it, and a customer
 * (or an operator, or a screen) inventing one would put a question in the thread
 * that no refusal is waiting on.
 *
 * The case is resolved from the verified identity session, never from the body,
 * so answering someone else's request is not a thing this route can be asked to
 * do — an unknown case for this identity is a 404, the same answer a case that
 * does not exist gets.
 */
export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await guardStableHttpEntrypoint("CEP-105", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const body = await strictJsonObject(request, 4_096);
  if (!body || typeof body.requestId !== "string" || typeof body.answer !== "string" || body.answer.trim().length === 0) {
    return NextResponse.json({ error: "לא הצלחנו לקרוא את התשובה", code: "request_answer_invalid" }, { status: 400 });
  }

  const session = await resolveIdentitySession(await readCaseSessionCookie());
  if (!session) {
    return NextResponse.json({ error: "צריך להיכנס לתיק כדי לענות", code: "session_required" }, { status: 401 });
  }
  const { token } = await context.params;
  const cases = await listIdentityCases(session.identity_id);
  const found = cases.find((candidate) => candidate.public_id === token);
  if (!found) {
    return NextResponse.json({ error: "לא נמצא תיק", code: "case_not_found" }, { status: 404 });
  }

  try {
    const answered = await answerCaseRequest({ requestId: body.requestId, caseId: found.case_id, answer: body.answer });
    if (!answered) {
      // Either it is not this case's request, or it was already answered — and an
      // answer is written once, so the second attempt is refused rather than merged.
      return NextResponse.json({ error: "השאלה כבר נענתה או שאינה שייכת לתיק הזה", code: "request_not_open" }, { status: 409 });
    }
    const remaining = await listCaseRequests(found.case_id);
    return NextResponse.json(
      { ok: true, open: remaining.filter((row) => row.answered_at === null).length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Answering a case request failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לשמור את התשובה", code: "request_answer_failed" }, { status: 503 });
  }
}
