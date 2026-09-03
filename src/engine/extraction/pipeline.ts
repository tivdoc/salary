import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { extractionRequestSchema, extractionResultSchema, type ExtractionRequest, type ExtractionResult } from "./contracts.ts";
import { assessExtractionConfidence } from "./confidence-policy.ts";
import { minimizePayslipForSemanticProcessing } from "./minimize.ts";
import { normalizePayslipExtraction } from "./normalization.ts";
import type { DocumentExtractor, PrivateDocumentSource } from "./provider.ts";
import { resolvePayslipSnapshot, type SnapshotResolutionContext } from "./resolver.ts";
import { validatePayslipGate0 } from "./validation.ts";

export type PayslipPipelineResult = Readonly<{
  raw_extraction: ExtractionResult;
  normalized_extraction: ReturnType<typeof normalizePayslipExtraction>;
  validation: ReturnType<typeof validatePayslipGate0>;
  confidence_assessment: ReturnType<typeof assessExtractionConfidence>;
  minimized_representation: ReturnType<typeof minimizePayslipForSemanticProcessing>;
  snapshot: EmploymentSnapshot | null;
}>;

export async function runPayslipExtractionPipeline(input: {
  request: ExtractionRequest;
  source: PrivateDocumentSource;
  extractor: DocumentExtractor;
  snapshot_context: SnapshotResolutionContext;
  reference_year?: number;
}): Promise<PayslipPipelineResult> {
  const request = extractionRequestSchema.parse(input.request);
  const rawExtraction = extractionResultSchema.parse(await input.extractor.extract(request, input.source));
  if (rawExtraction.extraction_id !== request.extraction_id || rawExtraction.document_id !== request.document.document_id) {
    throw new TypeError("Extractor output must remain scoped to the requested extraction and document");
  }
  if (
    rawExtraction.provider.provider_id !== input.extractor.providerId ||
    rawExtraction.provider.extractor_version !== input.extractor.extractorVersion
  ) {
    throw new TypeError("Extractor output must identify the adapter and version that produced it");
  }
  const normalizedExtraction = normalizePayslipExtraction(rawExtraction);
  const validation = validatePayslipGate0(normalizedExtraction, { reference_year: input.reference_year });
  const confidenceAssessment = assessExtractionConfidence(normalizedExtraction, validation);
  const minimizedRepresentation = minimizePayslipForSemanticProcessing(normalizedExtraction);
  const snapshot = rawExtraction.status === "failed"
    ? null
    : resolvePayslipSnapshot({
        document: request.document,
        extraction: normalizedExtraction,
        validation,
        context: input.snapshot_context,
      });
  return {
    raw_extraction: rawExtraction,
    normalized_extraction: normalizedExtraction,
    validation,
    confidence_assessment: confidenceAssessment,
    minimized_representation: minimizedRepresentation,
    snapshot,
  };
}
