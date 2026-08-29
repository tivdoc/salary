import "server-only";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { EmploymentSnapshot } from "@/engine/facts/snapshot";
import {
  extractionRequestSchema,
  payslipFieldKeySchema,
  type ExtractionRequest,
  type PayslipFieldKey,
} from "@/engine/extraction/contracts";
import type { PrivateDocumentSource } from "@/engine/extraction/provider";
import { resolvePayslipSnapshot, type SnapshotResolutionContext } from "@/engine/extraction/resolver";
import {
  buildPassEvaluation,
  PAYSLIP_EXTRACTION_V2_VERSION,
  resolvePayslipExtractionPasses,
  selectTargetedRecovery,
  type ExtractionRegion,
  type PayslipExtractionV2Result,
} from "@/engine/extraction/v2";
import { toSafeEngineLog, type SafeEngineLog } from "@/server/engine/safe-logging";
import { preprocessPayslipDocument, type PreparedPayslipDocument } from "../../preprocessing";
import { resolveOpenAiExtractionConfig, type OpenAiExtractionConfig } from "./config";
import { classifyOpenAiError, type OpenAiExtractionErrorCode } from "./errors";
import { createFailedOpenAiExtractionResult } from "./mapper";
import { isSupportedOpenAiDocumentMimeType } from "./request";
import { mapOpenAiV2Output, type MappedOpenAiV2Pass } from "./v2-mapper";
import {
  OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
  OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
} from "./v2-prompt";
import { buildOpenAiV2ResponsesRequest, type OpenAiV2ResponsesRequest } from "./v2-request";
import type { OpenAiPayslipV2StructuredOutput } from "./v2-schema";

export type OpenAiV2TransportResponse = Readonly<{
  id: string;
  status: string;
  outputParsed: OpenAiPayslipV2StructuredOutput | null;
  usage: Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }> | null;
}>;

export interface OpenAiV2ResponsesTransport {
  parse(request: OpenAiV2ResponsesRequest): Promise<OpenAiV2TransportResponse>;
}
function createOpenAiV2SdkTransport(input: { apiKey: string; timeoutMs: number }): OpenAiV2ResponsesTransport {
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

function uuidFrom(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

type SafeLogSink = (entry: SafeEngineLog) => void;

export class OpenAiPayslipV2PassExtractor {
  readonly providerId = "openai";
  readonly extractorVersion: string;
  private readonly transport: OpenAiV2ResponsesTransport | null;

  constructor(
    private readonly config: OpenAiExtractionConfig,
    private readonly options: {
      transport?: OpenAiV2ResponsesTransport;
      clock?: () => Date;
      durationClock?: () => number;
      log?: SafeLogSink;
      extractorVersion?: string;
    } = {},
  ) {
    this.extractorVersion = options.extractorVersion ?? PAYSLIP_EXTRACTION_V2_VERSION;
    this.transport = options.transport ?? (config.apiKey
      ? createOpenAiV2SdkTransport({ apiKey: config.apiKey, timeoutMs: config.timeoutMs })
      : null);
  }

  private failed(input: {
    request: ExtractionRequest;
    code: OpenAiExtractionErrorCode;
    startedAt: number;
    kind: "first_pass" | "targeted_recovery";
    requestedFields: readonly PayslipFieldKey[];
    prepared: PreparedPayslipDocument;
  }): MappedOpenAiV2Pass {
    const clock = this.options.clock ?? (() => new Date());
    const durationClock = this.options.durationClock ?? (() => performance.now());
    const now = clock().toISOString();
    const durationMs = Math.max(0, Math.round(durationClock() - input.startedAt));
    const extraction = createFailedOpenAiExtractionResult({
      request: input.request,
      model: this.config.model,
      extractorVersion: this.extractorVersion,
      durationMs,
      errorCode: input.code,
      extractedAt: now,
    });
    (this.options.log ?? (() => undefined))(toSafeEngineLog({
      event: "payslip_extraction",
      timestamp: now,
      case_id: input.request.case_id,
      analysis_run_id: input.request.analysis_run_id,
      document_id: input.request.document.document_id,
      extraction_id: input.request.extraction_id,
      stage: "document_extraction",
      status: "failed",
      provider_id: this.providerId,
      extractor_version: this.extractorVersion,
      model_version: this.config.model,
      duration_ms: durationMs,
      error_code: input.code,
      pass_kind: input.kind,
      prompt_version: input.kind === "first_pass"
        ? OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION
        : OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
      requested_field_count: input.requestedFields.length,
      region_count: input.prepared.crops.length,
      preprocessing_version: input.prepared.metadata.preprocessing_version,
    }));
    return {
      extraction,
      salary_type_assessment: { documented: null, inferred: null },
      critical_context: { required_fields: input.requestedFields },
      pension_section_visible: false,
      totals_section_visible: false,
    };
  }

  async extractPreparedPass(input: {
    request: ExtractionRequest;
    prepared: PreparedPayslipDocument;
    kind: "first_pass" | "targeted_recovery";
    requestedFields: readonly PayslipFieldKey[];
  }): Promise<MappedOpenAiV2Pass> {
    const request = extractionRequestSchema.parse(input.request);
    const durationClock = this.options.durationClock ?? (() => performance.now());
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = durationClock();
    if (!this.transport) return this.failed({ ...input, request, startedAt, code: "openai_not_configured" });
    if (!isSupportedOpenAiDocumentMimeType(request.document.mime_type)) {
      return this.failed({ ...input, request, startedAt, code: "unsupported_document" });
    }
    try {
      const response = await this.transport.parse(buildOpenAiV2ResponsesRequest({
        model: this.config.model,
        prepared: input.prepared,
        kind: input.kind,
        requested_fields: input.requestedFields,
      }));
      if (response.status !== "completed" || response.outputParsed === null) {
        return this.failed({ ...input, request, startedAt, code: "provider_invalid_response" });
      }
      const now = clock().toISOString();
      const durationMs = Math.max(0, Math.round(durationClock() - startedAt));
      const mapped = mapOpenAiV2Output({
        request,
        output: response.outputParsed,
        model: this.config.model,
        extractorVersion: this.extractorVersion,
        durationMs,
        providerResponseId: response.id,
        tokenUsage: response.usage,
        extractedAt: now,
        ...(input.kind === "targeted_recovery" ? { allowedFields: input.requestedFields } : {}),
      });
      (this.options.log ?? (() => undefined))(toSafeEngineLog({
        event: "payslip_extraction",
        timestamp: now,
        case_id: request.case_id,
        analysis_run_id: request.analysis_run_id,
        document_id: request.document.document_id,
        extraction_id: request.extraction_id,
        stage: "document_extraction",
        status: mapped.extraction.status,
        provider_id: this.providerId,
        extractor_version: this.extractorVersion,
        model_version: this.config.model,
        provider_response_id: response.id,
        duration_ms: durationMs,
        ...(response.usage ?? {}),
        pass_kind: input.kind,
        prompt_version: input.kind === "first_pass"
          ? OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION
          : OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
        requested_field_count: input.requestedFields.length,
        region_count: input.prepared.crops.length,
        preprocessing_version: input.prepared.metadata.preprocessing_version,
      }));
      return mapped;
    } catch (error) {
      return this.failed({ ...input, request, startedAt, code: classifyOpenAiError(error) });
    }
  }
}

export type OpenAiPayslipV2Run = Readonly<{
  result: PayslipExtractionV2Result;
  snapshot: EmploymentSnapshot | null;
  preprocessing: readonly PreparedPayslipDocument["metadata"][];
}>;

export async function runOpenAiPayslipExtractionV2(input: {
  request: ExtractionRequest;
  source: PrivateDocumentSource;
  extractor: OpenAiPayslipV2PassExtractor;
  snapshot_context: SnapshotResolutionContext;
  reference_year?: number;
}): Promise<OpenAiPayslipV2Run> {
  const request = extractionRequestSchema.parse(input.request);
  const bytes = await input.source.read(request.document);
  const firstPassId = uuidFrom(`${request.extraction_id}:v2:first-pass`);
  const firstPassRequest = { ...request, extraction_id: firstPassId };
  const firstRegions: readonly ExtractionRegion[] = ["header", "earnings", "totals", "pension"];
  const firstPrepared = await preprocessPayslipDocument({
    bytes,
    mime_type: request.document.mime_type,
    regions: firstRegions,
  });
  const firstMapped = await input.extractor.extractPreparedPass({
    request: firstPassRequest,
    prepared: firstPrepared,
    kind: "first_pass",
    requestedFields: payslipFieldKeySchema.options,
  });
  const firstPass = buildPassEvaluation({
    pass_id: firstPassId,
    kind: "first_pass",
    requested_fields: payslipFieldKeySchema.options,
    selected_regions: firstPrepared.crops.map((crop) => crop.region),
    prompt_version: OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
    model: firstMapped.extraction.provider.model_version ?? "unknown",
    raw_extraction: firstMapped.extraction,
    salary_type_assessment: firstMapped.salary_type_assessment,
    pension_section_visible: firstMapped.pension_section_visible,
    totals_section_visible: firstMapped.totals_section_visible,
    critical_context: firstMapped.critical_context,
    reference_year: input.reference_year,
  });
  const plan = firstMapped.extraction.status === "failed" ? null : selectTargetedRecovery(firstPass);
  const recoveryPasses = [];
  const preprocessing = [firstPrepared.metadata];
  if (plan) {
    const recoveryPassId = uuidFrom(`${request.extraction_id}:v2:targeted-recovery`);
    const recoveryPrepared = await preprocessPayslipDocument({
      bytes,
      mime_type: request.document.mime_type,
      regions: plan.regions,
    });
    preprocessing.push(recoveryPrepared.metadata);
    const recoveryMapped = await input.extractor.extractPreparedPass({
      request: { ...request, extraction_id: recoveryPassId },
      prepared: recoveryPrepared,
      kind: "targeted_recovery",
      requestedFields: plan.fields,
    });
    recoveryPasses.push(buildPassEvaluation({
      pass_id: recoveryPassId,
      kind: "targeted_recovery",
      requested_fields: plan.fields,
      selected_regions: recoveryPrepared.crops.map((crop) => crop.region),
      prompt_version: OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
      model: recoveryMapped.extraction.provider.model_version ?? "unknown",
      raw_extraction: recoveryMapped.extraction,
      salary_type_assessment: recoveryMapped.salary_type_assessment,
      pension_section_visible: recoveryMapped.pension_section_visible,
      totals_section_visible: recoveryMapped.totals_section_visible,
      critical_context: {
        ...recoveryMapped.critical_context,
        required_fields: plan.fields,
      },
      reference_year: input.reference_year,
    }));
  }
  const finalResult = resolvePayslipExtractionPasses({
    first_pass: firstPass,
    recovery_passes: recoveryPasses,
    final_extraction_id: request.extraction_id,
    critical_context: firstMapped.critical_context,
    reference_year: input.reference_year,
  });
  const snapshot = finalResult.final_extraction.status === "failed"
    ? null
    : resolvePayslipSnapshot({
        document: request.document,
        extraction: finalResult.final_extraction,
        validation: finalResult.final_validation,
        context: input.snapshot_context,
      });
  return { result: finalResult, snapshot, preprocessing };
}

export function createOpenAiPayslipV2ExtractorFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: ConstructorParameters<typeof OpenAiPayslipV2PassExtractor>[1] = {},
) {
  return new OpenAiPayslipV2PassExtractor(resolveOpenAiExtractionConfig(environment), options);
}
