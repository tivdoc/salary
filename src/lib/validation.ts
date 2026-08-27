import { z } from "zod";
import { firstTouchSchema } from "./funnel-validation";

export const questionnaireSchema = z.object({
  firstName: z.string().trim().min(2, "נא להזין שם פרטי").max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\-\s]{7,16}$/, "נא להזין מספר טלפון תקין"),
  email: z.email("נא להזין כתובת אימייל תקינה").max(180),
  stillEmployed: z.boolean(),
  salaryType: z.enum(["monthly", "hourly"]),
  typicalHoursPerDay: z.coerce.number().min(1).max(18),
  workDaysPerWeek: z.coerce.number().int().min(1).max(7),
  worksFriday: z.boolean(),
  worksSaturday: z.boolean(),
  payslipAvailable: z.boolean(),
  suspectedIssue: z.string().trim().max(500).optional().default(""),
  attribution: firstTouchSchema.nullable().optional(),
});

export type QuestionnaireInput = z.infer<typeof questionnaireSchema>;

export const documentTypes = ["payslip", "contract", "attendance"] as const;
export type DocumentType = (typeof documentTypes)[number];

export const acceptedDocumentMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

export type UploadDescriptor = {
  name: string;
  type: string;
  size: number;
};

export const uploadFileSchema = z.object({
  documentType: z.enum(documentTypes),
  name: z.string().trim().min(1).max(240),
  type: z.enum(acceptedDocumentMimeTypes),
  size: z.number().int().positive().max(MAX_FILE_SIZE),
});

export const uploadManifestSchema = z
  .object({
    files: z.array(uploadFileSchema).min(1).max(3),
  })
  .superRefine(({ files }, context) => {
    if (!files.some((file) => file.documentType === "payslip")) {
      context.addIssue({ code: "custom", message: "צריך לצרף לפחות תלוש שכר אחד" });
    }

    if (new Set(files.map((file) => file.documentType)).size !== files.length) {
      context.addIssue({ code: "custom", message: "אפשר לצרף קובץ אחד מכל סוג" });
    }

    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_SIZE) {
      context.addIssue({ code: "custom", message: "סך הקבצים גדול מ-25MB" });
    }
  });

export type UploadManifest = z.infer<typeof uploadManifestSchema>;

export function validateUploadDescriptor(file: UploadDescriptor): string | null {
  if (!acceptedDocumentMimeTypes.includes(file.type as (typeof acceptedDocumentMimeTypes)[number])) {
    return "אפשר להעלות PDF, JPG או PNG בלבד";
  }

  if (file.size <= 0) return "הקובץ ריק";
  if (file.size > MAX_FILE_SIZE) return "הקובץ גדול מ-10MB";
  return null;
}

export function extensionForMimeType(mimeType: string) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  return "jpg";
}

export function storageBaseName(documentType: DocumentType) {
  if (documentType === "payslip") return "payslip-01";
  return documentType;
}
