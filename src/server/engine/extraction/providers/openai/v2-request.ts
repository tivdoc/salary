import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import type { PayslipFieldKey } from "@/engine/extraction/contracts";
import type { PreparedPayslipDocument } from "../../preprocessing";
import { openAiPayslipV2StructuredOutputSchema } from "./v2-schema";
import {
  OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
  OPENAI_PAYSLIP_V2_INSTRUCTIONS,
  OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
  v2FirstPassUserText,
  v2RecoveryUserText,
} from "./v2-prompt";

function dataUrl(mimeType: string, bytes: Uint8Array) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function buildOpenAiV2ResponsesRequest(input: {
  model: string;
  prepared: PreparedPayslipDocument;
  kind: "first_pass" | "targeted_recovery";
  requested_fields?: readonly PayslipFieldKey[];
}) {
  const text = input.kind === "first_pass"
    ? v2FirstPassUserText()
    : v2RecoveryUserText(input.requested_fields ?? []);
  const originalInput = input.prepared.original.mime_type === "application/pdf"
    ? {
        type: "input_file" as const,
        filename: "payslip.pdf",
        file_data: dataUrl(input.prepared.original.mime_type, input.prepared.original.bytes),
        detail: "high" as const,
      }
    : {
        type: "input_image" as const,
        image_url: dataUrl(input.prepared.original.mime_type, input.prepared.original.bytes),
        detail: "high" as const,
      };
  const cropInputs = input.prepared.crops.flatMap((crop) => [
    { type: "input_text" as const, text: `High-resolution ${crop.region} crop:` },
    {
      type: "input_image" as const,
      image_url: dataUrl(crop.image.mime_type, crop.image.bytes),
      detail: "high" as const,
    },
  ]);
  const promptVersion = input.kind === "first_pass"
    ? OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION
    : OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION;
  return {
    model: input.model,
    instructions: OPENAI_PAYSLIP_V2_INSTRUCTIONS,
    input: [{
      role: "user" as const,
      content: [
        { type: "input_text" as const, text },
        { type: "input_text" as const, text: "Original full-page document:" },
        originalInput,
        ...cropInputs,
      ],
    }],
    text: { format: zodTextFormat(openAiPayslipV2StructuredOutputSchema, promptVersion) },
    max_output_tokens: 10_000,
    store: false,
  };
}

export type OpenAiV2ResponsesRequest = ReturnType<typeof buildOpenAiV2ResponsesRequest>;
