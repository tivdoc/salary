import "server-only";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { EmploymentSnapshot } from "@/engine/facts/snapshot";
import {versionSchema} from '@/engine/domain/primitives';
import {componentDuplicatePolicySchema,type Gate0Validation} from '@/engine/extraction/validation';
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
import { classifyOpenAiError, classifyOpenAiMappingError, openAiExtractionErrorCodeSchema, type OpenAiExtractionErrorCode } from "./errors";
import { createFailedOpenAiExtractionResult } from "./mapper";
import { isSupportedOpenAiDocumentMimeType } from "./request";
import { mapOpenAiV2Output, type MappedOpenAiV2Pass } from "./v2-mapper";
import {
  OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
  OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
} from "./v2-prompt";
import { buildOpenAiV2ResponsesRequest, OPENAI_SOL_COMPARISON_PROFILE, openAiV2PromptVersion, type OpenAiV2ResponsesRequest } from "./v2-request";
import { openAiPayslipV2AcceptedOutputSchema, type OpenAiPayslipV2AcceptedOutput as OpenAiPayslipV2StructuredOutput } from "./v2-schema";
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {createOpenAiProviderReceipt,safeProviderIdentifier,type OpenAiProviderReceipt} from './provider-receipt';
import {assertManagedOpenAiRecovery,type ManagedOpenAiRecoveryAuthority} from './managed-package-recovery';

export type OpenAiV2TransportResponse = Readonly<{
  id: string;
  status: string;
  outputParsed: OpenAiPayslipV2StructuredOutput | null;
  usage: Readonly<{ input_tokens: number; output_tokens: number; total_tokens: number }> | null;
  model?:string|null;
  requestId?:string|null;
}>;

export interface OpenAiV2ResponsesTransport {
  parse(request: OpenAiV2ResponsesRequest): Promise<OpenAiV2TransportResponse>;
}
export const OPENAI_V2_STRUCTURED_DIAGNOSTIC_MAX_BYTES=256*1024;
function createOpenAiV2SdkTransport(input: { apiKey: string; timeoutMs: number; baseURL?:string }): OpenAiV2ResponsesTransport {
  const client = new OpenAI({ apiKey: input.apiKey, timeout: input.timeoutMs, maxRetries: 0, ...(input.baseURL?{baseURL:input.baseURL}:{}) });
  return {
    async parse(request) {
      const response = await client.responses.parse(request);
      return {
        id: response.id,
        status: response.status ?? "failed",
        outputParsed: response.output_parsed,
        model: response.model,
        requestId: response._request_id,
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
/** Explicit server-side diagnostic sink for bounded synthetic proof runners.
 * Not a logger or client payload; callers must scope/persist it privately. It
 * receives only schema-parsed output and safe provenance, never SDK credentials.
 * The immutable copy cannot alter the output passed to the mapper. */
export type OpenAiV2StructuredDiagnostic=Readonly<{
  schema_version:'tivdoc-openai-structured-diagnostic-v1';origin:OpenAiProviderReceipt['origin'];
  case_id:string;analysis_run_id:string;document_id:string;source_sha256:string;request_sha256:string;
  pass_kind:'first_pass'|'targeted_recovery';prompt_version:string;provider_response_id:string|null;provider_request_id:string|null;
  structured_output:OpenAiPayslipV2StructuredOutput;structured_output_sha256:string;
}>;

function providerPagesMatch(output:OpenAiPayslipV2StructuredOutput,actualPages:number){
  if(output.page_count!==actualPages)return false;
  const visit=(value:unknown):boolean=>{
    if(Array.isArray(value))return value.every(visit);
    if(value&&typeof value==='object'){
      const row=value as Record<string,unknown>;
      if('page' in row&&row.page!==null&&(typeof row.page!=='number'||!Number.isInteger(row.page)||row.page<1||row.page>actualPages))return false;
      return Object.values(row).every(visit);
    }
    return true;
  };
  return visit(output);
}

type SafeLogSink = (entry: SafeEngineLog) => void;

export class OpenAiPayslipV2PassExtractor {
  readonly providerId = "openai";
  readonly extractorVersion: string;
  readonly recoveryExecution: 'automatic' | 'skip_package_budget' | 'skip_managed_package_budget';
  readonly componentDuplicatePolicy: Gate0Validation['component_duplicate_policy'];
  private readonly transport: OpenAiV2ResponsesTransport | null;
  private readonly origin:OpenAiProviderReceipt['origin'];

  constructor(
    private readonly config: OpenAiExtractionConfig,
    private readonly options: {
      transport?: OpenAiV2ResponsesTransport;
      clock?: () => Date;
      durationClock?: () => number;
      log?: SafeLogSink;
      extractorVersion?: string;
      executionProfile?: Parameters<typeof buildOpenAiV2ResponsesRequest>[0]['executionProfile'];
      sourcePagePolicy?: Parameters<typeof buildOpenAiV2ResponsesRequest>[0]['sourcePagePolicy'];
      recoveryExecution?: 'automatic' | 'skip_package_budget' | 'skip_managed_package_budget';
      managedRecoveryAuthority?: ManagedOpenAiRecoveryAuthority;
      componentDuplicatePolicy?: Gate0Validation['component_duplicate_policy'];
    } = {},
  ) {
    // Validate before constructing the transport: otherwise even the failure
    // receipt can throw after a paid response when the version is malformed.
    this.extractorVersion = versionSchema.parse(options.extractorVersion ?? PAYSLIP_EXTRACTION_V2_VERSION);
    openAiV2PromptVersion('first_pass',options.sourcePagePolicy);
    this.componentDuplicatePolicy=options.componentDuplicatePolicy===undefined?undefined:componentDuplicatePolicySchema.parse(options.componentDuplicatePolicy);
    this.recoveryExecution=options.recoveryExecution??'automatic';
    if(!['automatic','skip_package_budget','skip_managed_package_budget'].includes(this.recoveryExecution)
      ||(this.recoveryExecution==='skip_package_budget'&&(options.executionProfile!==OPENAI_SOL_COMPARISON_PROFILE
        ||process.env.NODE_ENV!=='test'||process.env.TIVDOC_SOL_SAVED_WORKER_PROOF!=='1')))
      throw new TypeError('OPENAI_RECOVERY_EXECUTION_SCOPE');
    if(this.recoveryExecution==='skip_managed_package_budget'){
      if(options.transport||options.executionProfile!==OPENAI_SOL_COMPARISON_PROFILE||config.model!=='gpt-5.6-sol')
        throw new TypeError('OPENAI_RECOVERY_EXECUTION_SCOPE');
      assertManagedOpenAiRecovery(options.managedRecoveryAuthority,config.apiKey);
    }else if(options.managedRecoveryAuthority!==undefined)throw new TypeError('OPENAI_RECOVERY_EXECUTION_SCOPE');
    if(options.executionProfile!==undefined&&(options.executionProfile!==OPENAI_SOL_COMPARISON_PROFILE||config.model!=='gpt-5.6-sol'))
      throw new TypeError('OPENAI_COMPARISON_PROFILE_MODEL_MISMATCH');
    this.origin=options.transport?'injected_test_provider':config.apiKey?'openai_live':'not_configured';
    this.transport = options.transport ?? (config.apiKey
      ? createOpenAiV2SdkTransport({ apiKey: config.apiKey, timeoutMs: config.timeoutMs,
        ...(options.executionProfile?{baseURL:'https://api.openai.com/v1'}:{}) })
      : null);
  }

  private failed(input: {
    request: ExtractionRequest;
    code: OpenAiExtractionErrorCode;
    startedAt: number;
    kind: "first_pass" | "targeted_recovery";
    requestedFields: readonly PayslipFieldKey[];
    prepared: PreparedPayslipDocument;
    requestHash?:string|null;
    response?:OpenAiV2TransportResponse;
    providerError?:unknown;
    sourcePageCount?:number;
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
      prompt_version: openAiV2PromptVersion(input.kind,this.options.sourcePagePolicy),
      requested_field_count: input.requestedFields.length,
      region_count: input.prepared.crops.length,
      preprocessing_version: input.prepared.metadata.preprocessing_version,
    }));
    return {
      extraction,
      provider_receipt:this.receipt({request:input.request,kind:input.kind,extraction,requestHash:input.requestHash??null,
        response:input.response,error:input.providerError,sourcePageCount:input.sourcePageCount}),
      salary_type_assessment: { documented: null, inferred: null },
      critical_context: { required_fields: input.requestedFields },
      pension_section_visible: false,
      totals_section_visible: false,
    };
  }

  private receipt(input:{request:ExtractionRequest;kind:'first_pass'|'targeted_recovery';extraction:MappedOpenAiV2Pass['extraction'];
    requestHash:string|null;response?:OpenAiV2TransportResponse;error?:unknown;sourcePageCount?:number}){
    const error=typeof input.error==='object'&&input.error!==null?input.error as Record<string,unknown>:{};
    const extraction=input.extraction;
    return createOpenAiProviderReceipt({
      schema_version:'tivdoc-openai-provider-receipt-v1',origin:this.origin,
      case_id:input.request.case_id,analysis_run_id:input.request.analysis_run_id,document_id:input.request.document.document_id,
      extraction_id:input.request.extraction_id,source_sha256:input.request.document.content_sha256,
      source_size_bytes:input.request.document.size_bytes,source_mime_type:input.request.document.mime_type,
      ...(input.sourcePageCount===undefined?{}:{source_page_count:input.sourcePageCount}),
      request_sha256:input.requestHash,raw_extraction_sha256:canonicalSha256(extraction),pass_kind:input.kind,
      requested_model:this.config.model,actual_model:safeProviderIdentifier(input.response?.model),
      extractor_version:this.extractorVersion,prompt_version:openAiV2PromptVersion(input.kind,this.options.sourcePagePolicy),
      provider_response_id:safeProviderIdentifier(input.response?.id),provider_request_id:safeProviderIdentifier(input.response?.requestId??error.requestID),
      provider_attempted:input.requestHash!==null,status:extraction.status==='failed'?'failed':'completed',
      error_code:extraction.status==='failed'?openAiExtractionErrorCodeSchema.parse(extraction.error_code):null,
      http_status:typeof error.status==='number'&&Number.isInteger(error.status)&&error.status>=100&&error.status<=599?error.status:null,
      duration_ms:extraction.operation.duration_ms,token_usage:input.response?.usage??null,
      cost:{status:'not_returned_by_provider',amount_usd:null},created_at:extraction.extracted_at,
    });
  }

  async extractPreparedPass(input: {
    request: ExtractionRequest;
    prepared: PreparedPayslipDocument;
    kind: "first_pass" | "targeted_recovery";
    requestedFields: readonly PayslipFieldKey[];
    sourcePageCount?:number;
    onStructuredOutput?:(diagnostic:OpenAiV2StructuredDiagnostic)=>void;
  }): Promise<MappedOpenAiV2Pass> {
    const request = extractionRequestSchema.parse(input.request);
    if(this.recoveryExecution==='skip_managed_package_budget'){
      assertManagedOpenAiRecovery(this.options.managedRecoveryAuthority,this.config.apiKey,request);
      if(input.kind!=='first_pass')throw new TypeError('OPENAI_MANAGED_RECOVERY_DISABLED');
    }
    const durationClock = this.options.durationClock ?? (() => performance.now());
    const clock = this.options.clock ?? (() => new Date());
    const startedAt = durationClock();
    if(input.sourcePageCount!==undefined&&(!Number.isInteger(input.sourcePageCount)||input.sourcePageCount<1||input.sourcePageCount>12))
      throw new TypeError('EXTRACTION_SOURCE_PAGE_COUNT_INVALID');
    if (!this.transport) return this.failed({ ...input, request, startedAt, code: "openai_not_configured" });
    if (!isSupportedOpenAiDocumentMimeType(request.document.mime_type)) {
      return this.failed({ ...input, request, startedAt, code: "unsupported_document" });
    }
    const original=input.prepared.original;
    if(original.bytes.byteLength!==request.document.size_bytes||original.mime_type!==request.document.mime_type
      ||original.sha256!==request.document.content_sha256
      ||createHash('sha256').update(original.bytes).digest('hex')!==request.document.content_sha256
      ||input.prepared.crops.some(crop=>createHash('sha256').update(crop.image.bytes).digest('hex')!==crop.image.sha256))
      throw new TypeError('EXTRACTION_PREPARED_SOURCE_MISMATCH');
    let requestHash:string|null=null;
    let received:OpenAiV2TransportResponse|undefined;
    try {
      const providerRequest=buildOpenAiV2ResponsesRequest({
        model: this.config.model,
        prepared: input.prepared,
        kind: input.kind,
        requested_fields: input.requestedFields,
        ...(this.options.executionProfile ? {executionProfile: this.options.executionProfile} : {}),
        ...(this.options.sourcePagePolicy?{sourcePagePolicy:this.options.sourcePagePolicy}:{}),
      });
      requestHash=canonicalSha256(providerRequest);
      const response = await this.transport.parse(providerRequest);
      received=response;
      if (response.status !== "completed" || response.outputParsed === null) {
        return this.failed({ ...input, request, startedAt, code: "provider_invalid_response",requestHash,response });
      }
      const now = clock().toISOString();
      const durationMs = Math.max(0, Math.round(durationClock() - startedAt));
      const output=openAiPayslipV2AcceptedOutputSchema.parse(response.outputParsed);
      if(input.onStructuredOutput){
        if(Buffer.byteLength(JSON.stringify(output),'utf8')>OPENAI_V2_STRUCTURED_DIAGNOSTIC_MAX_BYTES)
          throw new TypeError('OPENAI_DIAGNOSTIC_SIZE_LIMIT');
        input.onStructuredOutput(deepFreeze({schema_version:'tivdoc-openai-structured-diagnostic-v1',origin:this.origin,
          case_id:request.case_id,analysis_run_id:request.analysis_run_id,document_id:request.document.document_id,
          source_sha256:request.document.content_sha256,request_sha256:requestHash,pass_kind:input.kind,
          prompt_version:openAiV2PromptVersion(input.kind,this.options.sourcePagePolicy),
          provider_response_id:safeProviderIdentifier(response.id),provider_request_id:safeProviderIdentifier(response.requestId),
          structured_output:structuredClone(output),structured_output_sha256:canonicalSha256(output)}));
      }
      // Retain the paid, schema-valid provider response for private diagnosis
      // even when its source coordinates are refused. It is never mapped or
      // promoted to a successful extraction by this diagnostic sink.
      if(input.sourcePageCount!==undefined&&!providerPagesMatch(output,input.sourcePageCount))
        return this.failed({...input,request,startedAt,code:'provider_source_page_mismatch',requestHash,response});
      let mapped:MappedOpenAiV2Pass;
      try{mapped = mapOpenAiV2Output({
        request,
        output,
        model: response.model??this.config.model,
        extractorVersion: this.extractorVersion,
        durationMs,
        providerResponseId: response.id,
        tokenUsage: response.usage,
        extractedAt: now,
        ...(input.kind === "targeted_recovery" ? { allowedFields: input.requestedFields } : {}),
      });}catch(error){
        return this.failed({...input,request,startedAt,code:classifyOpenAiMappingError(error),requestHash,response});
      }
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
        prompt_version: openAiV2PromptVersion(input.kind,this.options.sourcePagePolicy),
        requested_field_count: input.requestedFields.length,
        region_count: input.prepared.crops.length,
        preprocessing_version: input.prepared.metadata.preprocessing_version,
      }));
      return {...mapped,provider_receipt:this.receipt({request,kind:input.kind,extraction:mapped.extraction,requestHash,response,sourcePageCount:input.sourcePageCount})};
    } catch (error) {
      return this.failed({ ...input, request, startedAt, code: classifyOpenAiError(error),requestHash,response:received,providerError:error });
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
    component_duplicate_policy: input.extractor.componentDuplicatePolicy,
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
      component_duplicate_policy: input.extractor.componentDuplicatePolicy,
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
