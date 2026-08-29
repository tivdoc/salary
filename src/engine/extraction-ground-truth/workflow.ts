import type { GroundTruthFieldAnnotation, GroundTruthManifest } from "../wave2/contracts.ts";
import { canonicalStringify } from "../rule-runtime/canonical.ts";
import { GroundTruthError, requireGroundTruth } from "./errors.ts";
import {
  calculateLockedGroundTruthSha256,
  manifestHasDisagreement,
  validateGroundTruthManifest,
} from "./validation.ts";

function requireStatus(manifest: GroundTruthManifest, expected: GroundTruthManifest["status"]) {
  requireGroundTruth(manifest.status === expected, `ground_truth_transition_requires_${expected}`);
}

function uniqueAuthor(annotations: readonly GroundTruthFieldAnnotation[]) {
  requireGroundTruth(annotations.length > 0, "ground_truth_empty_annotation_pass");
  const authors = new Set(annotations.map((annotation) => annotation.author_id));
  requireGroundTruth(authors.size === 1, "ground_truth_annotation_pass_requires_one_author");
  return annotations[0]!.author_id;
}

export function createGroundTruthAnnotation1(input: unknown): GroundTruthManifest {
  const manifest = validateGroundTruthManifest(input);
  requireStatus(manifest, "annotation_1");
  return manifest;
}

export function addGroundTruthAnnotation2(
  prior: GroundTruthManifest,
  annotations: readonly GroundTruthFieldAnnotation[],
): GroundTruthManifest {
  const current = validateGroundTruthManifest(prior);
  requireStatus(current, "annotation_1");
  const author = uniqueAuthor(annotations);
  requireGroundTruth(author !== current.annotator_1_id, "ground_truth_requires_distinct_annotators");
  requireGroundTruth(annotations.every((annotation) => annotation.annotation_pass === "annotation_2"), "ground_truth_expected_annotation_2_pass");
  return validateGroundTruthManifest({
    ...current,
    status: "annotation_2",
    annotations: [...current.annotations, ...annotations],
    annotator_2_id: author,
  });
}

export function recordGroundTruthDisagreement(prior: GroundTruthManifest): GroundTruthManifest {
  const current = validateGroundTruthManifest(prior);
  requireStatus(current, "annotation_2");
  requireGroundTruth(manifestHasDisagreement(current), "ground_truth_no_disagreement_to_record");
  return validateGroundTruthManifest({ ...current, status: "disagreement" });
}

export function recordHumanAdjudication(
  prior: GroundTruthManifest,
  annotations: readonly GroundTruthFieldAnnotation[],
): GroundTruthManifest {
  const current = validateGroundTruthManifest(prior);
  requireGroundTruth(
    current.status === "annotation_2" || current.status === "disagreement",
    "ground_truth_human_adjudication_requires_second_pass",
  );
  const author = uniqueAuthor(annotations);
  requireGroundTruth(author !== current.annotator_1_id && author !== current.annotator_2_id, "ground_truth_adjudicator_must_be_independent");
  requireGroundTruth(
    annotations.every((annotation) => annotation.annotation_pass === "human_adjudication"),
    "ground_truth_expected_human_adjudication_pass",
  );
  return validateGroundTruthManifest({
    ...current,
    status: "human_adjudication",
    annotations: [...current.annotations, ...annotations],
    adjudicator_id: author,
  });
}

export function lockGroundTruth(prior: GroundTruthManifest): GroundTruthManifest {
  const current = validateGroundTruthManifest(prior);
  requireStatus(current, "human_adjudication");
  const candidate = { ...current, status: "locked_ground_truth" as const };
  return validateGroundTruthManifest({
    ...candidate,
    locked_sha256: calculateLockedGroundTruthSha256(candidate),
  });
}

export function assertLockedGroundTruthUnchanged(prior: GroundTruthManifest, candidate: GroundTruthManifest): void {
  const locked = validateGroundTruthManifest(prior);
  requireStatus(locked, "locked_ground_truth");
  if (canonicalStringify(locked) !== canonicalStringify(candidate)) {
    throw new GroundTruthError("ground_truth_locked_revision_is_immutable");
  }
}

export function createCorrectionRevision(input: {
  prior: GroundTruthManifest;
  manifest_id: string;
  annotations: readonly GroundTruthFieldAnnotation[];
  reason: string;
  created_at: string;
}): readonly [GroundTruthManifest, GroundTruthManifest] {
  const prior = validateGroundTruthManifest(input.prior);
  requireStatus(prior, "locked_ground_truth");
  requireGroundTruth(input.reason.trim().length > 0, "ground_truth_correction_reason_required");
  requireGroundTruth(input.manifest_id !== prior.manifest_id, "ground_truth_correction_requires_new_manifest_id");
  const author = uniqueAuthor(input.annotations);
  requireGroundTruth(input.annotations.every((annotation) => annotation.annotation_pass === "annotation_1"), "ground_truth_correction_starts_annotation_1");
  const next = validateGroundTruthManifest({
    manifest_id: input.manifest_id,
    schema_version: prior.schema_version,
    revision: prior.revision + 1,
    document_sha256: prior.document_sha256,
    status: "annotation_1",
    sections: prior.sections,
    annotations: input.annotations,
    annotator_1_id: author,
    annotator_2_id: null,
    adjudicator_id: null,
    locked_sha256: null,
    supersedes_manifest_id: prior.manifest_id,
    revision_reason: input.reason.trim(),
    created_at: input.created_at,
  });
  return [prior, next] as const;
}
