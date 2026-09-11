import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { matchesDocumentSignature, type DocumentUpload, type UploadSnapshot } from "@/lib/document-upload";
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db";
import { reviewUploadReceiptSchema, reviewUploadScopeSchema, type ReviewUploadReceipt, type ReviewUploadScope } from "./review-fulfillment";

export class UploadError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
export type ReservedFile = DocumentUpload["files"][number] & {
  documentId: string; versionId: string; path: string; slot: string;
};
export type UploadBatch = { id: string; case_id: string; files: ReservedFile[]; completed_at: string | null; cancelled_at: string | null; expires_at: string; review_scope?: ReviewUploadScope | null };
export type ReviewUploadSnapshot = UploadSnapshot & { reviewReceipts?: ReviewUploadReceipt[] };

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

function batchReviewScope(caseId: string, batch: UploadBatch, requestId?: string) {
  if (batch.review_scope == null) return null;
  const parsed = reviewUploadScopeSchema.safeParse(batch.review_scope);
  if (!parsed.success) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
  if (batch.case_id !== caseId || parsed.data.request.target.case_id !== caseId || requestId !== undefined && parsed.data.request_id !== requestId) throw new UploadError("UPLOAD_FORBIDDEN", 403);
  return parsed.data;
}
function reviewSnapshot(caseId: string, snapshot: ReviewUploadSnapshot, expected?: { scope: ReviewUploadScope; batchId: string; files: ReservedFile[] }): ReviewUploadSnapshot {
  const receipts = snapshot.reviewReceipts;
  if (receipts !== undefined) {
    if (!Array.isArray(receipts)) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    const parsed = receipts.map(r => reviewUploadReceiptSchema.safeParse(r));
    if (parsed.some(r => !r.success)) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    if (receipts.some(r => r.case_id !== caseId)) throw new UploadError("UPLOAD_FORBIDDEN", 403);
  }
  if (expected) {
    const matches = (receipts ?? []).filter(r => r.batch_id === expected.batchId && r.request_id === expected.scope.request_id);
    if (matches.length !== 1 || matches[0].target_sha256 !== expected.scope.request.target.target_sha256
      || matches[0].order_id !== expected.scope.order_id || matches[0].order_origin !== expected.scope.order_origin
      || matches[0].order_receipt_sha256 !== expected.scope.order_receipt_sha256) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    const submitted = expected.files.filter(f => f.documentType === expected.scope.request.target.document_kind);
    if (matches[0].files.length !== submitted.length || matches[0].files.some(f => !submitted.some(s =>
      s.documentId === f.document_id && s.versionId === f.version_id && s.sha256 === f.source_sha256
      && s.documentType === f.document_kind && (s.periodMonth ?? null) === f.period_month))) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
  }
  return snapshot;
}
export async function uploadSnapshot(caseId: string, db?: CaseAccessDb): Promise<ReviewUploadSnapshot> {
  return reviewSnapshot(caseId, await rpc("case_documents_snapshot", { target_case: caseId }, db));
}

export async function prepareUpload(manifest: DocumentUpload) {
  const batch = await rpc<UploadBatch>("case_documents_reserve", {
    target_case: manifest.caseId, target_batch: manifest.batchId, target_manifest: manifest,
  });
  batchReviewScope(manifest.caseId, batch, manifest.requestId);
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

export async function completeUpload(caseId: string, batchId: string): Promise<ReviewUploadSnapshot> {
  const batch = await rpc<UploadBatch>("case_documents_batch", { target_case: caseId, target_batch: batchId });
  const scope = batchReviewScope(caseId, batch);
  const expected = scope ? { scope, batchId, files: batch.files } : undefined;
  if (batch.completed_at) return reviewSnapshot(caseId, await uploadSnapshot(caseId), expected);
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
  return reviewSnapshot(caseId, await rpc("case_documents_commit", { target_case: caseId, target_batch: batchId, target_checks: checks }), expected);
}

export function cancelUpload(caseId: string, batchId: string): Promise<UploadSnapshot> {
  return rpc("case_documents_cancel", { target_case: caseId, target_batch: batchId });
}

export function uploadErrorResponse(error: unknown): { error: string; code: string; status: number } {
  const code = error instanceof UploadError ? error.code : "UPLOAD_UNAVAILABLE";
  const messages: Record<string, string> = {
    UPLOAD_FORBIDDEN: "אין הרשאה להעלאה לתיק הזה. יש לפתוח מחדש את התיק.",
    UPLOAD_CONFLICT: "המסמכים בתיק השתנו או שהמקום תפוס בהעלאה אחרת. יש לרענן ולבחור שוב.",
    UPLOAD_LIMIT: "ההעלאה חורגת ממגבלת הקבצים או הנפח הזמינה. יש לרענן ולבדוק את מגבלות התיק וההעלאה.",
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
