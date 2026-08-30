import { describe, expect, it } from "vitest";
import { addGroundTruthAnnotation2, assertLockedGroundTruthUnchanged } from "../workflow.ts";
import { buildSyntheticGroundTruthWorkflow } from "../synthetic-fixtures.ts";
import { validateGroundTruthManifest } from "../validation.ts";
import { evaluateExtendedGroundTruth } from "./evaluator.ts";
import { overnightV07Policies, overnightV07Predictions } from "./fixtures.ts";
import { assertCandidateComparisonAllowed, buildOfflineGroundTruthWorkspace, existingPublicBenchmarkProvenanceInventory, syntheticFixtureProvenanceInventory } from "./workspace.ts";

describe("V07-P4-GT offline workspace", () => {
  it("reuses the canonical dual-annotation, disagreement, adjudication and lock semantics", () => {
    const workspace = buildOfflineGroundTruthWorkspace();
    expect(workspace.workflow.annotation_1.status).toBe("annotation_1");
    expect(workspace.workflow.annotation_2.status).toBe("annotation_2");
    expect(workspace.workflow.disagreement.status).toBe("disagreement");
    expect(workspace.workflow.human_adjudication.status).toBe("human_adjudication");
    expect(workspace.workflow.locked_ground_truth.status).toBe("locked_ground_truth");
    expect(workspace.document_seal.document_sha256).toBe(workspace.workflow.locked_ground_truth.document_sha256);
    expect(workspace.field_contract).toHaveLength(4);
    expect(workspace.candidate_comparison_policy.candidate_may_generate_annotation).toBe(false);
    assertCandidateComparisonAllowed({ manifest: workspace.workflow.annotation_1, view: "separate_candidate_comparison" });
  });

  it("inventories only explicit synthetic provenance and zero customer material", () => {
    const inventory = syntheticFixtureProvenanceInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory.every((item) => item.classification === "deterministic_synthetic" && item.customer_material === false)).toBe(true);
    expect(existingPublicBenchmarkProvenanceInventory()).toEqual([expect.objectContaining({ declared_neutral_fixture_count: 5, reuse_status: "excluded_pending_explicit_approval", fixture_bytes_read_by_p4: 0 })]);
  });

  it("rejects empty/duplicate annotations, same actor, locked mutation, invalid geometry and hash mismatch", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(() => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: [] })).toThrow();
    expect(() => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: [...workflow.annotation_1.annotations, workflow.annotation_1.annotations[0]] })).toThrow("duplicate_ground_truth_field_identity");
    const sameActor = workflow.annotation_2.annotations.filter((item) => item.annotation_pass === "annotation_2").map((item) => ({ ...item, author_id: workflow.annotation_1.annotator_1_id }));
    expect(() => addGroundTruthAnnotation2(workflow.annotation_1, sameActor)).toThrow("ground_truth_requires_distinct_annotators");
    expect(() => assertLockedGroundTruthUnchanged(workflow.locked_ground_truth, { ...workflow.locked_ground_truth, revision_reason: "forbidden mutation" })).toThrow("ground_truth_locked_revision_is_immutable");
    const invalidGeometry = { ...workflow.annotation_1, annotations: workflow.annotation_1.annotations.map((item, index) => index === 0 ? { ...item, bounding_box: { x: 0.9, y: 0.1, width: 0.2, height: 0.1, coordinate_space: "normalized" as const } } : item) };
    expect(() => validateGroundTruthManifest(invalidGeometry)).toThrow("ground_truth_invalid_geometry");
    expect(() => validateGroundTruthManifest({ ...workflow.locked_ground_truth, locked_sha256: "f".repeat(64) })).toThrow("ground_truth_locked_hash_mismatch");
    expect(() => assertCandidateComparisonAllowed({ manifest: workflow.annotation_1, view: "annotation_editor" })).toThrow("GT_CANDIDATE_COMPARISON_VIEW_NOT_SEPARATED");
  });
});

describe("V07-P4-GT extended evaluator mechanics", () => {
  it("distinguishes exact/tolerant/null/conflict outcomes and emits slices/calibration", () => {
    const manifest = buildOfflineGroundTruthWorkspace().workflow.locked_ground_truth;
    const report = evaluateExtendedGroundTruth({ benchmark_id: "synthetic.gt.v07", benchmark_version: "0.7.0", manifest, policies: overnightV07Policies, predictions: overnightV07Predictions, evaluated_at: "2040-05-04T00:00:00Z" });
    expect(report.fields.map((item) => item.value_outcome)).toEqual(["correct", "correct", "correct", "explicit_null"]);
    expect(report.fields.find((item) => item.field_identity === "synthetic.duration")?.conflict_outcome).toBe("correct");
    expect(report.layout_slices.length).toBeGreaterThan(0);
    expect(report.document_slices).toHaveLength(1);
    expect(report.calibration).toHaveLength(4);
    expect(report.metrics.overall).toBe("3/4");
  });

  it("never counts absent, null, conflict or error states as correct and requires locked truth", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(() => evaluateExtendedGroundTruth({ benchmark_id: "synthetic.gt.v07", benchmark_version: "0.7.0", manifest: workflow.human_adjudication, policies: overnightV07Policies, predictions: overnightV07Predictions, evaluated_at: "2040-05-04T00:00:00Z" })).toThrow("GT_EXTENDED_EVALUATOR_REQUIRES_LOCKED_GROUND_TRUTH");
    const states = ["absent", "null", "conflict", "error"] as const;
    const predictions = overnightV07Policies.map((policy, index) => ({ field_identity: policy.field_identity, outcome: states[index], value: null, conflict_detected: states[index] === "conflict", confidence_micros: null }));
    const report = evaluateExtendedGroundTruth({ benchmark_id: "synthetic.gt.v07", benchmark_version: "0.7.0", manifest: workflow.locked_ground_truth, policies: overnightV07Policies, predictions, baseline: Object.fromEntries(overnightV07Policies.map((item) => [item.field_identity, "correct"])), evaluated_at: "2040-05-04T00:00:00Z" });
    expect(report.fields.every((item) => item.value_outcome !== "correct")).toBe(true);
    expect(report.regression).toMatchObject({ regressed: 4, status: "regressed" });
  });
});
