import "server-only";
import type { DocumentExtractor, PrivateDocumentSource } from "@/engine/extraction/provider";
import { extractionRequestSchema, type ExtractionRequest } from "@/engine/extraction/contracts";
import { toSafeEngineLog, type SafeEngineLog } from "@/server/engine/safe-logging";
import { resolveOpenAiExtractionConfig, type OpenAiExtractionConfig } from "./config";
import { classifyOpenAiError, type OpenAiExtractionErrorCode } from "./errors";
import { createFailedOpenAiExtractionResult, mapOpenAiOutputToExtractionResult } from "./mapper";
import { buildOpenAiResponsesRequest, isSupportedOpenAiDocumentMimeType } from "./request";
import { openAiPayslipStructuredOutputSchema } from "./schema";
import { createOpenAiSdkTransport, type OpenAiResponsesTransport } from "./transport";

export const OPENAI_PAYSLIP_EXTRACTOR_VERSION = "1.0";

type Clock = () => Date;
type DurationClock = () => number;
type SafeLogSink = (entry: SafeEngineLog) => void;

export class OpenAiDocumentExtractor implements DocumentExtractor {
  readonly providerId = "openai";
  readonly extractorVersion = OPENAI_PAYSLIP_EXTRACTOR_VERSION;

  private readonly transport: OpenAiResponsesTransport | null;
  private readonly clock: Clock;
  private readonly durationClock: DurationClock;
  private readonly log: SafeLogSink;

  constructor(
    private readonly config: OpenAiExtractionConfig,
    options: {
      transport?: OpenAiResponsesTransport;
      clock?: Clock;
      durationClock?: DurationClock;
      log?: SafeLogSink;
    } = {},
  ) {
    this.transport = options.transport ?? (config.apiKey
      ? createOpenAiSdkTransport({ apiKey: config.apiKey, timeoutMs: config.timeoutMs })
      : null);
    this.clock = options.clock ?? (() => new Date());
    this.durationClock = options.durationClock ?? (() => performance.now());
    this.log = options.log ?? (() => undefined);
  }

  private failed(request: ExtractionRequest, startedAt: number, code: OpenAiExtractionErrorCode) {
    const now = this.clock().toISOString();
    const durationMs = Math.max(0, Math.round(this.durationClock() - startedAt));
    const result = createFailedOpenAiExtractionResult({
      request,
      model: this.config.model,
      extractorVersion: this.extractorVersion,
      durationMs,
      errorCode: code,
      extractedAt: now,
    });
    this.log(toSafeEngineLog({
      event: "payslip_extraction",
      timestamp: now,
      case_id: request.case_id,
      analysis_run_id: request.analysis_run_id,
      document_id: request.document.document_id,
      extraction_id: request.extraction_id,
      stage: "document_extraction",
      status: "failed",
      provider_id: this.providerId,
      extractor_version: this.extractorVersion,
      model_version: this.config.model,
      duration_ms: durationMs,
      error_code: code,
    }));
    return result;
  }

  async extract(requestInput: ExtractionRequest, source: PrivateDocumentSource) {
    const request = extractionRequestSchema.parse(requestInput);
    const startedAt = this.durationClock();
    if (!this.transport) return this.failed(request, startedAt, "openai_not_configured");
    if (!isSupportedOpenAiDocumentMimeType(request.document.mime_type)) {
      return this.failed(request, startedAt, "unsupported_document");
    }

    try {
      const bytes = await source.read(request.document);
      if (bytes.byteLength === 0) return this.failed(request, startedAt, "unsupported_document");
      const response = await this.transport.parse(buildOpenAiResponsesRequest({
        model: this.config.model,
        mimeType: request.document.mime_type,
        bytes,
      }));
      const parsed = openAiPayslipStructuredOutputSchema.safeParse(response.outputParsed);
      if (response.status !== "completed" || !parsed.success) {
        return this.failed(
          request,
          startedAt,
          response.outputParsed === null ? "provider_invalid_response" : "structured_output_validation_failed",
        );
      }
      const now = this.clock().toISOString();
      const durationMs = Math.max(0, Math.round(this.durationClock() - startedAt));
      const result = mapOpenAiOutputToExtractionResult({
        request,
        output: parsed.data,
        model: this.config.model,
        extractorVersion: this.extractorVersion,
        durationMs,
        providerResponseId: response.id,
        tokenUsage: response.usage,
        extractedAt: now,
      });
      this.log(toSafeEngineLog({
        event: "payslip_extraction",
        timestamp: now,
        case_id: request.case_id,
        analysis_run_id: request.analysis_run_id,
        document_id: request.document.document_id,
        extraction_id: request.extraction_id,
        stage: "document_extraction",
        status: result.status,
        provider_id: this.providerId,
        extractor_version: this.extractorVersion,
        model_version: this.config.model,
        provider_response_id: response.id,
        duration_ms: durationMs,
        ...(response.usage ?? {}),
      }));
      return result;
    } catch (error) {
      return this.failed(request, startedAt, classifyOpenAiError(error));
    }
  }
}

export function createOpenAiDocumentExtractorFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: ConstructorParameters<typeof OpenAiDocumentExtractor>[1] = {},
) {
  return new OpenAiDocumentExtractor(resolveOpenAiExtractionConfig(environment), options);
}
