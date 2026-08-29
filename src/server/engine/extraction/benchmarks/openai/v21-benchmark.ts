import "server-only";
import { z } from "zod";
import type { PayslipFieldKey } from "@/engine/extraction/contracts";
import { minimizePayslipForSemanticProcessing } from "@/engine/extraction/minimize";
import type { NormalizedPayslipExtraction } from "@/engine/extraction/payslip";
import type { PayslipPipelineResult } from "@/engine/extraction/pipeline";
import {
  factResolutionStateSchema,
  recoveryDecisionSchema,
  type FieldResolutionV21,
} from "@/engine/extraction/v21";
import type { OpenAiPayslipV21Run } from "../../providers/openai/v21-adapter";
import { OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION } from "../../providers/openai/v2-prompt";
import {
  estimateOpenAiExtractionCostUsd,
  openAiRenderedBenchmarkReportSchema,
  scoreOpenAiBenchmarkRuns,
  type BenchmarkArtifact,
  type BenchmarkGroundTruth,
  type OpenAiRenderedBenchmarkReport,
} from "./benchmark";
import { groundTruthForDocumentedSalaryType } from "./v2-benchmark";

export type OpenAiV21BenchmarkRun = Readonly<{
  artifact: BenchmarkArtifact;
  run: OpenAiPayslipV21Run;
}>;

const countMetricSchema = z.object({
  expected: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1).nullable(),
}).strict();

const stageCostSchema = z.object({
  first_pass_usd: z.number().nonnegative().nullable(),
  recovery_usd: z.number().nonnegative().nullable(),
  final_usd: z.number().nonnegative().nullable(),
}).strict();

const safetyDetailSchema = z.object({
  fixture_id: z.string(),
  field: z.string(),
  first_pass_outcome: z.string(),
  final_outcome: z.string(),
  resolution_state: factResolutionStateSchema,
}).strict();

const wrongAcceptedCriticalSchema = z.object({
  fixture_id: z.string(),
  field: z.string(),
  expected_value: z.unknown(),
  extracted_value: z.unknown(),
  resolution_state: factResolutionStateSchema,
  gate0_status: z.literal("valid"),
}).strict();

const fieldEvidenceSchema = z.object({
  fixture_id: z.string(),
  stage: z.enum(["first_pass", "final"]),
  field: z.string(),
  ground_truth_classification: z.enum(["expected_absent", "ambiguous", "unscored_not_annotated"]),
  counted_as_hallucination: z.boolean(),
  raw_value: z.string(),
  normalized_value: z.unknown(),
  confidence: z.number().min(0).max(1),
  warning_flags: z.array(z.string()),
  provenance: z.object({
    candidate_id: z.string().uuid(),
    pass_kind: z.enum(["first_pass", "targeted_recovery"]),
    document_id: z.string().uuid(),
    page: z.number().int().positive(),
    bounding_box: z.unknown().nullable(),
    extraction_method: z.string(),
  }).strict(),
  gate0_result: z.object({
    status: z.enum(["valid", "suspicious", "invalid", "requires_confirmation"]).nullable(),
    issue_codes: z.array(z.string()),
  }).strict(),
}).strict();

export const openAiV21BenchmarkReportSchema = z.object({
  report_version: z.literal("2.1"),
  model: z.string(),
  extractor_version: z.literal("2.1"),
  salary_type_scoring: z.literal("documented_only"),
  first_pass: openAiRenderedBenchmarkReportSchema,
  final_after_selective_recovery: openAiRenderedBenchmarkReportSchema,
  safety_metrics: z.object({
    recovery_regressions: z.object({
      count: z.number().int().nonnegative(),
      silent_count: z.number().int().nonnegative(),
      details: z.array(safetyDetailSchema),
    }).strict(),
    wrong_accepted_critical_values: z.object({ count: z.number().int().nonnegative(), details: z.array(wrongAcceptedCriticalSchema) }).strict(),
    suspicious_preserved: z.object({ count: z.number().int().nonnegative(), details: z.array(safetyDetailSchema) }).strict(),
    correctly_introduced_conflicts: z.object({ count: z.number().int().nonnegative(), details: z.array(safetyDetailSchema) }).strict(),
    recovery_yield: z.object({
      recovered_missing_critical_fields: z.number().int().nonnegative(),
      additional_api_calls: z.number().int().nonnegative(),
      recovered_fields_per_call: z.number().nonnegative().nullable(),
    }).strict(),
  }).strict(),
  recovery_summary: z.object({
    documents_requested: z.number().int().nonnegative(),
    documents_skipped: z.number().int().nonnegative(),
    additional_api_calls: z.number().int().nonnegative(),
    total_fields_requested: z.number().int().nonnegative(),
    requests: z.array(z.object({
      fixture_id: z.string(),
      decision: recoveryDecisionSchema,
    }).strict()),
  }).strict(),
  total_cost: stageCostSchema,
  total_latency_ms: z.object({
    first_pass: z.number().int().nonnegative(),
    recovery: z.number().int().nonnegative(),
    final: z.number().int().nonnegative(),
  }).strict(),
  total_token_usage: z.object({
    complete: z.boolean(),
    first_pass: z.number().int().nonnegative(),
    recovery: z.number().int().nonnegative(),
    final: z.number().int().nonnegative(),
  }).strict(),
  per_document: z.array(z.object({
    fixture_id: z.string(),
    first_pass_accuracy: countMetricSchema,
    first_pass_critical_accuracy: countMetricSchema,
    final_accuracy: countMetricSchema,
    final_critical_accuracy: countMetricSchema,
    recovery_decision: recoveryDecisionSchema,
    recovery_results: z.array(z.object({
      field: z.string(),
      status: factResolutionStateSchema,
      first_pass_status: factResolutionStateSchema,
      reason_codes: z.array(z.string()),
    }).strict()),
    conflicts: z.array(z.string()),
    recovered_fields: z.array(z.string()),
    regressions: z.array(z.string()),
    wrong_accepted_critical_values: z.array(z.string()),
    historical_gate0_issues: z.array(z.string()),
    current_gate0_issues: z.array(z.string()),
    final_gate0_issues: z.array(z.string()),
    resolved_historical_gate0_issues: z.array(z.string()),
    api_calls: z.number().int().positive(),
    latency_ms: z.object({ first_pass: z.number().int().nonnegative(), recovery: z.number().int().nonnegative(), final: z.number().int().nonnegative() }).strict(),
    token_usage: z.object({ first_pass: z.number().int().nonnegative().nullable(), recovery: z.number().int().nonnegative().nullable(), final: z.number().int().nonnegative().nullable() }).strict(),
    cost_usd: stageCostSchema,
  }).strict()),
  field_evidence: z.array(fieldEvidenceSchema),
}).strict();

export type OpenAiV21BenchmarkReport = Readonly<z.infer<typeof openAiV21BenchmarkReportSchema>>;

function rawFromNormalized(extraction: NormalizedPayslipExtraction) {
  return {
    ...extraction,
    fields: extraction.fields.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      field: candidate.field,
      raw_value: candidate.raw_value,
      confidence: candidate.confidence,
      source: candidate.source,
      extraction_method: candidate.extraction_method,
      warning_flags: candidate.warning_flags,
    })),
    additional_components: extraction.additional_components.map((component) => ({
      component_id: component.component_id,
      source_label: component.source_label,
      normalized_label: component.normalized_label,
      semantic_kind: component.semantic_kind,
      quantity_raw: component.quantity_raw,
      rate_raw: component.rate_raw,
      percentage_raw: component.percentage_raw,
      amount_raw: component.amount_raw,
      confidence: component.confidence,
      source: component.source,
      extraction_method: component.extraction_method,
      warning_flags: component.warning_flags,
    })),
  };
}

function firstPassPipeline(run: OpenAiPayslipV21Run): PayslipPipelineResult {
  const pass = run.result.first_pass;
  return {
    raw_extraction: pass.raw_extraction,
    normalized_extraction: pass.normalized_extraction,
    validation: pass.validation,
    confidence_assessment: pass.confidence_assessment,
    minimized_representation: minimizePayslipForSemanticProcessing(pass.normalized_extraction),
    snapshot: null,
  };
}

function finalPipeline(run: OpenAiPayslipV21Run): PayslipPipelineResult {
  return {
    raw_extraction: rawFromNormalized(run.result.final_extraction),
    normalized_extraction: run.result.final_extraction,
    validation: run.result.final_validation,
    confidence_assessment: run.result.final_confidence_assessment,
    minimized_representation: minimizePayslipForSemanticProcessing(run.result.final_extraction),
    snapshot: run.snapshot,
  };
}

function tokens(operation: { token_usage: { total_tokens: number } | null }) {
  return operation.token_usage?.total_tokens ?? null;
}

function sumNullable(values: readonly (number | null)[]) {
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

function mismatchByField(
  fixture: OpenAiRenderedBenchmarkReport["per_fixture"][number],
) {
  return new Map(fixture.mismatches.map((mismatch) => [mismatch.field, mismatch]));
}

function resolutionByField(resolutions: readonly FieldResolutionV21[]) {
  return new Map(resolutions.map((resolution) => [resolution.field, resolution]));
}

function fieldEvidence(input: {
  fixtureId: string;
  stage: "first_pass" | "final";
  extraction: NormalizedPayslipExtraction;
  validation: OpenAiPayslipV21Run["result"]["final_validation"];
  truth: BenchmarkGroundTruth;
  provenanceByCandidate: ReadonlyMap<string, "first_pass" | "targeted_recovery">;
}) {
  const expected = new Set(Object.keys(input.truth.expected_fields));
  const absent = new Set(input.truth.expected_absent_fields);
  const ambiguous = new Set(input.truth.ambiguous_fields?.map((field) => field.field) ?? []);
  const best = new Map<PayslipFieldKey, NormalizedPayslipExtraction["fields"][number]>();
  for (const candidate of [...input.extraction.fields].sort((left, right) => right.confidence - left.confidence)) {
    if (candidate.normalized_value !== null && !best.has(candidate.field)) best.set(candidate.field, candidate);
  }
  return [...best.entries()].flatMap(([field, candidate]) => {
    if (expected.has(field)) return [];
    const classification = absent.has(field)
      ? "expected_absent" as const
      : ambiguous.has(field)
        ? "ambiguous" as const
        : "unscored_not_annotated" as const;
    const assessment = input.validation.field_assessments.find((item) => item.candidate_id === candidate.candidate_id);
    return [{
      fixture_id: input.fixtureId,
      stage: input.stage,
      field,
      ground_truth_classification: classification,
      counted_as_hallucination: classification === "expected_absent",
      raw_value: candidate.raw_value,
      normalized_value: candidate.normalized_value,
      confidence: candidate.confidence,
      warning_flags: candidate.warning_flags,
      provenance: {
        candidate_id: candidate.candidate_id,
        pass_kind: input.provenanceByCandidate.get(candidate.candidate_id) ?? "first_pass",
        document_id: candidate.source.document_id,
        page: candidate.source.page,
        bounding_box: candidate.source.bounding_box ?? null,
        extraction_method: candidate.extraction_method,
      },
      gate0_result: {
        status: assessment?.status ?? null,
        issue_codes: assessment?.issue_codes ?? [],
      },
    }];
  });
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

export function buildOpenAiV21BenchmarkReport(input: {
  runs: readonly OpenAiV21BenchmarkRun[];
  groundTruth: readonly BenchmarkGroundTruth[];
  model: string;
  groundTruthSha256?: string | null;
  explicitSalaryTypeFixtureIds?: readonly string[];
}): OpenAiV21BenchmarkReport {
  const truth = groundTruthForDocumentedSalaryType(input.groundTruth, input.explicitSalaryTypeFixtureIds);
  const truthByFixture = new Map(truth.map((item) => [item.fixture_id, item]));
  const firstPass = scoreOpenAiBenchmarkRuns({
    runs: input.runs.map(({ artifact, run }) => ({ artifact, result: firstPassPipeline(run) })),
    groundTruth: truth,
    model: input.model,
    extractorVersion: "2.1",
    promptVersion: OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
    groundTruthSha256: input.groundTruthSha256,
  });
  const finalScored = scoreOpenAiBenchmarkRuns({
    runs: input.runs.map(({ artifact, run }) => ({ artifact, result: finalPipeline(run) })),
    groundTruth: truth,
    model: input.model,
    extractorVersion: "2.1",
    promptVersion: "payslip-extraction-openai-v2.1-final",
    groundTruthSha256: input.groundTruthSha256,
  });
  const totalCalls = input.runs.reduce((sum, item) => sum + 1 + item.run.result.recovery_passes.length, 0);
  const finalStage = { ...finalScored, provider_calls: totalCalls };
  const regressionDetails: z.infer<typeof safetyDetailSchema>[] = [];
  const wrongAcceptedDetails: z.infer<typeof wrongAcceptedCriticalSchema>[] = [];
  const suspiciousPreservedDetails: z.infer<typeof safetyDetailSchema>[] = [];
  const correctlyIntroducedConflictDetails: z.infer<typeof safetyDetailSchema>[] = [];
  const allFieldEvidence: z.infer<typeof fieldEvidenceSchema>[] = [];
  let recoveredMissingCriticalFields = 0;
  let firstLatency = 0;
  let recoveryLatency = 0;
  const firstTokenValues: (number | null)[] = [];
  const recoveryTokenValues: (number | null)[] = [];

  const perDocument = input.runs.map(({ artifact, run }, index) => {
    const fixtureTruth = truthByFixture.get(artifact.fixture_id);
    if (!fixtureTruth) throw new TypeError(`Ground truth is missing for ${artifact.fixture_id}`);
    const firstFixture = firstPass.per_fixture[index];
    const finalFixture = finalStage.per_fixture[index];
    const firstMismatches = mismatchByField(firstFixture);
    const finalMismatches = mismatchByField(finalFixture);
    const resolutions = resolutionByField(run.result.resolutions);
    const fixtureRegressions: string[] = [];
    const fixtureWrongAccepted: string[] = [];
    const provenanceByCandidate = new Map<string, "first_pass" | "targeted_recovery">([
      ...run.result.first_pass.normalized_extraction.fields.map((candidate) => (
        [candidate.candidate_id, "first_pass" as const] as const
      )),
      ...run.result.recovery_passes.flatMap((pass) => pass.normalized_extraction.fields.map((candidate) => (
        [candidate.candidate_id, "targeted_recovery" as const] as const
      ))),
    ]);

    for (const [field] of Object.entries(fixtureTruth.expected_fields) as [PayslipFieldKey, unknown][]) {
      const resolution = resolutions.get(field);
      if (!resolution) continue;
      const firstMismatch = firstMismatches.get(field);
      const finalMismatch = finalMismatches.get(field);
      const recoveryIntroducedConflict = resolution.status === "conflicted" &&
        resolution.first_pass_status !== "conflicted";
      if (!firstMismatch && (finalMismatch || recoveryIntroducedConflict)) {
        const finalOutcome = resolution.status === "conflicted" ? "conflicted" : finalMismatch?.kind ?? "unknown";
        const detail = {
          fixture_id: artifact.fixture_id,
          field,
          first_pass_outcome: "correct",
          final_outcome: finalOutcome,
          resolution_state: resolution.status,
        };
        regressionDetails.push(detail);
        fixtureRegressions.push(field);
      }
      if (
        finalMismatch?.kind === "incorrect" &&
        fixtureTruth.critical_fields.includes(field) &&
        ["confirmed", "recovered"].includes(resolution.status) &&
        finalMismatch.gate0_result.status === "valid"
      ) {
        wrongAcceptedDetails.push({
          fixture_id: artifact.fixture_id,
          field,
          expected_value: finalMismatch.expected_value,
          extracted_value: finalMismatch.extracted_value,
          resolution_state: resolution.status,
          gate0_status: "valid",
        });
        fixtureWrongAccepted.push(field);
      }
      if (
        resolution.first_pass_status === "suspicious" &&
        resolution.status === "suspicious" &&
        resolution.reason_codes.includes("correlated_recovery_agreement_preserved")
      ) {
        suspiciousPreservedDetails.push({
          fixture_id: artifact.fixture_id,
          field,
          first_pass_outcome: "suspicious",
          final_outcome: "suspicious",
          resolution_state: resolution.status,
        });
      }
      if (
        resolution.status === "conflicted" &&
        resolution.selected_candidate_id === null &&
        resolution.reason_codes.includes("cross_pass_disagreement")
      ) {
        correctlyIntroducedConflictDetails.push({
          fixture_id: artifact.fixture_id,
          field,
          first_pass_outcome: resolution.first_pass_status,
          final_outcome: "conflicted",
          resolution_state: resolution.status,
        });
      }
      if (
        resolution.status === "recovered" &&
        fixtureTruth.critical_fields.includes(field) &&
        firstMismatch?.kind === "missing" &&
        !finalMismatch
      ) {
        recoveredMissingCriticalFields += 1;
      }
    }

    allFieldEvidence.push(
      ...fieldEvidence({
        fixtureId: artifact.fixture_id,
        stage: "first_pass",
        extraction: run.result.first_pass.normalized_extraction,
        validation: run.result.first_pass.validation,
        truth: fixtureTruth,
        provenanceByCandidate,
      }),
      ...fieldEvidence({
        fixtureId: artifact.fixture_id,
        stage: "final",
        extraction: run.result.final_extraction,
        validation: run.result.final_validation,
        truth: fixtureTruth,
        provenanceByCandidate,
      }),
    );

    const firstOperation = run.result.first_pass.raw_extraction.operation;
    const recoveryOperations = run.result.recovery_passes.map((pass) => pass.raw_extraction.operation);
    const firstTokens = tokens(firstOperation);
    const recoveryTokens = sumNullable(recoveryOperations.map(tokens));
    const firstCost = estimateOpenAiExtractionCostUsd(input.model, firstOperation.token_usage);
    const recoveryCost = sumNullable(recoveryOperations.map((operation) =>
      estimateOpenAiExtractionCostUsd(input.model, operation.token_usage)
    ));
    const recoveryDuration = recoveryOperations.reduce((sum, operation) => sum + operation.duration_ms, 0);
    firstLatency += firstOperation.duration_ms;
    recoveryLatency += recoveryDuration;
    firstTokenValues.push(firstTokens);
    recoveryTokenValues.push(recoveryTokens);
    const recoveryResults = run.result.resolutions.filter((resolution) =>
      run.result.recovery_decision.fields_requested.includes(resolution.field)
    );
    return {
      fixture_id: artifact.fixture_id,
      first_pass_accuracy: firstFixture.exact_field_accuracy,
      first_pass_critical_accuracy: firstFixture.critical_field_accuracy,
      final_accuracy: finalFixture.exact_field_accuracy,
      final_critical_accuracy: finalFixture.critical_field_accuracy,
      recovery_decision: run.result.recovery_decision,
      recovery_results: recoveryResults.map((resolution) => ({
        field: resolution.field,
        status: resolution.status,
        first_pass_status: resolution.first_pass_status,
        reason_codes: resolution.reason_codes,
      })),
      conflicts: recoveryResults.filter((resolution) => resolution.status === "conflicted").map((resolution) => resolution.field),
      recovered_fields: recoveryResults.filter((resolution) => resolution.status === "recovered").map((resolution) => resolution.field),
      regressions: fixtureRegressions,
      wrong_accepted_critical_values: fixtureWrongAccepted,
      historical_gate0_issues: sortedUnique(run.result.historical_validation.issues.map((issue) => issue.code)),
      current_gate0_issues: sortedUnique(run.result.current_validation.issues.map((issue) => issue.code)),
      final_gate0_issues: sortedUnique(run.result.final_validation.issues.map((issue) => issue.code)),
      resolved_historical_gate0_issues: run.result.resolved_historical_issue_codes,
      api_calls: 1 + recoveryOperations.length,
      latency_ms: {
        first_pass: firstOperation.duration_ms,
        recovery: recoveryDuration,
        final: firstOperation.duration_ms + recoveryDuration,
      },
      token_usage: {
        first_pass: firstTokens,
        recovery: recoveryTokens,
        final: firstTokens === null || recoveryTokens === null ? null : firstTokens + recoveryTokens,
      },
      cost_usd: {
        first_pass_usd: firstCost,
        recovery_usd: recoveryCost,
        final_usd: firstCost === null || recoveryCost === null ? null : firstCost + recoveryCost,
      },
    };
  });

  const additionalCalls = totalCalls - input.runs.length;
  const firstCost = sumNullable(perDocument.map((item) => item.cost_usd.first_pass_usd));
  const recoveryCost = sumNullable(perDocument.map((item) => item.cost_usd.recovery_usd));
  const firstTokens = sumNullable(firstTokenValues);
  const recoveryTokens = sumNullable(recoveryTokenValues);
  return openAiV21BenchmarkReportSchema.parse({
    report_version: "2.1",
    model: input.model,
    extractor_version: "2.1",
    salary_type_scoring: "documented_only",
    first_pass: firstPass,
    final_after_selective_recovery: finalStage,
    safety_metrics: {
      recovery_regressions: {
        count: regressionDetails.length,
        silent_count: regressionDetails.filter((detail) => detail.final_outcome !== "conflicted").length,
        details: regressionDetails,
      },
      wrong_accepted_critical_values: { count: wrongAcceptedDetails.length, details: wrongAcceptedDetails },
      suspicious_preserved: { count: suspiciousPreservedDetails.length, details: suspiciousPreservedDetails },
      correctly_introduced_conflicts: {
        count: correctlyIntroducedConflictDetails.length,
        details: correctlyIntroducedConflictDetails,
      },
      recovery_yield: {
        recovered_missing_critical_fields: recoveredMissingCriticalFields,
        additional_api_calls: additionalCalls,
        recovered_fields_per_call: additionalCalls === 0 ? null : recoveredMissingCriticalFields / additionalCalls,
      },
    },
    recovery_summary: {
      documents_requested: input.runs.filter((item) => item.run.result.recovery_decision.requested).length,
      documents_skipped: input.runs.filter((item) => item.run.result.recovery_decision.skipped).length,
      additional_api_calls: additionalCalls,
      total_fields_requested: input.runs.reduce(
        (sum, item) => sum + item.run.result.recovery_decision.fields_requested.length,
        0,
      ),
      requests: input.runs.map((item) => ({
        fixture_id: item.artifact.fixture_id,
        decision: item.run.result.recovery_decision,
      })),
    },
    total_cost: {
      first_pass_usd: firstCost,
      recovery_usd: recoveryCost,
      final_usd: firstCost === null || recoveryCost === null ? null : firstCost + recoveryCost,
    },
    total_latency_ms: {
      first_pass: firstLatency,
      recovery: recoveryLatency,
      final: firstLatency + recoveryLatency,
    },
    total_token_usage: {
      complete: firstTokens !== null && recoveryTokens !== null,
      first_pass: firstTokens ?? 0,
      recovery: recoveryTokens ?? 0,
      final: (firstTokens ?? 0) + (recoveryTokens ?? 0),
    },
    per_document: perDocument,
    field_evidence: allFieldEvidence,
  });
}
