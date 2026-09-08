import {supportRequestSchema,submitSupport} from "@/server/product/reports/support";
import {sameOriginSessionRequest} from "@/server/product/case-access/session-actions";
import { RequestAnswerError } from "@/server/product/reports/request-answer";
import { NextResponse } from "next/server";
import { answerCaseRequest, editCaseRequest, listCaseRequests } from "@/server/product/reports/case-requests";
import { listIdentityCases, resolveIdentitySession } from "@/server/product/case-access/service";
import { readCaseSessionCookie } from "@/server/product/case-access/session-cookie";
import { refusedEntrypoint, strictJsonObject } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";
import {loadRequestDocumentSource} from '@/server/product/reports/request-document-source';
import {PRODUCT_HTTP_HEADERS} from '@/server/product/routes/http-common';
import {z} from 'zod';

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A request links only its exact source version. The server checks the
 * authenticated case and the stored target before reading and hashing bytes. */
export async function GET(request:Request,context:{params:Promise<{token:string}>}){
 try{await guardStableHttpEntrypoint("CEP-105",request);}catch(error){return refusedEntrypoint(error);}
 try{
  const session=await resolveIdentitySession(await readCaseSessionCookie());
  if(!session)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
  const {token}=await context.params,found=(await listIdentityCases(session.identity_id)).find(c=>c.public_id===token);
  const id=z.uuid().safeParse(new URL(request.url).searchParams.get('source'));
  if(!found||!id.success)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
  const source=await loadRequestDocumentSource({caseId:found.case_id,identityId:session.identity_id,requestId:id.data});
  if(!source)return new Response(null,{status:404,headers:PRODUCT_HTTP_HEADERS});
  return new Response(source.bytes,{headers:{...PRODUCT_HTTP_HEADERS,'Content-Type':source.mime,'Content-Disposition':`inline; filename="source-${source.version}.${source.extension}"`}});
 }catch{return NextResponse.json({code:'request_source_unavailable'},{status:503,headers:PRODUCT_HTTP_HEADERS});}
}

/**
 * Site S3.4 / D-2 — answering one request on the thread.
 *
 * Engine questions accept answers; separate support actions append messages. There is no path here that
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
  if(!sameOriginSessionRequest(request))return new Response(null,{status:403});
  const body = await strictJsonObject(request, 12000);
  const support=supportRequestSchema.safeParse(body);
  if(!support.success&&body?.action!==undefined&&(typeof body.action!=='string'||!['answer','draft','correction'].includes(body.action)))return NextResponse.json({code:'request_answer_invalid'},{status:400});
  if (!support.success && (!body || typeof body.requestId !== "string" || typeof body.answer !== "string" || body.answer.trim().length === 0)) {
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
    if(support.success){await submitSupport(found.case_id,session.identity_id,support.data);return NextResponse.json({ok:true},{status:202,headers:{"Cache-Control":"no-store"}});}
    if (!body || typeof body.requestId!=="string" || typeof body.answer!=="string") return new Response(null,{status:400});
    if (body.action === "draft" || body.action === "correction") {
      if (typeof body.expectedRevision !== "number") return NextResponse.json({code:"request_answer_invalid"},{status:400});
      await editCaseRequest({caseId:found.case_id,requestId:body.requestId,identityId:session.identity_id,answer:body.answer,expectedRevision:body.expectedRevision,kind:body.action});
      return NextResponse.json({ok:true},{headers:{"Cache-Control":"no-store"}});
    }
    const answered = await answerCaseRequest({ requestId: body.requestId, caseId: found.case_id, answer: body.answer, identityId:session.identity_id });
    if (!answered) {
      // Either it is not this case's request, or it was already answered — and an
      // answer is written once, so the second attempt is refused rather than merged.
      return NextResponse.json({ error: "השאלה כבר נענתה או שאינה שייכת לתיק הזה", code: "request_not_open" }, { status: 409 });
    }
    const remaining = await listCaseRequests(found.case_id,undefined,session.identity_id);
    return NextResponse.json(
      { ok: true, open: remaining.filter((row) => row.answered_at === null && row.source_current !== false && Date.parse(row.expires_at)>Date.now()).length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if(error instanceof Error&&/REQUEST_FIELD_SOURCE_CHANGED$/.test(error.message))return NextResponse.json({code:'request_edit_conflict',error:'המסמך השתנה מאז פתיחת השאלה. צריך לטעון את השאלה העדכנית.'},{status:409});
    if(error instanceof Error&&/REQUEST_(ANSWER|EDIT)_INVALID$/.test(error.message))return NextResponse.json({error:'התשובה אינה מתאימה לשאלה',code:'request_answer_invalid'},{status:400});
    if(error instanceof Error&&/REQUEST_EDIT_(CONFLICT|CLOSED)$/.test(error.message))return NextResponse.json({error:'התשובה או הטיוטה השתנו. אפשר לטעון את המצב שנשמר לפני שליחה נוספת.',code:'request_edit_conflict'},{status:409});
    if (error instanceof RequestAnswerError) return NextResponse.json({ error: "התשובה אינה מתאימה לשאלה", code: "request_answer_invalid" }, { status: 400 });
    console.error("Answering a case request failed", error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "לא הצלחנו לשמור את התשובה", code: "request_answer_failed" }, { status: 503 });
  }
}
