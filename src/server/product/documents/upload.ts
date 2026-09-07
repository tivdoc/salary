import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { matchesDocumentSignature, type DocumentUpload, type UploadSnapshot } from "@/lib/document-upload";
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db";

export class UploadError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
export type ReservedFile = DocumentUpload["files"][number] & {
  documentId: string; versionId: string; path: string; slot: string;
};
export type UploadBatch = { id: string; case_id: string; files: ReservedFile[]; completed_at: string | null; cancelled_at: string | null; expires_at: string };

async function rpc<T>(fn: string, args: Record<string, unknown>, db?: CaseAccessDb): Promise<T> {
  const store = db ?? await resolveCaseAccessDb();
  if (!store) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
  try {
    const rows = await store.rpc<{ value: T }>(fn, args);
    if (!rows[0]) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    return rows[0].value;
  } catch (error) {
    if (error instanceof UploadError) throw error;
    const message = error instanceof Error ? error.message : "";
    const code = message.match(/UPLOAD_[A-Z_]+/u)?.[0];
    throw new UploadError(code ?? "UPLOAD_UNAVAILABLE", code === "UPLOAD_FORBIDDEN" ? 403 : code ? 409 : 503);
  }
}

export function uploadSnapshot(caseId: string, db?: CaseAccessDb): Promise<UploadSnapshot> {
  return rpc("case_documents_snapshot", { target_case: caseId }, db);
}

export async function prepareUpload(manifest: DocumentUpload) {
  const batch = await rpc<UploadBatch>("case_documents_reserve", {
    target_case: manifest.caseId, target_batch: manifest.batchId, target_manifest: manifest,
  });
  if (batch.completed_at) return { batchId: batch.id, completed: true, uploads: [] };
  const storage = getSupabaseAdmin().storage.from("salary-documents");
  const uploads = [];
  for (const file of batch.files) {
    const { data: info, error: infoError } = await storage.info(file.path);
    if (info) {
      // A lost PUT response is recoverable. Completion still checks the bytes and digest.
      uploads.push({ clientId: file.clientId, uploaded: true });
      continue;
    }
    if (!infoError || !(String(infoError.statusCode) === "404" || ["NoSuchKey", "not_found"].includes(String((infoError as { code?: string }).code)))) {
      throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    }
    const { data, error } = await storage.createSignedUploadUrl(file.path, { upsert: false });
    if (error || !data) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    uploads.push({ clientId: file.clientId, uploaded: false, signedUrl: data.signedUrl });
  }
  return { batchId: batch.id, completed: false, uploads };
}

export async function completeUpload(caseId: string, batchId: string): Promise<UploadSnapshot> {
  const batch = await rpc<UploadBatch>("case_documents_batch", { target_case: caseId, target_batch: batchId });
  if (batch.completed_at) return uploadSnapshot(caseId);
  if (batch.cancelled_at) throw new UploadError("UPLOAD_CANCELLED");
  if (Date.parse(batch.expires_at) <= Date.now()) throw new UploadError("UPLOAD_EXPIRED");
  const storage = getSupabaseAdmin().storage.from("salary-documents");
  const checks: Record<string, string> = {};
  for (const file of batch.files) {
    const { data, error } = await storage.download(file.path);
    if (error || !data) throw new UploadError("UPLOAD_INCOMPLETE", 503);
    if (data.size !== file.size || data.type.split(";")[0] !== file.type) throw new UploadError("UPLOAD_INVALID_FILE", 422);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!matchesDocumentSignature(bytes, file.type) || digest !== file.sha256) throw new UploadError("UPLOAD_INVALID_FILE", 422);
    checks[file.versionId] = digest;
  }
  // No storage deletion, and no independently committed case/request changes.
  return rpc("case_documents_commit", { target_case: caseId, target_batch: batchId, target_checks: checks });
}

export function cancelUpload(caseId: string, batchId: string): Promise<UploadSnapshot> {
  return rpc("case_documents_cancel", { target_case: caseId, target_batch: batchId });
}

export function uploadErrorResponse(error: unknown): { error: string; code: string; status: number } {
  const code = error instanceof UploadError ? error.code : "UPLOAD_UNAVAILABLE";
  const messages: Record<string, string> = {
    UPLOAD_FORBIDDEN: "אין הרשאה להעלאה לתיק הזה. יש לפתוח מחדש את התיק.",
    UPLOAD_CONFLICT: "המסמכים בתיק השתנו או שהמקום תפוס בהעלאה אחרת. יש לרענן ולבחור שוב.",
    UPLOAD_LIMIT: "אין מקום פנוי להעלאה. אפשר לשמור עד 12 תלושים, חוזה ודוח נוכחות, ועד 25MB לתיק.",
    UPLOAD_EXPIRED: "ניסיון ההעלאה פג. אפשר לבטל אותו ולבחור שוב את הקבצים.",
    UPLOAD_CANCELLED: "ניסיון ההעלאה בוטל. אפשר לבחור שוב את הקבצים.",
    UPLOAD_REQUEST_CONFLICT: "בקשת ההשלמה השתנתה או שאינה מתאימה למסמך. יש לרענן את התיק.",
    UPLOAD_INVALID_FILE: "הקובץ שהתקבל אינו תואם לקובץ שנבחר. אפשר לבטל את הניסיון ולהעלות שוב.",
    UPLOAD_PAYSLIP_REQUIRED: "צריך לשמור לפחות תלוש שכר אחד בתיק.",
    UPLOAD_MONTH_LOCKED: "חודש הבדיקה כבר נקבע בתשלום. אפשר להוסיף מסמכים בלי לשנות אותו.",
    UPLOAD_MONTH_MISSING: "חודש הבדיקה חייב להתאים לתלוש שיישאר בתיק.",
  };
  return { error: messages[code] ?? "ההעלאה לא הושלמה. המסמכים השמורים נשמרו; אפשר לנסות שוב.", code, status: error instanceof UploadError ? error.status : 503 };
}
