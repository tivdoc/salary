import "server-only";
import OpenAI from "openai";
import type { OpenAiResponsesRequest } from "./request";
import type { OpenAiPayslipStructuredOutput } from "./schema";

export type OpenAiTransportResponse = Readonly<{
  id: string;
  status: string;
  outputParsed: OpenAiPayslipStructuredOutput | null;
  usage: Readonly<{
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }> | null;
}>;

export interface OpenAiResponsesTransport {
  parse(request: OpenAiResponsesRequest): Promise<OpenAiTransportResponse>;
}

export function createOpenAiSdkTransport(input: {
  apiKey: string;
  timeoutMs: number;
}): OpenAiResponsesTransport {
  const client = new OpenAI({ apiKey: input.apiKey, timeout: input.timeoutMs, maxRetries: 0 });
  return {
    async parse(request) {
      const response = await client.responses.parse(request);
      return {
        id: response.id,
        status: response.status ?? "failed",
        outputParsed: response.output_parsed,
        usage: response.usage == null
          ? null
          : {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              total_tokens: response.usage.total_tokens,
            },
      };
    },
  };
}
