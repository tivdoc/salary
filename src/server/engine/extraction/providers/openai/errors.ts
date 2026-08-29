import "server-only";
import { z } from "zod";

export const openAiExtractionErrorCodeSchema = z.enum([
  "openai_not_configured",
  "unsupported_document",
  "provider_timeout",
  "provider_rate_limit",
  "provider_invalid_response",
  "structured_output_validation_failed",
  "extraction_failed",
]);

export type OpenAiExtractionErrorCode = z.infer<typeof openAiExtractionErrorCodeSchema>;

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
}

export function classifyOpenAiError(error: unknown): OpenAiExtractionErrorCode {
  const record = errorRecord(error);
  const status = typeof record.status === "number" ? record.status : null;
  const name = typeof record.name === "string" ? record.name : "";
  const code = typeof record.code === "string" ? record.code : "";
  if (status === 429 || name === "RateLimitError") return "provider_rate_limit";
  if (name === "APITimeoutError" || code === "ETIMEDOUT" || code === "ECONNABORTED") return "provider_timeout";
  if (name === "ZodError" || name === "SyntaxError") return "structured_output_validation_failed";
  return "extraction_failed";
}
