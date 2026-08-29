import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { bindingLevelSchema, legalDateSchema, legalSourceStatusSchema } from "../../../engine/legal-knowledge/contracts.ts";
import { legalSectorSchema, legalTopicSchema } from "../../../engine/legal-knowledge/taxonomy.ts";

export const legalCoverageMatrixSchema = z.object({
  schema_version: z.literal("legal-coverage-matrix-v0.1"),
  coverage_window: z.object({
    from: legalDateSchema,
    to: legalDateSchema,
    timezone: z.literal("Asia/Jerusalem"),
    basis: z.literal("engineering_corpus_boundary_only"),
    approved_legal_scope_document: z.null(),
    legal_limitation_or_entitlement_statement: z.literal(false),
  }).strict(),
  corpus_status: z.literal("LEGAL_SOURCE_CORPUS_INCOMPLETE"),
  rows: z.array(z.object({
    topic: legalTopicSchema,
    effective_from: legalDateSchema,
    effective_to: legalDateSchema,
    sector: legalSectorSchema,
    source_version_id: z.string().nullable(),
    binding_level: bindingLevelSchema.nullable(),
    issuing_authority: z.string().nullable(),
    review_status: legalSourceStatusSchema.nullable(),
    coverage_status: z.enum(["candidate_needs_review", "gap", "blocked", "conflict"]),
    reason_codes: z.array(z.string().min(1)).min(1),
  }).strict()).min(7),
}).strict().superRefine((matrix, context) => {
  if (matrix.coverage_window.from > matrix.coverage_window.to) context.addIssue({ code: "custom", message: "coverage_window_inverted" });
});

export const defaultLegalCoverageMatrixPath = path.resolve(
  "src",
  "server",
  "engine",
  "legal-knowledge",
  "legal-coverage.v0.1.json",
);

export async function loadLegalCoverageMatrix(filePath = defaultLegalCoverageMatrixPath) {
  return legalCoverageMatrixSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}
