import "server-only";
import type {OpenAiExtractionErrorCode} from './error-contract';
export {openAiExtractionErrorCodeSchema} from './error-contract';
export type {OpenAiExtractionErrorCode} from './error-contract';

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
}

/** Called only after the provider's structured contract has parsed. The bounded
 * code distinguishes a local mapping failure without serializing error text,
 * raw fields, or misclassifying a local exception as a provider outage. */
export function classifyOpenAiMappingError(error:unknown):OpenAiExtractionErrorCode{
 return errorRecord(error).name==='ZodError'?'local_mapping_validation_failed':'local_mapping_failed';
}

export function classifyOpenAiError(error: unknown): OpenAiExtractionErrorCode {
  const record = errorRecord(error);
  const status = typeof record.status === "number" ? record.status : null;
  const name = typeof record.name === "string" ? record.name : "";
  const code = typeof record.code === "string" ? record.code : "";
  if (status === 429 || name === "RateLimitError") return "provider_rate_limit";
  if (status === 401 || name === "AuthenticationError") return "provider_authentication_failed";
  if (status === 403 || name === "PermissionDeniedError") return "provider_permission_denied";
  if (status === 404 || code === "model_not_found") return "provider_model_unavailable";
  if (status === 400 || status === 413 || status === 422) return "provider_input_rejected";
  if (name === "APITimeoutError" || name === "APIConnectionTimeoutError" || code === "ETIMEDOUT" || code === "ECONNABORTED") return "provider_timeout";
  if (name === "APIConnectionError") return "provider_connection_failed";
  if (name === "ZodError" || name === "SyntaxError") return "structured_output_validation_failed";
  return "extraction_failed";
}
