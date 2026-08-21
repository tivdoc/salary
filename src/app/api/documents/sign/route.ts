import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  extensionForMimeType,
  storageBaseName,
  uploadManifestSchema,
} from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
      .select("id")
      .eq("id", caseId)
      .single();
    if (caseError || !salaryCase) {
      return NextResponse.json({ error: "תיק הבדיקה לא נמצא" }, { status: 404 });
    }

    const uploads = await Promise.all(
      parsed.data.files.map(async (file) => {
        const fileName = `${storageBaseName(file.documentType)}.${extensionForMimeType(file.type)}`;
        const path = `cases/${caseId}/${fileName}`;
        const { data, error } = await supabase.storage
          .from("salary-documents")
          .createSignedUploadUrl(path, { upsert: true });
        if (error) throw error;
        return {
          documentType: file.documentType,
          path,
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
