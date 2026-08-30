import type { EmploymentSnapshot } from "../../facts/snapshot.ts";
import { syntheticCanonicalSnapshot, syntheticRuleInputMappingRegistry } from "../../analysis-orchestration/synthetic-fixtures.ts";
import { createCanonicalRuleInputSnapshot } from "../../rule-input/snapshot.ts";
import { registerRuleInputMappingRegistry } from "../../rule-input/mapping-registry.ts";
import { prepareRuleInputs } from "../../rule-input/preparation.ts";
import type { GroundTruthFieldAnnotation } from "../../wave2/contracts.ts";
import { canonicalStringify } from "../../rule-runtime/canonical.ts";
import { buildSyntheticGroundTruthWorkflow, SYNTHETIC_DOCUMENT_SHA256, syntheticValues } from "../../extraction-ground-truth/synthetic-fixtures.ts";
import { validateGroundTruthManifest, calculateLockedGroundTruthSha256 } from "../../extraction-ground-truth/validation.ts";
import { addGroundTruthAnnotation2, assertLockedGroundTruthUnchanged, createCorrectionRevision } from "../../extraction-ground-truth/workflow.ts";

type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function prepare(snapshot: EmploymentSnapshot, at = "2040-01-01T01:00:00.000Z") {
  return prepareRuleInputs(createCanonicalRuleInputSnapshot(snapshot), registerRuleInputMappingRegistry(syntheticRuleInputMappingRegistry), at);
}

function ruleCase(id: string, mutate: (snapshot: Mutable<EmploymentSnapshot>) => void, expected: string, at?: string) {
  const snapshot = clone(syntheticCanonicalSnapshot);
  mutate(snapshot);
  const result = prepare(snapshot as EmploymentSnapshot, at);
  const passed = result.result.status === "rejected" && result.result.values.length === 0 && result.result.rejection_codes.includes(expected);
  if (!passed) throw new Error(`rule_input_negative_matrix_failed:${id}`);
  return { id, expected_rejection: expected, observed_rejections: result.result.rejection_codes, partial_values_published: result.result.values.length, passed };
}

function expectedFailure(id: string, expected: string, action: () => unknown) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const passed = message.includes(expected);
    if (!passed) throw new Error(`ground_truth_negative_wrong_error:${id}:${message}`);
    return { id, expected_rejection: expected, observed_error: message, passed };
  }
  throw new Error(`ground_truth_negative_accepted:${id}`);
}

function correctionAnnotation(input: Partial<GroundTruthFieldAnnotation> = {}): GroundTruthFieldAnnotation {
  return {
    annotation_id: "SYNTHETIC_CORRECTION_A1_001",
    field_identity: "synthetic.amount",
    document_sha256: SYNTHETIC_DOCUMENT_SHA256,
    page: 1,
    section: "synthetic.section",
    bounding_box: null,
    value: syntheticValues.amount_b,
    annotation_pass: "annotation_1",
    author_id: "SYNTHETIC_CORRECTOR_A",
    annotated_at: "2040-06-01T10:00:00Z",
    resolves_annotation_ids: [],
    ...input,
  };
}

export function buildRuleInputNegativeMatrix() {
  const cases = [
    ruleCase("RULE_INPUT_NEG_001_MISSING", (snapshot) => {
      snapshot.facts = snapshot.facts.filter((fact) => fact.path !== "work.regular_hours");
    }, "fact.missing"),
    ruleCase("RULE_INPUT_NEG_002_CONFLICTED", (snapshot) => {
      const fact = snapshot.facts.find((entry) => entry.path === "work.regular_hours")!;
      fact.status = "conflicted";
      fact.value = null;
      fact.conflicting_fact_ids = ["88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999"];
    }, "fact.conflicted"),
    ruleCase("RULE_INPUT_NEG_003_UNCONFIRMED", (snapshot) => {
      snapshot.facts.find((entry) => entry.path === "work.regular_hours")!.status = "needs_confirmation";
    }, "fact.unconfirmed"),
    ruleCase("RULE_INPUT_NEG_004_STALE", () => {}, "fact.stale", "2040-01-01T03:00:01.000Z"),
    ruleCase("RULE_INPUT_NEG_005_LOW_CONFIDENCE", (snapshot) => {
      snapshot.facts.find((entry) => entry.path === "work.regular_hours")!.confidence = 0.5;
    }, "fact.below_confidence_threshold"),
  ];
  return { schema_version: "tivdoc-rule-input-negative-matrix-v0.4.1", synthetic_and_legally_neutral: true, cases, passed: cases.every((entry) => entry.passed) };
}

export function buildGroundTruthNegativeMatrix() {
  const workflow = buildSyntheticGroundTruthWorkflow();
  const second = workflow.annotation_2.annotations.filter((entry) => entry.annotation_pass === "annotation_2");
  const negativeCases = [
    expectedFailure("GT_NEG_001_DISTINCT_ANNOTATORS", "ground_truth_requires_distinct_annotators", () => addGroundTruthAnnotation2(workflow.annotation_1, second.map((entry) => ({ ...entry, author_id: workflow.annotation_1.annotator_1_id })))),
    expectedFailure("GT_NEG_002_EMPTY_TEMPLATE", "Too small", () => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: [] })),
    expectedFailure("GT_NEG_003_MISSING_EVIDENCE", "Invalid input", () => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: workflow.annotation_1.annotations.map((entry, index) => index === 0 ? { ...entry, page: undefined } : entry) })),
    expectedFailure("GT_NEG_004_HASH_MISMATCH", "ground_truth_annotation_document_hash_mismatch", () => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: workflow.annotation_1.annotations.map((entry, index) => index === 0 ? { ...entry, document_sha256: "2".repeat(64) } : entry) })),
    expectedFailure("GT_NEG_005_INVALID_GEOMETRY", "ground_truth_invalid_geometry", () => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: workflow.annotation_1.annotations.map((entry, index) => index === 0 ? { ...entry, bounding_box: { x: 0.9, y: 0.1, width: 0.2, height: 0.1, coordinate_space: "normalized" as const } } : entry) })),
    expectedFailure("GT_NEG_006_DUPLICATE_FIELD", "duplicate_ground_truth_field_identity", () => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: [...workflow.annotation_1.annotations, { ...workflow.annotation_1.annotations[0]!, annotation_id: "SYNTHETIC_DUPLICATE_FIELD_001" }] })),
    expectedFailure("GT_NEG_007_LOCKED_MUTATION", "ground_truth_locked_revision_is_immutable", () => {
      const changedPayload = { ...workflow.locked_ground_truth, created_at: "2040-05-01T09:00:01Z" };
      const changed = validateGroundTruthManifest({ ...changedPayload, locked_sha256: calculateLockedGroundTruthSha256(changedPayload) });
      assertLockedGroundTruthUnchanged(workflow.locked_ground_truth, changed);
    }),
  ];
  const [preserved, correction] = createCorrectionRevision({
    prior: workflow.locked_ground_truth,
    manifest_id: "SYNTHETIC_GT_MANIFEST_002",
    annotations: [correctionAnnotation()],
    reason: "Synthetic correction after independent human observation.",
    created_at: "2040-06-01T09:00:00Z",
  });
  const positiveCases = [
    {
      id: "GT_POS_001_CANONICAL_MONEY_REUSE",
      canonical_kind: syntheticValues.amount_a.kind,
      canonical_currency: syntheticValues.amount_a.value.currency,
      passed: syntheticValues.amount_a.kind === "money",
    },
    {
      id: "GT_POS_002_REVISION_PRESERVATION",
      prior_byte_preserved: canonicalStringify(preserved) === canonicalStringify(workflow.locked_ground_truth),
      revision_incremented: correction.revision === workflow.locked_ground_truth.revision + 1,
      supersedes_preserved: correction.supersedes_manifest_id === workflow.locked_ground_truth.manifest_id,
      passed: canonicalStringify(preserved) === canonicalStringify(workflow.locked_ground_truth) && correction.revision === 2,
    },
  ];
  return {
    schema_version: "tivdoc-ground-truth-negative-matrix-v0.4.1",
    synthetic_and_legally_neutral: true,
    canonical_calculation_value_schema_reused: true,
    negative_cases: negativeCases,
    positive_cases: positiveCases,
    passed: negativeCases.every((entry) => entry.passed) && positiveCases.every((entry) => entry.passed),
  };
}
