import "server-only";
import { createHash } from "node:crypto";
import type { EmploymentSnapshot } from "@/engine/facts/snapshot";
import {
  extractionRequestSchema,
  payslipFieldKeySchema,
  type ExtractionRequest,
} from "@/engine/extraction/contracts";
import type { PrivateDocumentSource } from "@/engine/extraction/provider";
import { resolvePayslipSnapshot, type SnapshotResolutionContext } from "@/engine/extraction/resolver";
import { buildPassEvaluation, type ExtractionRegion } from "@/engine/extraction/v2";
import {
  PAYSLIP_EXTRACTION_V21_VERSION,
  recoveryDecisionForV21,
  resolvePayslipExtractionPassesV21,
  selectTargetedRecoveryV21,
  type PayslipExtractionV21Result,
} from "@/engine/extraction/v21";
import { preprocessPayslipDocument, type PreparedPayslipDocument } from "../../preprocessing";
import { resolveOpenAiExtractionConfig } from "./config";
import { OpenAiPayslipV2PassExtractor } from "./v2-adapter";
import {
  OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
  OPENAI_PAYSLIP_V2_RECOVERY_PROMPT_VERSION,
} from "./v2-prompt";

function uuidFrom(seed: string) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export type OpenAiPayslipV21Run = Readonly<{
  result: PayslipExtractionV21Result;
  snapshot: EmploymentSnapshot | null;
  preprocessing: readonly PreparedPayslipDocument["metadata"][];
}>;

export async function runOpenAiPayslipExtractionV21(input: {
  request: ExtractionRequest;
  source: PrivateDocumentSource;
  extractor: OpenAiPayslipV2PassExtractor;
  snapshot_context: SnapshotResolutionContext;
  reference_year?: number;
}): Promise<OpenAiPayslipV21Run> {
  const request = extractionRequestSchema.parse(input.request);
  const bytes = await input.source.read(request.document);
  const firstPassId = uuidFrom(`${request.extraction_id}:v2.1:first-pass`);
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
  const plan = firstMapped.extraction.status === "failed" ? null : selectTargetedRecoveryV21(firstPass);
  const recoveryDecision = recoveryDecisionForV21(plan);
  const recoveryPasses = [];
  const preprocessing = [firstPrepared.metadata];
  if (plan) {
    const recoveryPassId = uuidFrom(`${request.extraction_id}:v2.1:targeted-recovery`);
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
  const finalResult = resolvePayslipExtractionPassesV21({
    first_pass: firstPass,
    recovery_passes: recoveryPasses,
    recovery_decision: recoveryDecision,
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

export function createOpenAiPayslipV21ExtractorFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: ConstructorParameters<typeof OpenAiPayslipV2PassExtractor>[1] = {},
) {
  return new OpenAiPayslipV2PassExtractor(resolveOpenAiExtractionConfig(environment), {
    ...options,
    extractorVersion: PAYSLIP_EXTRACTION_V21_VERSION,
  });
}
