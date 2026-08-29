import { describe, expect, it } from "vitest";
import type { GroundTruthFieldAnnotation } from "../wave2/contracts.ts";
import { canonicalStringify } from "../rule-runtime/canonical.ts";
import {
  addGroundTruthAnnotation2,
  assertLockedGroundTruthUnchanged,
  createCorrectionRevision,
  lockGroundTruth,
  recordGroundTruthDisagreement,
  recordHumanAdjudication,
} from "./workflow.ts";
import { buildSyntheticGroundTruthWorkflow, SYNTHETIC_DOCUMENT_SHA256, syntheticValues } from "./synthetic-fixtures.ts";
import { calculateLockedGroundTruthSha256, validateGroundTruthManifest } from "./validation.ts";
import { projectVersionedGroundTruth } from "./versioned-view.ts";

function firstAnnotation(input: Partial<GroundTruthFieldAnnotation> = {}): GroundTruthFieldAnnotation {
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

describe("synthetic Ground Truth workflow", () => {
  it("requires every explicit human workflow state before locking", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(Object.keys(workflow)).toEqual([
      "annotation_1",
      "annotation_2",
      "disagreement",
      "human_adjudication",
      "locked_ground_truth",
    ]);
    expect(workflow.locked_ground_truth.locked_sha256).toBe(calculateLockedGroundTruthSha256(workflow.locked_ground_truth));
    expect(Object.isFrozen(workflow.locked_ground_truth)).toBe(true);
    const versioned = projectVersionedGroundTruth(workflow.locked_ground_truth);
    expect(versioned.document).toMatchObject({ schema_version: "1.0", revision: 1 });
    expect(versioned.sections[0]?.fields.every((field) => field.schema_version === "1.0" && field.manifest_revision === 1)).toBe(true);
    expect(Object.isFrozen(versioned.sections[0]?.fields[0])).toBe(true);
    expect(() => lockGroundTruth(workflow.annotation_2)).toThrow("ground_truth_transition_requires_human_adjudication");
  });

  it("requires distinct annotators and never turns agreement into automatic adjudication", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    const second = workflow.annotation_2.annotations.filter((item) => item.annotation_pass === "annotation_2");
    expect(() => addGroundTruthAnnotation2(workflow.annotation_1, second.map((item) => ({
      ...item,
      author_id: workflow.annotation_1.annotator_1_id,
    })))).toThrow("ground_truth_requires_distinct_annotators");

    const agreeing = second.map((item) => {
      const matchingFirst = workflow.annotation_1.annotations.find((first) => first.field_identity === item.field_identity)!;
      return { ...item, value: matchingFirst.value };
    });
    const agreementState = addGroundTruthAnnotation2(workflow.annotation_1, agreeing);
    expect(agreementState.status).toBe("annotation_2");
    expect(() => recordGroundTruthDisagreement(agreementState)).toThrow("ground_truth_no_disagreement_to_record");
    expect(() => lockGroundTruth(agreementState)).toThrow();
    const humanAnnotations = workflow.human_adjudication.annotations.filter(
      (annotation) => annotation.annotation_pass === "human_adjudication",
    );
    expect(recordHumanAdjudication(agreementState, humanAnnotations).status).toBe("human_adjudication");
  });

  it("rejects empty templates, missing evidence and duplicate field identities", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(() => validateGroundTruthManifest({ ...workflow.annotation_1, annotations: [] })).toThrow();
    expect(() => validateGroundTruthManifest({
      ...workflow.annotation_1,
      annotations: workflow.annotation_1.annotations.map((annotation, index) => index === 0
        ? { ...annotation, page: undefined }
        : annotation),
    })).toThrow();
    expect(() => validateGroundTruthManifest({
      ...workflow.annotation_1,
      annotations: [...workflow.annotation_1.annotations, {
        ...workflow.annotation_1.annotations[0],
        annotation_id: "SYNTHETIC_DUPLICATE_FIELD_001",
      }],
    })).toThrow("duplicate_ground_truth_field_identity");
  });

  it("rejects document hash mismatch and invalid normalized geometry", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    expect(() => validateGroundTruthManifest({
      ...workflow.annotation_1,
      annotations: workflow.annotation_1.annotations.map((annotation, index) => index === 0
        ? { ...annotation, document_sha256: "2".repeat(64) }
        : annotation),
    })).toThrow("ground_truth_annotation_document_hash_mismatch");
    expect(() => validateGroundTruthManifest({
      ...workflow.annotation_1,
      annotations: workflow.annotation_1.annotations.map((annotation, index) => index === 0
        ? { ...annotation, bounding_box: { x: 0.9, y: 0.1, width: 0.2, height: 0.1, coordinate_space: "normalized" } }
        : annotation),
    })).toThrow("ground_truth_invalid_geometry");
  });

  it("rejects incomplete or invented adjudication evidence", () => {
    const workflow = buildSyntheticGroundTruthWorkflow();
    const adjudications = workflow.human_adjudication.annotations.filter((item) => item.annotation_pass === "human_adjudication");
    expect(() => recordHumanAdjudication(workflow.disagreement, adjudications.slice(0, -1))).toThrow("ground_truth_adjudication_must_cover_all_fields");
    expect(() => recordHumanAdjudication(workflow.disagreement, adjudications.map((item, index) => index === 0
      ? { ...item, resolves_annotation_ids: ["SYNTHETIC_INVENTED_001"] }
      : item))).toThrow("ground_truth_adjudication_evidence_mismatch");
  });

  it("rejects locked mutation and creates an append-only correction revision", () => {
    const locked = buildSyntheticGroundTruthWorkflow().locked_ground_truth;
    const changedPayload = { ...locked, created_at: "2040-05-01T09:00:01Z" };
    const changed = validateGroundTruthManifest({
      ...changedPayload,
      locked_sha256: calculateLockedGroundTruthSha256(changedPayload),
    });
    expect(() => assertLockedGroundTruthUnchanged(locked, changed)).toThrow("ground_truth_locked_revision_is_immutable");

    const [preserved, correction] = createCorrectionRevision({
      prior: locked,
      manifest_id: "SYNTHETIC_GT_MANIFEST_002",
      annotations: [firstAnnotation()],
      reason: "Synthetic correction after independent human observation.",
      created_at: "2040-06-01T09:00:00Z",
    });
    expect(canonicalStringify(preserved)).toBe(canonicalStringify(locked));
    expect(correction).toMatchObject({
      revision: 2,
      status: "annotation_1",
      supersedes_manifest_id: locked.manifest_id,
      revision_reason: "Synthetic correction after independent human observation.",
    });
    expect(() => createCorrectionRevision({
      prior: locked,
      manifest_id: "SYNTHETIC_GT_MANIFEST_003",
      annotations: [firstAnnotation()],
      reason: "   ",
      created_at: "2040-06-01T09:00:00Z",
    })).toThrow("ground_truth_correction_reason_required");
  });

  it("requires the same document hash for correction annotations", () => {
    const locked = buildSyntheticGroundTruthWorkflow().locked_ground_truth;
    expect(() => createCorrectionRevision({
      prior: locked,
      manifest_id: "SYNTHETIC_GT_MANIFEST_004",
      annotations: [firstAnnotation({ document_sha256: "3".repeat(64) })],
      reason: "Synthetic mismatch proof.",
      created_at: "2040-06-01T09:00:00Z",
    })).toThrow("ground_truth_annotation_document_hash_mismatch");
  });
});
