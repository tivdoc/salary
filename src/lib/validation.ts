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

// S2.2: a slot is what makes two payslips two documents rather than one
// overwriting the other. Twelve payslip slots is a year, which is the most the
// full report covers.
export const MAX_PAYSLIPS = 12;
export const payslipSlots = Array.from({ length: MAX_PAYSLIPS }, (_, index) => `payslip-${String(index + 1).padStart(2, "0")}`) as readonly string[];
export const documentSlots = [...payslipSlots, "contract", "attendance"] as const;
export type DocumentSlot = string;

/** The slot a document type belongs in: a payslip takes the first free payslip slot, the others have one each. */
export function slotForDocumentType(documentType: DocumentType, index = 0): DocumentSlot {
  return documentType === "payslip" ? `payslip-${String(index + 1).padStart(2, "0")}` : documentType;
}

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "חודש לא תקין");

export const uploadFileSchema = z.object({
  documentType: z.enum(documentTypes),
  slot: z.string().regex(/^(payslip-(0[1-9]|1[0-2])|contract|attendance)$/u),
  name: z.string().trim().min(1).max(240),
  type: z.enum(acceptedDocumentMimeTypes),
  size: z.number().int().positive().max(MAX_FILE_SIZE),
  /** The month a payslip covers. Absent for a contract or an attendance report. */
  periodMonth: monthSchema.optional(),
});

export const uploadManifestSchema = z
  .object({
    files: z.array(uploadFileSchema).min(1).max(MAX_PAYSLIPS + 2),
    /** S2.2 / D-4.1: the single month the initial check runs on. */
    checkPeriodMonth: monthSchema.optional(),
  })
  .superRefine(({ files, checkPeriodMonth }, context) => {
    if (!files.some((file) => file.documentType === "payslip")) {
      context.addIssue({ code: "custom", message: "צריך לצרף לפחות תלוש שכר אחד" });
    }

    // A slot holds one file. Two files in one slot is the overwrite this wave removed.
    if (new Set(files.map((file) => file.slot)).size !== files.length) {
      context.addIssue({ code: "custom", message: "כל קובץ תופס מקום משלו" });
    }

    for (const file of files) {
      if (file.slot !== slotForDocumentType(file.documentType, Number(file.slot.slice(-2)) - 1)) {
        context.addIssue({ code: "custom", message: "סוג הקובץ אינו מתאים למקום שלו" });
      }
      if (file.documentType !== "payslip" && file.periodMonth !== undefined) {
        context.addIssue({ code: "custom", message: "חודש נרשם לתלוש בלבד" });
      }
    }

    // The check month must be a month the customer actually uploaded a payslip for:
    // an initial check on a month with no payslip would have nothing to read.
    if (checkPeriodMonth !== undefined) {
      const months = files.filter((file) => file.documentType === "payslip").map((file) => file.periodMonth);
      if (!months.includes(checkPeriodMonth)) {
        context.addIssue({ code: "custom", message: "חודש הבדיקה חייב להיות חודש שהעלית עבורו תלוש" });
      }
    }

    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_SIZE) {
      context.addIssue({ code: "custom", message: "סך הקבצים גדול מ-25MB" });
    }
  });

/** The last complete month — the default month the initial check runs on. */
export function lastCompleteMonth(now: Date = new Date()): string {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

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

/** S2.2: the file's name in storage is its SLOT, so a second payslip cannot land on the first. */
export function storageBaseName(slot: DocumentSlot) {
  return slot;
}
