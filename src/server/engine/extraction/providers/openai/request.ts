import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import { openAiPayslipStructuredOutputSchema } from "./schema";
import {
  OPENAI_PAYSLIP_EXTRACTION_INSTRUCTIONS,
  OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION,
  OPENAI_PAYSLIP_EXTRACTION_USER_TEXT,
} from "./prompt";

export const supportedOpenAiDocumentMimeTypes = ["application/pdf", "image/jpeg", "image/png"] as const;
export type SupportedOpenAiDocumentMimeType = typeof supportedOpenAiDocumentMimeTypes[number];

export function isSupportedOpenAiDocumentMimeType(value: string): value is SupportedOpenAiDocumentMimeType {
  return supportedOpenAiDocumentMimeTypes.includes(value as SupportedOpenAiDocumentMimeType);
}

function dataUrl(mimeType: SupportedOpenAiDocumentMimeType, bytes: Uint8Array) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function buildOpenAiResponsesRequest(input: {
  model: string;
  mimeType: SupportedOpenAiDocumentMimeType;
  bytes: Uint8Array;
}) {
  const documentInput = input.mimeType === "application/pdf"
    ? {
        type: "input_file" as const,
        filename: "synthetic-payslip.pdf",
        file_data: dataUrl(input.mimeType, input.bytes),
      }
    : {
        type: "input_image" as const,
        image_url: dataUrl(input.mimeType, input.bytes),
        detail: "high" as const,
      };
  return {
    model: input.model,
    instructions: OPENAI_PAYSLIP_EXTRACTION_INSTRUCTIONS,
    input: [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: OPENAI_PAYSLIP_EXTRACTION_USER_TEXT },
          documentInput,
        ],
      },
    ],
    text: {
      format: zodTextFormat(openAiPayslipStructuredOutputSchema, OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION),
    },
    max_output_tokens: 8_000,
    store: false,
  };
}

export type OpenAiResponsesRequest = ReturnType<typeof buildOpenAiResponsesRequest>;
