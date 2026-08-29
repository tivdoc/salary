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
    status: domainCodeSchema.optional(),
    provider_id: domainCodeSchema.optional(),
    extractor_version: z.string().trim().min(1).max(120).optional(),
    model_version: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    provider_response_id: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_-]+$/).optional(),
    duration_ms: z.number().int().nonnegative().safe().optional(),
    input_tokens: z.number().int().nonnegative().safe().optional(),
    output_tokens: z.number().int().nonnegative().safe().optional(),
    total_tokens: z.number().int().nonnegative().safe().optional(),
    error_code: domainCodeSchema.optional(),
    retry_count: z.number().int().nonnegative().safe().optional(),
    pass_kind: z.enum(["first_pass", "targeted_recovery"]).optional(),
    prompt_version: domainCodeSchema.optional(),
    requested_field_count: z.number().int().nonnegative().safe().optional(),
    region_count: z.number().int().nonnegative().safe().optional(),
    provider_call_count: z.number().int().nonnegative().safe().optional(),
    preprocessing_version: domainCodeSchema.optional(),
  })
  .strict();

export type SafeEngineLog = Readonly<z.infer<typeof safeEngineLogSchema>>;

export function toSafeEngineLog(input: unknown): SafeEngineLog {
  return safeEngineLogSchema.parse(input);
}
