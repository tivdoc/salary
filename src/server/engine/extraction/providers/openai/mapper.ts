import "server-only";
import { createHash } from "node:crypto";
import { extractionResultSchema, type ExtractionRequest, type ExtractionResult } from "@/engine/extraction/contracts";
import type { OpenAiExtractionErrorCode } from "./errors";
import { openAiPayslipStructuredOutputSchema, type OpenAiPayslipStructuredOutput } from "./schema";

type ModelConfidence = OpenAiPayslipStructuredOutput["fields"][number]["confidence"];

const modelConfidence = { high: 0.94, medium: 0.72, low: 0.42 } as const;
const qualityConfidence = { high: 0.96, medium: 0.76, low: 0.48 } as const;

function uuidFrom(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function candidateConfidence(
  confidence: ModelConfidence,
  documentQuality: OpenAiPayslipStructuredOutput["document_quality"],
  warningCount: number,
) {
  const warningPenalty = Math.min(0.3, warningCount * 0.1);
  return Math.max(0, Math.min(modelConfidence[confidence], qualityConfidence[documentQuality]) - warningPenalty);
}

function source(input: {
  documentId: string;
  page: number | null;
  sourceLabel: string | null;
  rawValue?: string | null;
}) {
  const fragment = input.sourceLabel === null
    ? null
    : `${input.sourceLabel}${input.rawValue ? `: ${input.rawValue}` : ""}`.slice(0, 500);
  return {
    document_id: input.documentId,
    page: input.page ?? 1,
    ...(fragment ? { text_fragment: fragment } : {}),
  };
}

export function mapOpenAiOutputToExtractionResult(input: {
  request: ExtractionRequest;
  output: OpenAiPayslipStructuredOutput;
  model: string;
  extractorVersion: string;
  durationMs: number;
  providerResponseId: string;
  tokenUsage: { input_tokens: number; output_tokens: number; total_tokens: number } | null;
  extractedAt: string;
}) {
  const output = openAiPayslipStructuredOutputSchema.parse(input.output);
  const documentId = input.request.document.document_id;
  const extractedFields = output.fields.flatMap((field, index) => field.raw_value === null ? [] : [{
    candidate_id: uuidFrom(`${input.request.extraction_id}:field:${index}:${field.field}`),
    field: field.field,
    raw_value: field.raw_value,
    confidence: candidateConfidence(field.confidence, output.document_quality, field.warnings.length),
    source: source({
      documentId,
      page: field.evidence.page,
      sourceLabel: field.evidence.source_label,
      rawValue: field.raw_value,
    }),
    extraction_method: "ai_vision" as const,
    warning_flags: field.warnings,
  }]);
  const fields: ExtractionResult["fields"] = [{
    candidate_id: uuidFrom(`${input.request.extraction_id}:document-type`),
    field: "document_type",
    raw_value: output.detected_document_type,
    confidence: qualityConfidence[output.document_quality],
    source: source({ documentId, page: 1, sourceLabel: "document type" }),
    extraction_method: "ai_vision" as const,
    warning_flags: [],
  }, ...extractedFields];

  const additionalComponents = output.additional_components.flatMap((component, index) => {
    if (component.quantity_raw === null && component.rate_raw === null && component.amount_raw === null) return [];
    return [{
      component_id: uuidFrom(`${input.request.extraction_id}:component:${index}`),
      source_label: component.source_label,
      normalized_label: null,
      quantity_raw: component.quantity_raw,
      rate_raw: component.rate_raw,
      amount_raw: component.amount_raw,
      confidence: candidateConfidence(component.confidence, output.document_quality, component.warnings.length),
      source: source({
        documentId,
        page: component.evidence.page,
        sourceLabel: component.evidence.source_label ?? component.source_label,
        rawValue: component.amount_raw ?? component.quantity_raw ?? component.rate_raw,
      }),
      extraction_method: "ai_vision" as const,
      warning_flags: component.warnings,
    }];
  });

  const sensitiveMetadata = output.sensitive_metadata.flatMap((metadata, index) => metadata.raw_value === null ? [] : [{
    metadata_id: uuidFrom(`${input.request.extraction_id}:sensitive:${index}:${metadata.kind}`),
    kind: metadata.kind,
    raw_value: metadata.raw_value,
    confidence: candidateConfidence(metadata.confidence, output.document_quality, metadata.warnings.length),
    source: source({
      documentId,
      page: metadata.evidence.page,
      sourceLabel: metadata.evidence.source_label,
      rawValue: metadata.raw_value,
    }),
    extraction_method: "ai_vision" as const,
  }]);

  return extractionResultSchema.parse({
    extraction_id: input.request.extraction_id,
    document_id: documentId,
    status: fields.length > 1 ? "completed" : "partial",
    detected_document_type: output.detected_document_type,
    document_quality_confidence: qualityConfidence[output.document_quality],
    quality_metrics: {
      page_count: output.page_count,
      text_coverage: null,
      rotation_degrees: output.rotation_degrees,
      source_resolution_dpi: output.source_resolution_dpi,
    },
    fields,
    additional_components: additionalComponents,
    sensitive_metadata: sensitiveMetadata,
    earnings_components_complete: output.earnings_components_complete,
    warnings: output.warnings,
    provider: { provider_id: "openai", extractor_version: input.extractorVersion, model_version: input.model },
    operation: {
      duration_ms: input.durationMs,
      provider_response_id: input.providerResponseId,
      token_usage: input.tokenUsage,
    },
    extracted_at: input.extractedAt,
    error_code: null,
  });
}

export function createFailedOpenAiExtractionResult(input: {
  request: ExtractionRequest;
  model: string;
  extractorVersion: string;
  durationMs: number;
  errorCode: OpenAiExtractionErrorCode;
  extractedAt: string;
}) {
  return extractionResultSchema.parse({
    extraction_id: input.request.extraction_id,
    document_id: input.request.document.document_id,
    status: "failed",
    detected_document_type: "unknown",
    document_quality_confidence: 0,
    quality_metrics: { page_count: 1, text_coverage: null, rotation_degrees: null, source_resolution_dpi: null },
    fields: [],
    additional_components: [],
    sensitive_metadata: [],
    earnings_components_complete: false,
    warnings: [],
    provider: { provider_id: "openai", extractor_version: input.extractorVersion, model_version: input.model },
    operation: { duration_ms: input.durationMs, provider_response_id: null, token_usage: null },
    extracted_at: input.extractedAt,
    error_code: input.errorCode,
  });
}
