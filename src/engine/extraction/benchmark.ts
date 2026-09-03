import { z } from "zod";
import type { PayslipFieldKey } from "./contracts.ts";
import type { SyntheticGroundTruth } from "./fixtures/ground-truth.ts";
import type { SyntheticPayslipFixture } from "./fixtures/source-fixtures.ts";
import { runPayslipExtractionPipeline } from "./pipeline.ts";
import type { DocumentExtractor, PrivateDocumentSource } from "./provider.ts";
import { resolvedPayslipFactPaths } from "./resolver.ts";

const metricSchema = z
  .object({ expected: z.number().int().nonnegative(), correct: z.number().int().nonnegative() })
  .strict();

export const payslipBenchmarkReportSchema = z
  .object({
    provider_id: z.string(),
    extractor_version: z.string(),
    fixtures_total: z.number().int().positive(),
    extraction_failures: z.number().int().nonnegative(),
    fields_expected: z.number().int().nonnegative(),
    exact_matches: z.number().int().nonnegative(),
    missing_expected_fields: z.number().int().nonnegative(),
    hallucinated_fields: z.number().int().nonnegative(),
    expected_absent_fields: z.number().int().nonnegative(),
    absent_field_false_positives: z.number().int().nonnegative(),
    money_accuracy: metricSchema,
    hours_accuracy: metricSchema,
    period_accuracy: metricSchema,
    validation_catches: metricSchema,
    confidence_calibration: z
      .object({ samples: z.number().int().nonnegative(), brier_score: z.number().min(0).max(1) })
      .strict(),
    per_fixture: z.array(
      z
        .object({
          fixture_id: z.string(),
          expected_fields: z.number().int().nonnegative(),
          exact_matches: z.number().int().nonnegative(),
          missing_expected_fields: z.number().int().nonnegative(),
          hallucinated_fields: z.number().int().nonnegative(),
          validation_expected: z.number().int().nonnegative(),
          validation_detected: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export type PayslipBenchmarkReport = Readonly<z.infer<typeof payslipBenchmarkReportSchema>>;

function syntheticUuid(value: number) {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function exactlyEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMoneyField(field: PayslipFieldKey) {
  return [
    "base_monthly_salary",
    "hourly_rate",
    "gross_salary",
    "total_deductions",
    "net_salary",
    "travel_amount",
    "convalescence_amount",
    "pension_employee_contribution",
    "pension_employer_contribution",
    "severance_contribution",
    "pension_base",
  ].includes(field);
}

function isHoursField(field: PayslipFieldKey) {
  return ["regular_hours", "overtime_125_hours", "overtime_150_hours"].includes(field);
}

export async function benchmarkPayslipExtractor(input: {
  extractor: DocumentExtractor;
  source: PrivateDocumentSource;
  fixtures: readonly SyntheticPayslipFixture[];
  ground_truth: readonly SyntheticGroundTruth[];
  reference_year: number;
}): Promise<PayslipBenchmarkReport> {
  const truthByFixture = new Map(input.ground_truth.map((truth) => [truth.fixture_id, truth]));
  let extractionFailures = 0;
  let fieldsExpected = 0;
  let exactMatches = 0;
  let missingExpectedFields = 0;
  let hallucinatedFields = 0;
  let expectedAbsentFields = 0;
  let absentFieldFalsePositives = 0;
  const moneyAccuracy = { expected: 0, correct: 0 };
  const hoursAccuracy = { expected: 0, correct: 0 };
  const periodAccuracy = { expected: 0, correct: 0 };
  const validationCatches = { expected: 0, correct: 0 };
  let calibrationSamples = 0;
  let calibrationSquaredError = 0;
  const perFixture: PayslipBenchmarkReport["per_fixture"] = [];

  for (const [fixtureIndex, fixture] of input.fixtures.entries()) {
    const truth = truthByFixture.get(fixture.fixture_id);
    if (!truth) throw new TypeError(`Ground truth is missing for fixture ${fixture.fixture_id}`);
    const expectedEntries = Object.entries(truth.expected_fields) as [PayslipFieldKey, unknown][];
    fieldsExpected += expectedEntries.length;
    moneyAccuracy.expected += expectedEntries.filter(([field]) => isMoneyField(field)).length;
    hoursAccuracy.expected += expectedEntries.filter(([field]) => isHoursField(field)).length;
    periodAccuracy.expected += expectedEntries.filter(([field]) => field === "salary_period").length;
    validationCatches.expected += truth.expected_validation_issue_codes.length;
    expectedAbsentFields += truth.expected_absent_fields.length;
    try {
      const factIds = Object.fromEntries(
        resolvedPayslipFactPaths.map((path, pathIndex) => [path, syntheticUuid(10_000 + fixtureIndex * 100 + pathIndex)]),
      );
      const result = await runPayslipExtractionPipeline({
        request: fixture.request,
        extractor: input.extractor,
        source: input.source,
        snapshot_context: {
          snapshot_id: syntheticUuid(5_000 + fixtureIndex),
          case_id: fixture.request.case_id,
          analysis_run_id: fixture.request.analysis_run_id,
          schema_version: "1.0",
          created_at: fixture.request.requested_at,
          fact_ids: factIds,
        },
        reference_year: input.reference_year,
      });
      const actualByField = new Map<PayslipFieldKey, (typeof result.normalized_extraction.fields)[number]>();
      for (const field of result.normalized_extraction.fields
        .filter((candidate) => candidate.normalized_value !== null)
        .sort((left, right) => right.confidence - left.confidence)) {
        if (!actualByField.has(field.field)) actualByField.set(field.field, field);
      }
      let fixtureExact = 0;
      let fixtureMissing = 0;
      for (const [field, expected] of expectedEntries) {
        const actual = actualByField.get(field);
        const correct = actual !== undefined && exactlyEqual(actual.normalized_value, expected);
        if (correct) {
          exactMatches += 1;
          fixtureExact += 1;
        } else if (!actual) {
          missingExpectedFields += 1;
          fixtureMissing += 1;
        }
        if (isMoneyField(field)) {
          if (correct) moneyAccuracy.correct += 1;
        }
        if (isHoursField(field)) {
          if (correct) hoursAccuracy.correct += 1;
        }
        if (field === "salary_period") {
          if (correct) periodAccuracy.correct += 1;
        }
        if (actual) {
          calibrationSamples += 1;
          calibrationSquaredError += (actual.confidence - (correct ? 1 : 0)) ** 2;
        }
      }

      const expectedFieldNames = new Set(expectedEntries.map(([field]) => field));
      const absentFieldNames = new Set(truth.expected_absent_fields);
      const fixtureHallucinated = [...actualByField.keys()].filter(
        (field) => !expectedFieldNames.has(field) && !absentFieldNames.has(field),
      ).length;
      hallucinatedFields += fixtureHallucinated;
      absentFieldFalsePositives += truth.expected_absent_fields.filter((field) => actualByField.has(field)).length;

      const actualIssueCodes = new Set(result.validation.issues.map((issue) => issue.code));
      const validationDetected = truth.expected_validation_issue_codes.filter((code) => actualIssueCodes.has(code)).length;
      validationCatches.correct += validationDetected;
      perFixture.push({
        fixture_id: fixture.fixture_id,
        expected_fields: expectedEntries.length,
        exact_matches: fixtureExact,
        missing_expected_fields: fixtureMissing,
        hallucinated_fields: fixtureHallucinated,
        validation_expected: truth.expected_validation_issue_codes.length,
        validation_detected: validationDetected,
      });
    } catch {
      extractionFailures += 1;
      missingExpectedFields += expectedEntries.length;
      perFixture.push({
        fixture_id: fixture.fixture_id,
        expected_fields: Object.keys(truth.expected_fields).length,
        exact_matches: 0,
        missing_expected_fields: Object.keys(truth.expected_fields).length,
        hallucinated_fields: 0,
        validation_expected: truth.expected_validation_issue_codes.length,
        validation_detected: 0,
      });
    }
  }

  return payslipBenchmarkReportSchema.parse({
    provider_id: input.extractor.providerId,
    extractor_version: input.extractor.extractorVersion,
    fixtures_total: input.fixtures.length,
    extraction_failures: extractionFailures,
    fields_expected: fieldsExpected,
    exact_matches: exactMatches,
    missing_expected_fields: missingExpectedFields,
    hallucinated_fields: hallucinatedFields,
    expected_absent_fields: expectedAbsentFields,
    absent_field_false_positives: absentFieldFalsePositives,
    money_accuracy: moneyAccuracy,
    hours_accuracy: hoursAccuracy,
    period_accuracy: periodAccuracy,
    validation_catches: validationCatches,
    confidence_calibration: {
      samples: calibrationSamples,
      brier_score: calibrationSamples === 0 ? 0 : calibrationSquaredError / calibrationSamples,
    },
    per_fixture: perFixture,
  });
}
