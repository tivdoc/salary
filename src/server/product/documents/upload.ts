import { createHash } from "node:crypto";
import {inspectSourcePhysicalPages} from './physical-pages';
import {sourceIntakeUploadScopeSchema,sourceIntakeUploadReceiptSchema,type SourceIntakeUploadScope,type SourceIntakeUploadReceipt} from './source-intake-upload';
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { matchesDocumentSignature, travelTariffEvidencePurposeSchema, type DocumentUpload, type UploadSnapshot } from "@/lib/document-upload";
import { resolveCaseAccessDb, type CaseAccessDb } from "../case-access/db";
import { isTravelTariffReviewUpload, reviewUploadReceiptSchema, reviewUploadScopeSchema, type ReviewUploadReceipt, type ReviewUploadScope } from "./review-fulfillment";

export class UploadError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
export type ReservedFile = DocumentUpload["files"][number] & {
  documentId: string; versionId: string; path: string; slot: string;
};
export type UploadBatch = { id: string; case_id: string; files: ReservedFile[]; completed_at: string | null; cancelled_at: string | null; expires_at: string; review_scope?: ReviewUploadScope | null;source_intake_scope?:SourceIntakeUploadScope|null };
export type ReviewUploadSnapshot = Omit<UploadSnapshot,'sourceIntakeReceipts'> & { reviewReceipts?: ReviewUploadReceipt[];sourceIntakeReceipts?:SourceIntakeUploadReceipt[] };

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
  if(batch.review_scope!=null&&batch.source_intake_scope!=null)throw new UploadError('UPLOAD_UNAVAILABLE',503);
  if (batch.review_scope == null) return null;
  const parsed = reviewUploadScopeSchema.safeParse(batch.review_scope);
  if (!parsed.success) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
  if (batch.case_id !== caseId || parsed.data.request.target.case_id !== caseId || requestId !== undefined && parsed.data.request_id !== requestId) throw new UploadError("UPLOAD_FORBIDDEN", 403);
  if (isTravelTariffReviewUpload(parsed.data.request.target)) {
    const files = batch.files.filter(file => file.documentType === "other");
    const purpose = travelTariffEvidencePurposeSchema.safeParse(files[0]?.evidencePurpose);
    const period = parsed.data.request.target.period;
    if (files.length !== 1 || files[0].type !== "application/pdf" || files[0].periodMonth !== undefined || !purpose.success
      || purpose.data.month !== period.from.slice(0, 7) || purpose.data.month !== period.to.slice(0, 7)) throw new UploadError("UPLOAD_REQUEST_CONFLICT");
  }
  return parsed.data;
}
function batchSourceIntakeScope(caseId:string,batch:UploadBatch,manifest?:DocumentUpload){
 if(batch.source_intake_scope==null){if(manifest?.sourceIntake)throw new UploadError('UPLOAD_REQUEST_CONFLICT');return null;}
 const parsed=sourceIntakeUploadScopeSchema.safeParse(batch.source_intake_scope);
 if(!parsed.success||batch.review_scope!=null)throw new UploadError('UPLOAD_UNAVAILABLE',503);
 const scope=parsed.data;if(batch.case_id!==caseId||scope.target.case_id!==caseId)throw new UploadError('UPLOAD_FORBIDDEN',403);
 if(manifest&&(!manifest.sourceIntake||manifest.sourceIntake.policy!==scope.target.policy_version||manifest.sourceIntake.target_sha256!==scope.target.target_sha256||manifest.requestId!==scope.request_id))throw new UploadError('UPLOAD_REQUEST_CONFLICT');
 if(batch.files.length<1||batch.files.length>14||batch.files.some(f=>!['payslip','attendance','contract'].includes(f.documentType)||f.periodMonth!==undefined||f.evidencePurpose!==undefined))throw new UploadError('UPLOAD_REQUEST_CONFLICT');
 return scope;
}
type ExpectedReviewUpload = { scope: ReviewUploadScope; batchId: string; files: ReservedFile[]; verifiedTariffPageCounts?: Readonly<Record<string, number>> };
type ExpectedSourceIntakeUpload={scope:SourceIntakeUploadScope;batchId:string;files:ReservedFile[];physicalPages?:Readonly<Record<string,number>>};
function reviewSnapshot(caseId: string, snapshot: ReviewUploadSnapshot, expected?: ExpectedReviewUpload,intake?:ExpectedSourceIntakeUpload): ReviewUploadSnapshot {
  if(snapshot.sourceIntakeReceipts!==undefined){
   if(!Array.isArray(snapshot.sourceIntakeReceipts))throw new UploadError('UPLOAD_UNAVAILABLE',503);
   for(const value of snapshot.sourceIntakeReceipts){const r=sourceIntakeUploadReceiptSchema.safeParse(value);if(!r.success)throw new UploadError('UPLOAD_UNAVAILABLE',503);if(r.data.case_id!==caseId)throw new UploadError('UPLOAD_FORBIDDEN',403);}
  }
  if(intake){
   const t=intake.scope.target,matches=(snapshot.sourceIntakeReceipts??[]).filter(r=>r.batch_id===intake.batchId&&r.request_id===intake.scope.request_id);
   if(matches.length!==1)throw new UploadError('UPLOAD_UNAVAILABLE',503);const r=matches[0];
   if(r.target_sha256!==t.target_sha256||r.order_id!==t.order_id||r.order_receipt_sha256!==t.order_receipt_sha256||r.month!==t.month||r.files.length!==intake.files.length
    ||r.files.some(f=>!intake.files.some(s=>s.documentId===f.document_id&&s.versionId===f.version_id&&s.sha256===f.source_sha256&&s.documentType===f.document_kind)
     ||intake.physicalPages!==undefined&&intake.physicalPages[f.version_id]!==f.page_count
     ||snapshot.documents.filter(d=>d.id===f.document_id&&d.version_id===f.version_id&&d.document_type===f.document_kind&&d.period_month===null).length!==1))throw new UploadError('UPLOAD_UNAVAILABLE',503);
  }
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
    const tariffScope = isTravelTariffReviewUpload(expected.scope.request.target), receipt = matches[0];
    if (tariffScope !== (receipt.schema_version === "document-review-upload-receipt-v2")) throw new UploadError("UPLOAD_UNAVAILABLE", 503);
    if (receipt.schema_version === "document-review-upload-receipt-v2") {
      const file = submitted[0], source = receipt.files[0].tariff_source;
      const purpose = travelTariffEvidencePurposeSchema.safeParse(file?.evidencePurpose);
      const period = expected.scope.request.target.period;
      const current = snapshot.documents.filter(document => document.id === file.documentId && document.version_id === file.versionId);
      const saved = current[0]?.evidence_purpose;
      // SQL authenticates purpose_sha256 against its immutable actor/purpose
      // receipt. This boundary independently binds the visible purpose and,
      // on first completion, the physical page count just parsed from bytes.
      if (!purpose.success || receipt.period.from !== period.from || receipt.period.to !== period.to
        || source.document.case_id !== caseId || source.document.month !== purpose.data.month
        || source.group.page !== purpose.data.page || source.group.locator !== purpose.data.locator
        || current.length !== 1 || current[0].document_type !== "other" || current[0].mime_type !== "application/pdf"
        || !saved || saved.kind !== purpose.data.kind || saved.month !== purpose.data.month || saved.page !== purpose.data.page
        || saved.locator !== purpose.data.locator || saved.page_count !== source.document.page_count
        || expected.verifiedTariffPageCounts !== undefined && expected.verifiedTariffPageCounts[file.versionId] !== source.document.page_count) {
        throw new UploadError("UPLOAD_UNAVAILABLE", 503);
      }
    }
  }
  return snapshot;
}
export async function uploadSnapshot(caseId: string, db?: CaseAccessDb): Promise<ReviewUploadSnapshot> {
  return reviewSnapshot(caseId, await rpc("case_documents_snapshot", { target_case: caseId }, db));
}

export async function prepareUpload(manifest: DocumentUpload) {
  let targetIdentity: string | undefined;
  if (manifest.sourceIntake||manifest.files.some(file => file.documentType === "other")) {
    const [{ readCaseSessionCookie }, { resolveIdentitySession }] = await Promise.all([
      import("../case-access/session-cookie"), import("../case-access/service"),
    ]);
    const identity = await resolveIdentitySession(await readCaseSessionCookie());
    if (!identity) throw new UploadError("UPLOAD_FORBIDDEN", 403);
    targetIdentity = identity.identity_id;
  }
  const batch = await rpc<UploadBatch>("case_documents_reserve", {
    target_case: manifest.caseId, target_batch: manifest.batchId, target_manifest: manifest,
    ...(targetIdentity ? { target_identity: targetIdentity } : {}),
  });
  if (targetIdentity && batch.case_id !== manifest.caseId) throw new UploadError("UPLOAD_FORBIDDEN", 403);
  batchReviewScope(manifest.caseId, batch, manifest.requestId);
  batchSourceIntakeScope(manifest.caseId,batch,manifest);
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
  if (batch.files.some(file => file.documentType === "other") && batch.case_id !== caseId) throw new UploadError("UPLOAD_FORBIDDEN", 403);
  const scope = batchReviewScope(caseId, batch);
  const intakeScope=batchSourceIntakeScope(caseId,batch),intake=intakeScope?{scope:intakeScope,batchId,files:batch.files}:undefined;
  const expected = scope ? { scope, batchId, files: batch.files } : undefined;
  if (batch.completed_at) return reviewSnapshot(caseId, await uploadSnapshot(caseId), expected,intake);
  if (batch.cancelled_at) throw new UploadError("UPLOAD_CANCELLED");
  if (Date.parse(batch.expires_at) <= Date.now()) throw new UploadError("UPLOAD_EXPIRED");
  const storage = getSupabaseAdmin().storage.from("salary-documents");
  const checks: Record<string, string | { page_count: number }> = {};
  const verifiedTariffPageCounts: Record<string, number> = {};
  const physicalPages:Record<string,number>={};
  for (const file of batch.files) {
    const { data, error } = await storage.download(file.path);
    if (error || !data) throw new UploadError("UPLOAD_INCOMPLETE", 503);
    if (data.size !== file.size || data.type.split(";")[0] !== file.type) throw new UploadError("UPLOAD_INVALID_FILE", 422);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!matchesDocumentSignature(bytes, file.type) || digest !== file.sha256) throw new UploadError("UPLOAD_INVALID_FILE", 422);
    checks[file.versionId] = digest;
    let pages:number;
    try{pages=await inspectSourcePhysicalPages(bytes,file.type);}catch{throw new UploadError('UPLOAD_INVALID_FILE',422);}
    checks[`physical:${file.versionId}`]={page_count:pages};physicalPages[file.versionId]=pages;
    if (file.documentType === "other") {
      const purpose = travelTariffEvidencePurposeSchema.safeParse(file.evidencePurpose);
      if (batch.case_id !== caseId || file.type !== "application/pdf" || file.periodMonth !== undefined || !purpose.success) throw new UploadError("UPLOAD_INVALID_FILE", 422);
      try {
        // Only the parsed physical page tree is trusted; browser hints and
        // /Type /Page text counts are not source-page evidence.
        if (purpose.data.page > pages) throw new UploadError("UPLOAD_INVALID_FILE", 422);
        checks[`purpose:${file.versionId}`] = { page_count: pages };
        verifiedTariffPageCounts[file.versionId] = pages;
      } catch (error) {
        if (error instanceof UploadError) throw error;
        throw new UploadError("UPLOAD_INVALID_FILE", 422);
      }
    }
  }
  // No storage deletion, and no independently committed case/request changes.
  return reviewSnapshot(caseId, await rpc("case_documents_commit", { target_case: caseId, target_batch: batchId, target_checks: checks }), expected ? { ...expected, verifiedTariffPageCounts } : undefined,intake?{...intake,physicalPages}:undefined);
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
