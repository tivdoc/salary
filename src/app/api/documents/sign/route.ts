import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { documentUploadSchema } from "@/lib/document-upload";
import { prepareUpload, uploadErrorResponse } from "@/server/product/documents/upload";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try { await guardStableHttpEntrypoint("CEP-016", request); } catch (error) { return refusedEntrypoint(error); }
  const caseId = await readCaseIdFromCookie();
  if (!caseId) return NextResponse.json({ error: "תיק הבדיקה לא נמצא. יש להתחיל מחדש." }, { status: 401 });
  const parsed = documentUploadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "פרטי ההעלאה אינם תקינים. יש לרענן את המסך." }, { status: 422 });
  // Bind the rendered page as well as the cookie: another tab may have switched cases.
  if (parsed.data.caseId !== caseId) return NextResponse.json({ error: "התיק הפעיל השתנה. יש לפתוח שוב את התיק.", code: "UPLOAD_FORBIDDEN" }, { status: 403 });
  try {
    const result = await (prepareUpload(parsed.data));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { status, ...body } = uploadErrorResponse(error);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
