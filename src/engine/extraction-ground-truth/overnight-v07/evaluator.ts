import { calculationValueSchema, type CalculationValue } from "../../calculations/contracts.ts";
import type { GroundTruthManifest } from "../../wave2/contracts.ts";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../../rule-runtime/canonical.ts";
import { evaluateLockedGroundTruth, type GroundTruthFieldCategory, type GroundTruthFieldProfile } from "../evaluator.ts";
import { validateGroundTruthManifest } from "../validation.ts";

export type ExtendedComparisonPolicy = Readonly<{
  field_identity: string;
  category: GroundTruthFieldCategory;
  critical: boolean;
  comparison: "exact" | "normalized_text" | "decimal_absolute_micros";
  tolerance_micros: number;
  layout_slice: string;
  document_slice: string;
}>;

export type ExtendedPrediction = Readonly<{
  field_identity: string;
  outcome: "value" | "absent" | "null" | "conflict" | "error";
  value: CalculationValue | null;
  conflict_detected: boolean;
  confidence_micros: number | null;
}>;

export type ExtendedFieldResult = Readonly<{
  field_identity: string;
  category: GroundTruthFieldCategory;
  critical: boolean;
  layout_slice: string;
  document_slice: string;
  prediction_state: ExtendedPrediction["outcome"];
  value_outcome: "correct" | "value_mismatch" | "missed_absent" | "explicit_null" | "predicted_conflict_no_value" | "prediction_error";
  conflict_outcome: "correct" | "false_conflict" | "missed_conflict";
  confidence_micros: number | null;
}>;

export type ExtendedGroundTruthReport = Readonly<{
  schema_version: "tivdoc-extended-gt-evaluation-v0.7.0";
  benchmark_id: string;
  benchmark_version: string;
  manifest_id: string;
  locked_ground_truth_sha256: string;
  canonical_evaluator_report_sha256: string;
  fields: readonly ExtendedFieldResult[];
  metrics: Readonly<{
    overall: string;
    critical: string;
    money: string;
    hours: string;
    pay_period: string;
    annotator_agreement: string;
    false_conflicts: number;
    missed_conflicts: number;
  }>;
  layout_slices: readonly Readonly<{ slice: string; expected: number; correct: number; accuracy: string }>[];
  document_slices: readonly Readonly<{ slice: string; expected: number; correct: number; accuracy: string }>[];
  calibration: readonly Readonly<{ from_micros: number; to_micros: number; predicted: number; correct: number; observed_accuracy: string }>[];
  regression: Readonly<{ improved: number; regressed: number; stable: number; status: "no_baseline" | "improved_or_stable" | "regressed" }>;
  evaluated_at: string;
  report_sha256: string;
}>;

export function evaluateExtendedGroundTruth(input: Readonly<{
  benchmark_id: string;
  benchmark_version: string;
  manifest: GroundTruthManifest;
  policies: readonly ExtendedComparisonPolicy[];
  predictions: readonly ExtendedPrediction[];
  baseline?: Readonly<Record<string, ExtendedFieldResult["value_outcome"]>>;
  evaluated_at: string;
}>): ExtendedGroundTruthReport {
  const manifest = validateGroundTruthManifest(input.manifest);
  if (manifest.status !== "locked_ground_truth") throw new Error("GT_EXTENDED_EVALUATOR_REQUIRES_LOCKED_GROUND_TRUTH");
  if (!Number.isFinite(Date.parse(input.evaluated_at))) throw new Error("GT_EXTENDED_EVALUATED_AT_INVALID");
  const truth = new Map(manifest.annotations.filter((item) => item.annotation_pass === "human_adjudication").map((item) => [item.field_identity, item.value]));
  const first = new Map(manifest.annotations.filter((item) => item.annotation_pass === "annotation_1").map((item) => [item.field_identity, item.value]));
  const second = new Map(manifest.annotations.filter((item) => item.annotation_pass === "annotation_2").map((item) => [item.field_identity, item.value]));
  const policies = uniqueBy(input.policies, (item) => item.field_identity, "GT_DUPLICATE_COMPARISON_POLICY");
  const predictions = uniqueBy(input.predictions, (item) => item.field_identity, "GT_DUPLICATE_EXTENDED_PREDICTION");
  if (policies.size !== truth.size || [...truth.keys()].some((key) => !policies.has(key))) throw new Error("GT_POLICIES_MUST_COVER_LOCKED_FIELDS");
  if ([...predictions.keys()].some((key) => !truth.has(key))) throw new Error("GT_UNEXPECTED_PREDICTION_FIELD");
  for (const prediction of predictions.values()) validatePrediction(prediction);
  for (const policy of policies.values()) validatePolicy(policy);
  const fields = [...truth.keys()].sort().map((field_identity): ExtendedFieldResult => {
    const expected = truth.get(field_identity)!;
    const policy = policies.get(field_identity)!;
    const prediction = predictions.get(field_identity) ?? { field_identity, outcome: "absent" as const, value: null, conflict_detected: false, confidence_micros: null };
    const shouldConflict = canonicalStringify(first.get(field_identity)) !== canonicalStringify(second.get(field_identity));
    const valueOutcome = prediction.outcome === "value"
      ? valuesMatch(expected, prediction.value!, policy) ? "correct" as const : "value_mismatch" as const
      : prediction.outcome === "absent" ? "missed_absent" as const
        : prediction.outcome === "null" ? "explicit_null" as const
          : prediction.outcome === "conflict" ? "predicted_conflict_no_value" as const : "prediction_error" as const;
    return deepFreeze({
      field_identity,
      category: policy.category,
      critical: policy.critical,
      layout_slice: policy.layout_slice,
      document_slice: policy.document_slice,
      prediction_state: prediction.outcome,
      value_outcome: valueOutcome,
      conflict_outcome: prediction.conflict_detected === shouldConflict ? "correct" as const : prediction.conflict_detected ? "false_conflict" as const : "missed_conflict" as const,
      confidence_micros: prediction.confidence_micros,
    });
  });
  const canonicalProfiles: readonly GroundTruthFieldProfile[] = [...policies.values()].map((item) => ({ field_identity: item.field_identity, category: item.category, critical: item.critical }));
  const canonicalPredictions = [...predictions.values()].filter((item) => item.outcome === "value" && item.value !== null).map((item) => ({ field_identity: item.field_identity, value: item.value!, conflict_detected: item.conflict_detected }));
  const canonical = evaluateLockedGroundTruth({ benchmark_id: input.benchmark_id, benchmark_version: input.benchmark_version, manifest, field_profiles: canonicalProfiles, predictions: canonicalPredictions, evaluated_at: input.evaluated_at });
  const agreementCount = [...truth.keys()].filter((key) => canonicalStringify(first.get(key)) === canonicalStringify(second.get(key))).length;
  const correct = (rows: readonly ExtendedFieldResult[]) => rows.filter((item) => item.value_outcome === "correct").length;
  const metrics = {
    overall: ratio(correct(fields), fields.length),
    critical: sliceAccuracy(fields.filter((item) => item.critical)),
    money: sliceAccuracy(fields.filter((item) => item.category === "monetary")),
    hours: sliceAccuracy(fields.filter((item) => item.category === "hours")),
    pay_period: sliceAccuracy(fields.filter((item) => item.category === "pay_period")),
    annotator_agreement: ratio(agreementCount, fields.length),
    false_conflicts: fields.filter((item) => item.conflict_outcome === "false_conflict").length,
    missed_conflicts: fields.filter((item) => item.conflict_outcome === "missed_conflict").length,
  };
  const baseline = input.baseline ?? null;
  const regressionCounts = fields.reduce((counts, field) => {
    const prior = baseline?.[field.field_identity];
    if (prior === undefined || (prior === "correct") === (field.value_outcome === "correct")) counts.stable += 1;
    else if (field.value_outcome === "correct") counts.improved += 1;
    else counts.regressed += 1;
    return counts;
  }, { improved: 0, regressed: 0, stable: 0 });
  const payload = {
    schema_version: "tivdoc-extended-gt-evaluation-v0.7.0" as const,
    benchmark_id: input.benchmark_id,
    benchmark_version: input.benchmark_version,
    manifest_id: manifest.manifest_id,
    locked_ground_truth_sha256: manifest.locked_sha256!,
    canonical_evaluator_report_sha256: canonical.report_sha256,
    fields,
    metrics,
    layout_slices: buildSlices(fields, "layout_slice"),
    document_slices: buildSlices(fields, "document_slice"),
    calibration: buildCalibration(fields),
    regression: { ...regressionCounts, status: baseline === null ? "no_baseline" as const : regressionCounts.regressed > 0 ? "regressed" as const : "improved_or_stable" as const },
    evaluated_at: input.evaluated_at,
  };
  return deepFreeze({ ...payload, report_sha256: canonicalSha256(payload) }) as ExtendedGroundTruthReport;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string, error: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) { const id = key(item); if (result.has(id)) throw new Error(error); result.set(id, item); }
  return result;
}

function validatePrediction(prediction: ExtendedPrediction) {
  if (prediction.outcome === "value") calculationValueSchema.parse(prediction.value);
  else if (prediction.value !== null) throw new Error("GT_NON_VALUE_PREDICTION_MUST_HAVE_NULL_VALUE");
  if (prediction.confidence_micros !== null && (!Number.isInteger(prediction.confidence_micros) || prediction.confidence_micros < 0 || prediction.confidence_micros > 1_000_000)) throw new Error("GT_CONFIDENCE_MICROS_INVALID");
}

function validatePolicy(policy: ExtendedComparisonPolicy) {
  if (!Number.isInteger(policy.tolerance_micros) || policy.tolerance_micros < 0 || policy.tolerance_micros > 1_000_000) throw new Error("GT_TOLERANCE_INVALID");
  if (policy.comparison !== "decimal_absolute_micros" && policy.tolerance_micros !== 0) throw new Error("GT_TOLERANCE_ONLY_FOR_DECIMAL");
}

function valuesMatch(expected: CalculationValue, actual: CalculationValue, policy: ExtendedComparisonPolicy): boolean {
  if (policy.comparison === "exact") return canonicalStringify(expected) === canonicalStringify(actual);
  if (policy.comparison === "normalized_text") return expected.kind === "text" && actual.kind === "text" && normalizeText(expected.value) === normalizeText(actual.value);
  return expected.kind === "decimal" && actual.kind === "decimal" && expected.unit === actual.unit && Math.abs(decimalMicros(expected.value) - decimalMicros(actual.value)) <= policy.tolerance_micros;
}

function normalizeText(value: string) { return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en"); }

function decimalMicros(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("GT_DECIMAL_TOLERANCE_REQUIRES_SIX_OR_FEWER_PLACES");
  const result = Number(BigInt(match[2]) * BigInt(1_000_000) + BigInt((match[3] ?? "").padEnd(6, "0")));
  if (!Number.isSafeInteger(result)) throw new Error("GT_DECIMAL_MICROS_OVERFLOW");
  return match[1] === "-" ? -result : result;
}

function ratio(correct: number, total: number): string { return total === 0 ? "1" : `${correct}/${total}`; }
function sliceAccuracy(rows: readonly ExtendedFieldResult[]): string { return ratio(rows.filter((item) => item.value_outcome === "correct").length, rows.length); }

function buildSlices(fields: readonly ExtendedFieldResult[], key: "layout_slice" | "document_slice") {
  const names = [...new Set(fields.map((item) => item[key]))].sort();
  return names.map((slice) => { const rows = fields.filter((item) => item[key] === slice); const correct = rows.filter((item) => item.value_outcome === "correct").length; return { slice, expected: rows.length, correct, accuracy: ratio(correct, rows.length) }; });
}

function buildCalibration(fields: readonly ExtendedFieldResult[]) {
  const bounds = [[0, 249_999], [250_000, 499_999], [500_000, 749_999], [750_000, 1_000_000]] as const;
  return bounds.map(([from_micros, to_micros]) => {
    const rows = fields.filter((item) => item.confidence_micros !== null && item.confidence_micros >= from_micros && item.confidence_micros <= to_micros);
    const correct = rows.filter((item) => item.value_outcome === "correct").length;
    return { from_micros, to_micros, predicted: rows.length, correct, observed_accuracy: ratio(correct, rows.length) };
  });
}
