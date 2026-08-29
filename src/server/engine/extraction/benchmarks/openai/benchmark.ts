import "server-only";
import { z } from "zod";
import type { PayslipPipelineResult } from "@/engine/extraction/pipeline";
import { runPayslipExtractionPipeline } from "@/engine/extraction/pipeline";
import { payslipFieldKeySchema, type ExtractionRequest, type PayslipFieldKey } from "@/engine/extraction/contracts";
import type { DocumentExtractor, PrivateDocumentSource } from "@/engine/extraction/provider";
import { resolvedPayslipFactPaths } from "@/engine/extraction/resolver";
import { gate0StatusSchema } from "@/engine/extraction/validation";
import { OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION } from "../../providers/openai/prompt";

const countMetricSchema = z.object({
  expected: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1).nullable(),
}).strict();

const gate0ResultSchema = z.object({
  status: gate0StatusSchema.nullable(),
  issue_codes: z.array(z.string()),
}).strict();

const mismatchSchema = z.object({
  field: payslipFieldKeySchema,
  kind: z.enum(["missing", "incorrect"]),
  expected_value: z.unknown(),
  extracted_value: z.unknown().nullable(),
  critical: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  warning_flags: z.array(z.string()),
  gate0_result: gate0ResultSchema,
}).strict();

const hallucinatedFieldDetailSchema = z.object({
  field: payslipFieldKeySchema,
  raw_extracted_value: z.string(),
  normalized_value: z.unknown(),
  confidence: z.number().min(0).max(1),
  warning_flags: z.array(z.string()),
  gate0_result: gate0ResultSchema,
}).strict();

const additionalComponentSchema = z.object({
  normalized_label: z.string().nullable(),
  quantity: z.string().nullable(),
  rate: z.unknown().nullable(),
  amount: z.unknown().nullable(),
  confidence: z.number().min(0).max(1),
  warning_flags: z.array(z.string()),
}).strict();

const fixtureMetricSchema = z.object({
  fixture_id: z.string(),
  quality: z.string(),
  format: z.enum(["pdf", "png", "jpg"]),
  extraction_failed: z.boolean(),
  extraction_status: z.enum(["completed", "partial", "failed", "exception"]),
  provider: z.object({
    provider_id: z.string(),
    model_version: z.string().nullable(),
    extractor_version: z.string(),
    prompt_version: z.string(),
  }).strict(),
  expected_fields: z.number().int().nonnegative(),
  exact_matches: z.number().int().nonnegative(),
  exact_field_accuracy: countMetricSchema,
  critical_field_accuracy: countMetricSchema,
  money_accuracy: countMetricSchema,
  hours_accuracy: countMetricSchema,
  salary_period_accuracy: countMetricSchema,
  missing_expected_fields: z.number().int().nonnegative(),
  wrong_fields: z.number().int().nonnegative(),
  hallucinated_fields: z.number().int().nonnegative(),
  mismatches: z.array(mismatchSchema),
  hallucinated_field_ids: z.array(payslipFieldKeySchema),
  hallucinated_field_details: z.array(hallucinatedFieldDetailSchema).optional(),
  gate0_status: gate0StatusSchema.nullable(),
  gate0_issue_codes: z.array(z.string()),
  expected_gate0_issue_codes: z.array(z.string()),
  unexpected_gate0_issue_codes: z.array(z.string()),
  extraction_warnings: z.array(z.string()),
  sensitive_metadata_candidates: z.number().int().nonnegative(),
  additional_components_expected: z.number().int().nonnegative(),
  additional_components_matched: z.number().int().nonnegative(),
  additional_components: z.array(additionalComponentSchema),
  duration_ms: z.number().int().nonnegative().nullable(),
  provider_response_id: z.string().nullable(),
  token_usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).strict().nullable(),
  estimated_cost_usd: z.number().nonnegative().nullable(),
}).strict();

const fieldMetricSchema = z.object({
  field: payslipFieldKeySchema,
  expected: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  wrong: z.number().int().nonnegative(),
  hallucinated: z.number().int().nonnegative(),
  accuracy: z.number().min(0).max(1).nullable(),
}).strict();

export const openAiRenderedBenchmarkReportSchema = z.object({
  report_version: z.literal("1.1"),
  provider_id: z.literal("openai"),
  model: z.string(),
  extractor_version: z.string(),
  prompt_version: z.string(),
  ground_truth_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  fixtures_total: z.number().int().positive(),
  provider_calls: z.number().int().nonnegative(),
  extraction_failures: z.number().int().nonnegative(),
  fields_expected: z.number().int().nonnegative(),
  exact_matches: z.number().int().nonnegative(),
  exact_field_accuracy: z.number().min(0).max(1).nullable(),
  critical_field_accuracy: countMetricSchema,
  money_accuracy: countMetricSchema,
  hours_accuracy: countMetricSchema,
  period_accuracy: countMetricSchema,
  missing_expected_fields: z.number().int().nonnegative(),
  wrong_fields: z.number().int().nonnegative(),
  hallucinated_fields: z.number().int().nonnegative(),
  gate0_catches: countMetricSchema,
  unexpected_gate0_warnings: z.number().int().nonnegative(),
  average_duration_ms: z.number().nonnegative().nullable(),
  token_usage: z.object({
    complete: z.boolean(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).strict(),
  estimated_cost_usd: z.number().nonnegative().nullable(),
  pricing: z.object({
    input_usd_per_million_tokens: z.number().nonnegative(),
    output_usd_per_million_tokens: z.number().nonnegative(),
    effective_on: z.string(),
    source: z.string().url(),
  }).strict().nullable(),
  critical_fields: z.array(z.object({
    field: payslipFieldKeySchema,
    expected: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1).nullable(),
  }).strict()),
  field_metrics: z.array(fieldMetricSchema),
  by_quality: z.array(z.object({
    quality: z.string(),
    fixtures: z.number().int().positive(),
    expected: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1).nullable(),
  }).strict()),
  per_fixture: z.array(fixtureMetricSchema),
}).strict();

export type OpenAiRenderedBenchmarkReport = Readonly<z.infer<typeof openAiRenderedBenchmarkReportSchema>>;

export type BenchmarkGroundTruth = Readonly<{
  fixture_id: string;
  expected_fields: Partial<Record<PayslipFieldKey, unknown>>;
  ambiguous_fields?: readonly Readonly<{ field: PayslipFieldKey; reason_code: string }>[];
  expected_absent_fields: readonly PayslipFieldKey[];
  critical_fields: readonly PayslipFieldKey[];
  expected_validation_issue_codes: readonly string[];
  additional_component_observations?: readonly Readonly<{
    observation_id: string;
    amount: Readonly<{ currency: "ILS"; minor_units: number }>;
    classification: string;
  }>[];
  classification_complete?: boolean;
}>;

export type BenchmarkArtifact = Readonly<{
  fixture_id: string;
  quality: string;
  format: "pdf" | "png" | "jpg";
  file_path: string;
  sha256: string;
  request: ExtractionRequest;
}>;

export type OpenAiBenchmarkRun = Readonly<{
  artifact: BenchmarkArtifact;
  result: PayslipPipelineResult | null;
}>;

export const openAiExtractionPricingCatalog: Readonly<Record<string, {
  input: number;
  output: number;
  effective_on: string;
  source: string;
}>> = {
  "gpt-5.6-sol": {
    input: 4,
    output: 20,
    effective_on: "2026-08-29",
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  },
};

const moneyFields = new Set<PayslipFieldKey>([
  "base_monthly_salary", "hourly_rate", "gross_salary", "total_deductions", "net_salary", "travel_amount",
  "convalescence_amount", "pension_employee_contribution", "pension_employer_contribution",
  "severance_contribution", "pension_base",
]);
const hoursFields = new Set<PayslipFieldKey>(["regular_hours", "overtime_125_hours", "overtime_150_hours"]);

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function exact(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function metric(expected: number, correct: number) {
  return { expected, correct, accuracy: expected === 0 ? null : correct / expected };
}

function estimatedCost(model: string, usage: { input_tokens: number; output_tokens: number } | null | undefined) {
  const pricing = openAiExtractionPricingCatalog[model];
  if (!pricing || !usage) return null;
  return (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000;
}

export const estimateOpenAiExtractionCostUsd = estimatedCost;

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

export function sensitiveValuesPresent(serialized: string, sensitiveValues: readonly string[]) {
  return sensitiveValues
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && serialized.includes(value));
}

export function scoreOpenAiBenchmarkRuns(input: {
  runs: readonly OpenAiBenchmarkRun[];
  groundTruth: readonly BenchmarkGroundTruth[];
  model: string;
  extractorVersion: string;
  groundTruthSha256?: string | null;
  promptVersion?: string;
}): OpenAiRenderedBenchmarkReport {
  const truthByFixture = new Map(input.groundTruth.map((truth) => [truth.fixture_id, truth]));
  let extractionFailures = 0;
  let fieldsExpected = 0;
  let exactMatches = 0;
  let missingExpected = 0;
  let wrongFields = 0;
  let hallucinated = 0;
  let criticalExpected = 0;
  let criticalCorrect = 0;
  let moneyExpected = 0;
  let moneyCorrect = 0;
  let hoursExpected = 0;
  let hoursCorrect = 0;
  let periodExpected = 0;
  let periodCorrect = 0;
  let gateExpected = 0;
  let gateCorrect = 0;
  let unexpectedGateWarnings = 0;
  let durationTotal = 0;
  let durationSamples = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let tokenSamples = 0;
  const criticalByField = new Map<PayslipFieldKey, { expected: number; correct: number }>();
  const fieldByName = new Map<PayslipFieldKey, { expected: number; correct: number; missing: number; wrong: number; hallucinated: number }>();
  const qualityMetrics = new Map<string, { fixtures: number; expected: number; correct: number }>();
  const perFixture: z.infer<typeof fixtureMetricSchema>[] = [];

  for (const run of input.runs) {
    const truth = truthByFixture.get(run.artifact.fixture_id);
    if (!truth) throw new TypeError(`Ground truth is missing for ${run.artifact.fixture_id}`);
    const expectedEntries = Object.entries(truth.expected_fields) as [PayslipFieldKey, unknown][];
    const failed = run.result === null || run.result.raw_extraction.status === "failed";
    if (failed) extractionFailures += 1;
    fieldsExpected += expectedEntries.length;
    const actual = new Map<PayslipFieldKey, NonNullable<OpenAiBenchmarkRun["result"]>["normalized_extraction"]["fields"][number]>();
    if (run.result) {
      for (const candidate of [...run.result.normalized_extraction.fields].sort((left, right) => right.confidence - left.confidence)) {
        if (candidate.normalized_value !== null && !actual.has(candidate.field)) actual.set(candidate.field, candidate);
      }
    }

    let fixtureExact = 0;
    let fixtureMissing = 0;
    let fixtureWrong = 0;
    let fixtureCriticalCorrect = 0;
    let fixtureMoneyExpected = 0;
    let fixtureMoneyCorrect = 0;
    let fixtureHoursExpected = 0;
    let fixtureHoursCorrect = 0;
    let fixturePeriodExpected = 0;
    let fixturePeriodCorrect = 0;
    const mismatches: z.infer<typeof mismatchSchema>[] = [];

    for (const [field, expectedValue] of expectedEntries) {
      const candidate = actual.get(field);
      const correct = candidate !== undefined && exact(candidate.normalized_value, expectedValue);
      const fieldMetric = fieldByName.get(field) ?? { expected: 0, correct: 0, missing: 0, wrong: 0, hallucinated: 0 };
      fieldMetric.expected += 1;
      if (correct) {
        exactMatches += 1;
        fixtureExact += 1;
        fieldMetric.correct += 1;
      } else if (!candidate) {
        missingExpected += 1;
        fixtureMissing += 1;
        fieldMetric.missing += 1;
      } else {
        wrongFields += 1;
        fixtureWrong += 1;
        fieldMetric.wrong += 1;
      }
      fieldByName.set(field, fieldMetric);

      if (!correct) {
        const assessment = candidate
          ? run.result?.validation.field_assessments.find((item) => item.candidate_id === candidate.candidate_id)
          : undefined;
        mismatches.push({
          field,
          kind: candidate ? "incorrect" : "missing",
          expected_value: expectedValue,
          extracted_value: candidate?.normalized_value ?? null,
          critical: truth.critical_fields.includes(field),
          confidence: candidate?.confidence ?? null,
          warning_flags: candidate?.warning_flags ?? [],
          gate0_result: {
            status: assessment?.status ?? null,
            issue_codes: assessment?.issue_codes ?? [],
          },
        });
      }

      if (moneyFields.has(field)) {
        moneyExpected += 1;
        fixtureMoneyExpected += 1;
        if (correct) {
          moneyCorrect += 1;
          fixtureMoneyCorrect += 1;
        }
      }
      if (hoursFields.has(field)) {
        hoursExpected += 1;
        fixtureHoursExpected += 1;
        if (correct) {
          hoursCorrect += 1;
          fixtureHoursCorrect += 1;
        }
      }
      if (field === "salary_period") {
        periodExpected += 1;
        fixturePeriodExpected += 1;
        if (correct) {
          periodCorrect += 1;
          fixturePeriodCorrect += 1;
        }
      }
      if (truth.critical_fields.includes(field)) {
        criticalExpected += 1;
        if (correct) {
          criticalCorrect += 1;
          fixtureCriticalCorrect += 1;
        }
        const perField = criticalByField.get(field) ?? { expected: 0, correct: 0 };
        perField.expected += 1;
        if (correct) perField.correct += 1;
        criticalByField.set(field, perField);
      }
    }

    const expectedNames = new Set(expectedEntries.map(([field]) => field));
    const ambiguousNames = new Set(truth.ambiguous_fields?.map((entry) => entry.field) ?? []);
    const explicitlyAbsent = new Set(truth.expected_absent_fields);
    const hallucinatedFieldIds = [...actual.keys()].filter((field) => {
      if (expectedNames.has(field) || ambiguousNames.has(field)) return false;
      return explicitlyAbsent.has(field);
    });
    for (const field of hallucinatedFieldIds) {
      const fieldMetric = fieldByName.get(field) ?? { expected: 0, correct: 0, missing: 0, wrong: 0, hallucinated: 0 };
      fieldMetric.hallucinated += 1;
      fieldByName.set(field, fieldMetric);
    }
    hallucinated += hallucinatedFieldIds.length;
    const hallucinatedFieldDetails = hallucinatedFieldIds.flatMap((field) => {
      const candidate = actual.get(field);
      if (!candidate) return [];
      const assessment = run.result?.validation.field_assessments.find(
        (item) => item.candidate_id === candidate.candidate_id,
      );
      return [{
        field,
        raw_extracted_value: candidate.raw_value,
        normalized_value: candidate.normalized_value,
        confidence: candidate.confidence,
        warning_flags: candidate.warning_flags,
        gate0_result: {
          status: assessment?.status ?? null,
          issue_codes: assessment?.issue_codes ?? [],
        },
      }];
    });

    const issueCodes = sortedUnique(run.result?.validation.issues.map((issue) => issue.code) ?? []);
    const expectedIssueCodes = sortedUnique(truth.expected_validation_issue_codes);
    const fixtureGateCorrect = expectedIssueCodes.filter((code) => issueCodes.includes(code)).length;
    const unexpectedIssueCodes = issueCodes.filter((code) => !expectedIssueCodes.includes(code));
    gateExpected += expectedIssueCodes.length;
    gateCorrect += fixtureGateCorrect;
    unexpectedGateWarnings += unexpectedIssueCodes.length;

    const operation = run.result?.raw_extraction.operation;
    if (operation) {
      durationTotal += operation.duration_ms;
      durationSamples += 1;
      if (operation.token_usage) {
        inputTokens += operation.token_usage.input_tokens;
        outputTokens += operation.token_usage.output_tokens;
        totalTokens += operation.token_usage.total_tokens;
        tokenSamples += 1;
      }
    }
    const quality = qualityMetrics.get(run.artifact.quality) ?? { fixtures: 0, expected: 0, correct: 0 };
    quality.fixtures += 1;
    quality.expected += expectedEntries.length;
    quality.correct += fixtureExact;
    qualityMetrics.set(run.artifact.quality, quality);

    const expectedAdditional = truth.additional_component_observations ?? [];
    const extractedAdditional = run.result?.normalized_extraction.additional_components ?? [];
    const unmatchedAmounts = extractedAdditional.map((component) => component.amount);
    let additionalMatched = 0;
    for (const expected of expectedAdditional) {
      const matchIndex = unmatchedAmounts.findIndex((amount) => exact(amount, expected.amount));
      if (matchIndex >= 0) {
        additionalMatched += 1;
        unmatchedAmounts.splice(matchIndex, 1);
      }
    }

    const provider = run.result?.raw_extraction.provider;
    const fixtureCriticalExpected = truth.critical_fields.length;
    perFixture.push({
      fixture_id: run.artifact.fixture_id,
      quality: run.artifact.quality,
      format: run.artifact.format,
      extraction_failed: failed,
      extraction_status: run.result?.raw_extraction.status ?? "exception",
      provider: {
        provider_id: provider?.provider_id ?? "openai",
        model_version: provider?.model_version ?? input.model,
        extractor_version: provider?.extractor_version ?? input.extractorVersion,
        prompt_version: input.promptVersion ?? OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION,
      },
      expected_fields: expectedEntries.length,
      exact_matches: fixtureExact,
      exact_field_accuracy: metric(expectedEntries.length, fixtureExact),
      critical_field_accuracy: metric(fixtureCriticalExpected, fixtureCriticalCorrect),
      money_accuracy: metric(fixtureMoneyExpected, fixtureMoneyCorrect),
      hours_accuracy: metric(fixtureHoursExpected, fixtureHoursCorrect),
      salary_period_accuracy: metric(fixturePeriodExpected, fixturePeriodCorrect),
      missing_expected_fields: fixtureMissing,
      wrong_fields: fixtureWrong,
      hallucinated_fields: hallucinatedFieldIds.length,
      mismatches,
      hallucinated_field_ids: hallucinatedFieldIds,
      hallucinated_field_details: hallucinatedFieldDetails,
      gate0_status: run.result?.validation.status ?? null,
      gate0_issue_codes: issueCodes,
      expected_gate0_issue_codes: expectedIssueCodes,
      unexpected_gate0_issue_codes: unexpectedIssueCodes,
      extraction_warnings: sortedUnique(run.result?.raw_extraction.warnings ?? []),
      sensitive_metadata_candidates: run.result?.raw_extraction.sensitive_metadata.length ?? 0,
      additional_components_expected: expectedAdditional.length,
      additional_components_matched: additionalMatched,
      additional_components: extractedAdditional.map((component) => ({
        normalized_label: component.normalized_label,
        quantity: component.quantity,
        rate: component.rate,
        amount: component.amount,
        confidence: component.confidence,
        warning_flags: sortedUnique([...component.warning_flags, ...component.normalization_warnings]),
      })),
      duration_ms: operation?.duration_ms ?? null,
      provider_response_id: operation?.provider_response_id ?? null,
      token_usage: operation?.token_usage ?? null,
      estimated_cost_usd: estimatedCost(input.model, operation?.token_usage),
    });
  }

  const pricingEntry = openAiExtractionPricingCatalog[input.model] ?? null;
  const tokenUsageComplete = tokenSamples === input.runs.length;
  const totalEstimatedCost = pricingEntry && tokenUsageComplete
    ? (inputTokens * pricingEntry.input + outputTokens * pricingEntry.output) / 1_000_000
    : null;
  return openAiRenderedBenchmarkReportSchema.parse({
    report_version: "1.1",
    provider_id: "openai",
    model: input.model,
    extractor_version: input.extractorVersion,
    prompt_version: input.promptVersion ?? OPENAI_PAYSLIP_EXTRACTION_PROMPT_VERSION,
    ground_truth_sha256: input.groundTruthSha256 ?? null,
    fixtures_total: input.runs.length,
    provider_calls: input.runs.length,
    extraction_failures: extractionFailures,
    fields_expected: fieldsExpected,
    exact_matches: exactMatches,
    exact_field_accuracy: fieldsExpected === 0 ? null : exactMatches / fieldsExpected,
    critical_field_accuracy: metric(criticalExpected, criticalCorrect),
    money_accuracy: metric(moneyExpected, moneyCorrect),
    hours_accuracy: metric(hoursExpected, hoursCorrect),
    period_accuracy: metric(periodExpected, periodCorrect),
    missing_expected_fields: missingExpected,
    wrong_fields: wrongFields,
    hallucinated_fields: hallucinated,
    gate0_catches: metric(gateExpected, gateCorrect),
    unexpected_gate0_warnings: unexpectedGateWarnings,
    average_duration_ms: durationSamples === 0 ? null : durationTotal / durationSamples,
    token_usage: { complete: tokenUsageComplete, input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
    estimated_cost_usd: totalEstimatedCost,
    pricing: pricingEntry ? {
      input_usd_per_million_tokens: pricingEntry.input,
      output_usd_per_million_tokens: pricingEntry.output,
      effective_on: pricingEntry.effective_on,
      source: pricingEntry.source,
    } : null,
    critical_fields: [...criticalByField.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([field, value]) => ({
      field,
      ...metric(value.expected, value.correct),
    })),
    field_metrics: [...fieldByName.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([field, value]) => ({
      field,
      ...value,
      accuracy: value.expected === 0 ? null : value.correct / value.expected,
    })),
    by_quality: [...qualityMetrics.entries()].map(([quality, value]) => ({
      quality,
      fixtures: value.fixtures,
      expected: value.expected,
      correct: value.correct,
      accuracy: value.expected === 0 ? null : value.correct / value.expected,
    })),
    per_fixture: perFixture,
  });
}

export async function runRenderedOpenAiBenchmark(input: {
  extractor: DocumentExtractor;
  source: PrivateDocumentSource;
  artifacts: readonly BenchmarkArtifact[];
  groundTruth: readonly BenchmarkGroundTruth[];
  model: string;
  referenceYear: number;
  groundTruthSha256?: string | null;
}) {
  const runs: OpenAiBenchmarkRun[] = [];
  for (const [index, artifact] of input.artifacts.entries()) {
    try {
      const factIds = Object.fromEntries(resolvedPayslipFactPaths.map((factPath, factIndex) => [factPath, uuid(60_000 + index * 100 + factIndex)]));
      const result = await runPayslipExtractionPipeline({
        request: artifact.request,
        extractor: input.extractor,
        source: input.source,
        snapshot_context: {
          snapshot_id: uuid(50_000 + index),
          case_id: artifact.request.case_id,
          analysis_run_id: artifact.request.analysis_run_id,
          schema_version: "1.0",
          created_at: artifact.request.requested_at,
          fact_ids: factIds,
        },
        reference_year: input.referenceYear,
      });
      runs.push({ artifact, result });
    } catch {
      runs.push({ artifact, result: null });
    }
  }
  return scoreOpenAiBenchmarkRuns({
    runs,
    groundTruth: input.groundTruth,
    model: input.model,
    extractorVersion: input.extractor.extractorVersion,
    groundTruthSha256: input.groundTruthSha256,
  });
}
