import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  extensionForMimeType,
  storageBaseName,
  uploadManifestSchema,
} from "@/lib/validation";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await guardStableHttpEntrypoint("CEP-016", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const caseId = await readCaseIdFromCookie();
  if (!caseId) {
    return NextResponse.json({ error: "תיק הבדיקה לא נמצא. יש להתחיל מחדש." }, { status: 401 });
  }

  const parsed = uploadManifestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "פרטי הקבצים אינם תקינים" },
      { status: 422 },
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data: salaryCase, error: caseError } = await supabase
      .from("cases")
      .select("id,contact_verified_at")
      .eq("id", caseId)
      .single();
    if (!caseError && salaryCase && !salaryCase.contact_verified_at) return NextResponse.json({ error: "צריך לאמת את הטלפון או האימייל לפני העלאת מסמכים", code: "contact_unverified" }, { status: 409 });
    if (caseError || !salaryCase) {
      return NextResponse.json({ error: "תיק הבדיקה לא נמצא" }, { status: 404 });
    }

    const uploads = await Promise.all(
      parsed.data.files.map(async (file) => {
        const fileName = `${storageBaseName(file.slot)}.${extensionForMimeType(file.type)}`;
        const path = `cases/${caseId}/${fileName}`;
        const { data, error } = await supabase.storage
          .from("salary-documents")
          .createSignedUploadUrl(path, { upsert: true });
        if (error) throw error;
        return {
          documentType: file.documentType,
          // S2.2: the client addresses each upload by its slot, so two payslips never share a target.
          slot: file.slot,
          path,
          signedUrl: data.signedUrl,
          token: data.token,
        };
      }),
    );

    return NextResponse.json({ uploads }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to create signed upload URLs", error);
    return NextResponse.json(
      { error: "לא הצלחנו להכין את האחסון להעלאה. אפשר לנסות שוב." },
      { status: 503 },
    );
  }
}
