import { NextResponse } from "next/server";
import { readCaseIdFromCookie } from "@/lib/case-cookie";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { recordCaseFunnelEvent } from "@/lib/funnel-server";
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
    await guardStableHttpEntrypoint("CEP-017", request);
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
    const directory = `cases/${caseId}`;
    const { data: objects, error: listError } = await supabase.storage
      .from("salary-documents")
      .list(directory, { limit: 20 });
    if (listError) throw listError;

    const records = parsed.data.files.map((file) => {
      const fileName = `${storageBaseName(file.documentType)}.${extensionForMimeType(file.type)}`;
      const stored = objects.find((object) => object.name === fileName);
      if (!stored) throw new Error(`Uploaded object is missing: ${fileName}`);

      const storedSize = Number(stored.metadata?.size ?? file.size);
      const storedMimeType = String(stored.metadata?.mimetype ?? file.type);
      if (
        storedSize !== file.size ||
        storedSize <= 0 ||
        storedSize > 10 * 1024 * 1024 ||
        storedMimeType !== file.type
      ) {
        throw new Error(`Uploaded object metadata does not match: ${fileName}`);
      }

      return {
        case_id: caseId,
        document_type: file.documentType,
        storage_path: `${directory}/${fileName}`,
        original_filename: file.name,
        mime_type: storedMimeType,
        size: storedSize,
      };
    });

    const { data: previousDocuments } = await supabase
      .from("documents")
      .select("storage_path,document_type")
      .eq("case_id", caseId);

    const { error: documentError } = await supabase
      .from("documents")
      .upsert(records, { onConflict: "case_id,document_type" });
    if (documentError) throw documentError;

    const { error: updateError } = await supabase
      .from("cases")
      .update({ status: "documents_uploaded", updated_at: new Date().toISOString() })
      .eq("id", caseId)
      .in("status", ["started", "questionnaire_completed", "documents_uploaded"]);
    if (updateError) throw updateError;
    await recordCaseFunnelEvent(caseId, "document_uploaded");

    const currentPaths = new Set(records.map((record) => record.storage_path));
    const obsoletePaths = (previousDocuments ?? [])
      .map((document) => document.storage_path)
      .filter((path) => !currentPaths.has(path));
    if (obsoletePaths.length) {
      const { error: cleanupError } = await supabase.storage
        .from("salary-documents")
        .remove(obsoletePaths);
      if (cleanupError) console.error("Failed to remove replaced document objects", cleanupError);
    }

    return NextResponse.json({ uploaded: records.map((record) => record.document_type) });
  } catch (error) {
    console.error("Document completion failed", error);
    return NextResponse.json(
      { error: "העלאת המסמכים לא הושלמה. אפשר לנסות שוב בלי לבחור מחדש את הקבצים." },
      { status: 503 },
    );
  }
}
