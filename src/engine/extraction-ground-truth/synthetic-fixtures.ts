import type { CalculationValue } from "../calculations/contracts.ts";
import type { GroundTruthFieldAnnotation, GroundTruthManifest } from "../wave2/contracts.ts";
import type { ExtractionBenchmarkPrediction, GroundTruthFieldProfile } from "./evaluator.ts";
import {
  addGroundTruthAnnotation2,
  createGroundTruthAnnotation1,
  lockGroundTruth,
  recordGroundTruthDisagreement,
  recordHumanAdjudication,
} from "./workflow.ts";

export const SYNTHETIC_DOCUMENT_SHA256 = "1".repeat(64);

const values = {
  amount_a: { kind: "money", value: { currency: "ZZZ", minor_units: 12_345 } },
  amount_b: { kind: "money", value: { currency: "ZZZ", minor_units: 12_346 } },
  duration_a: { kind: "decimal", value: "7.5", unit: "synthetic.hours" },
  duration_b: { kind: "decimal", value: "8", unit: "synthetic.hours" },
  period: { kind: "date", value: "2040-04-01" },
  label: { kind: "text", value: "synthetic-neutral-label" },
} as const satisfies Record<string, CalculationValue>;

function annotation(input: {
  id: string;
  field: string;
  value: CalculationValue;
  pass: GroundTruthFieldAnnotation["annotation_pass"];
  author: string;
  at: string;
  resolves?: readonly string[];
}): GroundTruthFieldAnnotation {
  return {
    annotation_id: input.id,
    field_identity: input.field,
    document_sha256: SYNTHETIC_DOCUMENT_SHA256,
    page: 1,
    section: "synthetic.section",
    bounding_box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05, coordinate_space: "normalized" },
    value: input.value,
    annotation_pass: input.pass,
    author_id: input.author,
    annotated_at: input.at,
    resolves_annotation_ids: input.resolves ?? [],
  };
}

const fields = [
  ["synthetic.amount", values.amount_a],
  ["synthetic.duration", values.duration_a],
  ["synthetic.period", values.period],
  ["synthetic.label", values.label],
] as const;

function pass(
  passName: GroundTruthFieldAnnotation["annotation_pass"],
  author: string,
  timestamp: string,
  overrides: Readonly<Record<string, CalculationValue>> = {},
  resolves: Readonly<Record<string, readonly string[]>> = {},
) {
  const suffix = passName === "annotation_1" ? "A1" : passName === "annotation_2" ? "A2" : "HA";
  return fields.map(([field, defaultValue], index) => annotation({
    id: `SYNTHETIC_${suffix}_${String(index + 1).padStart(3, "0")}`,
    field,
    value: overrides[field] ?? defaultValue,
    pass: passName,
    author,
    at: timestamp,
    resolves: resolves[field],
  }));
}

export function buildSyntheticGroundTruthWorkflow(): Readonly<{
  annotation_1: GroundTruthManifest;
  annotation_2: GroundTruthManifest;
  disagreement: GroundTruthManifest;
  human_adjudication: GroundTruthManifest;
  locked_ground_truth: GroundTruthManifest;
}> {
  const firstAnnotations = pass("annotation_1", "SYNTHETIC_ANNOTATOR_A", "2040-05-01T10:00:00Z");
  const initial = createGroundTruthAnnotation1({
    manifest_id: "SYNTHETIC_GT_MANIFEST_001",
    schema_version: "1.0",
    revision: 1,
    document_sha256: SYNTHETIC_DOCUMENT_SHA256,
    status: "annotation_1",
    sections: [{ section_id: "synthetic.section", page_from: 1, page_to: 1 }],
    annotations: firstAnnotations,
    annotator_1_id: "SYNTHETIC_ANNOTATOR_A",
    annotator_2_id: null,
    adjudicator_id: null,
    locked_sha256: null,
    supersedes_manifest_id: null,
    revision_reason: null,
    created_at: "2040-05-01T09:00:00Z",
  });
  const secondAnnotations = pass(
    "annotation_2",
    "SYNTHETIC_ANNOTATOR_B",
    "2040-05-02T10:00:00Z",
    { "synthetic.duration": values.duration_b },
  );
  const second = addGroundTruthAnnotation2(initial, secondAnnotations);
  const disagreement = recordGroundTruthDisagreement(second);
  const resolutions = Object.fromEntries(fields.map(([field], index) => [
    field,
    [`SYNTHETIC_A1_${String(index + 1).padStart(3, "0")}`, `SYNTHETIC_A2_${String(index + 1).padStart(3, "0")}`],
  ]));
  const human = recordHumanAdjudication(
    disagreement,
    pass("human_adjudication", "SYNTHETIC_ADJUDICATOR", "2040-05-03T10:00:00Z", {}, resolutions),
  );
  const locked = lockGroundTruth(human);
  return {
    annotation_1: initial,
    annotation_2: second,
    disagreement,
    human_adjudication: human,
    locked_ground_truth: locked,
  };
}

export const syntheticFieldProfiles: readonly GroundTruthFieldProfile[] = [
  { field_identity: "synthetic.amount", category: "monetary", critical: true },
  { field_identity: "synthetic.duration", category: "hours", critical: true },
  { field_identity: "synthetic.period", category: "pay_period", critical: true },
  { field_identity: "synthetic.label", category: "other", critical: false },
];

export const syntheticPredictions: readonly ExtractionBenchmarkPrediction[] = [
  { field_identity: "synthetic.amount", value: values.amount_a, conflict_detected: true },
  { field_identity: "synthetic.duration", value: values.duration_b, conflict_detected: false },
  { field_identity: "synthetic.period", value: values.period, conflict_detected: false },
  { field_identity: "synthetic.unexpected", value: values.label, conflict_detected: false },
];

export const syntheticValues = values;
