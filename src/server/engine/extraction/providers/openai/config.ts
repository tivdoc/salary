import "server-only";
import { z } from "zod";

export const DEFAULT_OPENAI_EXTRACTION_MODEL = "gpt-5.6-sol";
export const DEFAULT_OPENAI_EXTRACTION_TIMEOUT_MS = 120_000;

const modelSchema = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export type OpenAiExtractionConfig = Readonly<{
  apiKey: string | null;
  model: string;
  timeoutMs: number;
}>;

export function resolveOpenAiExtractionConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OpenAiExtractionConfig {
  const apiKey = environment.OPENAI_API_KEY?.trim() || null;
  const model = modelSchema.parse(environment.OPENAI_EXTRACTION_MODEL?.trim() || DEFAULT_OPENAI_EXTRACTION_MODEL);
  const rawTimeout = environment.OPENAI_EXTRACTION_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout === undefined || rawTimeout === ""
    ? DEFAULT_OPENAI_EXTRACTION_TIMEOUT_MS
    : z.coerce.number().int().min(1_000).max(300_000).parse(rawTimeout);
  return { apiKey, model, timeoutMs };
}
