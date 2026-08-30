import type { ExtendedComparisonPolicy, ExtendedPrediction } from "./evaluator.ts";
import { syntheticValues } from "../synthetic-fixtures.ts";

export const overnightV07Policies: readonly ExtendedComparisonPolicy[] = Object.freeze([
  { field_identity: "synthetic.amount", category: "monetary", critical: true, comparison: "exact", tolerance_micros: 0, layout_slice: "single_column", document_slice: "synthetic_clean" },
  { field_identity: "synthetic.duration", category: "hours", critical: true, comparison: "decimal_absolute_micros", tolerance_micros: 500_000, layout_slice: "single_column", document_slice: "synthetic_clean" },
  { field_identity: "synthetic.period", category: "pay_period", critical: true, comparison: "exact", tolerance_micros: 0, layout_slice: "header", document_slice: "synthetic_clean" },
  { field_identity: "synthetic.label", category: "other", critical: false, comparison: "normalized_text", tolerance_micros: 0, layout_slice: "single_column", document_slice: "synthetic_clean" },
]);

export const overnightV07Predictions: readonly ExtendedPrediction[] = Object.freeze([
  { field_identity: "synthetic.amount", outcome: "value", value: syntheticValues.amount_a, conflict_detected: false, confidence_micros: 950_000 },
  { field_identity: "synthetic.duration", outcome: "value", value: syntheticValues.duration_b, conflict_detected: true, confidence_micros: 720_000 },
  { field_identity: "synthetic.period", outcome: "null", value: null, conflict_detected: false, confidence_micros: null },
  { field_identity: "synthetic.label", outcome: "value", value: { kind: "text", value: "  SYNTHETIC-NEUTRAL-LABEL  " }, conflict_detected: false, confidence_micros: 830_000 },
]);
