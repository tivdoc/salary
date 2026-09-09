import {z} from 'zod';

// Public, bounded error vocabulary only. This pure contract imports no SDK,
// runtime configuration, transport or server-only implementation.
export const openAiExtractionErrorCodeSchema=z.enum([
 'openai_not_configured','unsupported_document','provider_timeout','provider_rate_limit',
 'provider_authentication_failed','provider_permission_denied','provider_model_unavailable',
 'provider_input_rejected','provider_connection_failed','provider_invalid_response',
 'provider_source_page_mismatch','structured_output_validation_failed','local_mapping_validation_failed','local_mapping_failed','extraction_failed',
]);
export type OpenAiExtractionErrorCode=z.infer<typeof openAiExtractionErrorCodeSchema>;
