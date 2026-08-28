import { z } from "zod";
import { dateRangeSchema, domainCodeSchema, isoTimestampSchema, uuidSchema } from "./primitives";

export const immutableDocumentSchema = z
  .object({
    document_id: uuidSchema,
    case_id: uuidSchema,
    document_type: domainCodeSchema,
    original_filename: z.string().trim().min(1).max(240),
    mime_type: z.string().trim().min(1).max(120),
    size_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    storage_path: z.string().trim().min(1).max(1_000),
    document_period: dateRangeSchema.nullable(),
    supersedes_document_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((document, context) => {
    const expectedPrefix = `cases/${document.case_id}/documents/${document.document_id}/original.`;
    if (!document.storage_path.startsWith(expectedPrefix)) {
      context.addIssue({
        code: "custom",
        message: `Immutable document paths must start with ${expectedPrefix}`,
        path: ["storage_path"],
      });
    }
    if (document.supersedes_document_id === document.document_id) {
      context.addIssue({
        code: "custom",
        message: "A document cannot supersede itself",
        path: ["supersedes_document_id"],
      });
    }
  });

export type ImmutableDocument = Readonly<z.infer<typeof immutableDocumentSchema>>;
