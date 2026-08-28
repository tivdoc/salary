import "server-only";
import { z } from "zod";
import { domainCodeSchema, isoTimestampSchema, uuidSchema } from "@/engine/domain/primitives";

export const safeEngineLogSchema = z
  .object({
    event: domainCodeSchema,
    timestamp: isoTimestampSchema,
    case_id: uuidSchema.optional(),
    analysis_run_id: uuidSchema.optional(),
    document_id: uuidSchema.optional(),
    extraction_id: uuidSchema.optional(),
    job_id: uuidSchema.optional(),
    stage: domainCodeSchema.optional(),
    duration_ms: z.number().int().nonnegative().safe().optional(),
    error_code: domainCodeSchema.optional(),
    retry_count: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export type SafeEngineLog = Readonly<z.infer<typeof safeEngineLogSchema>>;

export function toSafeEngineLog(input: unknown): SafeEngineLog {
  return safeEngineLogSchema.parse(input);
}
