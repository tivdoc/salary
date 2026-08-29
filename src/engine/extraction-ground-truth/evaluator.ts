import type { CalculationValue } from "../calculations/contracts.ts";
import { calculationValueSchema } from "../calculations/contracts.ts";
import type { GroundTruthManifest } from "../wave2/contracts.ts";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../rule-runtime/canonical.ts";
import { requireGroundTruth } from "./errors.ts";
import { validateGroundTruthManifest } from "./validation.ts";

export type GroundTruthFieldCategory = "monetary" | "hours" | "pay_period" | "other";

export type GroundTruthFieldProfile = Readonly<{
  field_identity: string;
  category: GroundTruthFieldCategory;
  critical: boolean;
}>;

export type ExtractionBenchmarkPrediction = Readonly<{
  field_identity: string;
  value: CalculationValue;
  conflict_detected: boolean;
}>;

export type AccuracyMetric = Readonly<{
  expected: number;
  correct: number;
  accuracy: string;
}>;

export type GroundTruthErrorMatrixRow = Readonly<{
  field_identity: string;
  category: GroundTruthFieldCategory;
  critical: boolean;
  value_outcome: "correct" | "value_mismatch" | "missed" | "unexpected";
  conflict_outcome: "correct" | "false_conflict" | "missed_conflict";
}>;

export type GroundTruthEvaluationReport = Readonly<{
  benchmark_id: string;
  benchmark_version: string;
  manifest_id: string;
  manifest_revision: number;
  locked_ground_truth_sha256: string;
  overall_accuracy: AccuracyMetric;
  critical_field_accuracy: AccuracyMetric;
  monetary_accuracy: AccuracyMetric;
  hours_accuracy: AccuracyMetric;
  pay_period_accuracy: AccuracyMetric;
  field_error_matrix: readonly GroundTruthErrorMatrixRow[];
  false_conflicts: readonly string[];
  missed_conflicts: readonly string[];
  evaluated_at: string;
  report_sha256: string;
}>;

function decimalRatio(correct: number, expected: number): string {
  if (expected === 0) return "1";
  const scale = BigInt(1_000_000);
  const scaled = (BigInt(correct) * scale) / BigInt(expected);
  if (scaled === scale) return "1";
  const digits = scaled.toString().padStart(6, "0").replace(/0+$/, "");
  return `0.${digits || "0"}`;
}

function metric(rows: readonly GroundTruthErrorMatrixRow[], predicate: (row: GroundTruthErrorMatrixRow) => boolean): AccuracyMetric {
  const selected = rows.filter(predicate);
  const correct = selected.filter((row) => row.value_outcome === "correct").length;
  return { expected: selected.length, correct, accuracy: decimalRatio(correct, selected.length) };
}

function adjudicatedValues(manifest: GroundTruthManifest) {
  return new Map(
    manifest.annotations
      .filter((annotation) => annotation.annotation_pass === "human_adjudication")
      .map((annotation) => [annotation.field_identity, annotation.value]),
  );
}

function disagreementByField(manifest: GroundTruthManifest) {
  const first = new Map(
    manifest.annotations
      .filter((annotation) => annotation.annotation_pass === "annotation_1")
      .map((annotation) => [annotation.field_identity, annotation.value]),
  );
  const second = new Map(
    manifest.annotations
      .filter((annotation) => annotation.annotation_pass === "annotation_2")
      .map((annotation) => [annotation.field_identity, annotation.value]),
  );
  return new Map(
    [...first].map(([identity, value]) => [
      identity,
      second.has(identity) && canonicalStringify(value) !== canonicalStringify(second.get(identity)),
    ]),
  );
}

function validateProfiles(profiles: readonly GroundTruthFieldProfile[], groundTruthFields: ReadonlySet<string>) {
  const identities = new Set<string>();
  for (const profile of profiles) {
    requireGroundTruth(profile.field_identity.trim().length > 0, "ground_truth_profile_identity_required");
    requireGroundTruth(!identities.has(profile.field_identity), "ground_truth_duplicate_field_profile");
    identities.add(profile.field_identity);
  }
  requireGroundTruth(
    profiles.length === groundTruthFields.size && profiles.every((profile) => groundTruthFields.has(profile.field_identity)),
    "ground_truth_field_profiles_must_cover_locked_fields",
  );
}

export function evaluateLockedGroundTruth(input: {
  benchmark_id: string;
  benchmark_version: string;
  manifest: GroundTruthManifest;
  field_profiles: readonly GroundTruthFieldProfile[];
  predictions: readonly ExtractionBenchmarkPrediction[];
  evaluated_at: string;
}): GroundTruthEvaluationReport {
  const manifest = validateGroundTruthManifest(input.manifest);
  requireGroundTruth(manifest.status === "locked_ground_truth", "ground_truth_evaluator_requires_locked_manifest");
  requireGroundTruth(input.benchmark_id.trim().length > 0 && input.benchmark_version.trim().length > 0, "ground_truth_benchmark_identity_required");
  requireGroundTruth(Number.isFinite(Date.parse(input.evaluated_at)), "ground_truth_evaluation_timestamp_invalid");

  const truth = adjudicatedValues(manifest);
  validateProfiles(input.field_profiles, new Set(truth.keys()));
  const profiles = new Map(input.field_profiles.map((profile) => [profile.field_identity, profile]));
  const predictions = new Map<string, ExtractionBenchmarkPrediction>();
  for (const prediction of input.predictions) {
    requireGroundTruth(!predictions.has(prediction.field_identity), "ground_truth_duplicate_prediction_identity");
    calculationValueSchema.parse(prediction.value);
    predictions.set(prediction.field_identity, prediction);
  }

  const expectedConflict = disagreementByField(manifest);
  const fieldIdentities = [...new Set([...truth.keys(), ...predictions.keys()])].sort();
  const rows: GroundTruthErrorMatrixRow[] = fieldIdentities.map((identity) => {
    const expected = truth.get(identity);
    const prediction = predictions.get(identity);
    const profile = profiles.get(identity) ?? { field_identity: identity, category: "other" as const, critical: false };
    const valueOutcome = expected === undefined
      ? "unexpected"
      : prediction === undefined
        ? "missed"
        : canonicalStringify(expected) === canonicalStringify(prediction.value)
          ? "correct"
          : "value_mismatch";
    const shouldConflict = expectedConflict.get(identity) ?? false;
    const actualConflict = prediction?.conflict_detected ?? false;
    const conflictOutcome = actualConflict === shouldConflict
      ? "correct"
      : actualConflict
        ? "false_conflict"
        : "missed_conflict";
    return {
      field_identity: identity,
      category: profile.category,
      critical: profile.critical,
      value_outcome: valueOutcome,
      conflict_outcome: conflictOutcome,
    };
  });

  const falseConflicts = rows.filter((row) => row.conflict_outcome === "false_conflict").map((row) => row.field_identity);
  const missedConflicts = rows.filter((row) => row.conflict_outcome === "missed_conflict").map((row) => row.field_identity);
  const payload = {
    benchmark_id: input.benchmark_id,
    benchmark_version: input.benchmark_version,
    manifest_id: manifest.manifest_id,
    manifest_revision: manifest.revision,
    locked_ground_truth_sha256: manifest.locked_sha256!,
    overall_accuracy: metric(rows, () => true),
    critical_field_accuracy: metric(rows, (row) => row.critical),
    monetary_accuracy: metric(rows, (row) => row.category === "monetary"),
    hours_accuracy: metric(rows, (row) => row.category === "hours"),
    pay_period_accuracy: metric(rows, (row) => row.category === "pay_period"),
    field_error_matrix: rows,
    false_conflicts: falseConflicts,
    missed_conflicts: missedConflicts,
    evaluated_at: input.evaluated_at,
  } as const;
  return deepFreeze({ ...payload, report_sha256: canonicalSha256(payload) }) as GroundTruthEvaluationReport;
}
