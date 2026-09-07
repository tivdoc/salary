import { z } from "zod";
import { acceptedDocumentMimeTypes, documentTypes, MAX_FILE_SIZE, MAX_PAYSLIPS, MAX_UPLOAD_SIZE } from "./validation";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export const documentUploadSchema = z.object({
  caseId: z.uuid(),
  batchId: z.uuid(),
  requestId: z.uuid().optional(),
  checkPeriodMonth: month.optional(),
  files: z.array(z.object({
    clientId: z.uuid(),
    documentType: z.enum(documentTypes),
    name: z.string().trim().min(1).max(240),
    type: z.enum(acceptedDocumentMimeTypes),
    size: z.number().int().positive().max(MAX_FILE_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    periodMonth: month.optional(),
    replace: z.object({ documentId: z.uuid(), versionId: z.uuid() }).strict().optional(),
  }).strict()).min(1).max(MAX_PAYSLIPS + 2),
}).strict().superRefine(({ files }, ctx) => {
  if (new Set(files.map((file) => file.clientId)).size !== files.length) ctx.addIssue({ code: "custom", message: "קובץ מופיע פעמיים" });
  const targets = files.flatMap((file) => file.replace ? [file.replace.documentId] : []);
  if (new Set(targets).size !== targets.length) ctx.addIssue({ code: "custom", message: "אפשר להחליף מסמך פעם אחת בכל העלאה" });
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_SIZE) ctx.addIssue({ code: "custom", message: "סך הקבצים גדול מ-25MB" });
  for (const file of files) {
    if (file.documentType === "payslip" && !file.periodMonth) ctx.addIssue({ code: "custom", message: "יש לבחור חודש לתלוש" });
    if (file.documentType !== "payslip" && file.periodMonth) ctx.addIssue({ code: "custom", message: "חודש נרשם לתלוש בלבד" });
  }
});

export const documentCompletionSchema = z.object({
  caseId: z.uuid(), batchId: z.uuid(), action: z.enum(["commit", "cancel"]).default("commit"),
}).strict();
export type DocumentUpload = z.infer<typeof documentUploadSchema>;
export type SavedDocument = {
  id: string; version_id: string; document_type: "payslip" | "contract" | "attendance";
  slot: string; original_filename: string; mime_type: string; size: number; period_month: string | null;
};
export type UploadSnapshot = {
  caseId: string; publicId: string; status: string; paymentStatus: string;
  checkPeriodMonth: string | null; documents: SavedDocument[];
  requests: { id: string; code: string; question: string; documentType: string }[];
};

/** File type is checked from bytes at completion, as well as the storage metadata. */
export function matchesDocumentSignature(bytes: Uint8Array, mime: string): boolean {
  const signatures: Record<string, number[]> = {
    "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
    "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "image/jpeg": [0xff, 0xd8, 0xff],
  };
  return signatures[mime]?.every((byte, index) => bytes[index] === byte) ?? false;
}

export function uploadNextPath(snapshot: Pick<UploadSnapshot, "status" | "paymentStatus" | "publicId">): string {
  return ["payment_pending", "paid", "under_review", "completed"].includes(snapshot.status)
    || ["pending", "paid", "verified", "refunded"].includes(snapshot.paymentStatus)
    ? `/case/${snapshot.publicId}/documents` : "/check/payment";
}
