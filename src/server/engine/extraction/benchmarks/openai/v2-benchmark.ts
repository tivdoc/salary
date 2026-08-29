import "server-only";
import { z } from "zod";
import type { PayslipFieldKey } from "@/engine/extraction/contracts";
import { minimizePayslipForSemanticProcessing } from "@/engine/extraction/minimize";
import type { NormalizedPayslipExtraction } from "@/engine/extraction/payslip";
import type { PayslipPipelineResult } from "@/engine/extraction/pipeline";
import type { OpenAiPayslipV2Run } from "../../providers/openai/v2-adapter";
import { OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION } from "../../providers/openai/v2-prompt";
import {
  estimateOpenAiExtractionCostUsd,
  openAiRenderedBenchmarkReportSchema,
  scoreOpenAiBenchmarkRuns,
  type BenchmarkArtifact,
  type BenchmarkGroundTruth,
  type OpenAiRenderedBenchmarkReport,
} from "./benchmark";

export type OpenAiV2BenchmarkRun = Readonly<{
  artifact: BenchmarkArtifact;
  run: OpenAiPayslipV2Run;
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

export const openAiV2BenchmarkReportSchema = z.object({
  report_version: z.literal("2.0"),
  model: z.string(),
  extractor_version: z.literal("2.0"),
  salary_type_scoring: z.literal("documented_only"),
  first_pass: openAiRenderedBenchmarkReportSchema,
  final_after_targeted_recovery: openAiRenderedBenchmarkReportSchema,
  critical_accuracy_improvement: z.number(),
  additional_api_calls: z.number().int().nonnegative(),
  critical_accuracy_improvement_per_additional_call: z.number().nullable(),
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
    recovery_fields: z.array(z.string()),
    recovery_results: z.array(z.object({ field: z.string(), status: z.string(), reason_codes: z.array(z.string()) }).strict()),
    conflicts: z.array(z.string()),
    recovered_fields: z.array(z.string()),
    unresolved_fields: z.array(z.string()),
    first_pass_wrong_values: z.number().int().nonnegative(),
    final_wrong_values: z.number().int().nonnegative(),
    first_pass_missing_values: z.number().int().nonnegative(),
    final_missing_values: z.number().int().nonnegative(),
    first_pass_hallucinations: z.number().int().nonnegative(),
    final_hallucinations: z.number().int().nonnegative(),
    first_pass_gate0_issues: z.array(z.string()),
    final_gate0_issues: z.array(z.string()),
    api_calls: z.number().int().positive(),
    latency_ms: z.object({ first_pass: z.number().int().nonnegative(), recovery: z.number().int().nonnegative(), final: z.number().int().nonnegative() }).strict(),
    token_usage: z.object({ first_pass: z.number().int().nonnegative().nullable(), recovery: z.number().int().nonnegative().nullable(), final: z.number().int().nonnegative().nullable() }).strict(),
    cost_usd: stageCostSchema,
  }).strict()),
  field_comparison: z.array(z.object({
    field: z.string(),
    v1: countMetricSchema.nullable(),
    v2_first_pass: countMetricSchema.nullable(),
    v2_final: countMetricSchema.nullable(),
  }).strict()),
}).strict();

export type OpenAiV2BenchmarkReport = Readonly<z.infer<typeof openAiV2BenchmarkReportSchema>>;

const comparisonFields: readonly PayslipFieldKey[] = [
  "salary_period",
  "salary_type",
  "base_monthly_salary",
  "gross_salary",
  "net_salary",
  "hourly_rate",
  "regular_hours",
  "overtime_125_hours",
  "overtime_150_hours",
  "pension_base",
  "pension_employee_contribution",
  "pension_employer_contribution",
  "severance_contribution",
  "travel_amount",
];

export function groundTruthForDocumentedSalaryType(
  groundTruth: readonly BenchmarkGroundTruth[],
  explicitSalaryTypeFixtureIds: readonly string[] = [],
) {
  const explicit = new Set(explicitSalaryTypeFixtureIds);
  return groundTruth.map((truth) => {
    if (explicit.has(truth.fixture_id) || !("salary_type" in truth.expected_fields)) return truth;
    const expectedFields = { ...truth.expected_fields };
    delete expectedFields.salary_type;
    return {
      ...truth,
      expected_fields: expectedFields,
      critical_fields: truth.critical_fields.filter((field) => field !== "salary_type"),
      ambiguous_fields: [
        ...(truth.ambiguous_fields ?? []),
        { field: "salary_type" as const, reason_code: "salary_type_not_explicitly_documented" },
      ],
    };
  });
}

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

function firstPassPipeline(run: OpenAiPayslipV2Run): PayslipPipelineResult {
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

function finalPipeline(run: OpenAiPayslipV2Run): PayslipPipelineResult {
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

function fieldMetric(report: OpenAiRenderedBenchmarkReport, field: PayslipFieldKey) {
  const metric = report.field_metrics.find((item) => item.field === field);
  return metric ? { expected: metric.expected, correct: metric.correct, accuracy: metric.accuracy } : null;
}

export function buildOpenAiV2BenchmarkReport(input: {
  runs: readonly OpenAiV2BenchmarkRun[];
  groundTruth: readonly BenchmarkGroundTruth[];
  model: string;
  v1Report?: unknown;
  groundTruthSha256?: string | null;
  explicitSalaryTypeFixtureIds?: readonly string[];
}): OpenAiV2BenchmarkReport {
  const v2Truth = groundTruthForDocumentedSalaryType(input.groundTruth, input.explicitSalaryTypeFixtureIds);
  const firstPass = scoreOpenAiBenchmarkRuns({
    runs: input.runs.map(({ artifact, run }) => ({ artifact, result: firstPassPipeline(run) })),
    groundTruth: v2Truth,
    model: input.model,
    extractorVersion: "2.0",
    promptVersion: OPENAI_PAYSLIP_V2_FIRST_PASS_PROMPT_VERSION,
    groundTruthSha256: input.groundTruthSha256,
  });
  const finalScored = scoreOpenAiBenchmarkRuns({
    runs: input.runs.map(({ artifact, run }) => ({ artifact, result: finalPipeline(run) })),
    groundTruth: v2Truth,
    model: input.model,
    extractorVersion: "2.0",
    promptVersion: "payslip-extraction-openai-v2-final",
    groundTruthSha256: input.groundTruthSha256,
  });
  const totalCalls = input.runs.reduce((sum, item) => sum + 1 + item.run.result.recovery_passes.length, 0);
  const finalStage = { ...finalScored, provider_calls: totalCalls };
  const v1Parsed = openAiRenderedBenchmarkReportSchema.safeParse(input.v1Report);

  let firstLatency = 0;
  let recoveryLatency = 0;
  const firstTokenValues: (number | null)[] = [];
  const recoveryTokenValues: (number | null)[] = [];
  const perDocument = input.runs.map(({ artifact, run }, index) => {
    const firstFixture = firstPass.per_fixture[index];
    const finalFixture = finalStage.per_fixture[index];
    const firstOperation = run.result.first_pass.raw_extraction.operation;
    const recoveryOperations = run.result.recovery_passes.map((pass) => pass.raw_extraction.operation);
    const firstTokens = tokens(firstOperation);
    const recoveryTokens = sumNullable(recoveryOperations.map(tokens));
    const firstCost = estimateOpenAiExtractionCostUsd(input.model, firstOperation.token_usage);
    const recoveryCosts = recoveryOperations.map((operation) => estimateOpenAiExtractionCostUsd(input.model, operation.token_usage));
    const recoveryCost = sumNullable(recoveryCosts);
    firstLatency += firstOperation.duration_ms;
    const recoveryDuration = recoveryOperations.reduce((sum, operation) => sum + operation.duration_ms, 0);
    recoveryLatency += recoveryDuration;
    firstTokenValues.push(firstTokens);
    recoveryTokenValues.push(recoveryTokens);
    const resolutionByField = run.result.resolutions.filter((resolution) =>
      run.result.recovery_passes.some((pass) => pass.requested_fields.includes(resolution.field))
    );
    return {
      fixture_id: artifact.fixture_id,
      first_pass_accuracy: firstFixture.exact_field_accuracy,
      first_pass_critical_accuracy: firstFixture.critical_field_accuracy,
      final_accuracy: finalFixture.exact_field_accuracy,
      final_critical_accuracy: finalFixture.critical_field_accuracy,
      recovery_fields: run.result.recovery_passes.flatMap((pass) => pass.requested_fields),
      recovery_results: resolutionByField.map((resolution) => ({
        field: resolution.field,
        status: resolution.status,
        reason_codes: resolution.reason_codes,
      })),
      conflicts: resolutionByField.filter((resolution) => resolution.status === "conflicted").map((resolution) => resolution.field),
      recovered_fields: resolutionByField
        .filter((resolution) => ["promoted_recovery", "cross_pass_agreement"].includes(resolution.status))
        .map((resolution) => resolution.field),
      unresolved_fields: resolutionByField
        .filter((resolution) => ["missing", "invalid", "conflicted"].includes(resolution.status))
        .map((resolution) => resolution.field),
      first_pass_wrong_values: firstFixture.wrong_fields,
      final_wrong_values: finalFixture.wrong_fields,
      first_pass_missing_values: firstFixture.missing_expected_fields,
      final_missing_values: finalFixture.missing_expected_fields,
      first_pass_hallucinations: firstFixture.hallucinated_fields,
      final_hallucinations: finalFixture.hallucinated_fields,
      first_pass_gate0_issues: firstFixture.gate0_issue_codes,
      final_gate0_issues: finalFixture.gate0_issue_codes,
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

  const firstCost = sumNullable(perDocument.map((item) => item.cost_usd.first_pass_usd));
  const recoveryCost = sumNullable(perDocument.map((item) => item.cost_usd.recovery_usd));
  const firstTokens = sumNullable(firstTokenValues);
  const recoveryTokens = sumNullable(recoveryTokenValues);
  const firstAccuracy = firstPass.critical_field_accuracy.accuracy ?? 0;
  const finalAccuracy = finalStage.critical_field_accuracy.accuracy ?? 0;
  const additionalCalls = totalCalls - input.runs.length;
  return openAiV2BenchmarkReportSchema.parse({
    report_version: "2.0",
    model: input.model,
    extractor_version: "2.0",
    salary_type_scoring: "documented_only",
    first_pass: firstPass,
    final_after_targeted_recovery: finalStage,
    critical_accuracy_improvement: finalAccuracy - firstAccuracy,
    additional_api_calls: additionalCalls,
    critical_accuracy_improvement_per_additional_call: additionalCalls === 0
      ? null
      : (finalAccuracy - firstAccuracy) / additionalCalls,
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
    field_comparison: comparisonFields.map((field) => ({
      field: field === "salary_type" ? "explicit_salary_type" : field,
      v1: v1Parsed.success ? fieldMetric(v1Parsed.data, field) : null,
      v2_first_pass: fieldMetric(firstPass, field),
      v2_final: fieldMetric(finalStage, field),
    })),
  });
}
